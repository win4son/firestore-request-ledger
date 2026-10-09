/**
 * The smallest slice of the Firestore server SDK this package touches.
 *
 * Declared structurally so the package has no runtime dependency and works with
 * whichever copy of `@google-cloud/firestore` your app already uses (the
 * Firestore instance returned by `firebase-admin` is one). Your operation hooks
 * receive your SDK's own `Transaction` type through the `Tx` parameter.
 */
export interface DocumentSnapshotLike {
    readonly exists: boolean;
    data(): unknown;
}

export interface DocumentReferenceLike {
    readonly id: string;
    readonly path: string;
}

export interface TransactionLike {
    get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike>;
    create(ref: DocumentReferenceLike, data: Record<string, unknown>): unknown;
}

export interface CollectionReferenceLike {
    doc(id: string): DocumentReferenceLike;
}

export interface FirestoreLike<Tx extends TransactionLike = TransactionLike> {
    collection(path: string): CollectionReferenceLike;
    runTransaction<T>(updateFunction: (transaction: Tx) => Promise<T>): Promise<T>;
}

/** Context passed to `authorize`. */
export interface AuthorizeContext {
    readonly actor: string;
    readonly requestId: string;
    readonly operation: string;
    readonly input: unknown;
    /**
     * true when this request id already has a stored outcome and the call is
     * about to replay it. A failure here is never stored and never terminal:
     * being refused now says nothing about whether the earlier attempt succeeded.
     */
    readonly replay: boolean;
}

/** Context passed to `read` and `write` (only for a request id with no stored outcome). */
export interface OperationContext<Payload> {
    readonly actor: string;
    /** Use it as the id of documents the operation creates, so they live and die with this request. */
    readonly requestId: string;
    readonly operation: string;
    readonly input: unknown;
    readonly payload: Payload;
}

/**
 * A business operation plugged into `execute`.
 *
 * Order inside one Firestore transaction attempt:
 *   1. the ledger reads this request id's record;
 *   2. stored outcome  -> `authorize(replay: true)`, then the stored outcome is returned;
 *   3. no record       -> `parse` -> `authorize(replay: false)` -> `read` -> `write`, and the
 *      ledger record is created in the same transaction as the business writes.
 *
 * Throw a `RequestRejection` (see `reject`) from `parse`, `authorize`, `read` or
 * `write` to refuse the request definitely. That refusal is stored and returned
 * as a terminal rejection only when step 3 applies. Any other error leaves no
 * record and propagates to the caller.
 */
export interface Operation<Tx, Payload = unknown, State = undefined, Result = unknown> {
    /** Stable name. Part of the content check: the same request id cannot be reused for another operation. */
    readonly name: string;
    /** Validate and normalise the input. Runs only when no outcome is stored for this request id. */
    parse?(input: unknown): Payload;
    /** Runs on every call, including replays. Request ids are not credentials. */
    authorize?(transaction: Tx, context: AuthorizeContext): void | Promise<void>;
    /** Transactional reads. Runs only when no outcome is stored. */
    read?(transaction: Tx, context: OperationContext<Payload>): State | Promise<State>;
    /**
     * Transactional writes. Must be synchronous, so it cannot read after writing.
     * The return value is stored as JSON and replayed verbatim, so keep it small.
     */
    write(transaction: Tx, context: OperationContext<Payload>, state: State): Result;
}

/** What the ledger stores per (actor, request id). */
export interface LedgerRecord {
    readonly v: 1;
    readonly actor: string;
    readonly requestId: string;
    readonly operation: string;
    /** SHA-256 over the operation name and canonical input. The input itself is not stored. */
    readonly fingerprint: string;
    readonly status: 'completed' | 'rejected';
    /** JSON text of the result (completed only). Stored as text so any JSON value round-trips exactly. */
    readonly resultJson?: string;
    readonly code?: string;
    readonly message?: string;
    readonly createdAt: unknown;
}
