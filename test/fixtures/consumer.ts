// Compiled by scripts/check-dist.mjs against the built package (dist/*.d.ts), as a
// consumer would see it: strict NodeNext settings, no .ts-extension imports.
import { createRequestTracker, isTerminalFor } from 'firestore-request-ledger/client';
import type { RequestTracker, SubmitOutcome } from 'firestore-request-ledger/client';
import { execute, reject } from 'firestore-request-ledger/server';
import type { FirestoreLike, LedgerReply, Operation, TransactionLike } from 'firestore-request-ledger/server';
import { settledReplyFor } from 'firestore-request-ledger/wire';

declare const db: FirestoreLike<TransactionLike>;

const operation: Operation<TransactionLike, { amount: number }, undefined, { ok: true }> = {
    name: 'demo',
    parse: (input) => {
        if (typeof (input as { amount?: unknown }).amount !== 'number') reject('invalid-argument', 'amount');
        return input as { amount: number };
    },
    write: () => ({ ok: true }),
};

export async function server(): Promise<LedgerReply<{ ok: true }>> {
    return execute({ db, operation, actor: 'a', requestId: 'req-00000001', input: { amount: 1 } });
}

export function client(): RequestTracker {
    const tracker = createRequestTracker({ actor: 'a', storage: null });
    const outcome: SubmitOutcome | null = null;
    void outcome;
    void isTerminalFor;
    void settledReplyFor;
    return tracker;
}

// The published types must be real, not `any`: these must be errors.
// @ts-expect-error status is a closed union
export const wrong: SubmitOutcome = { status: 'maybe', requestId: 'x' };
// @ts-expect-error write is required
export const incomplete: Operation<TransactionLike> = { name: 'x' };
