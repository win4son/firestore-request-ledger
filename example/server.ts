// Example API server for the synthetic demo. Talks only to the local Firestore emulator.
//
// It is deliberately small and NOT production code: the "actor" comes from an
// `x-demo-actor` header so you can switch between two synthetic users. A real
// server must derive the actor from verified authentication (for example a
// verified ID token) and must never trust a header or the request body for it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Firestore, Transaction } from '@google-cloud/firestore';
// In your own app: import from 'firestore-request-ledger/server'.
import { LedgerError, RequestRejection, errorReply, execute, isValidRequestId, lookup, reject } from '../src/server/index.ts';
import type { ErrorReply, Operation } from '../src/server/index.ts';

export const DEMO_PROJECT_ID = 'demo-request-ledger';
export const DEMO_ACTORS: readonly string[] = ['demo-user-a', 'demo-user-b'];
export const DEMO_BALANCE_CAP = 5000;
const MAX_BODY_BYTES = 16 * 1024;

export interface AddPoints {
    amount: number;
    note: string;
}

export interface AddPointsResult {
    balance: number;
    entryId: string;
}

/** Refuse to start unless every Firestore call goes to a local emulator under a demo- project. */
export function assertLocalEmulator(env: NodeJS.ProcessEnv = process.env): string {
    const host = env.FIRESTORE_EMULATOR_HOST ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
        throw new Error('The demo only runs against a local Firestore emulator. Start it with `npm run example`.');
    }
    const projectId = env.GCLOUD_PROJECT ?? DEMO_PROJECT_ID;
    if (!projectId.startsWith('demo-')) throw new Error('The demo project id must start with "demo-".');
    return projectId;
}

function simulatedError(requestId: string | null, code: string, message: string): ErrorReply {
    return { requestId, status: 'error', terminal: false, code, message };
}

export function createDemoApp(db: Firestore, options: { prefix?: string } = {}) {
    const prefix = options.prefix ?? 'demo';
    const accounts = db.collection(`${prefix}Accounts`);
    const ledgerCollection = `${prefix}RequestLedger`;

    const addPoints: Operation<Transaction, AddPoints, { balance: number }, AddPointsResult> = {
        name: 'addPoints',
        parse(input) {
            const value = (input ?? {}) as Partial<AddPoints>;
            if (!Number.isSafeInteger(value.amount) || (value.amount as number) < 1 || (value.amount as number) > 500) {
                reject('invalid-argument', 'amount must be a whole number from 1 to 500');
            }
            const note = value.note ?? '';
            if (typeof note !== 'string' || note.length > 120) reject('invalid-argument', 'note must be text of at most 120 characters');
            return { amount: value.amount as number, note };
        },
        async authorize(transaction, context) {
            // Checked on every call, replays included: a request id is not a credential.
            const account = await transaction.get(accounts.doc(context.actor));
            if (account.data()?.active !== true) reject('permission-denied', 'this synthetic account is not active');
        },
        async read(transaction, context) {
            const account = await transaction.get(accounts.doc(context.actor));
            return { balance: Number(account.data()?.balance ?? 0) };
        },
        write(transaction, context, state) {
            const balance = state.balance + context.payload.amount;
            if (balance > DEMO_BALANCE_CAP) reject('failed-precondition', `the demo balance is capped at ${DEMO_BALANCE_CAP}`);
            const account = accounts.doc(context.actor);
            transaction.update(account, { balance });
            transaction.set(account.collection('entries').doc(context.requestId), {
                amount: context.payload.amount,
                note: context.payload.note,
                at: new Date(),
            });
            return { balance, entryId: context.requestId };
        },
    };

    async function ensureAccounts(): Promise<void> {
        for (const actor of DEMO_ACTORS) {
            await db.runTransaction(async (transaction) => {
                const ref = accounts.doc(actor);
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists) transaction.create(ref, { balance: 0, active: true });
            });
        }
    }

    async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
            size += (chunk as Buffer).length;
            if (size > MAX_BODY_BYTES) return null;
            chunks.push(chunk as Buffer);
        }
        try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }

    function send(response: ServerResponse, status: number, body: unknown): void {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
    }

    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const actorHeader = request.headers['x-demo-actor'];
        const actor = typeof actorHeader === 'string' && DEMO_ACTORS.includes(actorHeader) ? actorHeader : null;
        if (!actor) return send(response, 401, simulatedError(null, 'unauthenticated', 'pick one of the synthetic demo users'));

        if (request.method === 'GET' && url.pathname === '/api/account') {
            const account = await accounts.doc(actor).get();
            const entries = await accounts.doc(actor).collection('entries').count().get();
            return send(response, 200, { balance: Number(account.data()?.balance ?? 0), entries: entries.data().count });
        }
        if (request.method !== 'POST' || (url.pathname !== '/api/execute' && url.pathname !== '/api/lookup')) {
            return send(response, 404, simulatedError(null, 'not-found', 'unknown endpoint'));
        }

        const body = await readBody(request);
        const requestId = body?.requestId;
        if (!body || !isValidRequestId(requestId)) {
            return send(response, 400, simulatedError(null, 'invalid-request', 'expected a JSON body with a valid requestId'));
        }

        // Fault injection for the demo. "deny" refuses this attempt before the ledger is consulted,
        // like an expired session would; it proves nothing about earlier attempts.
        const fault = request.headers['x-demo-fault'];
        if (fault === 'deny') {
            return send(response, 403, simulatedError(requestId, 'permission-denied', 'simulated: this attempt was refused before reaching the ledger'));
        }

        try {
            if (url.pathname === '/api/execute') {
                if (body.operation !== addPoints.name) return send(response, 400, simulatedError(requestId, 'invalid-operation', 'unknown operation'));
                const reply = await execute({ db, operation: addPoints, actor, requestId, input: body.input, collection: ledgerCollection });
                if (fault === 'drop-response') {
                    // Simulated: the server finished (and committed) but the response never arrives.
                    request.socket.destroy();
                    return;
                }
                return send(response, 200, reply);
            }
            const expect = typeof body.operation === 'string' ? { operation: body.operation, input: body.input } : undefined;
            const reply = await lookup({
                db,
                actor,
                requestId,
                collection: ledgerCollection,
                ...(expect ? { expect } : {}),
                authorize: async (transaction) => {
                    const account = await transaction.get(accounts.doc(actor));
                    if (account.data()?.active !== true) reject('permission-denied', 'this synthetic account is not active');
                },
            });
            return send(response, 200, reply);
        } catch (error) {
            // Thrown errors never settle the request: a mismatch, a refused replay, or "unknown".
            const status = error instanceof LedgerError ? 409 : error instanceof RequestRejection ? 403 : 500;
            return send(response, status, errorReply(error, requestId));
        }
    }

    return {
        ensureAccounts,
        handler(request: IncomingMessage, response: ServerResponse): void {
            handle(request, response).catch((error: unknown) => {
                if (!response.headersSent) send(response, 500, errorReply(error, null));
                else response.destroy();
            });
        },
    };
}
