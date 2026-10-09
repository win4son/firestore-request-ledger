/**
 * Reply shapes shared by the server helpers and the browser tracker.
 *
 * The one rule both sides rely on: a reply settles a request only when it is a
 * `completed` or `rejected` reply carrying the same `requestId`. A rejected
 * reply is final for that request id ("terminal"). Everything else -- network
 * errors, timeouts, HTTP 401/403/5xx, conflicts, malformed bodies -- says
 * nothing about whether an earlier attempt with the same id succeeded.
 */

/** Request ids become part of storage keys and Firestore document ids. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidRequestId(value: unknown): value is string {
    return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** The operation ran (now, or earlier and this is a replay of its stored result). */
export interface CompletedReply<R = unknown> {
    readonly requestId: string;
    readonly status: 'completed';
    readonly result: R;
    /** true when this reply was answered from the stored outcome instead of running the operation. */
    readonly replayed: boolean;
}

/** The operation was definitely refused and nothing was written for this request id. Final. */
export interface RejectedReply {
    readonly requestId: string;
    readonly status: 'rejected';
    readonly terminal: true;
    readonly code: string;
    readonly message: string;
    readonly replayed: boolean;
}

export type LedgerReply<R = unknown> = CompletedReply<R> | RejectedReply;

/** Lookup found no stored outcome. Not a failure: the original may not have arrived yet, or may still be running. */
export interface NotFoundReply {
    readonly requestId: string;
    readonly status: 'not-found';
}

export type LookupReply<R = unknown> = LedgerReply<R> | NotFoundReply;

/** Suggested body for errors that do not settle the request. Never terminal. */
export interface ErrorReply {
    readonly requestId: string | null;
    readonly status: 'error';
    readonly terminal: false;
    readonly code: string;
    readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the reply when it settles `requestId` (a well-formed completed or
 * terminal rejected reply for exactly that id), otherwise null.
 */
export function settledReplyFor<R = unknown>(reply: unknown, requestId: string): LedgerReply<R> | null {
    if (!isRecord(reply) || reply.requestId !== requestId || typeof reply.replayed !== 'boolean') return null;
    if (reply.status === 'completed' && Object.prototype.hasOwnProperty.call(reply, 'result')) {
        return {
            requestId,
            status: 'completed',
            result: reply.result as R,
            replayed: reply.replayed,
        };
    }
    if (
        reply.status === 'rejected'
        && reply.terminal === true
        && typeof reply.code === 'string'
        && typeof reply.message === 'string'
    ) {
        return {
            requestId,
            status: 'rejected',
            terminal: true,
            code: reply.code,
            message: reply.message,
            replayed: reply.replayed,
        };
    }
    return null;
}

/** True only for a terminal rejection bound to this request id. Error codes alone never qualify. */
export function isTerminalFor(reply: unknown, requestId: string): boolean {
    return settledReplyFor(reply, requestId)?.status === 'rejected';
}

/** True when the lookup reply says the server holds no outcome for this request id. */
export function isNotFoundFor(reply: unknown, requestId: string): boolean {
    return isRecord(reply) && reply.status === 'not-found' && reply.requestId === requestId;
}
