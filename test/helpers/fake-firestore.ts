import type { DocumentReferenceLike, DocumentSnapshotLike, FirestoreLike, TransactionLike } from '../../src/server/index.ts';

/** Numeric codes @google-cloud/firestore retries when the transaction callback throws them. */
const RETRYABLE_CODES = new Set<unknown>([10, 409, 1, 2, 4, 13, 14, 16, 8]);

interface StoredDoc {
    data: Record<string, unknown>;
    version: number;
}

/**
 * A deterministic stand-in for Firestore transactions, used to order races
 * precisely (the emulator suites cover the real SDK). Optimistic: a commit
 * fails and the callback re-runs when a document it read changed meanwhile.
 * Errors thrown by the callback abort without retry unless they carry a retryable
 * numeric code, as in the SDK.
 */
export class FakeFirestore implements FirestoreLike<FakeTransaction> {
    readonly docs = new Map<string, StoredDoc>();
    transactions = 0;
    /** Runs before each transaction attempt (1-based count across the instance). */
    beforeTransaction: ((attempt: number) => void | Promise<void>) | null = null;
    /** Runs after the callback, before the commit check. */
    beforeCommit: ((attempt: number) => void | Promise<void>) | null = null;

    collection(path: string): { doc(id: string): DocumentReferenceLike } {
        return { doc: (id: string) => ({ id, path: `${path}/${id}` }) };
    }

    doc(path: string): DocumentReferenceLike {
        return { id: path.split('/').pop() ?? path, path };
    }

    put(path: string, data: Record<string, unknown>): void {
        const current = this.docs.get(path);
        this.docs.set(path, { data: structuredClone(data), version: (current?.version ?? 0) + 1 });
    }

    read(path: string): Record<string, unknown> | undefined {
        const doc = this.docs.get(path);
        return doc ? structuredClone(doc.data) : undefined;
    }

    async runTransaction<T>(updateFunction: (transaction: FakeTransaction) => Promise<T>): Promise<T> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            this.transactions += 1;
            const count = this.transactions;
            await this.beforeTransaction?.(count);
            const transaction = new FakeTransaction(this);
            let result: T;
            try {
                result = await updateFunction(transaction);
            } catch (error) {
                // Like the SDK: callback errors with these gRPC codes are retried, all others abort.
                if (RETRYABLE_CODES.has((error as { code?: unknown } | null)?.code)) continue;
                throw error;
            }
            await this.beforeCommit?.(count);
            if (transaction.commit()) return result;
        }
        throw Object.assign(new Error('too much contention (fake)'), { code: 10 });
    }
}

export class FakeTransaction implements TransactionLike {
    readonly #db: FakeFirestore;
    readonly #reads = new Map<string, number>();
    readonly #writes: Array<() => void> = [];
    readonly #creates: string[] = [];

    constructor(db: FakeFirestore) {
        this.#db = db;
    }

    async get(ref: DocumentReferenceLike): Promise<DocumentSnapshotLike> {
        if (this.#writes.length > 0) throw new Error('transactions require all reads before all writes');
        const doc = this.#db.docs.get(ref.path);
        this.#reads.set(ref.path, doc?.version ?? 0);
        return { exists: doc !== undefined, data: () => (doc ? structuredClone(doc.data) : undefined) };
    }

    create(ref: DocumentReferenceLike, data: Record<string, unknown>): this {
        this.#creates.push(ref.path);
        this.#writes.push(() => this.#db.put(ref.path, data));
        return this;
    }

    set(ref: DocumentReferenceLike, data: Record<string, unknown>): this {
        this.#writes.push(() => this.#db.put(ref.path, data));
        return this;
    }

    /** Apply writes when nothing read has changed; false asks the caller to retry. */
    commit(): boolean {
        for (const [path, version] of this.#reads) {
            if ((this.#db.docs.get(path)?.version ?? 0) !== version) return false;
        }
        for (const path of this.#creates) {
            if (this.#db.docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS (fake)'), { code: 6 });
        }
        for (const write of this.#writes) write();
        return true;
    }
}
