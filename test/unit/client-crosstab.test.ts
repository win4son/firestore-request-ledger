// Cross-tab races with lagging per-tab storage caches (LaggingBrowser).
// Each tab reads its own copy of localStorage, which catches up only when
// delivered, so writes computed from an old view really happen. Contracts:
// a settled outcome never goes back to unconfirmed; tabs converge on the
// first settled outcome; a removed request never comes back, including
// writes that arrive around the expiry of its removal marker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestTracker } from '../../src/client/index.ts';
import type { RequestTracker, StorageLike } from '../../src/client/index.ts';
import { LaggingBrowser, deferred } from '../helpers/memory-browser.ts';

const REQUEST_ID = 'req-crosstab-000001';
const TTL = 1000;

function tracker(storage: StorageLike, clock: { now: number }): RequestTracker {
    return createRequestTracker({ actor: 'user-a', storage, crossTab: null, locks: null, newRequestId: () => REQUEST_ID, now: () => clock.now, tombstoneTtlMs: TTL });
}
const completed = (result: unknown, replayed = false) => ({ requestId: REQUEST_ID, status: 'completed', result, replayed });
const lost = async (): Promise<unknown> => {
    throw new TypeError('fetch failed');
};
const keysFor = (browser: LaggingBrowser): string[] => [...browser.data.keys()].filter((key) => key.includes(REQUEST_ID));

/** Tab A submits; the response is lost. Both tabs then see the unconfirmed request. */
async function seeded() {
    const browser = new LaggingBrowser();
    const clock = { now: 1_000_000 };
    const tabA = browser.tab();
    const tabB = browser.tab();
    const a = tracker(tabA.storage, clock);
    const b = tracker(tabB.storage, clock);
    const first = await a.submit({ slot: 'form', operation: 'pay', input: { amount: 1 }, send: lost });
    assert.equal(first.status, 'unconfirmed');
    browser.deliver(tabB);
    assert.equal(b.get(REQUEST_ID)?.state, 'unconfirmed');
    return { browser, clock, tabA, tabB, a, b };
}

test('X1 a tab with an old view records a late network error after another tab confirmed the result: still completed everywhere', async () => {
    const { browser, tabA, tabB, a, b } = await seeded();
    const confirmed = await b.check(REQUEST_ID, { lookup: async () => completed({ amount: 1 }, true) });
    assert.equal(confirmed.status, 'completed');
    // A has not seen B's result; its retry fails and it records the error from its old view.
    const late = await a.retry(REQUEST_ID, { send: lost });
    assert.equal(late.status, 'unconfirmed', 'A could not know yet');
    browser.deliver(tabA);
    browser.deliver(tabB);
    assert.equal(a.get(REQUEST_ID)?.state, 'completed');
    assert.equal(b.get(REQUEST_ID)?.state, 'completed');
    assert.equal(tracker(browser.tab({ lagging: false }).storage, { now: 0 }).get(REQUEST_ID)?.state, 'completed', 'after a reload');
});

test('X2 two terminal answers race from tabs with old views: every tab converges on the first settled outcome, never back to unconfirmed', async () => {
    for (const order of ['A first', 'B first'] as const) {
        const { browser, clock, tabA, tabB, a, b } = await seeded();
        const answerA = { requestId: REQUEST_ID, status: 'completed', result: 'from-A', replayed: false };
        const answerB = { requestId: REQUEST_ID, status: 'completed', result: 'from-B', replayed: true };
        // Neither tab sees the other's write before writing its own.
        const runA = async () => a.check(REQUEST_ID, { lookup: async () => answerA });
        const runB = async () => b.check(REQUEST_ID, { lookup: async () => answerB });
        if (order === 'A first') {
            await runA();
            clock.now += 5;
            await runB();
        } else {
            await runB();
            clock.now += 5;
            await runA();
        }
        browser.deliver(tabA);
        browser.deliver(tabB);
        const expected = order === 'A first' ? 'from-A' : 'from-B';
        for (const [name, t] of [['A', a], ['B', b], ['reload', tracker(browser.tab({ lagging: false }).storage, clock)]] as const) {
            const entry = t.get(REQUEST_ID);
            assert.equal(entry?.state, 'completed', `${order}: ${name}`);
            assert.deepEqual(entry?.outcome && entry.outcome.status === 'completed' ? entry.outcome.result : null, expected, `${order}: ${name} sees the first settled outcome`);
        }
    }
});

test('X3 a late reply lands after the request was discarded and its removal marker expired: it does not come back', async () => {
    for (const view of ['fresh', 'old'] as const) {
        const { browser, clock, tabA, tabB, a, b } = await seeded();
        const slow = deferred<unknown>();
        const inFlight = a.retry(REQUEST_ID, { send: () => slow.promise });
        assert.equal(b.discard(REQUEST_ID), true);
        clock.now += TTL + 1;
        b.list(); // prunes the expired marker
        assert.deepEqual(keysFor(browser).filter((key) => key.includes('/gone/')), [], 'precondition: marker expired and pruned');
        if (view === 'fresh') browser.deliver(tabA);
        slow.resolve(completed({ amount: 1 }));
        const late = await inFlight;
        assert.equal(late.status, 'completed', `${view}: the late caller still learns the outcome`);
        browser.deliver(tabA);
        browser.deliver(tabB);
        assert.equal(a.get(REQUEST_ID), null, `${view}: not back in A`);
        assert.deepEqual(b.list(), [], `${view}: not back in B`);
        assert.deepEqual(tracker(browser.tab({ lagging: false }).storage, clock).list(), [], `${view}: not back after a reload`);
    }
});

test('X4 a late write lands while the removal marker still exists; the marker then expires: the request stays gone', async () => {
    const { browser, clock, tabA, tabB, a, b } = await seeded();
    assert.equal(b.discard(REQUEST_ID), true);
    // A has not seen the removal; its retry error is written from the old view.
    const late = await a.retry(REQUEST_ID, { send: lost });
    assert.equal(late.status, 'unconfirmed');
    browser.deliver(tabB);
    assert.deepEqual(b.list(), [], 'hidden while the marker exists');
    clock.now += TTL + 1;
    b.list(); // prune
    browser.deliver(tabA);
    browser.deliver(tabB);
    assert.equal(a.get(REQUEST_ID), null);
    assert.deepEqual(b.list(), []);
    assert.deepEqual(tracker(browser.tab({ lagging: false }).storage, clock).list(), [], 'not back after a reload');
});

test('X5 an attempt count from a tab with an old view is not lost when another tab also attempts', async () => {
    const { browser, tabA, tabB, a, b } = await seeded();   // A: 1 attempt
    await a.retry(REQUEST_ID, { send: lost });             // A: 2
    await b.retry(REQUEST_ID, { send: lost });             // B (old view): 1 more
    browser.deliver(tabA);
    browser.deliver(tabB);
    assert.equal(a.get(REQUEST_ID)?.attempts, 3);
    assert.equal(b.get(REQUEST_ID)?.attempts, 3);
});

test('X6 a tab sees an outcome record before the request record it belongs to (out-of-order visibility) and prunes: the fresh result is kept', async () => {
    const browser = new LaggingBrowser();
    const clock = { now: 1_000_000 };
    const tabC = browser.tab();                         // open before the request exists: its view starts without it
    const tabA = browser.tab();
    const tabB = browser.tab();
    const a = tracker(tabA.storage, clock);
    const b = tracker(tabB.storage, clock);
    await a.submit({ slot: 'form', operation: 'pay', input: { amount: 1 }, send: lost });
    browser.deliver(tabB);
    assert.equal((await b.check(REQUEST_ID, { lookup: async () => completed({ amount: 1 }) })).status, 'completed');
    browser.deliverKeys(tabC, (key) => key.includes('/done/'));   // C receives only the outcome record so far
    const c = tracker(tabC.storage, clock);
    assert.equal(c.get(REQUEST_ID), null, 'precondition: C does not see the request record');
    c.list(); // prunes from that partial view
    browser.deliver(tabA);
    browser.deliver(tabC);
    for (const [name, t] of [['C', c], ['reload', tracker(browser.tab({ lagging: false }).storage, clock)]] as const) {
        assert.equal(t.get(REQUEST_ID)?.state, 'completed', `${name}: the result survives a prune from a partial view`);
    }
});
