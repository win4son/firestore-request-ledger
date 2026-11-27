// Real firebase-admin/firestore (default and named databases) against the local Firestore emulator.
// Run through `npm run test:integration` (firebase emulators:exec, project demo-request-ledger).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import type { Firestore as AdminFirestore, Transaction as AdminTransaction } from 'firebase-admin/firestore';
import {
    LedgerError,
    execute,
    lookup,
    reject,
    requestDocId,
} from '../../src/server/index.ts';
import type { Operation } from '../../src/server/index.ts';
import { emulatorConfig, uniqueName, uniqueRequestId } from '../helpers/emulator.ts';

const { projectId } = emulatorConfig();
const app = initializeApp({ projectId }, uniqueName('admin_app'));
const defaultDb = getFirestore(app);
const namedDb = getFirestore(app, 'ledger-named-db');

after(async () => {
    try {
        await Promise.allSettled([defaultDb.terminate(), namedDb.terminate()]);
    } finally {
        await deleteApp(app);
    }
});

interface CreditInput {
    amount: number;
}

interface CreditResult {
    balance: number;
}

function createCreditOperation(
    db: AdminFirestore,
    accountsCollection: string,
    onWrite: () => void,
): Operation<AdminTransaction, CreditInput, { balance: number }, CreditResult> {
    return {
        name: 'credit',
        parse(input) {
            const amount = (input as { amount?: unknown } | null)?.amount;
            if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
                reject('invalid-argument', 'amount must be a positive integer');
            }
            return { amount };
        },
        async read(tx, { actor }) {
            const snap = await tx.get(db.collection(accountsCollection).doc(actor));
            return { balance: Number(snap.data()?.balance ?? 0) };
        },
        write(tx, { actor, requestId, payload }, { balance }) {
            onWrite();
            const next = balance + payload.amount;
            const accountRef = db.collection(accountsCollection).doc(actor);
            tx.set(accountRef, { balance: next }, { merge: true });
            tx.set(accountRef.collection('entries').doc(requestId), { amount: payload.amount });
            return { balance: next };
        },
    };
}

test('S17 firebase-admin/firestore default database: execute, replay, content check, terminal rejection and lookup', async () => {
    const ns = uniqueName('admin_default');
    const ledger = `${ns}_ledger`;
    const accounts = `${ns}_accounts`;
    const actor = 'admin-user-1';

    let writes = 0;
    const operation = createCreditOperation(defaultDb, accounts, () => {
        writes += 1;
    });

    const reqId = uniqueRequestId('s17-ok');
    const first = await execute({
        db: defaultDb,
        operation,
        actor,
        requestId: reqId,
        input: { amount: 150 },
        collection: ledger,
        timestamp: () => FieldValue.serverTimestamp(),
    });
    assert.deepEqual(first, {
        status: 'completed',
        requestId: reqId,
        result: { balance: 150 },
        replayed: false,
    });
    assert.equal(writes, 1);

    // Same requestId and input replays without re-running write()
    const replay = await execute({
        db: defaultDb,
        operation,
        actor,
        requestId: reqId,
        input: { amount: 150 },
        collection: ledger,
        timestamp: () => FieldValue.serverTimestamp(),
    });
    assert.deepEqual(replay, {
        status: 'completed',
        requestId: reqId,
        result: { balance: 150 },
        replayed: true,
    });
    assert.equal(writes, 1);

    // Different input under the same requestId is refused with content-mismatch (non-terminal)
    await assert.rejects(
        () => execute({
            db: defaultDb,
            operation,
            actor,
            requestId: reqId,
            input: { amount: 200 },
            collection: ledger,
        }),
        (err: unknown) => err instanceof LedgerError && err.code === 'content-mismatch' && err.terminal === false,
    );

    // lookup() with authorize and expect returns the stored completed outcome
    let authorized = false;
    const found = await lookup({
        db: defaultDb,
        actor,
        requestId: reqId,
        collection: ledger,
        expect: { operation: 'credit', input: { amount: 150 } },
        authorize(_tx, ctx) {
            authorized = ctx.actor === actor && ctx.operation === 'credit';
        },
    });
    assert.equal(authorized, true);
    assert.deepEqual(found, {
        status: 'completed',
        requestId: reqId,
        result: { balance: 150 },
        replayed: true,
    });

    // Terminal rejection is stored and replayed without touching account balance
    const badReqId = uniqueRequestId('s17-rej');
    const rejectedFirst = await execute({
        db: defaultDb,
        operation,
        actor,
        requestId: badReqId,
        input: { amount: 0 },
        collection: ledger,
        timestamp: () => FieldValue.serverTimestamp(),
    });
    assert.equal(rejectedFirst.status, 'rejected');
    assert.equal(rejectedFirst.terminal, true);
    assert.equal(rejectedFirst.replayed, false);
    assert.equal(rejectedFirst.code, 'invalid-argument');

    const rejectedReplay = await execute({
        db: defaultDb,
        operation,
        actor,
        requestId: badReqId,
        input: { amount: 0 },
        collection: ledger,
    });
    assert.deepEqual(rejectedReplay, { ...rejectedFirst, replayed: true });

    const accountSnap = await defaultDb.collection(accounts).doc(actor).get();
    assert.equal(accountSnap.data()?.balance, 150);
});

test('S18 firebase-admin/firestore named database executes and replays in isolation from (default)', async () => {
    const ns = uniqueName('admin_named');
    const ledger = `${ns}_ledger`;
    const accounts = `${ns}_accounts`;
    const actor = 'admin-user-named';
    const sharedRequestId = uniqueRequestId('s18-iso');

    let namedWrites = 0;
    let defaultWrites = 0;
    const namedOp = createCreditOperation(namedDb, accounts, () => {
        namedWrites += 1;
    });
    const defaultOp = createCreditOperation(defaultDb, accounts, () => {
        defaultWrites += 1;
    });

    // 1. Execute and replay against the named database
    const firstNamed = await execute({
        db: namedDb,
        operation: namedOp,
        actor,
        requestId: sharedRequestId,
        input: { amount: 40 },
        collection: ledger,
        timestamp: () => FieldValue.serverTimestamp(),
    });
    assert.deepEqual(firstNamed, {
        status: 'completed',
        requestId: sharedRequestId,
        result: { balance: 40 },
        replayed: false,
    });

    const replayNamed = await execute({
        db: namedDb,
        operation: namedOp,
        actor,
        requestId: sharedRequestId,
        input: { amount: 40 },
        collection: ledger,
    });
    assert.deepEqual(replayNamed, {
        status: 'completed',
        requestId: sharedRequestId,
        result: { balance: 40 },
        replayed: true,
    });
    assert.equal(namedWrites, 1);

    // 2. Verify (default) database does not see the named database's ledger record
    const defaultLookupBefore = await lookup({
        db: defaultDb,
        actor,
        requestId: sharedRequestId,
        collection: ledger,
    });
    assert.deepEqual(defaultLookupBefore, { status: 'not-found', requestId: sharedRequestId });

    const defaultLedgerDoc = await defaultDb.collection(ledger).doc(requestDocId(actor, sharedRequestId)).get();
    assert.equal(defaultLedgerDoc.exists, false);

    // 3. Same (actor, requestId) with different content succeeds independently in (default)
    const firstDefault = await execute({
        db: defaultDb,
        operation: defaultOp,
        actor,
        requestId: sharedRequestId,
        input: { amount: 90 },
        collection: ledger,
        timestamp: () => FieldValue.serverTimestamp(),
    });
    assert.deepEqual(firstDefault, {
        status: 'completed',
        requestId: sharedRequestId,
        result: { balance: 90 },
        replayed: false,
    });
    assert.equal(defaultWrites, 1);

    // 4. Both databases retain their own ledger outcome and account balance
    const namedLookupAfter = await lookup({
        db: namedDb,
        actor,
        requestId: sharedRequestId,
        collection: ledger,
        expect: { operation: 'credit', input: { amount: 40 } },
    });
    assert.deepEqual(namedLookupAfter, {
        status: 'completed',
        requestId: sharedRequestId,
        result: { balance: 40 },
        replayed: true,
    });

    const namedBalance = (await namedDb.collection(accounts).doc(actor).get()).data()?.balance;
    const defaultBalance = (await defaultDb.collection(accounts).doc(actor).get()).data()?.balance;
    assert.equal(namedBalance, 40);
    assert.equal(defaultBalance, 90);
});
