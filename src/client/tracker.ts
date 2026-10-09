import { sameJson } from '../shared/canonical.ts';
import { isNotFoundFor, isValidRequestId, settledReplyFor } from '../shared/wire.ts';
import type { LedgerReply } from '../shared/wire.ts';
import type {
    AttemptError,
    CheckRequest,
    CrossTabPort,
    LockManagerLike,
    RequestTracker,
    RequestTrackerOptions,
    RetryRequest,
    SendFunction,
    SettledOutcome,
    StorageLike,
    SubmitOutcome,
    SubmitRequest,
    TrackedRequest,
    TrackedState,
} from './types.ts';

export type NotSentReason =
    | 'storage-unavailable'
    | 'storage-unreadable'
    | 'locks-unavailable'
    | 'slot-busy'
    | 'broken-entries'
    | 'broken-slot'
    | 'aborted'
    | 'invalid-input'
    | 'invalid-slot'
    | 'unknown-request';

/**
 * Thrown only when nothing was sent in this call. The original request, if any,
 * is untouched; `pending` points at the entry that caused a `slot-busy` refusal.
 */
export class NotSentError extends Error {
    readonly reason: NotSentReason;
    readonly pending: TrackedRequest | null;

    constructor(reason: NotSentReason, message: string, pending: TrackedRequest | null = null) {
        super(message);
        this.name = 'NotSentError';
        this.reason = reason;
        this.pending = pending;
    }
}

const DEFAULT_NAMESPACE = 'frl';
const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ERROR_TEXT = 500;
const MAX_SLOT_LENGTH = 256;
const STATES: readonly TrackedState[] = ['unconfirmed', 'completed', 'rejected'];

/** A cryptographically random request id. */
export function randomRequestId(): string {
    const source = (globalThis as { crypto?: Crypto }).crypto;
    if (source && typeof source.randomUUID === 'function') return source.randomUUID();
    if (source && typeof source.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        source.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('no cryptographically secure random source is available');
}

/**
 * Storage layout (per namespace and actor). Apart from the slot record, no key is
 * ever written from a read-modify-write of another tab's data, so a tab with an
 * old view of localStorage cannot overwrite what another tab stored:
 *   entry/<actor>/<id>         the request as created by `submit`; never rewritten
 *   try/<actor>/<id>/<tab>     attempts and the last error, written only by that tab
 *   done/<actor>/<id>/<tab>    a settled outcome, written only by that tab, at most once
 *   gone/<actor>/<id>          removal marker (acknowledged or discarded)
 *   slot/<actor>/<slot>        the ids of the slot's requests; written only by `submit` (and `resetSlot`), inside the
 *                              lock (when a lock manager is available), before the new request record, so every
 *                              request record that exists is listed in it
 *   slotcopy/<actor>/<slot>    a second copy of that record, written right after it: when one copy cannot be parsed,
 *                              the other restores it; when neither can, the slot stays blocked (never "empty")
 *   lost/<actor>/<id>          written by `discardBroken` before it removes a request record that cannot be parsed:
 *                              a slot whose record still lists that id stays blocked until `resetSlot`
 * A request exists only while its entry record exists and no removal marker
 * does. Attempt and outcome records without an entry are leftovers of a removed
 * request and are ignored, so a late write can never bring a request back.
 * Listing keys (Storage.key) can skip a key, without any error, while another tab
 * removes one, so decisions that must not miss a request read its keys directly:
 * the slot record names the slot's requests, and each request's own records are
 * read by key. Listings are used to show requests and to clean up.
 */

/** Per-storage state shared by every tracker in this tab (so two trackers never disagree). */
interface TabState {
    /** Random id naming the attempt and outcome records only this tab writes. */
    readonly id: string;
    /** Writes this tab could not save yet (value, or null for a removal), by key. Overlaid on reads and retried on every operation. */
    readonly overlay: Map<string, string | null>;
    /** Entry records last read successfully, used only while storage cannot be read. */
    readonly known: Map<string, string>;
    /**
     * The earliest settled outcome of each request seen in this tab, with the tab id that wrote it (the tie-break of
     * the ordering): a failed or partial read never turns it back into unconfirmed or into a later outcome.
     */
    readonly settled: Map<string, { readonly entry: TrackedRequest; readonly tab: string }>;
    /** Attempts in flight in this tab, keyed by entry key. A second send for the same request joins the first. */
    readonly inflight: Map<string, Promise<SubmitOutcome<unknown>>>;
    readonly listeners: Set<() => void>;
}

const tabStates = new WeakMap<object, TabState>();

function newTabId(): string {
    return randomRequestId().replace(/-/g, '').slice(0, 20);
}

function tabStateFor(storage: StorageLike | null): TabState {
    const fresh = (): TabState => ({ id: newTabId(), overlay: new Map(), known: new Map(), settled: new Map(), inflight: new Map(), listeners: new Set() });
    if (!storage) return fresh();
    let state = tabStates.get(storage);
    if (!state) {
        state = fresh();
        tabStates.set(storage, state);
    }
    return state;
}

function defaultStorage(): StorageLike | null {
    try {
        return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
    } catch {
        return null; // Access can throw (blocked storage, sandboxed frames).
    }
}

function defaultLocks(): LockManagerLike | null {
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
}

function defaultCrossTab(): CrossTabPort | null {
    const target = globalThis as {
        addEventListener?: (type: string, handler: (event: Event) => void) => void;
        removeEventListener?: (type: string, handler: (event: Event) => void) => void;
    };
    if (typeof target.addEventListener !== 'function') return null;
    return {
        subscribe(listener) {
            const handler = (event: Event): void => listener((event as StorageEvent).key ?? null);
            target.addEventListener?.('storage', handler);
            return () => target.removeEventListener?.('storage', handler);
        },
    };
}

function clip(text: string): string {
    return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

function describeError(error: unknown): AttemptError {
    const value = error as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
    const code = typeof value?.code === 'string' ? value.code
        : typeof value?.code === 'number' ? String(value.code)
            : typeof value?.name === 'string' ? value.name : 'error';
    const message = typeof value?.message === 'string' ? value.message : String(error);
    return { code: clip(code), message: clip(message) };
}

function describeReply(reply: unknown): AttemptError {
    const value = reply as { code?: unknown; message?: unknown } | null | undefined;
    if (value && typeof value === 'object' && typeof value.code === 'string') {
        return { code: clip(value.code), message: clip(typeof value.message === 'string' ? value.message : '') };
    }
    return { code: 'unrecognized-reply', message: 'the reply did not settle this request' };
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isAttemptError(value: unknown): value is AttemptError {
    return typeof value === 'object' && value !== null
        && typeof (value as AttemptError).code === 'string'
        && typeof (value as AttemptError).message === 'string';
}

function isSettledOutcome(value: unknown, state: TrackedState): value is SettledOutcome {
    if (typeof value !== 'object' || value === null) return false;
    const outcome = value as Record<string, unknown>;
    if (state === 'completed') {
        return outcome.status === 'completed'
            && Object.prototype.hasOwnProperty.call(outcome, 'result')
            && typeof outcome.replayed === 'boolean';
    }
    return state === 'rejected'
        && outcome.status === 'rejected'
        && typeof outcome.code === 'string'
        && typeof outcome.message === 'string';
}

/** Parse a stored entry and check it belongs to (actor, requestId). Null when unreadable. */
function parseEntry(raw: string, actor: string, requestId: string): TrackedRequest | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const entry = value as Record<string, unknown>;
    const state = entry.state as TrackedState;
    const valid = entry.v === 1
        && entry.requestId === requestId && isValidRequestId(entry.requestId)
        && entry.actor === actor
        && typeof entry.operation === 'string' && entry.operation.length > 0
        && typeof entry.slot === 'string' && entry.slot.length > 0
        && Object.prototype.hasOwnProperty.call(entry, 'input')
        && isFiniteNumber(entry.createdAt)
        && Number.isSafeInteger(entry.attempts) && (entry.attempts as number) >= 0
        && (entry.lastAttemptAt === null || isFiniteNumber(entry.lastAttemptAt))
        && (entry.lastError === null || isAttemptError(entry.lastError))
        && STATES.includes(state)
        && (state === 'unconfirmed'
            ? entry.outcome === null && entry.settledAt === null
            : isSettledOutcome(entry.outcome, state) && isFiniteNumber(entry.settledAt));
    return valid ? (entry as unknown as TrackedRequest) : null;
}

interface AttemptRecord {
    readonly v: 1;
    readonly attempts: number;
    readonly lastAttemptAt: number | null;
    readonly lastError: AttemptError | null;
    readonly errorAt: number | null;
}

interface OutcomeRecord {
    readonly v: 1;
    readonly state: 'completed' | 'rejected';
    readonly outcome: SettledOutcome;
    readonly settledAt: number;
}

function parseJson(raw: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(raw);
        return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function parseAttempt(raw: string): AttemptRecord | null {
    const value = parseJson(raw);
    const valid = !!value && value.v === 1
        && Number.isSafeInteger(value.attempts) && (value.attempts as number) >= 0
        && (value.lastAttemptAt === null || isFiniteNumber(value.lastAttemptAt))
        && (value.lastError === null || isAttemptError(value.lastError))
        && (value.errorAt === null || isFiniteNumber(value.errorAt));
    return valid ? (value as unknown as AttemptRecord) : null;
}

function parseOutcome(raw: string): OutcomeRecord | null {
    const value = parseJson(raw);
    const state = value?.state;
    const valid = !!value && value.v === 1
        && (state === 'completed' || state === 'rejected')
        && isSettledOutcome(value.outcome, state)
        && isFiniteNumber(value.settledAt);
    return valid ? (value as unknown as OutcomeRecord) : null;
}

/** The request ids a slot record lists, or null when it is not a valid slot record. */
function parseSlotRecord(raw: string): string[] | null {
    const value = parseJson(raw);
    if (!value || value.v !== 1 || !Array.isArray(value.ids)) return null;
    const ids: unknown[] = value.ids;
    return ids.every((id) => typeof id === 'string' && isValidRequestId(id)) ? [...new Set(ids as string[])] : null;
}

/** The settled outcome every tab agrees on: the earliest one, ties broken by the writing tab's id. */
function firstSettled(candidates: { readonly settledAt: number; readonly tab: string }[]): number {
    let best = -1;
    candidates.forEach((candidate, index) => {
        const current = candidates[best];
        if (!current || candidate.settledAt < current.settledAt
            || (candidate.settledAt === current.settledAt && candidate.tab < current.tab)) best = index;
    });
    return best;
}

function outcomeOf<R>(entry: TrackedRequest): SubmitOutcome<R> {
    const outcome = entry.outcome;
    if (entry.state === 'completed' && outcome?.status === 'completed') {
        return { status: 'completed', requestId: entry.requestId, result: outcome.result as R, replayed: outcome.replayed };
    }
    if (entry.state === 'rejected' && outcome?.status === 'rejected') {
        return { status: 'rejected', requestId: entry.requestId, code: outcome.code, message: outcome.message };
    }
    return { status: 'unconfirmed', requestId: entry.requestId, error: entry.lastError };
}

/** The JSON value that will actually be sent. Later changes to the caller's object cannot leak in. */
function jsonSnapshot<I>(input: I): I {
    let text: string | undefined;
    try {
        text = JSON.stringify(input);
    } catch {
        throw new NotSentError('invalid-input', 'input must be JSON-serialisable');
    }
    if (text === undefined) throw new NotSentError('invalid-input', 'input must be JSON-serialisable');
    return JSON.parse(text) as I;
}

interface View {
    readonly entry: TrackedRequest | null;
    /** A removal marker exists: the request was acknowledged or discarded and must not come back. */
    readonly gone: boolean;
    /** Keys that cannot be read (the entry record, or an outcome record that may hold the result). */
    readonly brokenKeys: readonly string[];
    /** The writing tab of the settled outcome shown ('' for one stored in the entry record itself). */
    readonly winnerTab?: string;
}

interface Parts {
    entry: string | null;
    readonly tries: [string, string][];
    readonly dones: [string, string][];
    gone: boolean;
}

export function createRequestTracker(options: RequestTrackerOptions): RequestTracker {
    const actor = options.actor;
    if (typeof actor !== 'string' || actor.length === 0) throw new Error('actor must be a non-empty string');
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    const locks = options.locks === undefined ? defaultLocks() : options.locks;
    const crossTab = options.crossTab === undefined ? defaultCrossTab() : options.crossTab;
    const newRequestId = options.newRequestId ?? randomRequestId;
    const now = options.now ?? Date.now;
    const tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    const tab = tabStateFor(storage);

    const ns = encodeURIComponent(options.namespace ?? DEFAULT_NAMESPACE);
    const actorPart = encodeURIComponent(actor);
    const keyRoot = `${ns}/v1/`;
    const entryPrefix = `${keyRoot}entry/${actorPart}/`;
    const tryPrefix = `${keyRoot}try/${actorPart}/`;
    const donePrefix = `${keyRoot}done/${actorPart}/`;
    const tombPrefix = `${keyRoot}gone/${actorPart}/`;
    const slotPrefix = `${keyRoot}slot/${actorPart}/`;
    const slotCopyPrefix = `${keyRoot}slotcopy/${actorPart}/`;
    const lostPrefix = `${keyRoot}lost/${actorPart}/`;
    const entryKey = (requestId: string): string => `${entryPrefix}${requestId}`;
    const tryKey = (requestId: string, tabId: string = tab.id): string => `${tryPrefix}${requestId}/${tabId}`;
    const doneKey = (requestId: string, tabId: string = tab.id): string => `${donePrefix}${requestId}/${tabId}`;
    const tombKey = (requestId: string): string => `${tombPrefix}${requestId}`;
    const slotKey = (slot: string): string => `${slotPrefix}${encodeURIComponent(slot)}`;
    const slotCopyKey = (slot: string): string => `${slotCopyPrefix}${encodeURIComponent(slot)}`;
    const lostKey = (requestId: string): string => `${lostPrefix}${requestId}`;
    const ownPrefixes = [entryPrefix, tryPrefix, donePrefix, tombPrefix];
    const lockName = `firestore-request-ledger:${ns}:${actorPart}`;

    function notify(): void {
        for (const listener of [...tab.listeners]) {
            try {
                listener();
            } catch {
                // A failing listener must not break the tracker.
            }
        }
    }

    /** Read one key: this tab's unsaved write first, then storage. Throws when storage cannot be read. */
    function readKey(key: string): string | null {
        if (tab.overlay.has(key)) return tab.overlay.get(key) ?? null;
        if (!storage) return null;
        return storage.getItem(key);
    }

    /** Write (or with null, remove) one key; keep it in this tab's overlay to retry when storage refuses. */
    function writeKey(key: string, value: string | null): boolean {
        if (storage) {
            try {
                if (value === null) storage.removeItem(key);
                else storage.setItem(key, value);
                tab.overlay.delete(key);
                return true;
            } catch {
                // Kept below.
            }
        }
        tab.overlay.set(key, value);
        return false;
    }

    /** Retry every write this tab could not save yet. Attempt and outcome records of a removed request are dropped. */
    function flush(): void {
        if (!storage) return;
        for (const [key, value] of [...tab.overlay]) {
            const id = recordId(key);
            try {
                if (value !== null && id && (key.startsWith(tryPrefix) || key.startsWith(donePrefix)) && storage.getItem(tombKey(id)) !== null) {
                    tab.overlay.delete(key);
                    continue;
                }
                if (value === null) storage.removeItem(key);
                else storage.setItem(key, value);
                tab.overlay.delete(key);
            } catch {
                // Still unsaved; reported by durable().
            }
        }
    }

    /** The request id inside one of this actor's keys, or null. */
    function recordId(key: string): string | null {
        for (const prefix of ownPrefixes) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const slash = rest.indexOf('/');
            return slash === -1 ? rest : rest.slice(0, slash);
        }
        return null;
    }

    /**
     * Every stored key of this actor (under `prefixes`) plus this tab's unsaved writes. Null when storage cannot be
     * listed. A listing can skip a key that exists while another tab changes storage: it shows, it does not prove absence.
     */
    function listKeys(prefixes: readonly string[] = ownPrefixes): string[] | null {
        const keys = new Set<string>();
        let readable = true;
        if (storage) {
            try {
                for (let index = 0; index < storage.length; index += 1) {
                    const key = storage.key(index);
                    if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.add(key);
                }
            } catch {
                readable = false;
            }
        }
        for (const [key, value] of tab.overlay) {
            if (value === null) keys.delete(key);
            else if (prefixes.some((prefix) => key.startsWith(prefix))) keys.add(key);
        }
        return readable ? [...keys] : null;
    }

    /** Whether the most recent read of this actor's records hit a storage error (see `readable()`). */
    let lastReadFailed = false;

    /** Group this actor's records by request id (only `onlyId` when given). `failed` is true when any read threw. */
    function collect(onlyId: string | null): { parts: Map<string, Parts>; failed: boolean } {
        let failed = false;
        const parts = new Map<string, Parts>();
        const partsOf = (id: string): Parts => {
            let found = parts.get(id);
            if (!found) {
                found = { entry: null, tries: [], dones: [], gone: false };
                parts.set(id, found);
            }
            return found;
        };
        const keys = listKeys();
        if (keys === null) {
            failed = true;
            // Storage cannot be read: show what this tab last read, plus its own unsaved writes.
            for (const [key, raw] of tab.known) {
                const id = recordId(key);
                if (id && (!onlyId || id === onlyId)) partsOf(id).entry = raw;
            }
        }
        const toRead = new Set(keys ?? tab.overlay.keys());
        // One request's own keys are read directly as well: a listing can skip them without any error.
        if (onlyId) for (const key of [entryKey(onlyId), tombKey(onlyId), tryKey(onlyId), doneKey(onlyId)]) toRead.add(key);
        for (const key of toRead) {
            const id = recordId(key);
            if (!id || (onlyId && id !== onlyId)) continue;
            let raw: string | null;
            try {
                raw = readKey(key);
            } catch {
                failed = true;
                raw = key.startsWith(entryPrefix) ? tab.known.get(key) ?? null : tab.overlay.get(key) ?? null;
            }
            if (raw === null) continue;
            const tabPart = key.slice(key.lastIndexOf('/') + 1);
            if (key.startsWith(entryPrefix)) {
                partsOf(id).entry = raw;
                tab.known.set(key, raw);
            } else if (key.startsWith(tryPrefix)) partsOf(id).tries.push([tabPart, raw]);
            else if (key.startsWith(donePrefix)) partsOf(id).dones.push([tabPart, raw]);
            else partsOf(id).gone = true;
        }
        lastReadFailed = failed;
        return { parts, failed };
    }

    /** One request as all tabs will see it once storage has caught up. */
    function fold(requestId: string, parts: Parts | undefined): View {
        if (!parts) return { entry: null, gone: false, brokenKeys: [] };
        if (parts.gone) return { entry: null, gone: true, brokenKeys: [] };
        if (parts.entry === null) return { entry: null, gone: false, brokenKeys: [] }; // leftovers of a removed request
        const base = parseEntry(parts.entry, actor, requestId);
        if (!base) return { entry: null, gone: false, brokenKeys: [entryKey(requestId)] };
        let attempts = base.attempts;
        let lastAttemptAt = base.lastAttemptAt;
        let lastError = base.lastError;
        let errorAt = base.lastError ? base.lastAttemptAt ?? 0 : Number.NEGATIVE_INFINITY;
        let errorTab = '';
        for (const [tabPart, raw] of parts.tries) {
            const record = parseAttempt(raw);
            if (!record) continue; // attempt counts are informational
            attempts += record.attempts;
            if (record.lastAttemptAt !== null && (lastAttemptAt === null || record.lastAttemptAt > lastAttemptAt)) lastAttemptAt = record.lastAttemptAt;
            if (record.lastError && record.errorAt !== null
                && (record.errorAt > errorAt || (record.errorAt === errorAt && tabPart > errorTab))) {
                lastError = record.lastError;
                errorAt = record.errorAt;
                errorTab = tabPart;
            }
        }
        const candidates: { state: 'completed' | 'rejected'; outcome: SettledOutcome; settledAt: number; tab: string }[] = [];
        if (base.state !== 'unconfirmed' && base.outcome && base.settledAt !== null) {
            candidates.push({ state: base.state, outcome: base.outcome, settledAt: base.settledAt, tab: '' });
        }
        const brokenKeys: string[] = [];
        for (const [tabPart, raw] of parts.dones) {
            const record = parseOutcome(raw);
            if (record) candidates.push({ state: record.state, outcome: record.outcome, settledAt: record.settledAt, tab: tabPart });
            else brokenKeys.push(doneKey(requestId, tabPart)); // it may hold the result: never guess
        }
        if (brokenKeys.length > 0) return { entry: null, gone: false, brokenKeys };
        const winner = candidates[firstSettled(candidates)];
        const entry: TrackedRequest = winner
            ? { ...base, attempts, lastAttemptAt, lastError, state: winner.state, outcome: winner.outcome, settledAt: winner.settledAt }
            : { ...base, attempts, lastAttemptAt, lastError, state: 'unconfirmed', outcome: null, settledAt: null };
        return { entry, gone: false, brokenKeys: [], winnerTab: winner ? winner.tab : undefined };
    }

    /**
     * Settled states never go back to unconfirmed in this tab. When a read fails (or an outcome record cannot be
     * seen), the last settled view seen here is kept. A request that is confirmed removed (marker, or no request
     * record while storage could be read) is forgotten.
     */
    function remember(requestId: string, current: View, failed: boolean): View {
        const memoryKey = entryKey(requestId);
        if (current.gone || (!current.entry && !failed && current.brokenKeys.length === 0)) {
            tab.settled.delete(memoryKey);
            return current;
        }
        const remembered = tab.settled.get(memoryKey);
        const seen = current.entry;
        if (seen && seen.state !== 'unconfirmed' && seen.settledAt !== null) {
            const shown = { entry: seen, tab: current.winnerTab ?? '' };
            // A read that misses the earliest outcome record (a partial read) must not replace it with a later one:
            // the remembered outcome takes part in the same "earliest settledAt, then tab id" ordering.
            const earlier = remembered && remembered.entry.settledAt !== null
                && (remembered.entry.settledAt < seen.settledAt
                    || (remembered.entry.settledAt === seen.settledAt && remembered.tab < shown.tab));
            if (!earlier) {
                tab.settled.set(memoryKey, shown);
                return current;
            }
        }
        if (!remembered) return current;
        const entry: TrackedRequest = seen
            ? { ...remembered.entry, attempts: Math.max(remembered.entry.attempts, seen.attempts), lastAttemptAt: seen.lastAttemptAt ?? remembered.entry.lastAttemptAt }
            : remembered.entry;
        return { entry, gone: false, brokenKeys: current.brokenKeys };
    }

    /** One request, with whether any read failed. Its own keys are read directly, so a listing that skips them does not hide it. */
    function readView(requestId: string): { view: View; failed: boolean } {
        const { parts, failed } = collect(requestId);
        return { view: remember(requestId, fold(requestId, parts.get(requestId)), failed), failed };
    }

    function view(requestId: string): View {
        return readView(requestId).view;
    }

    /** This tab's own attempt record for a request (zero when it has none). */
    function ownAttempt(requestId: string): AttemptRecord {
        let raw: string | null = null;
        try {
            raw = readKey(tryKey(requestId));
        } catch {
            raw = tab.overlay.get(tryKey(requestId)) ?? null;
        }
        return (raw !== null ? parseAttempt(raw) : null) ?? { v: 1, attempts: 0, lastAttemptAt: null, lastError: null, errorAt: null };
    }

    /** Count a send started by this tab. */
    function recordAttempt(requestId: string): void {
        const own = ownAttempt(requestId);
        writeKey(tryKey(requestId), JSON.stringify({ ...own, attempts: own.attempts + 1, lastAttemptAt: now() }));
        notify();
    }

    /** Remove every record of a request; the removal marker goes first so other tabs stop showing it immediately. */
    function remove(requestId: string, tombstone: boolean): void {
        if (tombstone) writeKey(tombKey(requestId), String(now()));
        const keys = listKeys() ?? [];
        for (const key of new Set([entryKey(requestId), tryKey(requestId), doneKey(requestId), ...keys.filter((key) => recordId(key) === requestId && !key.startsWith(tombPrefix))])) {
            writeKey(key, null);
        }
        tab.known.delete(entryKey(requestId));
        notify();
    }

    /** Expired removal markers go, together with every record left for that request (including late writes). */
    function pruneTombstones(): void {
        if (!storage) return;
        const keys = listKeys();
        if (keys === null) return; // Pruning only saves space.
        const expired = new Set<string>();
        for (const key of keys) {
            if (!key.startsWith(tombPrefix)) continue;
            let at = Number.NaN;
            try {
                at = Number(readKey(key));
            } catch {
                continue;
            }
            if (!Number.isFinite(at) || now() - at > tombstoneTtlMs) expired.add(key.slice(tombPrefix.length));
        }
        const listed = new Set(keys.filter((key) => key.startsWith(entryPrefix)).map((key) => key.slice(entryPrefix.length)));
        for (const key of keys) {
            const id = recordId(key);
            if (!id || key.startsWith(tombPrefix)) continue;
            if (expired.has(id)) {
                writeKey(key, null);
                continue;
            }
            if (listed.has(id) || !(key.startsWith(tryPrefix) || key.startsWith(donePrefix))) continue;
            if (isLeftover(id, key)) writeKey(key, null);
        }
        for (const id of expired) writeKey(tombKey(id), null);
    }

    /**
     * An attempt or outcome record is removed as a leftover only with positive evidence, never because a listing
     * did not show its request record (other tabs can change storage while it is listed): its request record and
     * removal marker are both confirmed absent by direct reads, and the record itself is older than the marker
     * lifetime. Anything that cannot be confirmed is kept; leftovers are ignored by every read anyway.
     */
    function isLeftover(requestId: string, key: string): boolean {
        if (!storage) return false;
        try {
            if (storage.getItem(entryKey(requestId)) !== null) return false;
            if (storage.getItem(tombKey(requestId)) !== null) return false; // goes with the marker when it expires
            const raw = storage.getItem(key);
            if (raw === null) return false;
            const written = key.startsWith(donePrefix)
                ? parseOutcome(raw)?.settledAt
                : (() => {
                    const record = parseAttempt(raw);
                    return record ? Math.max(record.lastAttemptAt ?? Number.NEGATIVE_INFINITY, record.errorAt ?? Number.NEGATIVE_INFINITY) : undefined;
                })();
            return typeof written === 'number' && Number.isFinite(written) && now() - written > tombstoneTtlMs;
        } catch {
            return false;
        }
    }

    function scan(): { entries: TrackedRequest[]; broken: string[] } {
        flush();
        const entries: TrackedRequest[] = [];
        const broken: string[] = [];
        const { parts: all, failed } = collect(null);
        const ids = new Set(all.keys());
        if (failed) {
            for (const key of tab.settled.keys()) {
                const id = recordId(key);
                if (id) ids.add(id);
            }
        }
        let anyFailed = failed;
        for (const id of ids) {
            const folded = fold(id, all.get(id));
            let current: View;
            if (!folded.entry && !folded.gone && folded.brokenKeys.length === 0 && !failed) {
                // The listing showed records of this request but not its request record. A listing can skip a key
                // without any error, so that is no proof of removal: read the request's own keys directly before
                // treating it as gone (which would also forget the settled outcome seen in this tab).
                const direct = readView(id);
                anyFailed = anyFailed || direct.failed;
                current = direct.view;
            } else {
                current = remember(id, folded, failed);
            }
            if (current.entry) entries.push(current.entry);
            broken.push(...current.brokenKeys);
        }
        lastReadFailed = anyFailed;
        entries.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
        return { entries, broken };
    }

    /**
     * A slot's record and its copy, both read directly; `ids` is their union. `ids` is null when neither copy can be
     * used (one cannot be parsed and the other is missing or cannot be parsed either): the slot's requests are then
     * unknown, which is never the same as "none". `repair` is true when a copy is missing, damaged or behind.
     * Throws NotSentError('storage-unreadable') when a copy cannot be read.
     */
    function readSlot(slot: string): { ids: string[] | null; repair: boolean } {
        const read = (key: string): string | null => {
            try {
                return readKey(key);
            } catch {
                throw new NotSentError('storage-unreadable', 'the record of this slot cannot be read right now, so this slot cannot be checked; nothing was sent');
            }
        };
        const first = read(slotKey(slot));
        const second = read(slotCopyKey(slot));
        if (first === null && second === null) return { ids: [], repair: false };
        const a = first === null ? null : parseSlotRecord(first);
        const b = second === null ? null : parseSlotRecord(second);
        if (!a && !b) return { ids: null, repair: false };
        const ids = [...new Set([...(a ?? []), ...(b ?? [])])];
        return { ids, repair: !a || !b || a.length !== ids.length || b.length !== ids.length };
    }

    /** Write a slot's record, then its copy, each read back. Throws when either cannot be saved. */
    function writeSlot(slot: string, ids: readonly string[]): void {
        if (!storage) throw new Error('no storage');
        const text = JSON.stringify({ v: 1, ids });
        for (const key of [slotKey(slot), slotCopyKey(slot)]) {
            storage.setItem(key, text);
            if (storage.getItem(key) !== text) throw new Error('read-back mismatch');
        }
    }

    /**
     * Listed ids whose request record `discardBroken` removed as unreadable (read directly): such a request may have been
     * sent with its reply lost, and its content is gone, so the slot cannot be judged free.
     */
    function lostIn(ids: readonly string[]): string[] {
        return ids.filter((id) => {
            if (requestRecordExists(id)) return false;
            try {
                return readKey(lostKey(id)) !== null;
            } catch {
                throw new NotSentError('storage-unreadable', 'the records of this slot cannot be read right now, so this slot cannot be checked; nothing was sent');
            }
        });
    }

    /** Whether discardBroken() left a lost marker for this id (read directly). True when that cannot be confirmed. */
    function lostMarkerExists(requestId: string): boolean {
        try {
            return readKey(lostKey(requestId)) !== null;
        } catch {
            return true;
        }
    }

    /** Slots whose record a listing shows and which cannot be used (neither copy can be parsed, or it lists a lost request). Best effort. */
    function blockedSlots(): string[] {
        const names = new Set<string>();
        for (const key of listKeys([slotPrefix, slotCopyPrefix]) ?? []) {
            const encoded = key.startsWith(slotPrefix) ? key.slice(slotPrefix.length) : key.slice(slotCopyPrefix.length);
            try {
                names.add(decodeURIComponent(encoded));
            } catch {
                // Not a key this tracker wrote.
            }
        }
        return [...names].filter((slot) => {
            try {
                const ids = readSlot(slot).ids;
                return ids === null || lostIn(ids).length > 0;
            } catch {
                return false; // Not readable now: submit refuses for that slot; readable() reports failed reads.
            }
        });
    }

    /** Whether a request record exists, by a direct read. True when that cannot be confirmed. */
    function requestRecordExists(requestId: string): boolean {
        if (!storage) return true;
        try {
            return storage.getItem(entryKey(requestId)) !== null;
        } catch {
            return true;
        }
    }

    function withLock<T>(task: () => Promise<T>): Promise<T> {
        if (locks) return locks.request(lockName, () => task());
        if (options.requireLocks) {
            return Promise.reject(new NotSentError('locks-unavailable', 'cross-tab locking is unavailable in this browser; nothing was sent'));
        }
        return task();
    }

    function settle(entry: TrackedRequest, reply: LedgerReply<unknown>): TrackedRequest {
        const outcome: SettledOutcome = reply.status === 'completed'
            ? { status: 'completed', result: reply.result, replayed: reply.replayed }
            : { status: 'rejected', code: reply.code, message: reply.message };
        return { ...entry, state: reply.status, outcome, settledAt: now() };
    }

    /**
     * A settled reply arrived. This tab writes its own outcome record once; every tab then agrees on the
     * earliest settled outcome. A request that is no longer tracked (removed, or its entry record gone) is
     * not written back: the caller still gets this reply, but nothing reappears in the list.
     */
    function recordSettled<R>(requestId: string, known: TrackedRequest, reply: LedgerReply<unknown>): SubmitOutcome<R> {
        flush();
        const current = view(requestId);
        if (!current.entry) return outcomeOf<R>(settle(known, reply));
        if (current.entry.state !== 'unconfirmed') return outcomeOf<R>(current.entry);
        const settled = settle(current.entry, reply);
        const record: OutcomeRecord = { v: 1, state: settled.state as 'completed' | 'rejected', outcome: settled.outcome as SettledOutcome, settledAt: settled.settledAt as number };
        writeKey(doneKey(requestId), JSON.stringify(record));
        notify();
        const after = view(requestId).entry;
        return outcomeOf<R>(after && after.state !== 'unconfirmed' ? after : settled);
    }

    /** An attempt ended without a settled reply: only this tab's attempt record changes. Never downgrades a settled request. */
    function recordUnknown<R>(requestId: string, error: AttemptError): SubmitOutcome<R> {
        flush();
        const current = view(requestId);
        if (current.entry && current.entry.state === 'unconfirmed') {
            const own = ownAttempt(requestId);
            writeKey(tryKey(requestId), JSON.stringify({ ...own, lastError: error, errorAt: now() }));
            notify();
        }
        const after = view(requestId).entry;
        if (after && after.state !== 'unconfirmed') return outcomeOf<R>(after);
        return { status: 'unconfirmed', requestId, error };
    }

    function attempt<R>(
        requestId: string,
        send: SendFunction<unknown>,
        gate: { readonly stillValid?: (() => boolean) | undefined; readonly created: boolean },
    ): Promise<SubmitOutcome<R>> {
        const key = entryKey(requestId);
        const running = tab.inflight.get(key);
        if (running) return running as Promise<SubmitOutcome<R>>;

        flush();
        const before = view(requestId).entry;
        if (!before) {
            return Promise.reject(new NotSentError('unknown-request', 'this request is no longer tracked; nothing was sent'));
        }
        if (before.state !== 'unconfirmed') return Promise.resolve(outcomeOf<R>(before));

        // Last gate before the network: nothing below awaits until the send starts.
        if (gate.stillValid && !gate.stillValid()) {
            if (gate.created && before.attempts === 0) remove(requestId, false);
            return Promise.reject(new NotSentError('aborted', 'the operation was no longer valid; nothing was sent'));
        }
        recordAttempt(requestId);
        const marked = view(requestId).entry ?? before;

        const outgoing = { requestId, operation: marked.operation, input: marked.input };
        const run = (async (): Promise<SubmitOutcome<R>> => {
            let reply: unknown;
            try {
                reply = await send(outgoing);
            } catch (error) {
                return recordUnknown<R>(requestId, describeError(error));
            }
            const settled = settledReplyFor(reply, requestId);
            if (!settled) return recordUnknown<R>(requestId, describeReply(reply));
            return recordSettled<R>(requestId, marked, settled);
        })();
        tab.inflight.set(key, run as Promise<SubmitOutcome<unknown>>);
        const cleanup = (): void => {
            if (tab.inflight.get(key) === run) tab.inflight.delete(key);
        };
        run.then(cleanup, cleanup);
        return run;
    }

    async function submit<I, R = unknown>(request: SubmitRequest<I>): Promise<SubmitOutcome<R>> {
        const { slot, operation } = request;
        if (typeof slot !== 'string' || slot.length === 0 || slot.length > MAX_SLOT_LENGTH) {
            throw new NotSentError('invalid-slot', 'slot must be a non-empty string of at most 256 characters');
        }
        if (typeof operation !== 'string' || operation.length === 0) {
            throw new NotSentError('invalid-input', 'operation must be a non-empty string');
        }
        const input = jsonSnapshot(request.input);
        const chosen = await withLock(async () => {
            if (request.stillValid && !request.stillValid()) {
                throw new NotSentError('aborted', 'the operation was no longer valid; nothing was sent');
            }
            /**
             * The slot rule: reuse an open request with the same content, refuse different content, replay a settled
             * one; `found` null: create. The slot's requests are the ids its slot record lists, each read directly, plus
             * any a listing shows: a listing alone can skip a request without any error, and a new id for a request that
             * was missed would run the operation again.
             */
            const existing = (exclude: string | null): { found: TrackedRequest | null; listed: string[]; unlisted: string[]; repair: boolean } => {
                const record = readSlot(slot);
                if (!record.ids) {
                    throw new NotSentError(
                        'broken-slot',
                        'neither copy of this slot\'s record can be read, so its requests are unknown; nothing was sent. Make sure none of them is still unconfirmed, then call resetSlot()',
                    );
                }
                const listed = record.ids;
                const { entries, broken } = scan();
                let failed = lastReadFailed;
                const inSlot = new Map<string, TrackedRequest>();
                for (const entry of entries) if (entry.slot === slot) inSlot.set(entry.requestId, entry);
                for (const id of listed) {
                    if (inSlot.has(id)) continue;
                    const read = readView(id);
                    failed = failed || read.failed;
                    broken.push(...read.view.brokenKeys);
                    if (read.view.entry && read.view.entry.slot === slot) inSlot.set(id, read.view.entry);
                }
                // A request that cannot be read may be the open request of this slot: deciding "free" from a failed read
                // would send a second request under a new id (a second execution). Refuse instead.
                if (failed) {
                    throw new NotSentError('storage-unreadable', 'remembered requests cannot be read right now, so this slot cannot be checked; nothing was sent');
                }
                if (broken.length > 0) {
                    throw new NotSentError('broken-entries', 'some remembered requests cannot be read; review and remove them before sending new ones');
                }
                // Checked after the reads above. discardBroken() writes the lost marker before it removes the request
                // record, so a listed request whose record was missing above has its marker visible here, also when no
                // lock keeps discardBroken() from running in the middle of this check.
                if (lostIn(listed.filter((id) => !inSlot.has(id))).length > 0) {
                    throw new NotSentError(
                        'broken-slot',
                        'a request of this slot was removed as unreadable (discardBroken) and may have been sent; nothing was sent. Make sure it did not run, then call resetSlot()',
                    );
                }
                // Requests of this slot that only a listing showed (saved by an older version, by a tab without locks,
                // or listed in a slot record that was discarded as broken): written into the slot record below.
                const unlisted = [...inSlot.keys()].filter((id) => !listed.includes(id) && id !== exclude);
                const candidates = [...inSlot.values()]
                    .filter((entry) => entry.requestId !== exclude)
                    .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
                const open = candidates.find((entry) => entry.state === 'unconfirmed');
                if (open) {
                    if (open.operation === operation && sameJson(open.input, input)) return { found: open, listed, unlisted, repair: record.repair };
                    throw new NotSentError(
                        'slot-busy',
                        'an earlier request in this slot is still unconfirmed; check it or retry it with its original content first',
                        open,
                    );
                }
                return { found: candidates.find((entry) => entry.operation === operation && sameJson(entry.input, input)) ?? null, listed, unlisted, repair: record.repair };
            };
            /**
             * The slot record's ids, without those whose request record a direct read shows absent (removed, or a save that
             * failed). An id with a lost marker stays: it keeps the slot blocked until resetSlot().
             */
            const keptIds = (listed: readonly string[], unlisted: readonly string[]): string[] => [...listed, ...unlisted]
                .filter((id) => requestRecordExists(id) || lostMarkerExists(id));
            const { found, listed, unlisted, repair } = existing(null);
            if (found) {
                if (unlisted.length > 0 || repair) {
                    try {
                        writeSlot(slot, keptIds(listed, unlisted));
                    } catch {
                        // Best effort: the request is still found by listings.
                    }
                }
                return { entry: found, created: false };
            }
            if (!storage) throw new NotSentError('storage-unavailable', 'requests cannot be remembered in this browser; nothing was sent');

            const requestId = newRequestId();
            if (!isValidRequestId(requestId)) throw new Error('newRequestId returned an id that does not match REQUEST_ID_PATTERN');
            const entry: TrackedRequest = {
                v: 1,
                requestId,
                actor,
                operation,
                slot,
                input,
                createdAt: now(),
                attempts: 0,
                lastAttemptAt: null,
                lastError: null,
                state: 'unconfirmed',
                outcome: null,
                settledAt: null,
            };
            // Save before send: a request this browser cannot remember must not leave it. The slot record goes first, so
            // every request record that exists is listed in it; ids whose request record a direct read shows absent
            // (removed, or a save that failed) are dropped. Only submit writes it, inside its lock.
            const text = JSON.stringify(entry);
            try {
                writeSlot(slot, [...keptIds(listed, unlisted), requestId]);
                storage.setItem(entryKey(requestId), text);
                if (storage.getItem(entryKey(requestId)) !== text) throw new Error('read-back mismatch');
                tab.known.set(entryKey(requestId), text);
            } catch {
                try {
                    storage.removeItem(entryKey(requestId));
                } catch {
                    // Nothing more to undo.
                }
                throw new NotSentError('storage-unavailable', 'the request could not be saved in this browser; nothing was sent');
            }
            // Check the slot again (without locks, another tab may have saved a request in this slot meanwhile; a
            // request saved by an older version is found only by a listing). If this finds another request, the new
            // record is withdrawn before anything is sent.
            // Withdrawing the new record: without locks, the other tab's slot record write may have been overwritten by
            // ours, so the slot's requests are written back (ours is gone, so a direct read drops it).
            const withdraw = (): void => {
                remove(requestId, false);
                try {
                    const current = readSlot(slot).ids;
                    if (!current) return;
                    const shown = scan().entries.filter((other) => other.slot === slot).map((other) => other.requestId);
                    writeSlot(slot, keptIds(current, shown.filter((id) => !current.includes(id))));
                } catch {
                    // Best effort: the requests are still found by listings.
                }
            };
            let again: TrackedRequest | null;
            try {
                again = existing(requestId).found;
            } catch (error) {
                withdraw();
                throw error;
            }
            if (again) {
                withdraw();
                return { entry: again, created: false };
            }
            notify();
            return { entry, created: true };
        });
        return attempt<R>(chosen.entry.requestId, request.send as SendFunction<unknown>, {
            stillValid: request.stillValid,
            created: chosen.created,
        });
    }

    async function retry<R = unknown>(requestId: string, request: RetryRequest<unknown>): Promise<SubmitOutcome<R>> {
        return attempt<R>(requestId, request.send, { stillValid: request.stillValid, created: false });
    }

    async function check<R = unknown>(requestId: string, request: CheckRequest<unknown>): Promise<SubmitOutcome<R>> {
        flush();
        const entry = view(requestId).entry;
        if (!entry) throw new NotSentError('unknown-request', 'this request is no longer tracked');
        if (entry.state !== 'unconfirmed') return outcomeOf<R>(entry);
        let reply: unknown;
        try {
            reply = await request.lookup({ requestId, operation: entry.operation, input: entry.input });
        } catch (error) {
            return recordUnknown<R>(requestId, describeError(error));
        }
        const settled = settledReplyFor(reply, requestId);
        if (settled) return recordSettled<R>(requestId, entry, settled);
        if (isNotFoundFor(reply, requestId)) {
            return recordUnknown<R>(requestId, {
                code: 'not-found',
                message: 'the server has no outcome for this request yet; it may not have arrived or may still be running. Retrying with the same request id is safe.',
            });
        }
        return recordUnknown<R>(requestId, describeReply(reply));
    }

    function acknowledge(requestId: string): boolean {
        flush();
        const current = view(requestId).entry;
        if (!current || current.state === 'unconfirmed') return false;
        remove(requestId, true);
        return true;
    }

    function discard(requestId: string): boolean {
        flush();
        if (!view(requestId).entry) return false;
        remove(requestId, true);
        return true;
    }

    /** Runs inside the same lock as submit's slot check, so the check never sees half of it. */
    function discardBroken(): Promise<number> {
        return withLock(async () => discardBrokenLocked());
    }

    function discardBrokenLocked(): number {
        const { broken } = scan();
        let removed = 0;
        // A slot record is never removed here: it may be the only reliable list of the slot's requests. A copy that
        // cannot be parsed is restored from the other copy; a slot whose copies are both unusable stays blocked
        // (brokenSlots(), resetSlot()).
        for (const key of listKeys([slotPrefix, slotCopyPrefix]) ?? []) {
            const copy = key.startsWith(slotCopyPrefix);
            let slot: string;
            try {
                slot = decodeURIComponent(key.slice((copy ? slotCopyPrefix : slotPrefix).length));
                const raw = storage?.getItem(key) ?? null;
                if (raw === null || parseSlotRecord(raw)) continue;
                const other = storage?.getItem(copy ? slotKey(slot) : slotCopyKey(slot)) ?? null;
                const ids = other === null ? null : parseSlotRecord(other);
                if (!ids) continue;
                // A submit in another tab may rewrite both copies meanwhile; readers take the union of the two, so
                // writing this possibly older list into the damaged copy loses nothing.
                storage?.setItem(key, JSON.stringify({ v: 1, ids }));
                removed += 1;
            } catch {
                // Leave it; submit still reads both copies.
            }
        }
        for (const key of broken) {
            try {
                // An unreadable request record may have been sent with its reply lost. Its slot record (if it lists the
                // id) must not then look free: leave a marker first, unless the request was already removed.
                const id = key.startsWith(entryPrefix) ? recordId(key) : null;
                if (id && storage?.getItem(tombKey(id)) === null) {
                    const at = String(now());
                    storage.setItem(lostKey(id), at);
                    if (storage.getItem(lostKey(id)) !== at) continue;
                }
                storage?.removeItem(key);
                tab.known.delete(key);
                removed += 1;
            } catch {
                // Leave it; it is still reported.
            }
        }
        if (removed > 0) notify();
        return removed;
    }

    /**
     * Rebuild a slot's record from its usable copies (if any) and the slot's requests that a listing shows. Only for
     * a slot listed by brokenSlots(): a listing can skip a request, so the app must first make sure that no request
     * of this slot is still unconfirmed (for example with check() on the slot's requests in list()).
     */
    async function resetSlot(slot: string): Promise<string[]> {
        if (typeof slot !== 'string' || slot.length === 0 || slot.length > MAX_SLOT_LENGTH) {
            throw new NotSentError('invalid-slot', 'slot must be a non-empty string of at most 256 characters');
        }
        if (!storage) throw new NotSentError('storage-unavailable', 'requests cannot be remembered in this browser');
        return withLock(async () => {
            const current = readSlot(slot).ids ?? [];
            const { entries } = scan();
            if (lastReadFailed) throw new NotSentError('storage-unreadable', 'remembered requests cannot be read right now; nothing was changed');
            const ids = [...new Set([...current, ...entries.filter((entry) => entry.slot === slot).map((entry) => entry.requestId)])]
                .filter((id) => requestRecordExists(id));
            try {
                writeSlot(slot, ids);
            } catch {
                throw new NotSentError('storage-unavailable', 'the slot record could not be saved');
            }
            for (const id of current) {
                if (ids.includes(id)) continue;
                try {
                    storage.removeItem(lostKey(id));
                } catch {
                    // Harmless: the id is no longer listed in this slot.
                }
            }
            notify();
            return ids;
        });
    }

    function subscribe(listener: () => void): () => void {
        tab.listeners.add(listener);
        const stopCrossTab = crossTab?.subscribe((key) => {
            if (key === null || key.startsWith(keyRoot)) listener();
        });
        return () => {
            tab.listeners.delete(listener);
            stopCrossTab?.();
        };
    }

    /** Whether this actor's records could be read just now. While false, list() and get() show the last state seen in this tab. */
    function readable(): boolean {
        if (!storage) return false;
        flush();
        collect(null);
        return !lastReadFailed;
    }

    function durable(): boolean {
        if (!storage) return false;
        flush();
        for (const key of tab.overlay.keys()) {
            if (ownPrefixes.some((prefix) => key.startsWith(prefix))) return false;
        }
        return true;
    }

    return {
        actor,
        list() {
            pruneTombstones();
            return scan().entries;
        },
        get(requestId) {
            flush();
            return view(requestId).entry;
        },
        brokenCount() {
            return scan().broken.length;
        },
        brokenSlots() {
            flush();
            return blockedSlots();
        },
        resetSlot,
        submit,
        retry,
        check,
        acknowledge,
        discard,
        discardBroken,
        subscribe,
        durable,
        readable,
    };
}
