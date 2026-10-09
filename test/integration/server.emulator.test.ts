// Real @google-cloud/firestore transactions against the local Firestore emulator.
// Run through `npm run test:integration` (firebase emulators:exec, project demo-request-ledger).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import {
    LedgerError,
    RequestRejection,
    execute,
    lookup,
    reject,
    requestDocId,
} from '../../src/server/index.ts';
import type { FirestoreLike, LedgerReply, Operation } from '../../src/server/index.ts';
import { emulatorFirestore, emulatorRestBase, uniqueName, uniqueRequestId } from '../helpers/emulator.ts';

const db = emulatorFirestore();
after(async () => {
    await db.terminate();
});

interface Deposit {
    account: string;
    amount: number;
}
interface DepositResult {
    balance: number;
    entryId: string;
}

/** A fresh namespace per test: ledger, accounts, permissions and history collections. */
async function setup(options: { balance?: number; actors?: string[] } = {}) {
    const ns = uniqueName('t');
    const names = { ledger: `${ns}_ledger`, accounts: `${ns}_accounts`, perms: `${ns}_perms`, history: `${ns}_history` };
    await db.collection(names.accounts).doc('acct-1').set({ balance: options.balance ?? 0 });
    for (const actor of options.actors ?? ['user-a']) {
        await db.collection(names.perms).doc(actor).set({ canDeposit: true });
    }
    let readFailures = 0;
    const operation: Operation<Transaction, Deposit, { balance: number }, DepositResult> = {
        name: 'deposit',
        parse(input) {
            const value = (input ?? {}) as Partial<Deposit>;
            if (typeof value.account !== 'string' || value.account.length === 0 || value.account.includes('/')) {
                reject('invalid-argument', 'account is required');
            }
            if (!Number.isSafeInteger(value.amount) || (value.amount as number) <= 0) {
                reject('invalid-argument', 'amount must be a positive integer');
            }
            return { account: value.account as string, amount: value.amount as number };
        },
        async authorize(transaction, context) {
            const permission = await transaction.get(db.collection(names.perms).doc(context.actor));
            if (permission.data()?.canDeposit !== true) reject('permission-denied', 'not allowed to deposit');
        },
        async read(transaction, context) {
            if (readFailures > 0) {
                readFailures -= 1;
                throw new Error('transient read failure (test)');
            }
            const account = await transaction.get(db.collection(names.accounts).doc(context.payload.account));
            if (!account.exists) reject('not-found', 'no such account');
            return { balance: account.data()?.balance as number };
        },
        write(transaction, context, state) {
            const balance = state.balance + context.payload.amount;
            transaction.update(db.collection(names.accounts).doc(context.payload.account), { balance });
            transaction.set(db.collection(names.history).doc(context.requestId), {
                actor: context.actor,
                account: context.payload.account,
                amount: context.payload.amount,
            });
            if (balance > 1000) reject('failed-precondition', 'balance limit exceeded'); // after staging writes on purpose
            return { balance, entryId: context.requestId };
        },
    };
    const run = (actor: string, requestId: string, input: unknown, op = operation, firestore: FirestoreLike<Transaction> = db) =>
        execute({ db: firestore, operation: op, actor, requestId, input, collection: names.ledger });
    const balance = async (): Promise<number> => (await db.collection(names.accounts).doc('acct-1').get()).data()?.balance as number;
    const count = async (collection: string): Promise<number> => (await db.collection(collection).count().get()).data().count;
    const record = async (actor: string, requestId: string) =>
        (await db.collection(names.ledger).doc(requestDocId(actor, requestId)).get()).data();
    return {
        names,
        operation,
        run,
        balance,
        count,
        record,
        failNextReads(n: number) {
            readFailures = n;
        },
        setPermission: (actor: string, allowed: boolean) => db.collection(names.perms).doc(actor).set({ canDeposit: allowed }),
    };
}

test('S01 first execution: completed, business write and ledger record commit together; the reply equals what is stored', async () => {
    const t = await setup();
    const id = uniqueRequestId('s01');
    const reply = await t.run('user-a', id, { account: 'acct-1', amount: 100 });
    assert.deepEqual(reply, { requestId: id, status: 'completed', result: { balance: 100, entryId: id }, replayed: false });
    assert.equal(await t.balance(), 100);
    assert.equal(await t.count(t.names.history), 1);
    const stored = await t.record('user-a', id);
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.actor, 'user-a');
    assert.equal(stored?.requestId, id);
    assert.equal(stored?.operation, 'deposit');
    assert.match(String(stored?.fingerprint), /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(String(stored?.resultJson)), reply.status === 'completed' ? reply.result : null);
    assert.equal(stored?.input, undefined, 'the input itself is not stored');
});

test('S02 response lost, same id and content resent: the stored result is replayed and nothing is written twice', async () => {
    const t = await setup();
    const id = uniqueRequestId('s02');
    const first = await t.run('user-a', id, { account: 'acct-1', amount: 100 });
    // (pretend `first` never reached the client)
    const second = await t.run('user-a', id, { account: 'acct-1', amount: 100 });
    assert.equal(second.replayed, true);
    assert.deepEqual(second.status === 'completed' && second.result, first.status === 'completed' && first.result);
    assert.equal(await t.balance(), 100);
    assert.equal(await t.count(t.names.history), 1);
    assert.equal(await t.count(t.names.ledger), 1);
});

test('S03 the same request sent five times concurrently executes exactly once', async () => {
    const t = await setup();
    const id = uniqueRequestId('s03');
    // Under load the emulator can end a contended transaction with a non-definite error
    // (seen once: "INVALID_ARGUMENT: Transaction is invalid or closed"). A non-definite error
    // leaves the id open, and the documented recovery is to resend the same request, so each
    // sender does exactly that. Definite answers and ledger errors are never retried here.
    let resends = 0;
    const send = async (): Promise<LedgerReply<DepositResult>> => {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await t.run('user-a', id, { account: 'acct-1', amount: 10 });
            } catch (error) {
                if (attempt >= 3 || error instanceof RequestRejection || error instanceof LedgerError) throw error;
                resends += 1;
            }
        }
    };
    const replies = await Promise.all(Array.from({ length: 5 }, send));
    // Exactly one execution: the business write and the history entry happened once.
    // Without resends exactly one reply is the first execution. A resend after a lost commit
    // reply is answered as a replay, so with resends at most one reply can be first.
    const firsts = replies.filter((reply) => !reply.replayed).length;
    if (resends === 0) assert.equal(firsts, 1);
    else assert.ok(firsts <= 1, `resends=${resends} firsts=${firsts}`);
    for (const reply of replies) assert.deepEqual(reply.status === 'completed' && reply.result, { balance: 10, entryId: id });
    assert.equal(await t.balance(), 10);
    assert.equal(await t.count(t.names.history), 1);
    assert.equal(await t.count(t.names.ledger), 1);
});

test('S04 same id, different content: content-mismatch (not terminal), nothing written; the original still replays', async () => {
    const t = await setup();
    const id = uniqueRequestId('s04');
    await t.run('user-a', id, { account: 'acct-1', amount: 100 });
    const before = await t.record('user-a', id);
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 700 }), (error: unknown) =>
        error instanceof LedgerError && error.code === 'content-mismatch' && error.terminal === false);
    assert.equal(await t.balance(), 100);
    assert.deepEqual(await t.record('user-a', id), before);
    const again = await t.run('user-a', id, { account: 'acct-1', amount: 100 });
    assert.equal(again.status === 'completed' && again.replayed, true);
});

test('S05 the full request is compared, not only the payload: same input under another operation name is a mismatch', async () => {
    const t = await setup();
    const id = uniqueRequestId('s05');
    await t.run('user-a', id, { account: 'acct-1', amount: 5 });
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 5 }, { ...t.operation, name: 'deposit-v2' }), { code: 'content-mismatch' });
    assert.equal(await t.balance(), 5);
});

test('S06 object key order does not change the content check', async () => {
    const t = await setup();
    const id = uniqueRequestId('s06');
    await t.run('user-a', id, { account: 'acct-1', amount: 5 });
    const replay = await t.run('user-a', id, { amount: 5, account: 'acct-1' });
    assert.equal(replay.replayed, true);
    assert.equal(await t.balance(), 5);
});

test('S07 two actors using the same request id get independent requests', async () => {
    const t = await setup({ actors: ['user-a', 'user-b'] });
    const id = uniqueRequestId('s07');
    const a = await t.run('user-a', id, { account: 'acct-1', amount: 1 });
    const b = await t.run('user-b', id, { account: 'acct-1', amount: 1 });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, false);
    assert.equal(await t.balance(), 2);
    assert.equal(await t.count(t.names.ledger), 2);
});

test('S08 invalid input: a stored terminal rejection, replayed for the same content; other content under that id is a mismatch', async () => {
    const t = await setup();
    const id = uniqueRequestId('s08');
    const first = await t.run('user-a', id, { account: 'acct-1', amount: 0 });
    assert.deepEqual(first, {
        requestId: id,
        status: 'rejected',
        terminal: true,
        code: 'invalid-argument',
        message: 'amount must be a positive integer',
        replayed: false,
    });
    const second = await t.run('user-a', id, { account: 'acct-1', amount: 0 });
    assert.deepEqual(second, { ...first, replayed: true });
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 5 }), { code: 'content-mismatch' });
    assert.equal(await t.balance(), 0);
    assert.equal(await t.count(t.names.history), 0);
    assert.equal((await t.record('user-a', id))?.status, 'rejected');
});

test('S09 a refusal raised after writes were staged commits none of them', async () => {
    const t = await setup({ balance: 990 });
    const id = uniqueRequestId('s09');
    const reply = await t.run('user-a', id, { account: 'acct-1', amount: 50 });
    assert.equal(reply.status, 'rejected');
    assert.equal(reply.status === 'rejected' && reply.code, 'failed-precondition');
    assert.equal(await t.balance(), 990);
    assert.equal(await t.count(t.names.history), 0);
});

test('S10 a non-definite error leaves no record (not terminal); the same id later succeeds once', async () => {
    const t = await setup();
    const id = uniqueRequestId('s10');
    t.failNextReads(1);
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 3 }), /transient read failure/);
    assert.equal(await t.record('user-a', id), undefined);
    const later = await t.run('user-a', id, { account: 'acct-1', amount: 3 });
    assert.equal(later.status === 'completed' && later.replayed, false);
    assert.equal(await t.balance(), 3);
});

test('S11 permission revoked after success: the replay is refused without a stored or terminal answer; nothing re-executes', async () => {
    const t = await setup();
    const id = uniqueRequestId('s11');
    await t.run('user-a', id, { account: 'acct-1', amount: 40 });
    await t.setPermission('user-a', false);
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 40 }), (error: unknown) =>
        error instanceof RequestRejection && error.code === 'permission-denied');
    assert.equal((await t.record('user-a', id))?.status, 'completed', 'the stored success is untouched');
    await t.setPermission('user-a', true);
    const replay = await t.run('user-a', id, { account: 'acct-1', amount: 40 });
    assert.deepEqual(replay, { requestId: id, status: 'completed', result: { balance: 40, entryId: id }, replayed: true });
    assert.equal(await t.balance(), 40);
});

test('S12 permission refused on a fresh id: stored as terminal; restoring permission does not reopen that id', async () => {
    const t = await setup();
    await t.setPermission('user-a', false);
    const id = uniqueRequestId('s12');
    const refused = await t.run('user-a', id, { account: 'acct-1', amount: 1 });
    assert.equal(refused.status === 'rejected' && refused.code, 'permission-denied');
    await t.setPermission('user-a', true);
    const again = await t.run('user-a', id, { account: 'acct-1', amount: 1 });
    assert.deepEqual(again, { ...refused, replayed: true });
    assert.equal(await t.balance(), 0);
});

test('S13 race: a retry is refused, but the original with the same id commits before the refusal is stored; the success wins', async () => {
    const t = await setup();
    const id = uniqueRequestId('s13');
    const input = { account: 'acct-2', amount: 7 }; // acct-2 does not exist yet: the retry's read refuses
    let calls = 0;
    // Same Firestore, but the moment the retry starts storing its refusal (its second
    // transaction), the original request -- which sees the account -- runs to completion first.
    const interleaving: FirestoreLike<Transaction> = {
        collection: (path) => db.collection(path),
        runTransaction: async <T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> => {
            calls += 1;
            if (calls === 2) {
                await db.collection(t.names.accounts).doc('acct-2').set({ balance: 0 });
                const original = await t.run('user-a', id, input);
                assert.equal(original.status === 'completed' && original.replayed, false);
            }
            return db.runTransaction(fn);
        },
    };
    const retry: LedgerReply<DepositResult> = await t.run('user-a', id, input, t.operation, interleaving);
    assert.deepEqual(retry, { requestId: id, status: 'completed', result: { balance: 7, entryId: id }, replayed: true });
    assert.equal((await t.record('user-a', id))?.status, 'completed');
    assert.equal(await t.count(t.names.history), 1);
});

test('S14 an oversized result is refused before anything commits (not terminal, no record)', async () => {
    const t = await setup();
    const id = uniqueRequestId('s14');
    const op: Operation<Transaction, Deposit, { balance: number }, unknown> = {
        ...t.operation,
        write: (transaction, context, state) => {
            t.operation.write(transaction, context, state);
            return { blob: 'x'.repeat(20_000) };
        },
    };
    await assert.rejects(t.run('user-a', id, { account: 'acct-1', amount: 1 }, op as typeof t.operation), { code: 'invalid-result' });
    assert.equal(await t.balance(), 0);
    assert.equal(await t.record('user-a', id), undefined);
});

test('S15 lookup reports completed / rejected / not-found, verifies content, is actor-scoped and writes nothing', async () => {
    const t = await setup();
    const done = uniqueRequestId('s15a');
    const refused = uniqueRequestId('s15b');
    await t.run('user-a', done, { account: 'acct-1', amount: 2 });
    await t.run('user-a', refused, { account: 'acct-1', amount: -1 });
    const ledgerBefore = await t.count(t.names.ledger);
    const options = { db, collection: t.names.ledger };
    assert.deepEqual(await lookup({ ...options, actor: 'user-a', requestId: done }), {
        requestId: done,
        status: 'completed',
        result: { balance: 2, entryId: done },
        replayed: true,
    });
    assert.equal((await lookup({ ...options, actor: 'user-a', requestId: refused })).status, 'rejected');
    assert.deepEqual(await lookup({ ...options, actor: 'user-a', requestId: uniqueRequestId('none') }).then((r) => r.status), 'not-found');
    assert.equal((await lookup({ ...options, actor: 'user-b', requestId: done })).status, 'not-found');
    await assert.rejects(
        lookup({ ...options, actor: 'user-a', requestId: done, expect: { operation: 'deposit', input: { account: 'acct-1', amount: 3 } } }),
        { code: 'content-mismatch' },
    );
    assert.equal(
        (await lookup({ ...options, actor: 'user-a', requestId: done, expect: { operation: 'deposit', input: { amount: 2, account: 'acct-1' } } })).status,
        'completed',
    );
    assert.equal(await t.count(t.names.ledger), ledgerBefore);
    assert.equal(await t.balance(), 2);
});

test('S16 the shipped rules deny client SDK access to ledger records (owner access is the control)', async () => {
    const t = await setup();
    const id = uniqueRequestId('s16');
    await t.run('user-a', id, { account: 'acct-1', amount: 1 });
    const url = `${emulatorRestBase()}/${t.names.ledger}/${requestDocId('user-a', id)}`;
    const anonymousRead = await fetch(url);
    assert.equal(anonymousRead.status, 403);
    const anonymousWrite = await fetch(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { status: { stringValue: 'completed' } } }),
    });
    assert.equal(anonymousWrite.status, 403);
    const ownerRead = await fetch(url, { headers: { authorization: 'Bearer owner' } });
    assert.equal(ownerRead.status, 200);
    assert.equal((await t.record('user-a', id))?.status, 'completed');
});

// Type-level check: the real SDK's Firestore satisfies the structural interface.
const typeCheck: FirestoreLike<Transaction> = db satisfies Firestore;
void typeCheck;
