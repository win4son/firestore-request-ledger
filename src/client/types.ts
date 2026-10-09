/** The parts of the Web Storage API the tracker uses (`localStorage` satisfies it). */
export interface StorageLike {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** The parts of the Web Locks API the tracker uses (`navigator.locks` satisfies it). */
export interface LockManagerLike {
    request<T>(name: string, callback: (lock: unknown) => T | Promise<T>): Promise<T>;
}

/** Notifies about storage changes made by other tabs (the browser's `storage` event). */
export interface CrossTabPort {
    subscribe(listener: (key: string | null) => void): () => void;
}

/** Why the most recent attempt did not settle the request. Informational only. */
export interface AttemptError {
    readonly code: string;
    readonly message: string;
}

export type TrackedState = 'unconfirmed' | 'completed' | 'rejected';

export type SettledOutcome<R = unknown> =
    | { readonly status: 'completed'; readonly result: R; readonly replayed: boolean }
    | { readonly status: 'rejected'; readonly code: string; readonly message: string };

/** One remembered request, exactly as it was (or will be) sent. */
export interface TrackedRequest<I = unknown, R = unknown> {
    readonly v: 1;
    readonly requestId: string;
    readonly actor: string;
    readonly operation: string;
    /** Caller-defined scope: at most one unconfirmed request per (actor, slot). */
    readonly slot: string;
    /** The complete input, as the JSON value that is sent. */
    readonly input: I;
    readonly createdAt: number;
    /** Sends started, summed over tabs; a lower bound when a tab could not save its count. */
    readonly attempts: number;
    readonly lastAttemptAt: number | null;
    readonly lastError: AttemptError | null;
    /** `unconfirmed` until a settled reply for this request id arrives; settled states never go back. */
    readonly state: TrackedState;
    readonly outcome: SettledOutcome<R> | null;
    readonly settledAt: number | null;
}

/** What `submit`, `retry` and `check` resolve to. Network failures are reported here, not thrown. */
export type SubmitOutcome<R = unknown> =
    | { readonly status: 'completed'; readonly requestId: string; readonly result: R; readonly replayed: boolean }
    | { readonly status: 'rejected'; readonly requestId: string; readonly code: string; readonly message: string }
    | { readonly status: 'unconfirmed'; readonly requestId: string; readonly error: AttemptError | null };

/** What your transport sends: always the complete stored request, never a re-built one. */
export interface OutgoingRequest<I = unknown> {
    readonly requestId: string;
    readonly operation: string;
    readonly input: I;
}

/**
 * Sends a request and resolves with the server's reply body. Reject (throw) on
 * network errors; resolve with whatever body you received otherwise. The tracker
 * decides from the body whether the request is settled.
 */
export type SendFunction<I = unknown> = (request: OutgoingRequest<I>) => Promise<unknown>;

/** Asks the server for the stored outcome without running anything. */
export type LookupFunction<I = unknown> = (request: OutgoingRequest<I>) => Promise<unknown>;

export interface RequestTrackerOptions {
    /** The signed-in user. Create a new tracker when the user changes. */
    readonly actor: string;
    /** Prefix for storage keys and lock names. Default `frl`. */
    readonly namespace?: string;
    /** Default: `globalThis.localStorage` when accessible, otherwise none (nothing can be sent). */
    readonly storage?: StorageLike | null;
    /** Default: `navigator.locks` when available. Serialises `submit` decisions across tabs. */
    readonly locks?: LockManagerLike | null;
    /** Refuse to send when no lock manager is available. Default false. */
    readonly requireLocks?: boolean;
    /** Default: the window `storage` event when running in a browser. */
    readonly crossTab?: CrossTabPort | null;
    /** Default: `crypto.randomUUID()`. Must match `REQUEST_ID_PATTERN`. */
    readonly newRequestId?: () => string;
    readonly now?: () => number;
    /** How long removal markers are kept. Removed requests never come back either way; this only bounds storage use. Default 30 days. */
    readonly tombstoneTtlMs?: number;
}

export interface SubmitRequest<I> {
    readonly slot: string;
    readonly operation: string;
    readonly input: I;
    readonly send: SendFunction<I>;
    /**
     * Checked after waiting for the lock and again immediately before sending.
     * Return false when the page unmounted, the user changed, or permission is gone.
     */
    readonly stillValid?: () => boolean;
}

export interface RetryRequest<I> {
    readonly send: SendFunction<I>;
    readonly stillValid?: () => boolean;
}

export interface CheckRequest<I> {
    readonly lookup: LookupFunction<I>;
}

export interface RequestTracker {
    readonly actor: string;
    /** This actor's remembered requests, oldest first. */
    list(): TrackedRequest[];
    get(requestId: string): TrackedRequest | null;
    /** Stored entries for this actor that cannot be read. While any exist, `submit` refuses. */
    brokenCount(): number;
    /**
     * Slots whose record cannot be used (neither copy can be parsed). `submit` refuses for these slots
     * (`broken-slot`) and `discardBroken()` leaves them alone, because their requests are unknown.
     */
    brokenSlots(): string[];
    /**
     * Rebuild a slot's record from what a listing shows. A listing can miss requests, so call this only after making
     * sure that no request of this slot is still unconfirmed. Resolves with the ids now recorded for the slot.
     */
    resetSlot(slot: string): Promise<string[]>;
    /**
     * Remember the request, then send it. Reuses the original request id when the
     * same slot already holds an unconfirmed (or settled, unacknowledged) request
     * with the same operation and input; refuses different content for a slot
     * that is still unconfirmed. Throws `NotSentError` only when nothing was sent.
     */
    submit<I, R = unknown>(request: SubmitRequest<I>): Promise<SubmitOutcome<R>>;
    /** Resend the stored request with its original id. A settled request resolves from storage without sending. */
    retry<R = unknown>(requestId: string, request: RetryRequest<unknown>): Promise<SubmitOutcome<R>>;
    /** Ask the server for the stored outcome. `not-found` keeps the request unconfirmed. */
    check<R = unknown>(requestId: string, request: CheckRequest<unknown>): Promise<SubmitOutcome<R>>;
    /** The user has seen a settled outcome: forget it. Unconfirmed requests are kept (returns false). */
    acknowledge(requestId: string): boolean;
    /** Forget a request regardless of state. Does not cancel anything on the server. */
    discard(requestId: string): boolean;
    /**
     * Remove unreadable entries for this actor, and restore a slot record copy that cannot be parsed from its other
     * copy. Returns how many records were removed or restored. Never removes a slot record. Runs inside the same lock
     * as `submit`'s slot check.
     */
    discardBroken(): Promise<number>;
    /** Called after changes from this tab or (with a cross-tab port) other tabs. */
    subscribe(listener: () => void): () => void;
    /** True when every change is saved to storage that survives a reload. */
    durable(): boolean;
    /**
     * True when this actor's stored requests could be read just now. While storage cannot be read, `list()` and
     * `get()` show the last state seen in this tab; a settled request is never shown as unconfirmed because of it.
     */
    readable(): boolean;
}
