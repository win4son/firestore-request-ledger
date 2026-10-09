import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    LedgerError,
    RequestRejection,
    errorReply,
    execute,
    fingerprintRequest,
    lookup,
    reject,
    requestDocId,
} from '../../src/server/index.ts';
import type { LedgerRecord, Operation } from '../../src/server/index.ts';
import { FakeFirestore, type FakeTransaction } from '../helpers/fake-firestore.ts';

const ACTOR = 'user-a';
const ID = 'req-0000000000000001';
const recordPath = (actor = ACTOR, requestId = ID): string => `requestLedger/${requestDocId(actor, requestId)}`;

function completedRecord(input: unknown, result: unknown, overrides: Partial<LedgerRecord> = {}): Record<string, unknown> {
    return {
        v: 1,
        actor: ACTOR,
        requestId: ID,
        operation: 'transfer',
        fingerprint: fingerprintRequest('transfer', input),
        status: 'completed',
        resultJson: JSON.stringify(result),
        createdAt: new Date(0),
        ...overrides,
    };
}

/** An operation whose write refuses, so the ledger has to persist a rejection. */
function refusingOperation(db: FakeFirestore, authorize?: Operation<FakeTransaction>['authorize']): Operation<FakeTransaction, unknown, undefined, unknown> {
    return {
        name: 'transfer',
        ...(authorize ? { authorize } : {}),
        write: (transaction) => {
            transaction.set(db.doc('business/side-effect'), { touched: true });
            reject('failed-precondition', 'over the limit');
        },
    };
}

test('U01 record ids are scoped by actor, unambiguous and path-safe', () => {
    assert.notEqual(requestDocId('a', 'b_c-00000000'), requestDocId('a_b', 'c-00000000'));
    assert.notEqual(requestDocId('user-a', ID), requestDocId('user-b', ID));
    assert.equal(requestDocId('user-a', ID), requestDocId('user-a', ID));
    assert.match(requestDocId('we/ird..actor', ID), /^[0-9a-f]{64}$/);
});

test('U02 the fingerprint covers the operation name and the whole input, not key order', () => {
    const input = { amount: 100, to: 'acct-1', memo: { a: 1, b: 2 } };
    assert.equal(fingerprintRequest('transfer', input), fingerprintRequest('transfer', { memo: { b: 2, a: 1 }, to: 'acct-1', amount: 100 }));
    assert.notEqual(fingerprintRequest('transfer', input), fingerprintRequest('refund', input));
    assert.notEqual(fingerprintRequest('transfer', input), fingerprintRequest('transfer', { ...input, amount: 101 }));
    assert.notEqual(fingerprintRequest('transfer', input), fingerprintRequest('transfer', { ...input, extra: null }));
    assert.equal(fingerprintRequest('transfer', input), fingerprintRequest('transfer', { ...input, extra: undefined }));
});

test('U03 malformed id, actor or operation: LedgerError before any transaction', async () => {
    const db = new FakeFirestore();
    const operation: Operation<FakeTransaction> = { name: 'noop', write: () => null };
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: 'bad/id', input: {} }), { code: 'invalid-request-id', terminal: false });
    await assert.rejects(execute({ db, operation, actor: '', requestId: ID, input: {} }), { code: 'invalid-actor' });
    await assert.rejects(execute({ db, operation: { name: '', write: () => null }, actor: ACTOR, requestId: ID, input: {} }), { code: 'invalid-operation' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: cyclic }), { code: 'unfingerprintable-input' });
    assert.equal(db.transactions, 0);
    assert.equal(db.docs.size, 0);
});

test('U04 rejection loses to a success committed just before it is stored: answer is the replayed success', async () => {
    const db = new FakeFirestore();
    const input = { amount: 100 };
    db.beforeTransaction = (n) => {
        if (n === 2) db.put(recordPath(), completedRecord(input, { id: 'tx-1' }));
    };
    const reply = await execute({ db, operation: refusingOperation(db), actor: ACTOR, requestId: ID, input });
    assert.deepEqual(reply, { requestId: ID, status: 'completed', result: { id: 'tx-1' }, replayed: true });
    assert.equal(db.read(recordPath())?.status, 'completed');
    assert.equal(db.read('business/side-effect'), undefined);
});

test('U05 a rejection stored first by another call is what this call answers (terminal, replayed)', async () => {
    const db = new FakeFirestore();
    const input = { amount: 100 };
    db.beforeTransaction = (n) => {
        if (n === 2) {
            db.put(recordPath(), { ...completedRecord(input, null), status: 'rejected', resultJson: undefined, code: 'not-found', message: 'gone' });
        }
    };
    const reply = await execute({ db, operation: refusingOperation(db), actor: ACTOR, requestId: ID, input });
    assert.deepEqual(reply, { requestId: ID, status: 'rejected', terminal: true, code: 'not-found', message: 'gone', replayed: true });
});

test('U06 the record that won has different content: content-mismatch, not terminal, nothing overwritten', async () => {
    const db = new FakeFirestore();
    db.beforeTransaction = (n) => {
        if (n === 2) db.put(recordPath(), completedRecord({ amount: 999 }, { id: 'other' }));
    };
    await assert.rejects(
        execute({ db, operation: refusingOperation(db), actor: ACTOR, requestId: ID, input: { amount: 100 } }),
        (error: unknown) => error instanceof LedgerError && error.code === 'content-mismatch' && error.terminal === false,
    );
    assert.equal(JSON.parse(String(db.read(recordPath())?.resultJson)).id, 'other');
});

test('U07 the record that won is a success but this caller is no longer authorised: refused, not terminal, not stored', async () => {
    const db = new FakeFirestore();
    const input = { amount: 100 };
    let allowed = true;
    db.beforeTransaction = (n) => {
        if (n === 2) {
            db.put(recordPath(), completedRecord(input, { id: 'tx-1' }));
            allowed = false;
        }
    };
    const authorize = (): void => {
        if (!allowed) reject('permission-denied', 'access revoked');
    };
    await assert.rejects(
        execute({ db, operation: refusingOperation(db, authorize), actor: ACTOR, requestId: ID, input }),
        (error: unknown) => error instanceof RequestRejection && error.code === 'permission-denied',
    );
    assert.equal(db.read(recordPath())?.status, 'completed', 'the stored success is untouched');
});

test('U08 storing the rejection fails: the error propagates and nothing is terminal', async () => {
    const db = new FakeFirestore();
    db.beforeTransaction = (n) => {
        if (n === 2) throw Object.assign(new Error('unavailable (fake)'), { code: 14 });
    };
    await assert.rejects(execute({ db, operation: refusingOperation(db), actor: ACTOR, requestId: ID, input: { amount: 1 } }), /unavailable/);
    assert.equal(db.read(recordPath()), undefined);
});

test('U09 commit contention: the retried attempt sees the winner and replays it instead of writing again', async () => {
    const db = new FakeFirestore();
    const input = { amount: 5 };
    let writes = 0;
    db.beforeCommit = (n) => {
        if (n === 1) db.put(recordPath(), completedRecord(input, { id: 'winner' }));
    };
    const operation: Operation<FakeTransaction> = {
        name: 'transfer',
        write: (transaction) => {
            writes += 1;
            transaction.set(db.doc('business/loser'), { wrote: true });
            return { id: 'loser' };
        },
    };
    const reply = await execute({ db, operation, actor: ACTOR, requestId: ID, input });
    assert.deepEqual(reply, { requestId: ID, status: 'completed', result: { id: 'winner' }, replayed: true });
    assert.equal(writes, 1);
    assert.equal(db.read('business/loser'), undefined);
});

test('U10 ledger errors are never classified as definite, even by a permissive classifier', async () => {
    const db = new FakeFirestore();
    const operation: Operation<FakeTransaction> = { name: 'big', write: () => ({ blob: 'x'.repeat(100) }) };
    await assert.rejects(
        execute({ db, operation, actor: ACTOR, requestId: ID, input: {}, maxResultBytes: 10, classifyRejection: () => ({ code: 'x', message: 'y' }) }),
        { code: 'invalid-result', terminal: false },
    );
    assert.equal(db.read(recordPath()), undefined);
});

test('U11 a custom classifier can treat code-carrying errors (e.g. an HttpsError) as definite', async () => {
    const db = new FakeFirestore();
    const definite = new Set(['invalid-argument', 'failed-precondition', 'permission-denied', 'not-found']);
    const classifyRejection = (error: unknown) => {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' && definite.has(code) ? { code, message: (error as Error).message } : null;
    };
    const operation: Operation<FakeTransaction> = {
        name: 'callable',
        parse: () => {
            throw Object.assign(new Error('amount must be positive'), { code: 'invalid-argument' });
        },
        write: () => null,
    };
    const reply = await execute({ db, operation, actor: ACTOR, requestId: ID, input: { amount: -1 }, classifyRejection });
    assert.equal(reply.status, 'rejected');
    const transient: Operation<FakeTransaction> = {
        name: 'callable',
        parse: () => {
            throw Object.assign(new Error('deadline'), { code: 'deadline-exceeded' });
        },
        write: () => null,
    };
    await assert.rejects(execute({ db, operation: transient, actor: ACTOR, requestId: 'req-0000000000000002', input: {}, classifyRejection }), /deadline/);
    assert.equal(db.read(recordPath(ACTOR, 'req-0000000000000002')), undefined);
});

test('U12 an unreadable record is reported, never treated as success, rejection or absence', async () => {
    const db = new FakeFirestore();
    db.put(recordPath(), completedRecord({}, null, { status: 'weird' as 'completed' }));
    const operation: Operation<FakeTransaction> = { name: 'transfer', write: () => 'ran' };
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: {} }), { code: 'unreadable-record' });
    db.put(recordPath(), completedRecord({}, null, { resultJson: '{not json' }));
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: {} }), { code: 'unreadable-record' });
});

test('U13 errorReply is never terminal and hides unexpected error details', () => {
    const internal = errorReply(new Error('stack-bearing secret detail'), ID);
    assert.deepEqual(internal, {
        requestId: ID,
        status: 'error',
        terminal: false,
        code: 'internal',
        message: 'the outcome of this request is unknown; retry with the same request id',
    });
    assert.equal(errorReply(new LedgerError('content-mismatch', 'm'), ID).terminal, false);
    assert.equal(errorReply(new RequestRejection('permission-denied', 'no'), null).code, 'permission-denied');
});

test('U14 an async write is refused before anything is stored, without an unhandled rejection', async () => {
    const db = new FakeFirestore();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
        const operation: Operation<FakeTransaction> = {
            name: 'async',
            write: (async () => {
                throw new Error('late');
            }) as unknown as Operation<FakeTransaction>['write'],
        };
        await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: {} }), { code: 'async-write' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(unhandled, []);
        assert.equal(db.read(recordPath()), undefined);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('U15 lookup authorises before revealing anything (even absence) and can verify content', async () => {
    const db = new FakeFirestore();
    const seen: Array<string | null> = [];
    await assert.rejects(
        lookup({
            db,
            actor: ACTOR,
            requestId: ID,
            authorize: (_tx, context) => {
                seen.push(context.operation);
                reject('permission-denied', 'no');
            },
        }),
        { code: 'permission-denied' },
    );
    assert.deepEqual(seen, [null]);
    db.put(recordPath(), completedRecord({ amount: 1 }, { id: 'r' }));
    const found = await lookup({ db, actor: ACTOR, requestId: ID, expect: { operation: 'transfer', input: { amount: 1 } } });
    assert.deepEqual(found, { requestId: ID, status: 'completed', result: { id: 'r' }, replayed: true });
    await assert.rejects(lookup({ db, actor: ACTOR, requestId: ID, expect: { operation: 'transfer', input: { amount: 2 } } }), { code: 'content-mismatch' });
    assert.deepEqual(await lookup({ db, actor: 'user-b', requestId: ID }), { requestId: ID, status: 'not-found' });
});

test('U16 a refusal from an attempt the SDK retries does not leak into the final answer', async () => {
    const db = new FakeFirestore();
    let attempt = 0;
    const operation: Operation<FakeTransaction> = {
        name: 'flaky',
        read: () => {
            attempt += 1;
            // Attempt 1: classified as definite, but carries a code the SDK retries.
            if (attempt === 1) throw Object.assign(new Error('refused?'), { code: 14, definite: true });
            // Attempt 2: a plain failure that is not definite.
            throw new Error('still failing');
        },
        write: () => null,
    };
    const classifyRejection = (error: unknown) =>
        (error as { definite?: boolean }).definite ? { code: 'failed-precondition', message: 'refused' } : null;
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: {}, classifyRejection }), /still failing/);
    assert.equal(attempt, 2);
    assert.equal(db.read(recordPath()), undefined, 'no terminal rejection was stored');
});

test('U17 a refusal from a retried attempt is not stored when a later attempt fails before deciding anything', async () => {
    const db = new FakeFirestore();
    const operation: Operation<FakeTransaction> = {
        name: 'flaky',
        read: () => {
            throw Object.assign(new Error('refused?'), { code: 14, definite: true });
        },
        write: () => null,
    };
    db.beforeTransaction = (n) => {
        if (n === 2) throw new Error('could not begin the retry');
    };
    const classifyRejection = (error: unknown) =>
        (error as { definite?: boolean }).definite ? { code: 'failed-precondition', message: 'refused' } : null;
    await assert.rejects(execute({ db, operation, actor: ACTOR, requestId: ID, input: {}, classifyRejection }), /could not begin the retry/);
    assert.equal(db.read(recordPath()), undefined, 'the stale refusal from attempt 1 was not stored');
});
