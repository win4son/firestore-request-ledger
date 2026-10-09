// Second review round: pruning must not treat "not seen while listing keys" as
// proof that a request is gone, and failed storage reads must not turn a
// settled request back into an unconfirmed one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestTracker } from '../../src/client/index.ts';
import type { RequestTracker, StorageLike } from '../../src/client/index.ts';
import { FakeLocks, MemoryBrowser } from '../helpers/memory-browser.ts';

let counter = 0;
const ids = (): string => `req-robust-${String(++counter).padStart(8, '0')}`;

/** One shared map; each tab gets a storage object with optional hooks. */
class Shared {
    readonly data = new Map<string, string>();
    tab(hooks: { onKey?: (index: number, key: string | null) => void; failGet?: (key: string) => boolean; afterGet?: (key: string) => void; failList?: () => boolean } = {}): StorageLike {
        const data = this.data;
        return {
            get length() {
                if (hooks.failList?.()) throw new Error('SecurityError (test double)');
                return data.size;
            },
            key(index) {
                if (hooks.failList?.()) throw new Error('SecurityError (test double)');
                const key = [...data.keys()][index] ?? null;
                hooks.onKey?.(index, key);
                return key;
            },
            getItem(key) {
                if (hooks.failGet?.(key)) throw new Error('SecurityError (test double)');
                const value = data.get(key) ?? null;
                hooks.afterGet?.(key); // this read happened before whatever the hook does (another tab's change)
                return value;
            },
            setItem(key, value) {
                data.set(key, String(value));
            },
            removeItem(key) {
                data.delete(key);
            },
        };
    }
}

function tracker(storage: StorageLike, clock: { now: number }): RequestTracker {
    return createRequestTracker({ actor: 'user-a', storage, crossTab: null, locks: null, newRequestId: ids, now: () => clock.now, tombstoneTtlMs: 1000 });
}
const reply = (status: 'completed' | 'rejected') => async (request: { requestId: string }) => (status === 'completed'
    ? { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false }
    : { requestId: request.requestId, status: 'rejected', terminal: true, code: 'invalid-argument', message: 'no', replayed: false });

test('R1 pruning while another tab removes a key: a request record skipped by the listing is not treated as gone; its result stays', async () => {
    const shared = new Shared();
    const clock = { now: 1_000_000 };
    const a = tracker(shared.tab(), clock);
    const first = await a.submit({ slot: 'one', operation: 'pay', input: 1, send: reply('completed') });
    const second = await a.submit({ slot: 'two', operation: 'pay', input: 2, send: reply('completed') });
    assert.equal(a.get(second.requestId)?.state, 'completed');
    // Put the two request records next to each other, so removing the first during a listing shifts the second past the cursor.
    const entries = [...shared.data].filter(([key]) => key.includes('/entry/'));
    const rest = [...shared.data].filter(([key]) => !key.includes('/entry/'));
    shared.data.clear();
    for (const [key, value] of [...entries, ...rest]) shared.data.set(key, value);
    clock.now += 10 * 60 * 60 * 1000; // records are old enough for any age rule
    let removed = false;
    const c = tracker(shared.tab({
        onKey: (_index, key) => {
            if (!removed && key && key.endsWith(`/entry/user-a/${first.requestId}`)) {
                removed = true;
                // Another tab discards the first request in the middle of this tab's listing.
                shared.data.delete(key);
                shared.data.set(`frl/v1/gone/user-a/${first.requestId}`, String(clock.now));
            }
        },
    }), clock);
    c.list(); // prunes
    assert.ok(removed, 'precondition: the listing was disturbed');
    const fresh = tracker(shared.tab(), clock);
    assert.equal(fresh.get(second.requestId)?.state, 'completed', 'the second request keeps its result after a reload');
    assert.equal(c.get(second.requestId)?.state, 'completed');
});

for (const status of ['completed', 'rejected'] as const) {
    test(`R2 ${status}: failed reads (single key, listing, every read) keep the settled outcome; readable() reports the failure`, async () => {
        for (const failure of ['outcome key', 'listing', 'every read'] as const) {
            const shared = new Shared();
            const clock = { now: 2_000_000 };
            let failing = false;
            const storage = shared.tab({
                failGet: (key) => failing && (failure === 'every read' || (failure === 'outcome key' && key.includes('/done/'))),
                failList: () => failing && (failure === 'listing' || failure === 'every read'),
            });
            const t = tracker(storage, clock);
            const outcome = await t.submit({ slot: 's', operation: 'pay', input: 1, send: reply(status) });
            assert.equal(t.get(outcome.requestId)?.state, status);
            failing = true;
            assert.equal(t.get(outcome.requestId)?.state, status, `${failure}: get() keeps ${status}`);
            assert.equal(t.list().find((e) => e.requestId === outcome.requestId)?.state, status, `${failure}: list() keeps ${status}`);
            const again = await t.retry(outcome.requestId, { send: async () => { throw new Error('must not send'); } });
            assert.equal(again.status, status, `${failure}: retry answers from the remembered outcome without sending`);
            assert.equal(t.readable(), false, `${failure}: the read failure is reported separately`);
            failing = false;
            assert.equal(t.get(outcome.requestId)?.state, status);
            assert.equal(t.readable(), true, `${failure}: readable again`);
        }
    });
}

test('R3 submit while another tab removes a key during the slot check: an unconfirmed request skipped by the listing still blocks the slot; nothing is sent', async () => {
    const shared = new Shared();
    const clock = { now: 3_000_000 };
    const a = tracker(shared.tab(), clock);
    const other = await a.submit({ slot: 'other', operation: 'pay', input: 0, send: reply('completed') });
    const open = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(open.status, 'unconfirmed');
    // Put the other request's record right before the open one, so removing it mid-listing shifts the open one past the cursor.
    const entries = [...shared.data].filter(([key]) => key.includes('/entry/'));
    const rest = [...shared.data].filter(([key]) => !key.includes('/entry/'));
    shared.data.clear();
    for (const [key, value] of [...entries, ...rest]) shared.data.set(key, value);
    let removed = false;
    const b = tracker(shared.tab({
        onKey: (_index, key) => {
            if (!removed && key && key.endsWith(`/entry/user-a/${other.requestId}`)) {
                removed = true;
                shared.data.delete(key); // another tab acknowledges the other request meanwhile
                shared.data.set(`frl/v1/gone/user-a/${other.requestId}`, String(clock.now));
            }
        },
    }), clock);
    let sent = 0;
    await assert.rejects(
        b.submit({ slot: 'form', operation: 'pay', input: 2, send: async () => { sent += 1; return null; } }),
        (error: unknown) => (error as { reason?: string }).reason === 'slot-busy',
    );
    assert.ok(removed, 'precondition: the listing was disturbed');
    assert.equal(sent, 0, 'nothing was sent');
    const ids = tracker(shared.tab(), clock).list().filter((e) => e.slot === 'form').map((e) => e.requestId);
    assert.deepEqual(ids, [open.requestId], 'no second request in the slot');
});

test('R4 submit when the old request in the slot cannot be read (the request record, or the listing): refused as storage-unreadable; nothing is sent', async () => {
    for (const failure of ['request record', 'listing'] as const) {
        const shared = new Shared();
        const clock = { now: 4_000_000 };
        const a = tracker(shared.tab(), clock);
        const old = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
        let failing = true;
        const b = tracker(shared.tab({
            failGet: (key) => failing && failure === 'request record' && key.endsWith(`/entry/user-a/${old.requestId}`),
            failList: () => failing && failure === 'listing',
        }), clock);
        let sent = 0;
        await assert.rejects(
            b.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { sent += 1; return null; } }),
            (error: unknown) => (error as { reason?: string }).reason === 'storage-unreadable',
            failure,
        );
        assert.equal(sent, 0, `${failure}: nothing sent`);
        failing = false;
        assert.deepEqual(tracker(shared.tab(), clock).list().map((e) => e.requestId), [old.requestId], `${failure}: no second request`);
    }
});

test('R5 a partial read cannot replace the earliest settled outcome already seen (either order, and the same settledAt)', async () => {
    for (const order of ['first written first', 'later written first', 'same time'] as const) {
        const shared = new Shared();
        const clock = { now: 5_000_000 };
        const a = tracker(shared.tab(), clock);
        const b = tracker(shared.tab(), clock);
        const req = await a.submit({ slot: 's', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
        // Both tabs store a settled outcome without seeing the other's (each writes only its own record).
        const answer = (result: string) => async () => ({ requestId: req.requestId, status: 'completed', result, replayed: false });
        const doneKeys = (): string[] => [...shared.data.keys()].filter((key) => key.includes('/done/'));
        const writeOutcome = (t: RequestTracker, result: string, settledAt: number) => {
            const before = new Set(doneKeys());
            clock.now = settledAt;
            return t.check(req.requestId, { lookup: answer(result) }).then(() => doneKeys().find((key) => !before.has(key)));
        };
        // Hide B's record from A while A writes, and A's from B, by writing in two steps with the other key removed meanwhile.
        const aKey = await writeOutcome(a, 'from-A', order === 'later written first' ? 6_000_010 : 6_000_000);
        const aValue = shared.data.get(aKey as string) as string;
        shared.data.delete(aKey as string);
        const bKey = await writeOutcome(b, 'from-B', order === 'first written first' ? 6_000_010 : order === 'later written first' ? 6_000_000 : 6_000_000);
        shared.data.set(aKey as string, aValue);
        const all = [[aKey, 'from-A'], [bKey, 'from-B']] as const;
        const settledAt = (key: string): number => (JSON.parse(shared.data.get(key) as string) as { settledAt: number }).settledAt;
        const sorted = [...all].sort(([k1], [k2]) => settledAt(k1 as string) - settledAt(k2 as string) || ((k1 as string).slice((k1 as string).lastIndexOf('/')) < (k2 as string).slice((k2 as string).lastIndexOf('/')) ? -1 : 1));
        const [earliestKey, earliestResult] = sorted[0] as readonly [string, string];
        let failKey: string | null = null;
        const reader = tracker(shared.tab({ failGet: (key) => key === failKey }), clock);
        const seen = reader.get(req.requestId);
        assert.equal(seen?.outcome?.status === 'completed' ? seen.outcome.result : null, earliestResult, `${order}: reader sees the earliest`);
        failKey = earliestKey; // the earliest record becomes unreadable; the later one is still readable
        const after = reader.get(req.requestId);
        assert.equal(after?.outcome?.status === 'completed' ? after.outcome.result : null, earliestResult, `${order}: still the earliest after a partial read`);
        failKey = null;
    }
});

// Fourth review round: a listing that skips a key is not an error, so it cannot be caught by "refuse when a read
// throws", and a second listing can skip it too. Whether a slot already holds a request must come from records that
// are read directly, not from listings.

/** Move `before` (new unrelated keys) directly in front of `target`: removing one of them mid-listing then skips `target`. */
function placeBefore(data: Map<string, string>, before: readonly string[], target: string): void {
    const rows = [...data].filter(([key]) => !before.includes(key));
    assert.ok(rows.some(([key]) => key === target), 'precondition: the target key exists');
    data.clear();
    for (const [key, value] of rows) {
        if (key === target) for (const extra of before) data.set(extra, 'unrelated');
        data.set(key, value);
    }
}

/**
 * A tab whose first `misses` listings each skip `target` (Infinity: every listing): when a listing reaches the
 * unrelated key right before it, another tab removes that key, so the next index already points past `target`.
 */
function skippingTab(shared: Shared, target: string | readonly string[], misses: number, failGet?: (key: string) => boolean): { storage: StorageLike; skipped: () => number; shown: () => number } {
    const targets = typeof target === 'string' ? [target] : target;
    targets.forEach((one, t) => placeBefore(shared.data, Array.from({ length: Number.isFinite(misses) ? misses : 40 }, (_, index) => `unrelated-${t}-${index + 1}`), one));
    let skipped = 0;
    let shown = 0;
    const storage = shared.tab({
        onKey: (_index, key) => {
            if (key && targets.includes(key)) shown += 1;
            if (skipped >= misses || !key?.startsWith('unrelated-')) return;
            const keys = [...shared.data.keys()];
            if (!targets.includes(keys[keys.indexOf(key) + 1] as string)) return;
            shared.data.delete(key);
            skipped += 1;
        },
        failGet,
    });
    return { storage, skipped: () => skipped, shown: () => shown };
}

/** Every record of one request (request, attempt and outcome records): skipping all of them hides the request from listings. */
function recordsOf(shared: Shared, requestId: string): string[] {
    return [...shared.data.keys()].filter((key) => /^frl\/v1\/(entry|try|done)\/user-a\//.test(key) && (key.endsWith(`/${requestId}`) || key.includes(`/${requestId}/`)));
}

for (const [misses, all] of [[0, false], [1, false], [2, false], [Infinity, false], [Infinity, true]] as const) {
    for (const kind of ['open, same content', 'open, different content', 'settled, same content'] as const) {
        test(`R6 the slot's old request (${kind}) is skipped by ${Number.isFinite(misses) ? misses : 'every'} listing(s)${all ? ', all its records' : ''} during submit: it is still found; nothing runs twice`, async () => {
            const shared = new Shared();
            const clock = { now: 7_000_000 };
            const executed = new Set<string>();
            const server = async (request: { requestId: string }) => {
                executed.add(request.requestId);
                return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
            };
            const lost = async (request: { requestId: string }) => {
                await server(request);
                throw new TypeError('response lost after commit');
            };
            const a = tracker(shared.tab(), clock);
            const first = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: kind === 'settled, same content' ? server : lost });
            assert.equal(executed.size, 1);
            const { storage, skipped, shown } = skippingTab(shared, all ? recordsOf(shared, first.requestId) : `frl/v1/entry/user-a/${first.requestId}`, misses);
            const b = tracker(storage, clock);
            let sent = 0;
            const counted = async (request: { requestId: string }) => {
                sent += 1;
                return server(request);
            };
            if (kind === 'open, different content') {
                await assert.rejects(
                    b.submit({ slot: 'form', operation: 'pay', input: 2, send: counted }),
                    (error: unknown) => (error as { reason?: string }).reason === 'slot-busy',
                    kind,
                );
                assert.equal(sent, 0, `${kind}: nothing sent`);
            } else {
                const second = await b.submit({ slot: 'form', operation: 'pay', input: 1, send: counted });
                assert.equal(second.requestId, first.requestId, `${kind}: the same request id`);
                assert.equal(second.status, 'completed', kind);
                // A settled outcome stored by another tab is found through listings only: while every listing skips it
                // too, the request looks unconfirmed here and the same id is sent again (the server replays it).
                assert.equal(sent, kind === 'settled, same content' && !all ? 0 : 1, `${kind}: sends`);
            }
            if (Number.isFinite(misses)) assert.equal(skipped(), misses, `${kind}: precondition: ${misses} listing(s) skipped the old request`);
            else assert.deepEqual([skipped() >= 2, shown()], [true, 0], `${kind}: precondition: no listing showed the old request`);
            assert.equal(executed.size, 1, `${kind}: executed once`);
            assert.equal(b.readable(), true, kind);
            assert.deepEqual(tracker(shared.tab(), clock).list().filter((e) => e.slot === 'form').map((e) => e.requestId), [first.requestId], `${kind}: one request in the slot`);
        });
    }
}

for (const operation of ['get', 'acknowledge', 'reply'] as const) {
    test(`R7 one request whose record a listing skips (${operation}): get() and acknowledge() still find it, and a reply arriving meanwhile is stored`, async () => {
        const shared = new Shared();
        const clock = { now: 8_000_000 };
        const a = tracker(shared.tab(), clock);
        const settled = operation !== 'reply';
        const req = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: settled ? reply('completed') : async () => { throw new TypeError('fetch failed'); } });
        const target = `frl/v1/entry/user-a/${req.requestId}`;
        placeBefore(shared.data, ['unrelated-1'], target);
        let armed = operation !== 'reply';
        let skipped = 0;
        const b = tracker(shared.tab({
            onKey: (_index, key) => {
                if (armed && skipped === 0 && key === 'unrelated-1') {
                    shared.data.delete(key);
                    skipped += 1;
                }
            },
        }), clock);
        if (operation === 'get') {
            assert.equal(b.get(req.requestId)?.state, 'completed', 'get() finds it');
        } else if (operation === 'acknowledge') {
            assert.equal(b.acknowledge(req.requestId), true, 'acknowledge() finds it');
            assert.equal(tracker(shared.tab(), clock).get(req.requestId), null, 'and removes it');
        } else {
            const outcome = await b.retry(req.requestId, {
                send: async (request) => {
                    armed = true; // the listing made while saving the reply skips the request record
                    return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
                },
            });
            assert.equal(outcome.status, 'completed');
            assert.equal(tracker(shared.tab(), clock).get(req.requestId)?.state, 'completed', 'the reply was stored');
        }
        assert.equal(skipped, 1, `${operation}: precondition: the listing skipped the request record`);
    });
}

const slotRecord = (data: Map<string, string>, slot: string, which: 'slot' | 'slotcopy' = 'slot'): string[] | null => {
    const raw = data.get(`frl/v1/${which}/user-a/${encodeURIComponent(slot)}`);
    return raw === undefined ? null : (JSON.parse(raw) as { ids: string[] }).ids;
};

test('R8 the slot record itself: a damaged copy is restored from the other; both damaged → the slot stays blocked (broken-slot) until resetSlot(); unreadable → storage-unreadable; cannot be saved → nothing sent, nothing left', async () => {
    const lostSend = async () => { throw new TypeError('fetch failed'); };
    // One copy cannot be parsed: the other copy is used and the damaged one is restored.
    for (const damaged of ['slot', 'slotcopy'] as const) {
        const shared = new Shared();
        const clock = { now: 9_000_000 };
        const a = tracker(shared.tab(), clock);
        const open = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: lostSend });
        shared.data.set(`frl/v1/${damaged}/user-a/form`, '{"v":1,"ids":["not a valid id!"]}');
        assert.deepEqual(a.brokenSlots(), [], `${damaged}: still usable`);
        const again = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: reply('completed') });
        assert.equal(again.requestId, open.requestId, `${damaged}: the open request is reused, not replaced`);
        assert.deepEqual([slotRecord(shared.data, 'form'), slotRecord(shared.data, 'form', 'slotcopy')], [[open.requestId], [open.requestId]], `${damaged}: restored`);
    }
    // Both copies cannot be used (also: one damaged and the other missing): the slot's requests are unknown. The slot
    // stays blocked, also after discardBroken() and while no listing shows the slot record; resetSlot() rebuilds it.
    for (const damage of ['both damaged', 'damaged and copy missing'] as const) {
        const shared = new Shared();
        const clock = { now: 9_050_000 };
        const a = tracker(shared.tab(), clock);
        const open = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: lostSend });
        shared.data.set('frl/v1/slot/user-a/form', 'not json');
        if (damage === 'both damaged') shared.data.set('frl/v1/slotcopy/user-a/form', 'not json');
        else shared.data.delete('frl/v1/slotcopy/user-a/form');
        let sent = 0;
        const counted = async () => { sent += 1; return null; };
        const refused = (error: unknown) => (error as { reason?: string }).reason === 'broken-slot';
        await assert.rejects(a.submit({ slot: 'form', operation: 'pay', input: 1, send: counted }), refused, damage);
        assert.deepEqual([a.brokenSlots(), a.brokenCount()], [['form'], 0], damage);
        assert.equal(await a.discardBroken(), 0, `${damage}: discardBroken() leaves the slot record`);
        assert.equal(shared.data.get('frl/v1/slot/user-a/form'), 'not json');
        const { storage, shown } = skippingTab(shared, 'frl/v1/slot/user-a/form', Infinity);
        assert.equal((await tracker(storage, clock).submit({ slot: 'other-form', operation: 'pay', input: 1, send: reply('completed') })).status, 'completed', `${damage}: other slots are not blocked`);
        await assert.rejects(tracker(storage, clock).submit({ slot: 'form', operation: 'pay', input: 2, send: counted }), refused, `${damage}: still refused when no listing shows the slot record`);
        assert.equal(shown(), 0, 'precondition');
        assert.equal(sent, 0, `${damage}: nothing sent`);
        assert.deepEqual(await a.resetSlot('form'), [open.requestId], `${damage}: rebuilt from the slot's requests`);
        assert.deepEqual(a.brokenSlots(), []);
        const again = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: reply('completed') });
        assert.equal(again.requestId, open.requestId, `${damage}: reused after resetSlot()`);
    }
    // The two copies differ (one is behind, for example restored by discardBroken() from an older copy while a submit
    // rewrote both): the union counts, so an open request listed only in one copy still holds the slot.
    for (const behind of ['slot', 'slotcopy'] as const) {
        const shared = new Shared();
        const clock = { now: 9_080_000 };
        const a = tracker(shared.tab(), clock);
        const open = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: lostSend });
        shared.data.set(`frl/v1/${behind}/user-a/form`, '{"v":1,"ids":[]}');
        const { storage, shown } = skippingTab(shared, recordsOf(shared, open.requestId), Infinity);
        let sent = 0;
        await assert.rejects(
            tracker(storage, clock).submit({ slot: 'form', operation: 'pay', input: 2, send: async () => { sent += 1; return null; } }),
            (error: unknown) => (error as { reason?: string }).reason === 'slot-busy',
            `${behind} behind`,
        );
        assert.deepEqual([sent, shown()], [0, 0], `${behind} behind: nothing sent; precondition: no listing showed the open request`);
    }
    // Unreadable: refused.
    for (const failing of ['/slot/', '/slotcopy/'] as const) {
        const shared = new Shared();
        const clock = { now: 9_100_000 };
        await tracker(shared.tab(), clock).submit({ slot: 'form', operation: 'pay', input: 1, send: lostSend });
        const b = tracker(shared.tab({ failGet: (key) => key.includes(failing) }), clock);
        let sent = 0;
        await assert.rejects(
            b.submit({ slot: 'form', operation: 'pay', input: 2, send: async () => { sent += 1; return null; } }),
            (error: unknown) => (error as { reason?: string }).reason === 'storage-unreadable',
            failing,
        );
        assert.equal(sent, 0, failing);
    }
    // Cannot be saved: nothing is sent and no request record is left; a request record that cannot be saved after the
    // slot record leaves only an id that the next submit drops.
    for (const failing of ['/slot/', '/slotcopy/', '/entry/'] as const) {
        const browser = new MemoryBrowser();
        const t = createRequestTracker({ actor: 'user-a', storage: browser.tab().storage, crossTab: null, locks: null, newRequestId: ids });
        browser.failWrite = (key, value) => value !== null && key.includes(failing);
        let sent = 0;
        await assert.rejects(
            t.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { sent += 1; return null; } }),
            (error: unknown) => (error as { reason?: string }).reason === 'storage-unavailable',
            failing,
        );
        assert.equal(sent, 0, `${failing}: nothing sent`);
        assert.deepEqual(t.list(), [], `${failing}: no request left`);
        browser.failWrite = null;
        const next = await t.submit({ slot: 'form', operation: 'pay', input: 1, send: reply('completed') });
        assert.deepEqual([slotRecord(browser.data, 'form'), slotRecord(browser.data, 'form', 'slotcopy')], [[next.requestId], [next.requestId]], `${failing}: only the saved request is listed`);
    }
});

test('R9 the slot record keeps settled requests that are not acknowledged (they still replay when listings skip them) and drops removed ones', async () => {
    const shared = new Shared();
    const clock = { now: 9_500_000 };
    const a = tracker(shared.tab(), clock);
    const kept = await a.submit({ slot: 'form', operation: 'pay', input: 'A', send: reply('completed') });
    const acked = await a.submit({ slot: 'form', operation: 'pay', input: 'B', send: reply('completed') });
    assert.deepEqual(slotRecord(shared.data, 'form'), [kept.requestId, acked.requestId]);
    assert.equal(a.acknowledge(acked.requestId), true);
    const third = await a.submit({ slot: 'form', operation: 'pay', input: 'C', send: reply('completed') });
    assert.deepEqual(slotRecord(shared.data, 'form'), [kept.requestId, third.requestId], 'the acknowledged id is dropped, the settled one kept');
    const { storage, skipped } = skippingTab(shared, `frl/v1/entry/user-a/${kept.requestId}`, 2);
    let sent = 0;
    const replayed = await tracker(storage, clock).submit({ slot: 'form', operation: 'pay', input: 'A', send: async () => { sent += 1; return null; } });
    assert.equal(skipped(), 2, 'precondition: two listings skipped the settled request');
    assert.deepEqual([replayed.requestId, replayed.status, sent], [kept.requestId, 'completed', 0], 'replayed from storage, nothing sent');
});

test('R10 every listing skips all records of the slot\'s old request and its direct read fails: refused as storage-unreadable; nothing is sent', async () => {
    const shared = new Shared();
    const clock = { now: 9_800_000 };
    const old = await tracker(shared.tab(), clock).submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
    const target = `frl/v1/entry/user-a/${old.requestId}`;
    const { storage, skipped, shown } = skippingTab(shared, recordsOf(shared, old.requestId), Infinity, (key) => key === target);
    const b = tracker(storage, clock);
    let sent = 0;
    await assert.rejects(
        b.submit({ slot: 'form', operation: 'pay', input: 2, send: async () => { sent += 1; return null; } }),
        (error: unknown) => (error as { reason?: string }).reason === 'storage-unreadable',
    );
    assert.deepEqual([skipped() >= 2, shown()], [true, 0], 'precondition: no listing showed the old request');
    assert.equal(sent, 0);
});

// Fifth review round.

for (const partial of ['outcome unreadable', 'outcome skipped by the listing'] as const) {
    test(`R11 get → list() whose listing skips the request record → partial read (${partial}): the settled outcome seen stays; list() still shows it`, async () => {
        const shared = new Shared();
        const clock = { now: 10_000_000 };
        const writer = tracker(shared.tab(), clock);
        const req = await writer.submit({ slot: 'form', operation: 'pay', input: 1, send: reply('completed') });
        const entry = `frl/v1/entry/user-a/${req.requestId}`;
        const done = [...shared.data.keys()].find((key) => key.includes('/done/')) as string;
        let skip: string | null = null;
        let failDone = false;
        let shownSkipped = 0;
        placeBefore(shared.data, Array.from({ length: 40 }, (_, i) => `unrelated-e-${i}`), entry);
        placeBefore(shared.data, Array.from({ length: 40 }, (_, i) => `unrelated-d-${i}`), done);
        const reader = tracker(shared.tab({
            onKey: (_index, key) => {
                if (key === skip) shownSkipped += 1;
                if (!skip || !key?.startsWith('unrelated-')) return;
                const keys = [...shared.data.keys()];
                if (keys[keys.indexOf(key) + 1] === skip) shared.data.delete(key);
            },
            failGet: (key) => failDone && key === done,
        }), clock);
        assert.equal(reader.get(req.requestId)?.state, 'completed', 'seen as completed');
        skip = entry;
        const listed = reader.list().find((e) => e.requestId === req.requestId)?.state;
        assert.equal(shownSkipped, 0, 'precondition: the listing did not show the request record');
        skip = partial === 'outcome skipped by the listing' ? done : null;
        shownSkipped = 0;
        failDone = partial === 'outcome unreadable';
        const later = reader.get(req.requestId)?.state;
        if (skip) assert.equal(shownSkipped, 0, 'precondition: the listing did not show the outcome record');
        assert.ok(shared.data.has(entry) && shared.data.has(done), 'both records are still stored');
        assert.deepEqual({ listed, later }, { listed: 'completed', later: 'completed' }, 'list() still shows it as completed, and a later partial read keeps the outcome');
    });
}

test('R12 a damaged slot record, discardBroken(), then a submit whose every listing skips all records of the old request: the same id; nothing runs twice', async () => {
    for (const recovery of ['discardBroken() first', 'submit directly'] as const) {
        const shared = new Shared();
        const clock = { now: 11_000_000 };
        const executed = new Set<string>();
        const server = async (request: { requestId: string }) => {
            executed.add(request.requestId);
            return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
        };
        const writer = tracker(shared.tab(), clock);
        const first = await writer.submit({ slot: 'form', operation: 'pay', input: 1, send: async (r: { requestId: string }) => { await server(r); throw new TypeError('response lost after commit'); } });
        shared.data.set('frl/v1/slot/user-a/form', 'synthetic-broken-json');
        if (recovery === 'discardBroken() first') assert.equal(await writer.discardBroken(), 1, 'the damaged copy is restored, not removed');
        const { storage, shown } = skippingTab(shared, recordsOf(shared, first.requestId), Infinity);
        const second = await tracker(storage, clock).submit({ slot: 'form', operation: 'pay', input: 1, send: server });
        assert.equal(shown(), 0, `${recovery}: precondition: no listing showed the old request`);
        assert.deepEqual([second.requestId, executed.size], [first.requestId, 1], `${recovery}: the same id, executed once`);
    }
});

test('R13 an unreadable request record that its slot record lists, removed by discardBroken(): the slot stays blocked (broken-slot) until resetSlot(); other slots are free', async () => {
    const shared = new Shared();
    const clock = { now: 12_000_000 };
    const executed = new Set<string>();
    const server = async (request: { requestId: string }) => {
        executed.add(request.requestId);
        return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
    };
    const a = tracker(shared.tab(), clock);
    const sent = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: async (r: { requestId: string }) => { await server(r); throw new TypeError('response lost after commit'); } });
    shared.data.set(`frl/v1/entry/user-a/${sent.requestId}`, '{"v":1,"requestId":'); // damaged by something else
    assert.equal(a.brokenCount(), 1);
    assert.equal(await a.discardBroken(), 1);
    await assert.rejects(
        a.submit({ slot: 'form', operation: 'pay', input: 1, send: server }),
        (error: unknown) => (error as { reason?: string }).reason === 'broken-slot',
    );
    assert.equal(executed.size, 1, 'not run again');
    assert.deepEqual(a.brokenSlots(), ['form']);
    assert.equal((await a.submit({ slot: 'other', operation: 'pay', input: 1, send: server })).status, 'completed', 'other slots are free');
    // The app has checked with its server; it accepts that the request's content is gone.
    assert.deepEqual(await a.resetSlot('form'), []);
    assert.deepEqual(a.brokenSlots(), []);
    assert.equal(shared.data.has(`frl/v1/lost/user-a/${sent.requestId}`), false, 'the marker goes with the reset');
    assert.equal((await a.submit({ slot: 'form', operation: 'pay', input: 1, send: server })).status, 'completed');
});

test('R14 a request of the slot that only a listing shows (its slot record is missing) is written back when submit goes ahead, so later listings that skip it do not matter', async () => {
    const shared = new Shared();
    const clock = { now: 13_000_000 };
    const a = tracker(shared.tab(), clock);
    const open = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
    shared.data.delete('frl/v1/slot/user-a/form');
    shared.data.delete('frl/v1/slotcopy/user-a/form'); // as if saved without a slot record (a tab without locks, or removed by something else)
    const again = await a.submit({ slot: 'form', operation: 'pay', input: 1, send: async () => { throw new TypeError('fetch failed'); } });
    assert.equal(again.requestId, open.requestId);
    assert.deepEqual([slotRecord(shared.data, 'form'), slotRecord(shared.data, 'form', 'slotcopy')], [[open.requestId], [open.requestId]], 'written back');
    const { storage, shown } = skippingTab(shared, recordsOf(shared, open.requestId), Infinity);
    let sent = 0;
    await assert.rejects(
        tracker(storage, clock).submit({ slot: 'form', operation: 'pay', input: 2, send: async () => { sent += 1; return null; } }),
        (error: unknown) => (error as { reason?: string }).reason === 'slot-busy',
    );
    assert.deepEqual([sent, shown()], [0, 0], 'nothing sent; precondition: no listing showed the open request');
});

// Sixth review round: discardBroken() in another tab while submit checks the slot. The cleanup is started right after
// the reader's k-th storage read, for every k until the submit is over, so every point of the check is covered.

type Scenario = 'open request' | 'settled request, new content';
async function cleanupRace(scenario: Scenario, k: number, exclusive: boolean) {
    const shared = new Shared();
    const clock = { now: 14_000_000 };
    const locks = exclusive ? new FakeLocks() : { request: async <T,>(_name: string, task: (lock: unknown) => T | Promise<T>) => task(null) };
    const make = (storage: StorageLike) => createRequestTracker({ actor: 'user-a', storage, crossTab: null, locks, requireLocks: true, newRequestId: ids, now: () => clock.now });
    const executed: string[] = [];
    const server = async (request: { requestId: string }) => {
        executed.push(request.requestId);
        return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
    };
    const writer = make(shared.tab());
    const old = await writer.submit({ slot: 'form', operation: 'pay', input: 'A', send: scenario === 'open request' ? async (r: { requestId: string }) => { await server(r); throw new TypeError('response lost after commit'); } : server });
    const entry = `frl/v1/entry/user-a/${old.requestId}`;
    if (scenario === 'open request') shared.data.set(entry, 'synthetic corrupt JSON'); // damaged before the reader starts
    const cleaner = make(shared.tab());
    let reads = 0;
    let cleanup: Promise<number> | null = null;
    const reader = make(shared.tab({
        afterGet: () => {
            reads += 1;
            if (reads !== k || cleanup) return;
            if (scenario !== 'open request') shared.data.set(entry, 'synthetic corrupt JSON'); // damaged right now
            cleanup = cleaner.discardBroken();
        },
    }));
    let outcome: string;
    try {
        const result = await reader.submit({ slot: 'form', operation: 'pay', input: scenario === 'open request' ? 'A' : 'B', send: server });
        outcome = result.requestId === old.requestId ? 'reused' : 'created';
    } catch (error) {
        outcome = (error as { reason?: string }).reason ?? String(error);
    }
    const removed = cleanup ? await cleanup : null;
    return { shared, old, executed, outcome, removed, reads, cleanupRan: cleanup !== null };
}

for (const exclusive of [false, true] as const) {
    for (const scenario of ['open request', 'settled request, new content'] as const) {
        test(`${exclusive ? 'R16 with a shared exclusive lock' : 'R15 without a lock that keeps tabs apart'}: discardBroken() in another tab after each read of submit's check (${scenario}): the old request never runs again and its slot stays blocked`, async () => {
            const control = await cleanupRace(scenario, 0, exclusive);
            const total = control.reads;
            assert.ok(total > 5, 'precondition: the check reads storage');
            const outcomes = new Set<string>();
            for (let k = 1; k <= total + 1; k += 1) {
                const run = await cleanupRace(scenario, k, exclusive);
                const label = `${scenario}, cleanup after read ${k} of ${total}`;
                if (k <= run.reads) assert.ok(run.cleanupRan, `${label}: precondition: the cleanup started`);
                outcomes.add(run.outcome);
                assert.equal(run.executed.filter((id) => id === run.old.requestId).length, 1, `${label}: the old request ran once`);
                if (scenario === 'open request') {
                    assert.ok(['broken-entries', 'broken-slot'].includes(run.outcome), `${label}: refused (${run.outcome})`);
                    if (exclusive) assert.equal(run.outcome, 'broken-entries', `${label}: the cleanup waited for the lock, so the check saw the damaged record`);
                } else {
                    assert.ok(['created', 'broken-entries', 'broken-slot'].includes(run.outcome), `${label}: ${run.outcome}`);
                    // The damage itself comes from outside and is not held off by the lock; only the cleanup is. With the
                    // lock the check never sees a lost marker appear midway, so it never ends with broken-slot.
                    if (exclusive) assert.notEqual(run.outcome, 'broken-slot', `${label}: the cleanup waited for the lock`);
                }
                if (run.cleanupRan) {
                    assert.equal(run.removed, 1, `${label}: the cleanup removed the damaged record`);
                    assert.ok(run.shared.data.has(`frl/v1/lost/user-a/${run.old.requestId}`), `${label}: lost marker`);
                    for (const which of ['slot', 'slotcopy'] as const) {
                        assert.ok(slotRecord(run.shared.data, 'form', which)?.includes(run.old.requestId), `${label}: ${which} still lists the old request`);
                    }
                    const later = createRequestTracker({ actor: 'user-a', storage: run.shared.tab(), crossTab: null, locks: null, newRequestId: ids });
                    await assert.rejects(
                        later.submit({ slot: 'form', operation: 'pay', input: 'A', send: async () => { throw new Error('must not send'); } }),
                        (error: unknown) => (error as { reason?: string }).reason === 'broken-slot',
                        `${label}: the slot stays blocked`,
                    );
                }
            }
            assert.ok(outcomes.size >= 1);
        });
    }
}

for (const content of ['same content', 'different content'] as const) {
    test(`R17 without locks, another tab's whole submit runs between two reads of this tab's submit, before it sends (${content}): only one request runs, and the slot record lists it`, async () => {
        // Reads of this tab's submit up to the moment it sends (the other tab's submit is started after each of them).
        const total = await (async () => {
            const shared = new Shared();
            let reads = 0;
            let atSend = 0;
            const t = createRequestTracker({ actor: 'user-a', storage: shared.tab({ afterGet: () => { reads += 1; } }), crossTab: null, locks: null, newRequestId: ids });
            await t.submit({ slot: 'form', operation: 'pay', input: 1, send: async (request) => { atSend = reads; return { requestId: request.requestId, status: 'completed', result: 1, replayed: false }; } });
            return atSend;
        })();
        assert.ok(total > 5, 'precondition');
        for (let k = 1; k <= total; k += 1) {
            const shared = new Shared();
            const executed: string[] = [];
            const server = async (request: { requestId: string }) => {
                executed.push(request.requestId);
                return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
            };
            const other = createRequestTracker({ actor: 'user-a', storage: shared.tab(), crossTab: null, locks: null, newRequestId: ids });
            let reads = 0;
            let otherJob: Promise<unknown> | null = null;
            const t = createRequestTracker({
                actor: 'user-a',
                storage: shared.tab({ afterGet: () => { reads += 1; if (reads === k && !otherJob) otherJob = other.submit({ slot: 'form', operation: 'pay', input: 1, send: server }).catch((error) => error); } }),
                crossTab: null,
                locks: null,
                newRequestId: ids,
            });
            // This tab's request stays unconfirmed until the other tab's submit is over.
            const held = async (request: { requestId: string }) => {
                executed.push(request.requestId);
                await otherJob;
                return { requestId: request.requestId, status: 'completed', result: { ok: true }, replayed: false };
            };
            let mine: string;
            try {
                mine = (await t.submit({ slot: 'form', operation: 'pay', input: content === 'same content' ? 1 : 2, send: held })).requestId;
            } catch (error) {
                mine = (error as { reason?: string }).reason ?? String(error);
            }
            await otherJob;
            const label = `${content}, the other submit after read ${k} of ${total}`;
            assert.ok(otherJob, `${label}: precondition: the other submit ran`);
            // Same content: one id. Different content: the slot rule lets only one of the two run (the other waits).
            assert.equal(new Set(executed).size, 1, `${label}: one request id ran (${executed.join(',')}; this tab: ${mine})`);
            const live = tracker(shared.tab(), { now: Date.now() }).list().filter((e) => e.slot === 'form').map((e) => e.requestId);
            for (const which of ['slot', 'slotcopy'] as const) {
                const listed = slotRecord(shared.data, 'form', which) ?? [];
                for (const id of live) assert.ok(listed.includes(id), `${label}: ${which} lists ${id}`);
            }
        }
    });
}
