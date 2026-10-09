/**
 * A definite refusal decided by your operation: "the server received this,
 * looked at it, and the answer is no". Thrown from `parse`, `authorize`, `read`
 * or `write`, it becomes a stored, terminal rejection when the request id has
 * no outcome yet.
 */
export class RequestRejection extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'RequestRejection';
        this.code = code;
    }
}

/** Throw a definite refusal. */
export function reject(code: string, message: string): never {
    throw new RequestRejection(code, message);
}

export type LedgerErrorCode =
    | 'invalid-request-id'
    | 'invalid-actor'
    | 'invalid-operation'
    | 'unfingerprintable-input'
    | 'content-mismatch'
    | 'actor-mismatch'
    | 'unreadable-record'
    | 'invalid-result'
    | 'async-write';

/**
 * An error raised by the ledger itself. Never terminal: it does not settle the
 * request id, and clients must keep the original request.
 */
export class LedgerError extends Error {
    readonly code: LedgerErrorCode;
    readonly terminal = false;

    constructor(code: LedgerErrorCode, message: string) {
        super(message);
        this.name = 'LedgerError';
        this.code = code;
    }
}
