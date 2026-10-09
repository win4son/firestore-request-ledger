import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/canonical.ts';
import { isValidRequestId } from '../shared/wire.ts';
import type { CompletedReply, ErrorReply, LedgerReply, LookupReply, RejectedReply } from '../shared/wire.ts';
import { LedgerError, RequestRejection } from './errors.ts';
import type {
    AuthorizeContext,
    DocumentReferenceLike,
    FirestoreLike,
    LedgerRecord,
    Operation,
    OperationContext,
    TransactionLike,
} from './types.ts';

export const DEFAULT_COLLECTION = 'requestLedger';
export const DEFAULT_MAX_RESULT_BYTES = 16 * 1024;
const RECORD_VERSION = 1;
const MAX_ACTOR_LENGTH = 512;
const MAX_OPERATION_LENGTH = 128;
const MAX_STORED_MESSAGE_LENGTH = 1000;

export interface Rejection {
    readonly code: string;
    readonly message: string;
}

/** Default classifier: only `RequestRejection` counts as a definite refusal. */
export function defaultClassifyRejection(error: unknown): Rejection | null {
    return error instanceof RequestRejection ? { code: error.code, message: error.message } : null;
}

export interface ExecuteOptions<Tx extends TransactionLike, Payload, State, Result> {
    readonly db: FirestoreLike<Tx>;
    readonly operation: Operation<Tx, Payload, State, Result>;
    /** The authenticated principal, derived by your server. Never take it from the request body. */
    readonly actor: string;
    readonly requestId: string;
    /** The complete request content as received (a JSON value). */
    readonly input: unknown;
    /** Collection holding ledger records. Default `requestLedger`. Deny all client access to it in your rules. */
    readonly collection?: string;
    /** Upper bound for the stored result JSON, in UTF-8 bytes. Default 16 KiB. */
    readonly maxResultBytes?: number;
    /**
     * Decide which errors are definite refusals. Return `{ code, message }` to
     * store a terminal rejection, or null to let the error propagate without a
     * record. `LedgerError`s are never passed to it. Default: `RequestRejection` only.
     */
    readonly classifyRejection?: (error: unknown) => Rejection | null;
    /** Value stored in `createdAt`. Default `() => new Date()`. Pass your SDK's `FieldValue.serverTimestamp`. */
    readonly timestamp?: () => unknown;
}

export interface LookupContext {
    readonly actor: string;
    readonly requestId: string;
    /** Operation name of the stored record, or null when there is none. */
    readonly operation: string | null;
}

export interface LookupOptions<Tx extends TransactionLike> {
    readonly db: FirestoreLike<Tx>;
    readonly actor: string;
    readonly requestId: string;
    readonly collection?: string;
    /** Runs before anything is revealed, including "not found". Throwing aborts the lookup. */
    readonly authorize?: (transaction: Tx, context: LookupContext) => void | Promise<void>;
    /** When given, the stored record must match this operation and input, as in `execute`. */
    readonly expect?: { readonly operation: string; readonly input: unknown };
}

function assertActor(actor: unknown): asserts actor is string {
    if (typeof actor !== 'string' || actor.length === 0 || actor.length > MAX_ACTOR_LENGTH) {
        throw new LedgerError('invalid-actor', 'actor must be a non-empty string derived from authentication');
    }
}

function assertRequestId(requestId: unknown): asserts requestId is string {
    if (!isValidRequestId(requestId)) {
        throw new LedgerError('invalid-request-id', 'requestId must be 8-128 characters of A-Z, a-z, 0-9, "_" or "-"');
    }
}

function assertOperationName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_OPERATION_LENGTH) {
        throw new LedgerError('invalid-operation', 'operation name must be a non-empty string of at most 128 characters');
    }
}

/**
 * Document id of the record for (actor, requestId). Scoping by actor means two
 * users can never replay, block or probe each other's requests by reusing an id.
 */
export function requestDocId(actor: string, requestId: string): string {
    assertActor(actor);
    assertRequestId(requestId);
    return createHash('sha256').update(JSON.stringify([actor, requestId])).digest('hex');
}

/** SHA-256 over the operation name and the canonical JSON of the complete input. */
export function fingerprintRequest(operation: string, input: unknown): string {
    assertOperationName(operation);
    let text: string | undefined;
    try {
        text = canonicalJson({ v: RECORD_VERSION, operation, input });
    } catch {
        throw new LedgerError('unfingerprintable-input', 'input must be a JSON value (no cycles or BigInt)');
    }
    return createHash('sha256').update(text ?? '').digest('hex');
}

function encodeResult(result: unknown, maxBytes: number): string {
    let json: string | undefined;
    try {
        json = JSON.stringify(result === undefined ? null : result);
    } catch {
        throw new LedgerError('invalid-result', 'operation result must be JSON-serialisable');
    }
    if (json === undefined) throw new LedgerError('invalid-result', 'operation result must be JSON-serialisable');
    if (new TextEncoder().encode(json).length > maxBytes) {
        throw new LedgerError('invalid-result', `operation result exceeds ${maxBytes} bytes; return identifiers, not documents`);
    }
    return json;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && typeof (value as { then?: unknown }).then === 'function';
}

function normaliseRejection(candidate: Rejection | null | undefined): Rejection | null {
    if (!candidate || typeof candidate.code !== 'string' || candidate.code.length === 0) return null;
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    return { code: candidate.code, message: message.slice(0, MAX_STORED_MESSAGE_LENGTH) };
}

interface Identity {
    readonly actor: string;
    readonly requestId: string;
    /** When null the content is not checked (lookup without `expect`). */
    readonly fingerprint: string | null;
}

/**
 * Answer from a stored record. Completed -> replayed result; rejected -> the same
 * terminal rejection. Anything that does not match the caller is a non-terminal error.
 */
function answerFromRecord<R>(data: unknown, identity: Identity): LedgerReply<R> {
    const record = (typeof data === 'object' && data !== null ? data : {}) as Partial<LedgerRecord>;
    if (record.actor !== identity.actor || record.requestId !== identity.requestId) {
        throw new LedgerError('actor-mismatch', 'this request id belongs to another actor');
    }
    if (identity.fingerprint !== null && record.fingerprint !== identity.fingerprint) {
        throw new LedgerError(
            'content-mismatch',
            'this request id was already used with a different operation or input; resend the original content or start a new request',
        );
    }
    if (record.status === 'completed' && typeof record.resultJson === 'string') {
        let result: R;
        try {
            result = JSON.parse(record.resultJson) as R;
        } catch {
            throw new LedgerError('unreadable-record', 'the stored outcome for this request id cannot be read');
        }
        const reply: CompletedReply<R> = { requestId: identity.requestId, status: 'completed', result, replayed: true };
        return reply;
    }
    if (record.status === 'rejected' && typeof record.code === 'string' && typeof record.message === 'string') {
        const reply: RejectedReply = {
            requestId: identity.requestId,
            status: 'rejected',
            terminal: true,
            code: record.code,
            message: record.message,
            replayed: true,
        };
        return reply;
    }
    throw new LedgerError('unreadable-record', 'the stored outcome for this request id cannot be read');
}

/**
 * Run `operation` at most once per (actor, requestId) and remember its outcome.
 *
 * Returns a settled reply: `completed` (fresh or replayed) or a terminal
 * `rejected`. Throws when the request id is not settled by this call -- a
 * `LedgerError` (bad id, content mismatch, unreadable record, invalid result),
 * an `authorize` failure on replay, or any non-definite error from your hooks or
 * from Firestore. Thrown errors are never terminal.
 */
export async function execute<Tx extends TransactionLike, Payload = unknown, State = undefined, Result = unknown>(
    options: ExecuteOptions<Tx, Payload, State, Result>,
): Promise<LedgerReply<Result>> {
    const { db, operation, actor, requestId, input } = options;
    assertActor(actor);
    assertRequestId(requestId);
    assertOperationName(operation?.name);
    if (typeof operation.write !== 'function') throw new LedgerError('invalid-operation', 'operation.write is required');

    const fingerprint = fingerprintRequest(operation.name, input);
    const ref = db.collection(options.collection ?? DEFAULT_COLLECTION).doc(requestDocId(actor, requestId));
    const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    const timestamp = options.timestamp ?? (() => new Date());
    const classify = (error: unknown): Rejection | null => {
        if (error instanceof LedgerError) return null;
        return normaliseRejection((options.classifyRejection ?? defaultClassifyRejection)(error));
    };
    const identity: Identity = { actor, requestId, fingerprint };
    const authorizeContext = (replay: boolean): AuthorizeContext => ({
        actor,
        requestId,
        operation: operation.name,
        input,
        replay,
    });

    const replay = async (transaction: Tx, data: unknown): Promise<LedgerReply<Result>> => {
        // Authorisation is checked again on every replay; a refusal here is not stored.
        if (operation.authorize) await operation.authorize(transaction, authorizeContext(true));
        return answerFromRecord<Result>(data, identity);
    };

    // A holder object, because the transaction callback may run more than once. Only the
    // refusal whose error actually ended the transaction counts (the SDK may retry an
    // attempt and then fail for another reason).
    const settled: { rejection: Rejection | null; error: unknown } = { rejection: null, error: undefined };

    try {
        return await db.runTransaction(async (transaction) => {
            settled.rejection = null;
            settled.error = undefined;
            const snapshot = await transaction.get(ref);
            if (snapshot.exists) return replay(transaction, snapshot.data());

            // From here on, this request id has no stored outcome in this transaction's view.
            try {
                const payload = operation.parse ? operation.parse(input) : (input as Payload);
                if (operation.authorize) await operation.authorize(transaction, authorizeContext(false));
                const context: OperationContext<Payload> = { actor, requestId, operation: operation.name, input, payload };
                const state = operation.read ? await operation.read(transaction, context) : (undefined as State);
                const raw: unknown = operation.write(transaction, context, state);
                if (isThenable(raw)) {
                    // Keep a late rejection from an async write from becoming an unhandled rejection.
                    Promise.resolve(raw).catch(() => undefined);
                    throw new LedgerError('async-write', 'operation.write must be synchronous; do all reads in read()');
                }
                const resultJson = encodeResult(raw, maxResultBytes);
                const record: LedgerRecord = {
                    v: RECORD_VERSION,
                    actor,
                    requestId,
                    operation: operation.name,
                    fingerprint,
                    status: 'completed',
                    resultJson,
                    createdAt: timestamp(),
                };
                transaction.create(ref, record as unknown as Record<string, unknown>);
                const reply: CompletedReply<Result> = {
                    requestId,
                    status: 'completed',
                    result: JSON.parse(resultJson) as Result,
                    replayed: false,
                };
                return reply;
            } catch (error) {
                settled.rejection = classify(error);
                settled.error = error;
                throw error;
            }
        });
    } catch (error) {
        const rejection = settled.rejection;
        if (!rejection || error !== settled.error) throw error;
        // The business transaction was abandoned. Store the refusal in a separate
        // transaction that re-checks the record: if another call with the same id
        // committed in the meantime, its outcome wins and is what we answer.
        return db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(ref);
            if (snapshot.exists) return replay(transaction, snapshot.data());
            const record: LedgerRecord = {
                v: RECORD_VERSION,
                actor,
                requestId,
                operation: operation.name,
                fingerprint,
                status: 'rejected',
                code: rejection.code,
                message: rejection.message,
                createdAt: timestamp(),
            };
            transaction.create(ref, record as unknown as Record<string, unknown>);
            const reply: RejectedReply = {
                requestId,
                status: 'rejected',
                terminal: true,
                code: rejection.code,
                message: rejection.message,
                replayed: false,
            };
            return reply;
        });
    }
}

/**
 * Read the stored outcome for (actor, requestId) without running anything.
 * `not-found` is not a failure: the original request may not have arrived yet or
 * may still be running. Retrying with the same id and content is the safe follow-up.
 */
export async function lookup<Tx extends TransactionLike, R = unknown>(options: LookupOptions<Tx>): Promise<LookupReply<R>> {
    const { db, actor, requestId } = options;
    assertActor(actor);
    assertRequestId(requestId);
    const fingerprint = options.expect ? fingerprintRequest(options.expect.operation, options.expect.input) : null;
    const ref: DocumentReferenceLike = db.collection(options.collection ?? DEFAULT_COLLECTION).doc(requestDocId(actor, requestId));
    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const data = snapshot.exists ? snapshot.data() : undefined;
        const operation = typeof (data as Partial<LedgerRecord> | undefined)?.operation === 'string'
            ? (data as LedgerRecord).operation
            : null;
        if (options.authorize) await options.authorize(transaction, { actor, requestId, operation });
        if (!snapshot.exists) return { requestId, status: 'not-found' } as const;
        return answerFromRecord<R>(data, { actor, requestId, fingerprint });
    });
}

/** Turn a thrown error into a non-terminal reply body for your transport. Never exposes stack traces. */
export function errorReply(error: unknown, requestId: string | null): ErrorReply {
    const code = error instanceof LedgerError || error instanceof RequestRejection ? error.code : 'internal';
    const message = error instanceof LedgerError || error instanceof RequestRejection
        ? error.message
        : 'the outcome of this request is unknown; retry with the same request id';
    return { requestId, status: 'error', terminal: false, code, message };
}
