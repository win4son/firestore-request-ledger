// Drives the example's API server and browser transport through the real tracker,
// against the local Firestore emulator: normal success, lost response, recovery.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { NotSentError, createRequestTracker } from '../../src/client/index.ts';
import { createDemoApp } from '../../example/server.ts';
import { NO_FAULTS, createDemoApi } from '../../example/src/api.ts';
import type { Faults } from '../../example/src/api.ts';
import { emulatorFirestore, uniqueName } from '../helpers/emulator.ts';
import { MemoryBrowser } from '../helpers/memory-browser.ts';

const db = emulatorFirestore();
const app = createDemoApp(db, { prefix: uniqueName('example') });
const server = createServer(app.handler);
let baseUrl = '';
let nextFaults: Faults = NO_FAULTS;

before(async () => {
    await app.ensureAccounts();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.terminate();
});

function demoClient(actor = 'demo-user-a') {
    const api = createDemoApi({
        actor,
        baseUrl,
        takeFaults: () => {
            const taken = nextFaults;
            nextFaults = NO_FAULTS;
            return taken;
        },
    });
    const browser = new MemoryBrowser();
    const tracker = createRequestTracker({ actor, namespace: 'frl-demo', storage: browser.tab().storage, locks: null, crossTab: null });
    const submit = (amount: number) => tracker.submit({ slot: 'add-points', operation: 'addPoints', input: { amount, note: 'synthetic' }, send: api.send });
    return { api, tracker, browser, submit };
}

test('E1 normal success: completed, balance and committed entries go up by one request', async () => {
    const { api, submit } = demoClient();
    const before = await api.account();
    const outcome = await submit(5);
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.status === 'completed' && outcome.replayed, false);
    const afterwards = await api.account();
    assert.equal(afterwards.balance, before.balance + 5);
    assert.equal(afterwards.entries, before.entries + 1);
});

test('E2 lost response: unknown in the browser although the server committed; check() recovers the stored result', async () => {
    const { api, tracker, submit } = demoClient();
    const before = await api.account();
    nextFaults = { dropResponse: true, deny: false };
    const lost = await submit(7);
    assert.equal(lost.status, 'unconfirmed');
    assert.equal((await api.account()).balance, before.balance + 7, 'the server did commit');
    const checked = await tracker.check(lost.requestId, { lookup: api.lookup });
    assert.equal(checked.status, 'completed');
    assert.equal(checked.status === 'completed' && checked.replayed, true);
    const afterwards = await api.account();
    assert.equal(afterwards.balance, before.balance + 7);
    assert.equal(afterwards.entries, before.entries + 1);
});

test('E3 lost response, then retry with the same id: replayed, applied once', async () => {
    const { api, tracker, submit } = demoClient();
    const before = await api.account();
    nextFaults = { dropResponse: true, deny: false };
    const lost = await submit(3);
    assert.equal(lost.status, 'unconfirmed');
    const retried = await tracker.retry(lost.requestId, { send: api.send });
    assert.deepEqual(retried.status === 'completed' && [retried.replayed, retried.requestId], [true, lost.requestId]);
    const afterwards = await api.account();
    assert.equal(afterwards.balance, before.balance + 3);
    assert.equal(afterwards.entries, before.entries + 1);
});

test('E4 a refused retry keeps the request unconfirmed, different content waits, and a later retry still replays', async () => {
    const { api, tracker, submit } = demoClient();
    const before = await api.account();
    nextFaults = { dropResponse: true, deny: false };
    const lost = await submit(4);
    nextFaults = { dropResponse: false, deny: true };
    const refused = await tracker.retry(lost.requestId, { send: api.send });
    assert.equal(refused.status, 'unconfirmed');
    assert.equal(refused.status === 'unconfirmed' && refused.error?.code, 'permission-denied');
    assert.equal(tracker.get(lost.requestId)?.state, 'unconfirmed');
    await assert.rejects(submit(9), (error: unknown) => error instanceof NotSentError && error.reason === 'slot-busy');
    const recovered = await tracker.retry(lost.requestId, { send: api.send });
    assert.equal(recovered.status === 'completed' && recovered.replayed, true);
    assert.equal((await api.account()).balance, before.balance + 4);
});

test('E5 invalid input is a terminal rejection: nothing written, and the slot is free again', async () => {
    const { api, submit } = demoClient('demo-user-b');
    const before = await api.account();
    const refused = await submit(0);
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.status === 'rejected' && refused.code, 'invalid-argument');
    assert.deepEqual(await api.account(), before);
    const next = await submit(2);
    assert.equal(next.status, 'completed');
});

test('E6 lost response, then another tab cannot read the old request: it refuses to create a new one; the server ran once', async () => {
    const { api, browser, submit } = demoClient();
    const before = await api.account();
    nextFaults = { dropResponse: true, deny: false };
    const lost = await submit(9);
    assert.equal(lost.status, 'unconfirmed');
    assert.equal((await api.account()).balance, before.balance + 9, 'the first request committed');
    // Another tab of the same browser profile whose read of the old request fails.
    const base = browser.tab().storage;
    let reads = true;
    const storage = {
        get length() { return base.length; },
        key: (index: number) => base.key(index),
        getItem: (key: string) => { if (reads && key.includes('/entry/') && key.endsWith(`/${lost.requestId}`)) throw new Error('synthetic read failure'); return base.getItem(key); },
        setItem: (key: string, value: string) => base.setItem(key, value),
        removeItem: (key: string) => base.removeItem(key),
    };
    const other = createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo', storage, locks: null, crossTab: null });
    let sent = 0;
    await assert.rejects(
        other.submit({ slot: 'add-points', operation: 'addPoints', input: { amount: 9, note: 'synthetic' }, send: async (request) => { sent += 1; return api.send(request); } }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'storage-unreadable',
    );
    assert.equal(sent, 0);
    reads = false;
    const afterwards = await api.account();
    assert.equal(afterwards.balance, before.balance + 9, 'no second execution');
    assert.equal(afterwards.entries, before.entries + 1);
});

for (const [misses, all] of [[0, false], [1, false], [2, false], [Infinity, false], [Infinity, true]] as const) {
    test(`E7 lost response, then another tab's submit whose ${Number.isFinite(misses) ? misses : 'every'} listing(s) skip the old request${all ? ' (all its records)' : ''} (another tab removes keys meanwhile): same id, the server ran once`, async () => {
        const { api, browser, submit } = demoClient();
        const before = await api.account();
        nextFaults = { dropResponse: true, deny: false };
        const lost = await submit(11);
        assert.equal(lost.status, 'unconfirmed');
        assert.equal((await api.account()).balance, before.balance + 11, 'the first request committed');
        // Unrelated keys sit right before the old request record; another tab removing the one next to it while a
        // listing passes skips that record.
        const target = `frl-demo/v1/entry/demo-user-a/${lost.requestId}`;
        const targets = all ? [...browser.data.keys()].filter((key) => key.endsWith(`/${lost.requestId}`) || key.includes(`/${lost.requestId}/`)) : [target];
        const rows = [...browser.data].filter(([key]) => !key.startsWith('unrelated-'));
        browser.data.clear();
        for (const [key, value] of rows) {
            if (targets.includes(key)) for (let index = 0; index < (Number.isFinite(misses) ? misses : 40); index += 1) browser.data.set(`unrelated-${key}-${index}`, 'x');
            browser.data.set(key, value);
        }
        assert.ok(rows.some(([key]) => key === target), 'precondition: the old request record exists');
        const base = browser.tab().storage;
        let skipped = 0;
        let shown = 0;
        const storage = {
            get length() { return base.length; },
            key: (index: number) => {
                const key = base.key(index);
                if (key && targets.includes(key)) shown += 1;
                const keys = [...browser.data.keys()];
                if (skipped < misses && key?.startsWith('unrelated-') && targets.includes(keys[keys.indexOf(key) + 1] as string)) {
                    browser.data.delete(key);
                    skipped += 1;
                }
                return key;
            },
            getItem: (key: string) => base.getItem(key),
            setItem: (key: string, value: string) => base.setItem(key, value),
            removeItem: (key: string) => base.removeItem(key),
        };
        const other = createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo', storage, locks: null, crossTab: null });
        const again = await other.submit({ slot: 'add-points', operation: 'addPoints', input: { amount: 11, note: 'synthetic' }, send: api.send });
        if (Number.isFinite(misses)) assert.equal(skipped, misses, `precondition: ${misses} listing(s) skipped the old request`);
        else assert.deepEqual([skipped >= 2, shown], [true, 0], 'precondition: no listing showed the old request');
        const afterwards = await api.account();
        assert.deepEqual([afterwards.balance - before.balance, afterwards.entries - before.entries], [11, 1], 'no second execution (balance change, committed entries)');
        assert.equal(again.requestId, lost.requestId, 'the same request id');
        assert.equal(again.status === 'completed' && again.replayed, true, 'replayed, not executed again');
        assert.equal(other.readable(), true);
    });
}

for (const damage of ['one copy', 'both copies'] as const) {
    test(`E8 lost response, the slot record damaged (${damage}), discardBroken(), then a submit whose every listing skips all records of the old request: the server ran once`, async () => {
        const { api, browser, submit, tracker } = demoClient();
        const before = await api.account();
        nextFaults = { dropResponse: true, deny: false };
        const lost = await submit(13);
        assert.equal(lost.status, 'unconfirmed');
        assert.equal((await api.account()).balance, before.balance + 13, 'the first request committed');
        browser.data.set('frl-demo/v1/slot/demo-user-a/add-points', 'synthetic-broken-json');
        if (damage === 'both copies') browser.data.set('frl-demo/v1/slotcopy/demo-user-a/add-points', 'synthetic-broken-json');
        await tracker.discardBroken();
        // Every listing skips every record of the old request (request, attempt and outcome records).
        const targets = [...browser.data.keys()].filter((key) => key.endsWith(`/${lost.requestId}`) || key.includes(`/${lost.requestId}/`));
        const rows = [...browser.data].filter(([key]) => !key.startsWith('unrelated-'));
        browser.data.clear();
        for (const [key, value] of rows) {
            if (targets.includes(key)) for (let index = 0; index < 40; index += 1) browser.data.set(`unrelated-${key}-${index}`, 'x');
            browser.data.set(key, value);
        }
        const base = browser.tab().storage;
        let shown = 0;
        const storage = {
            get length() { return base.length; },
            key: (index: number) => {
                const key = base.key(index);
                if (key && targets.includes(key)) shown += 1;
                const keys = [...browser.data.keys()];
                if (key?.startsWith('unrelated-') && targets.includes(keys[keys.indexOf(key) + 1] as string)) browser.data.delete(key);
                return key;
            },
            getItem: (key: string) => base.getItem(key),
            setItem: (key: string, value: string) => base.setItem(key, value),
            removeItem: (key: string) => base.removeItem(key),
        };
        const other = createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo', storage, locks: null, crossTab: null });
        const again = () => other.submit({ slot: 'add-points', operation: 'addPoints', input: { amount: 13, note: 'synthetic' }, send: api.send });
        if (damage === 'both copies') {
            await assert.rejects(again(), (error: unknown) => error instanceof NotSentError && error.reason === 'broken-slot');
            assert.deepEqual(other.brokenSlots(), ['add-points']);
            assert.deepEqual(await tracker.resetSlot('add-points'), [lost.requestId], 'rebuilt by the app after review');
        }
        const replayed = await again();
        assert.equal(shown, 0, 'precondition: no listing showed the old request');
        const afterwards = await api.account();
        assert.deepEqual([afterwards.balance - before.balance, afterwards.entries - before.entries], [13, 1], 'no second execution (balance change, committed entries)');
        assert.equal(replayed.requestId, lost.requestId, 'the same request id');
        assert.equal(replayed.status === 'completed' && replayed.replayed, true);
    });
}

for (const schedule of ['no cleanup', 'cleanup before submit', 'cleanup right after submit reads the old request', 'cleanup right after submit reads the slot record'] as const) {
    test(`E9 lost response, the request record damaged, another tab's discardBroken() (${schedule}): the server ran once and the slot stays blocked`, async () => {
        const { api, browser, submit } = demoClient();
        const before = await api.account();
        nextFaults = { dropResponse: true, deny: false };
        const lost = await submit(17);
        assert.equal(lost.status, 'unconfirmed');
        const entry = `frl-demo/v1/entry/demo-user-a/${lost.requestId}`;
        browser.data.set(entry, 'synthetic corrupt JSON');
        // No lock keeps the two trackers apart here (locks: null), so the cleanup can run in the middle of the check.
        const cleaner = createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo', storage: browser.tab().storage, locks: null, crossTab: null });
        if (schedule === 'cleanup before submit') assert.equal(await cleaner.discardBroken(), 1);
        const base = browser.tab().storage;
        let cleanup: Promise<number> | null = null;
        const storage = {
            get length() { return base.length; },
            key: (index: number) => base.key(index),
            getItem: (key: string) => {
                const value = base.getItem(key); // this read happens before the other tab's cleanup
                if (schedule === 'cleanup right after submit reads the old request' && key === entry && !cleanup) cleanup = cleaner.discardBroken();
                if (schedule === 'cleanup right after submit reads the slot record' && key.startsWith('frl-demo/v1/slot/') && !cleanup) cleanup = cleaner.discardBroken();
                return value;
            },
            setItem: (key: string, value: string) => base.setItem(key, value),
            removeItem: (key: string) => base.removeItem(key),
        };
        const reader = createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo', storage, locks: null, crossTab: null });
        let refused: string | null = null;
        try {
            await reader.submit({ slot: 'add-points', operation: 'addPoints', input: { amount: 17, note: 'synthetic' }, send: api.send });
        } catch (error) {
            refused = error instanceof NotSentError ? error.reason : String(error);
        }
        if (schedule.startsWith('cleanup right after')) assert.equal(await cleanup, 1, 'precondition: the cleanup ran during the check');
        const afterwards = await api.account();
        assert.deepEqual([afterwards.balance - before.balance, afterwards.entries - before.entries], [17, 1], 'no second execution (balance change, committed entries)');
        assert.ok(refused === 'broken-entries' || refused === 'broken-slot', `refused (${refused})`);
        if (schedule === 'no cleanup') assert.equal(refused, 'broken-entries');
        if (schedule === 'cleanup before submit' || schedule === 'cleanup right after submit reads the slot record') assert.equal(refused, 'broken-slot');
        if (schedule !== 'no cleanup') {
            await assert.rejects(
                reader.submit({ slot: 'add-points', operation: 'addPoints', input: { amount: 17, note: 'synthetic' }, send: api.send }),
                (error: unknown) => error instanceof NotSentError && error.reason === 'broken-slot',
                'the slot stays blocked',
            );
        }
    });
}
