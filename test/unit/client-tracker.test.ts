import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotSentError, createRequestTracker } from '../../src/client/index.ts';
import type { LedgerReply, OutgoingRequest, RequestTrackerOptions, SubmitOutcome } from '../../src/client/index.ts';
import { FakeLocks, MemoryBrowser, deferred, tick } from '../helpers/memory-browser.ts';

/** A server double with the ledger's contract: one execution per request id, replays afterwards. */
class FakeServer {
    readonly records = new Map<string, LedgerReply>();
    readonly received: OutgoingRequest[] = [];
    executions = 0;
    refuse: ((request: OutgoingRequest) => { code: string; message: string } | null) | null = null;

    handle(request: OutgoingRequest): LedgerReply {
        this.received.push(structuredClone(request));
        const stored = this.records.get(request.requestId);
        if (stored) return { ...stored, replayed: true };
        const refusal = this.refuse?.(request) ?? null;
        let reply: LedgerReply;
        if (refusal) {
            reply = { requestId: request.requestId, status: 'rejected', terminal: true, ...refusal, replayed: false };
        } else {
            this.executions += 1;
            reply = { requestId: request.requestId, status: 'completed', result: { execution: this.executions }, replayed: false };
        }
        this.records.set(request.requestId, reply);
        return reply;
    }

    /** Normal round trip. */
    readonly send = async (request: OutgoingRequest): Promise<unknown> => this.handle(request);

    /** The server commits, then the response is lost on the way back. */
    readonly lose = async (request: OutgoingRequest): Promise<unknown> => {
        this.handle(request);
        throw new TypeError('fetch failed');
    };

    readonly lookup = async (request: OutgoingRequest): Promise<unknown> =>
        this.records.get(request.requestId) ?? { requestId: request.requestId, status: 'not-found' };
}

let counter = 0;
const ids = (): string => `req-${String(++counter).padStart(12, '0')}`;

function trackerFor(tab: ReturnType<MemoryBrowser['tab']>, overrides: Partial<RequestTrackerOptions> = {}) {
    return createRequestTracker({ actor: 'user-a', storage: tab.storage, crossTab: tab.crossTab, locks: null, newRequestId: ids, ...overrides });
}

const entryKeys = (browser: MemoryBrowser): string[] => [...browser.data.keys()].filter((key) => key.includes('/entry/'));

const neverSend = async (): Promise<unknown> => {
    throw new Error('send must not be called');
};

test('C01 save before send: the entry is in storage, with an attempt counted, before the network call starts', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    let storedAtSend: unknown = null;
    const outcome = await tracker.submit({
        slot: 'form',
        operation: 'transfer',
        input: { amount: 100 },
        send: async (request) => {
            // What a freshly loaded page would see at this moment (the stored request, read through the tracker)
            storedAtSend = trackerFor(browser.tab()).get(request.requestId);
            return server.send(request);
        },
    });
    assert.equal(outcome.status, 'completed');
    assert.ok(storedAtSend, 'the request was stored before it was sent');
    const stored = storedAtSend as { input: unknown; operation: string; attempts: number; state: string };
    assert.deepEqual(stored.input, { amount: 100 });
    assert.equal(stored.operation, 'transfer');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.state, 'unconfirmed');
});

test('C02 what is sent is the complete stored request (operation + input + id), immune to later caller mutation', async () => {
    const browser = new MemoryBrowser();
    const tab = browser.tab();
    const server = new FakeServer();
    const input = { amount: 100, memo: { note: 'rent' }, when: new Date('2026-01-01T00:00:00Z') };
    const first = await trackerFor(tab).submit({ slot: 'form', operation: 'transfer', input, send: server.lose });
    input.amount = 999;
    input.memo.note = 'changed';
    assert.equal(first.status, 'unconfirmed');
    // Reload: a fresh page (new tab object) on the same browser storage.
    const reloaded = trackerFor(browser.tab());
    const [entry] = reloaded.list();
    assert.ok(entry);
    assert.deepEqual(entry.input, { amount: 100, memo: { note: 'rent' }, when: '2026-01-01T00:00:00.000Z' });
    await reloaded.retry(entry.requestId, { send: server.send });
    assert.equal(server.received.length, 2);
    assert.deepEqual(server.received[1], server.received[0], 'the retry is byte-for-byte the original request');
    assert.deepEqual(server.received[0], { requestId: entry.requestId, operation: 'transfer', input: entry.input });
});

test('C03 storage refuses the write: NotSentError(storage-unavailable), nothing sent, nothing left behind', async () => {
    const browser = new MemoryBrowser();
    browser.failWrite = () => true;
    const tracker = trackerFor(browser.tab());
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'storage-unavailable',
    );
    browser.failWrite = null;
    assert.deepEqual(tracker.list(), []);
    assert.equal(browser.data.size, 0);
});

test('C04 no storage at all: nothing can be sent', async () => {
    const tracker = createRequestTracker({ actor: 'user-a', storage: null, locks: null, crossTab: null });
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'storage-unavailable',
    );
    assert.equal(tracker.durable(), false);
});

test('C05 response lost: kept as unconfirmed across a reload; same-id retry replays, the server ran once', async () => {
    const browser = new MemoryBrowser();
    const server = new FakeServer();
    const lost = await trackerFor(browser.tab()).submit({ slot: 'form', operation: 'transfer', input: { amount: 5 }, send: server.lose });
    assert.equal(lost.status, 'unconfirmed');
    assert.equal(server.executions, 1, 'the server did commit');

    const reloaded = trackerFor(browser.tab());
    const [entry] = reloaded.list();
    assert.equal(entry?.state, 'unconfirmed');
    assert.equal(entry?.lastError?.code, 'TypeError');
    const retried = await reloaded.retry(entry!.requestId, { send: server.send });
    assert.deepEqual(retried, { status: 'completed', requestId: entry!.requestId, result: { execution: 1 }, replayed: true });
    assert.equal(server.executions, 1);
});

test('C06 check(): completed settles; not-found and a refused lookup keep the request unconfirmed', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const pending = await tracker.submit({
        slot: 'form',
        operation: 'transfer',
        input: { amount: 1 },
        send: async () => {
            throw new TypeError('fetch failed'); // never reached the server
        },
    });
    const requestId = pending.requestId;
    const notFound = await tracker.check(requestId, { lookup: server.lookup });
    assert.equal(notFound.status, 'unconfirmed');
    assert.equal(notFound.status === 'unconfirmed' && notFound.error?.code, 'not-found');
    const refused = await tracker.check(requestId, {
        lookup: async () => ({ requestId, status: 'error', terminal: false, code: 'permission-denied', message: 'signed out' }),
    });
    assert.equal(refused.status, 'unconfirmed');
    assert.equal(tracker.get(requestId)?.state, 'unconfirmed');
    // Now the request reaches the server through a retry whose response is lost; check() finds it.
    await tracker.retry(requestId, { send: server.lose });
    const found = await tracker.check(requestId, { lookup: server.lookup });
    assert.equal(found.status, 'completed');
    assert.equal(tracker.get(requestId)?.state, 'completed');
});

test('C07 a retry refused by sign-in or permission keeps the request; it does not imply the first attempt failed', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const lost = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 7 }, send: server.lose });
    const requestId = lost.requestId;
    const thrown = await tracker.retry(requestId, {
        send: async () => {
            throw Object.assign(new Error('HTTP 401'), { code: 'unauthenticated' });
        },
    });
    assert.equal(thrown.status, 'unconfirmed');
    const replied = await tracker.retry(requestId, {
        send: async () => ({ requestId, status: 'error', terminal: false, code: 'permission-denied', message: 'no access' }),
    });
    assert.equal(replied.status, 'unconfirmed');
    // A rejection-shaped body without terminal:true must not settle either.
    const notTerminal = await tracker.retry(requestId, {
        send: async () => ({ requestId, status: 'rejected', code: 'permission-denied', message: 'no', replayed: false }),
    });
    assert.equal(notTerminal.status, 'unconfirmed');
    const entry = tracker.get(requestId);
    assert.equal(entry?.state, 'unconfirmed');
    assert.equal(entry?.attempts, 4);
    assert.equal(entry?.lastError?.code, 'permission-denied', 'the non-settling reply is kept for display only');
    const finalOutcome = await tracker.retry(requestId, { send: server.send });
    assert.equal(finalOutcome.status, 'completed');
    assert.equal(server.executions, 1);
});

test('C08 a terminal rejection for this id settles it; the slot is free for new content; acknowledge forgets it', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    server.refuse = (request) => ((request.input as { amount: number }).amount > 10 ? { code: 'failed-precondition', message: 'too much' } : null);
    const refused = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 50 }, send: server.send });
    assert.deepEqual(refused, { status: 'rejected', requestId: refused.requestId, code: 'failed-precondition', message: 'too much' });
    assert.equal(tracker.get(refused.requestId)?.state, 'rejected');
    const next = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 5 }, send: server.send });
    assert.equal(next.status, 'completed');
    assert.notEqual(next.requestId, refused.requestId);
    assert.equal(tracker.acknowledge(refused.requestId), true);
    assert.equal(tracker.get(refused.requestId), null);
});

test('C09 a terminal-looking reply for another request id does not settle this one', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const outcome = await tracker.submit({
        slot: 'form',
        operation: 'transfer',
        input: {},
        send: async () => ({ requestId: 'someone-else-0001', status: 'rejected', terminal: true, code: 'not-found', message: 'x', replayed: false }),
    });
    assert.equal(outcome.status, 'unconfirmed');
    assert.equal(tracker.get(outcome.requestId)?.state, 'unconfirmed');
});

test('C10 late network error after another tab confirmed the result: stays completed, and the late call reports completed', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const server = new FakeServer();
    const slow = deferred<unknown>();
    const original = tab1.submit({ slot: 'form', operation: 'transfer', input: { amount: 3 }, send: () => slow.promise });
    await tick();
    const [entry] = tab2.list();
    assert.ok(entry);
    const retried = await tab2.retry(entry.requestId, { send: server.send });
    assert.equal(retried.status, 'completed');
    slow.reject(new TypeError('fetch failed')); // the original attempt times out afterwards
    const late = await original;
    assert.equal(late.status, 'completed');
    assert.equal(tab1.get(entry.requestId)?.state, 'completed');
    assert.equal(tab2.get(entry.requestId)?.state, 'completed');
});

test('C11 late success after the result was acknowledged (or discarded): the request does not come back', async () => {
    for (const how of ['acknowledge', 'discard'] as const) {
        const browser = new MemoryBrowser();
        const tab1 = trackerFor(browser.tab());
        const tab2 = trackerFor(browser.tab());
        const server = new FakeServer();
        const slow = deferred<unknown>();
        const original = tab1.submit({ slot: 'form', operation: 'transfer', input: { amount: 3 }, send: () => slow.promise });
        await tick();
        const [entry] = tab2.list();
        assert.ok(entry);
        if (how === 'acknowledge') {
            await tab2.retry(entry.requestId, { send: server.send });
            assert.equal(tab2.acknowledge(entry.requestId), true);
        } else {
            assert.equal(tab2.discard(entry.requestId), true);
        }
        slow.resolve(server.handle({ requestId: entry.requestId, operation: 'transfer', input: { amount: 3 } }));
        const late = await original;
        assert.equal(late.status, 'completed', how);
        assert.deepEqual(tab1.list(), [], `${how}: no resurrection in the late tab`);
        assert.deepEqual(trackerFor(browser.tab()).list(), [], `${how}: nor after a reload`);
        assert.deepEqual(entryKeys(browser), [], `${how}: nor in storage`);
    }
});

test('C12 late unknown after a terminal rejection was acknowledged: nothing comes back', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const slow = deferred<unknown>();
    const original = tab1.submit({ slot: 'form', operation: 'transfer', input: { amount: 3 }, send: () => slow.promise });
    await tick();
    const [entry] = tab2.list();
    assert.ok(entry);
    const rejected = await tab2.retry(entry.requestId, {
        send: async (request) => ({ requestId: request.requestId, status: 'rejected', terminal: true, code: 'invalid-argument', message: 'bad', replayed: false }),
    });
    assert.equal(rejected.status, 'rejected');
    tab2.acknowledge(entry.requestId);
    slow.reject(new TypeError('fetch failed'));
    assert.equal((await original).status, 'unconfirmed');
    assert.deepEqual(tab1.list(), []);
});

test('C13 a late reply never replaces the first settled outcome', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const slow = deferred<unknown>();
    const original = tab1.submit({ slot: 'form', operation: 'transfer', input: {}, send: () => slow.promise });
    await tick();
    const [entry] = tab2.list();
    assert.ok(entry);
    await tab2.retry(entry.requestId, {
        send: async (request) => ({ requestId: request.requestId, status: 'completed', result: 'first', replayed: false }),
    });
    slow.resolve({ requestId: entry.requestId, status: 'rejected', terminal: true, code: 'x', message: 'contradiction', replayed: false });
    const late = await original;
    assert.deepEqual(late, { status: 'completed', requestId: entry.requestId, result: 'first', replayed: false });
    assert.equal(tab1.get(entry.requestId)?.state, 'completed');
});

test('C14 other tabs are notified through the cross-tab port; this tab through its own listeners', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const server = new FakeServer();
    let tab1Calls = 0;
    let tab2Calls = 0;
    const stop1 = tab1.subscribe(() => {
        tab1Calls += 1;
    });
    const stop2 = tab2.subscribe(() => {
        tab2Calls += 1;
    });
    await tab1.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.send });
    await tick();
    assert.ok(tab1Calls > 0);
    assert.ok(tab2Calls > 0);
    assert.equal(tab2.list()[0]?.state, 'completed');
    stop1();
    stop2();
    const before = tab2Calls;
    await tab1.submit({ slot: 'other', operation: 'transfer', input: {}, send: server.send });
    await tick();
    assert.equal(tab2Calls, before, 'unsubscribed listeners are not called');
});

test('C15 storage fails after sending: the result stays visible in this tab, durable() is false, and it is saved once storage recovers', async () => {
    const browser = new MemoryBrowser();
    const tab = browser.tab();
    const tracker = trackerFor(tab);
    const server = new FakeServer();
    let failing = false;
    browser.failWrite = () => failing;
    const outcome = await tracker.submit({
        slot: 'form',
        operation: 'transfer',
        input: { amount: 1 },
        send: async (request) => {
            failing = true; // quota runs out while the request is in flight
            return server.send(request);
        },
    });
    assert.equal(outcome.status, 'completed');
    assert.equal(tracker.get(outcome.requestId)?.state, 'completed', 'visible from memory');
    assert.equal(tracker.durable(), false);
    assert.equal(trackerFor(browser.tab()).get(outcome.requestId)?.state, 'unconfirmed', 'another page still sees the older saved state');
    failing = false;
    assert.equal(tracker.durable(), true, 'flushed on the next operation');
    assert.equal(trackerFor(browser.tab()).get(outcome.requestId)?.state, 'completed');
});

test('C16 a stale unsaved change cannot bring back a request another tab already acknowledged', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const server = new FakeServer();
    const lost = await tab1.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.lose });
    browser.failWrite = () => true;
    await tab1.retry(lost.requestId, {
        send: async () => {
            throw new TypeError('offline');
        },
    }); // tab1 now holds an unsaved "unconfirmed" change in memory
    assert.equal(tab1.durable(), false);
    browser.failWrite = null;
    await tab2.retry(lost.requestId, { send: server.send });
    assert.equal(tab2.acknowledge(lost.requestId), true);
    // tab1 flushes its stale change now; the removal marker wins.
    assert.deepEqual(tab1.list(), []);
    assert.equal(tab1.durable(), true);
    assert.deepEqual(trackerFor(browser.tab()).list(), []);
    assert.deepEqual(entryKeys(browser), [], 'the stale change was not written back to storage');
});

test('C28 a stale unsaved "unconfirmed" change cannot overwrite a result another tab stored meanwhile', async () => {
    const browser = new MemoryBrowser();
    const tab1 = trackerFor(browser.tab());
    const tab2 = trackerFor(browser.tab());
    const server = new FakeServer();
    const lost = await tab1.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.lose });
    browser.failWrite = () => true;
    await tab1.retry(lost.requestId, {
        send: async () => {
            throw new TypeError('offline');
        },
    });
    assert.equal(tab1.durable(), false, 'tab1 holds an unsaved unconfirmed change');
    browser.failWrite = null;
    const done = await tab2.retry(lost.requestId, { send: server.send });
    assert.equal(done.status, 'completed');
    // tab1 flushes now: the stored completed outcome must survive.
    assert.equal(tab1.get(lost.requestId)?.state, 'completed');
    assert.equal(tab1.durable(), true);
    const stored = trackerFor(browser.tab()).get(lost.requestId);   // a freshly loaded page
    assert.equal(stored?.state, 'completed');
    // Each tab counts its own sends in its own record, so no count is lost: submit + tab1 retry + tab2 retry.
    assert.equal(stored?.attempts, 3);
});

test('C17 slot rules: different content waits, same content reuses the id, settled-unacknowledged same content replays locally', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const lost = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: server.lose });
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 2 }, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'slot-busy' && error.pending?.requestId === lost.requestId,
    );
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'refund', input: { amount: 1 }, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'slot-busy',
    );
    const again = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: server.send });
    assert.equal(again.requestId, lost.requestId, 'same content in the same slot reuses the original id');
    assert.equal(server.executions, 1);
    const sentBefore = server.received.length;
    const local = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: neverSend });
    assert.equal(local.requestId, lost.requestId);
    assert.equal(server.received.length, sentBefore, 'answered from storage, not sent again');
    tracker.acknowledge(lost.requestId);
    const fresh = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: server.send });
    assert.notEqual(fresh.requestId, lost.requestId, 'after acknowledging, the same content is a new request');
    assert.equal(server.executions, 2);
    const parallelSlot = await tracker.submit({ slot: 'other-form', operation: 'transfer', input: { amount: 9 }, send: server.send });
    assert.equal(parallelSlot.status, 'completed', 'slots are independent');
});

test('C18 double submit in one tab sends once; both calls get the same outcome', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    let sends = 0;
    const gate = deferred<void>();
    const send = async (request: OutgoingRequest): Promise<unknown> => {
        sends += 1;
        await gate.promise;
        return server.send(request);
    };
    const first = tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send });
    const second = tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send });
    await tick();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(sends, 1);
    assert.deepEqual(a, b);
    assert.equal(tracker.get(a.requestId)?.attempts, 1);
});

test('C19 stillValid: refused before saving, or at the last gate (fresh entry removed, existing entry kept)', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: neverSend, stillValid: () => false }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'aborted',
    );
    assert.deepEqual(tracker.list(), []);

    let calls = 0;
    const flipsAfterLock = (): boolean => {
        calls += 1;
        return calls === 1; // valid while choosing the id, invalid right before sending (e.g. unmounted, user switched)
    };
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: neverSend, stillValid: flipsAfterLock }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'aborted',
    );
    assert.deepEqual(tracker.list(), [], 'a request that never left is not kept');

    const lost = await tracker.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: server.lose });
    await assert.rejects(
        tracker.retry(lost.requestId, { send: neverSend, stillValid: () => false }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'aborted',
    );
    assert.equal(tracker.get(lost.requestId)?.state, 'unconfirmed', 'a request that was already sent is kept');
});

test('C20 trackers are per actor: another user neither sees nor reuses the first user\'s requests', async () => {
    const browser = new MemoryBrowser();
    const tab = browser.tab();
    const userA = trackerFor(tab, { actor: 'user-a' });
    const userB = trackerFor(tab, { actor: 'user-b' });
    const server = new FakeServer();
    const slow = deferred<unknown>();
    const pending = userA.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: () => slow.promise });
    await tick();
    assert.deepEqual(userB.list(), []);
    const own = await userB.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: server.send });
    assert.equal(own.status, 'completed', 'same slot and content, different user: an independent request');
    const [aEntry] = userA.list();
    assert.ok(aEntry);
    assert.notEqual(own.requestId, aEntry.requestId);
    slow.resolve(server.handle({ requestId: aEntry.requestId, operation: 'transfer', input: { amount: 1 } }));
    await pending;
    assert.equal(userA.get(aEntry.requestId)?.state, 'completed');
    assert.equal(userB.get(aEntry.requestId), null);
    assert.deepEqual(userB.list().map((entry) => entry.requestId), [own.requestId]);
});

test('C21 unreadable entries block new submits until they are reviewed and removed', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    browser.data.set('frl/v1/entry/user-a/req-broken-0001', '{"v":1,"requestId":"req-broken-0001"');
    browser.data.set('frl/v1/entry/user-b/req-broken-0002', 'not json'); // another user's: not ours to judge
    assert.equal(tracker.brokenCount(), 1);
    await assert.rejects(
        tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'broken-entries',
    );
    assert.equal(await tracker.discardBroken(), 1);
    assert.equal((await tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.send })).status, 'completed');
    assert.ok(browser.data.has('frl/v1/entry/user-b/req-broken-0002'));
});

test('C22 cross-tab exclusion: the slot decision and the save happen while the lock is held', async () => {
    const browser = new MemoryBrowser();
    const locks = new FakeLocks();
    const tab1 = trackerFor(browser.tab(), { locks });
    const tab2 = trackerFor(browser.tab(), { locks });
    const server = new FakeServer();
    const newEntryWrites: boolean[] = [];
    browser.failWrite = (key, value) => {
        if (value && key.includes('/entry/') && (JSON.parse(value) as { attempts: number }).attempts === 0) {
            newEntryWrites.push(locks.held.size > 0);
        }
        return false;
    };
    const slow = deferred<unknown>();
    const a = tab1.submit({ slot: 'form', operation: 'transfer', input: { amount: 1 }, send: () => slow.promise });
    const b = tab2.submit({ slot: 'form', operation: 'transfer', input: { amount: 2 }, send: neverSend });
    await assert.rejects(b, (error: unknown) => error instanceof NotSentError && error.reason === 'slot-busy');
    slow.resolve(undefined);
    await a;
    assert.deepEqual(newEntryWrites, [true]);
    assert.equal(locks.requests, 2);
    const strict = trackerFor(browser.tab(), { locks: null, requireLocks: true });
    await assert.rejects(
        strict.submit({ slot: 'x', operation: 'transfer', input: {}, send: server.send }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'locks-unavailable',
    );
});

test('C23 removal markers expire after the configured time', async () => {
    const browser = new MemoryBrowser();
    let clock = 1_000_000;
    const tracker = trackerFor(browser.tab(), { now: () => clock, tombstoneTtlMs: 1000 });
    const server = new FakeServer();
    const done = await tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.send });
    tracker.acknowledge(done.requestId);
    const markers = () => [...browser.data.keys()].filter((key) => key.includes('/gone/'));
    assert.equal(markers().length, 1);
    clock += 500;
    tracker.list();
    assert.equal(markers().length, 1);
    clock += 1000;
    tracker.list();
    assert.equal(markers().length, 0);
});

test('C24 retry of a settled request answers from storage; retry of an unknown id is NotSentError', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const done = await tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.send });
    const again = await tracker.retry(done.requestId, { send: neverSend });
    assert.deepEqual(again, done);
    const checked = await tracker.check(done.requestId, { lookup: neverSend });
    assert.deepEqual(checked, done);
    await assert.rejects(tracker.retry('req-unknown-00001', { send: neverSend }), (error: unknown) => error instanceof NotSentError && error.reason === 'unknown-request');
    await assert.rejects(tracker.check('req-unknown-00001', { lookup: neverSend }), (error: unknown) => error instanceof NotSentError && error.reason === 'unknown-request');
});

test('C25 input that cannot be sent as JSON is refused before anything is stored', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    for (const input of [undefined, { big: 1n }, (() => 1) as unknown]) {
        await assert.rejects(
            tracker.submit({ slot: 'form', operation: 'transfer', input, send: neverSend }),
            (error: unknown) => error instanceof NotSentError && error.reason === 'invalid-input',
        );
    }
    await assert.rejects(
        tracker.submit({ slot: '', operation: 'transfer', input: {}, send: neverSend }),
        (error: unknown) => error instanceof NotSentError && error.reason === 'invalid-slot',
    );
    assert.equal(browser.data.size, 0);
});

test('C26 acknowledge refuses an unconfirmed request; discard forgets it (the server is not told)', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const lost = await tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.lose });
    assert.equal(tracker.acknowledge(lost.requestId), false);
    assert.equal(tracker.get(lost.requestId)?.state, 'unconfirmed');
    assert.equal(tracker.discard(lost.requestId), true);
    assert.equal(tracker.get(lost.requestId), null);
    assert.equal(server.executions, 1, 'discarding does not undo what the server did');
});

test('C27 outcome types line up with the stored entry (response vs storage)', async () => {
    const browser = new MemoryBrowser();
    const tracker = trackerFor(browser.tab());
    const server = new FakeServer();
    const outcome: SubmitOutcome<{ execution: number }> = await tracker.submit({ slot: 'form', operation: 'transfer', input: {}, send: server.send });
    const stored = tracker.get(outcome.requestId);
    assert.equal(outcome.status, 'completed');
    assert.deepEqual(stored?.outcome, { status: 'completed', result: { execution: 1 }, replayed: false });
    assert.deepEqual(outcome.status === 'completed' && outcome.result, stored?.outcome?.status === 'completed' && stored.outcome.result);
});
