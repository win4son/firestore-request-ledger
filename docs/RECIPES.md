# Integration Recipes

Copy-paste starting points for integrating `firestore-request-ledger` into common TypeScript stacks.
All server examples derive `actor` from verified authentication—never from the request body.

> **Compatibility note**: `firebase-admin/firestore` re-exports `@google-cloud/firestore`, which matches `FirestoreLike`. Automated tests in this repository currently run directly against `@google-cloud/firestore` with the local Firestore emulator.

---

## 1. Shared Operation Definition

Define each business operation once so both HTTP handlers and callable functions share the same contract:

```ts
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { reject, type Operation } from 'firestore-request-ledger/server';

export interface AddPointsInput {
  amount: number;
}

export interface AddPointsResult {
  balance: number;
}

export const createAddPointsOperation = (
  db: Firestore,
): Operation<Transaction, AddPointsInput, { balance: number }, AddPointsResult> => ({
  name: 'addPoints',

  parse(input) {
    const amount = (input as { amount?: unknown } | null)?.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
      reject('invalid-argument', 'amount must be a positive safe integer');
    }
    return { amount };
  },

  async authorize(tx, { actor }) {
    const member = await tx.get(db.doc(`members/${actor}`));
    if (member.data()?.active !== true) {
      reject('permission-denied', 'actor is not an active member');
    }
  },

  async read(tx, { actor }) {
    const account = await tx.get(db.doc(`accounts/${actor}`));
    return { balance: Number(account.data()?.balance ?? 0) };
  },

  write(tx, { actor, requestId, payload }, { balance }) {
    const nextBalance = balance + payload.amount;
    tx.set(db.doc(`accounts/${actor}`), { balance: nextBalance }, { merge: true });
    tx.set(db.doc(`accounts/${actor}/entries/${requestId}`), { amount: payload.amount });
    return { balance: nextBalance };
  },
});
```

---

## 2. Firebase Cloud Functions v2 (`onCall`)

With Firebase Callable Functions, `request.auth.uid` is verified by Firebase before your handler runs.
Return the wire reply directly so the client tracker can inspect `status` and `terminal`.

```ts
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { errorReply, execute, LedgerError, lookup } from 'firestore-request-ledger/server';
import { createAddPointsOperation } from './operations.ts';

const db = getFirestore();
const addPoints = createAddPointsOperation(db);

interface WireRequest {
  requestId?: unknown;
  operation?: unknown;
  input?: unknown;
}

export const executeOperation = onCall(async (request) => {
  const actor = request.auth?.uid;
  if (!actor) {
    // Non-terminal: a signed-out retry must leave the client request unconfirmed.
    throw new HttpsError('unauthenticated', 'Sign in required');
  }

  const body = (request.data ?? {}) as WireRequest;
  if (body.operation !== addPoints.name) {
    throw new HttpsError('invalid-argument', 'Unknown operation');
  }

  try {
    return await execute({
      db,
      operation: addPoints,
      actor,
      requestId: body.requestId as string,
      input: body.input,
      timestamp: () => FieldValue.serverTimestamp(),
    });
  } catch (error) {
    // Return a non-terminal error reply so the tracker keeps the request unconfirmed.
    if (error instanceof LedgerError) {
      return errorReply(error, typeof body.requestId === 'string' ? body.requestId : undefined);
    }
    throw new HttpsError('internal', 'Temporary server error');
  }
});

export const lookupOperation = onCall(async (request) => {
  const actor = request.auth?.uid;
  if (!actor) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }

  const body = (request.data ?? {}) as WireRequest;
  try {
    return await lookup({
      db,
      actor,
      requestId: body.requestId as string,
      expect:
        typeof body.operation === 'string'
          ? { operation: body.operation, input: body.input }
          : undefined,
      async authorize(tx, { actor: uid }) {
        const member = await tx.get(db.doc(`members/${uid}`));
        if (member.data()?.active !== true) {
          throw new HttpsError('permission-denied', 'actor is not an active member');
        }
      },
    });
  } catch (error) {
    if (error instanceof LedgerError) {
      return errorReply(error, typeof body.requestId === 'string' ? body.requestId : undefined);
    }
    throw error;
  }
});
```

On the browser side, wrap `httpsCallable` into a `SendFunction` / `LookupFunction`:

```ts
import { getFunctions, httpsCallable } from 'firebase/functions';
import type { LookupFunction, SendFunction } from 'firestore-request-ledger/client';

const functions = getFunctions();
const callExecute = httpsCallable(functions, 'executeOperation');
const callLookup = httpsCallable(functions, 'lookupOperation');

export const send: SendFunction = async (req) => (await callExecute(req)).data;
export const lookupRequest: LookupFunction = async (req) => (await callLookup(req)).data;
```

> If `httpsCallable` rejects (network drop, `unauthenticated`, `internal`), `createRequestTracker` records the attempt error and keeps the request `unconfirmed`.

---

## 3. Next.js App Router Route Handler (`app/api/execute/route.ts`)

Derive `actor` by verifying the `Authorization: Bearer <idToken>` header (or your server-side session cookie) before touching the ledger.

```ts
import { NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { errorReply, execute, LedgerError } from 'firestore-request-ledger/server';
import { createAddPointsOperation } from '@/lib/operations';

export const runtime = 'nodejs';

const db = getFirestore();
const addPoints = createAddPointsOperation(db);

async function verifyActor(request: Request): Promise<string | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7));
    return decoded.uid;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const actor = await verifyActor(request);
  if (!actor) {
    return NextResponse.json({ status: 'error', terminal: false, code: 'unauthenticated' }, { status: 401 });
  }

  let body: { requestId?: unknown; operation?: unknown; input?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ status: 'error', terminal: false, code: 'invalid-json' }, { status: 400 });
  }

  if (body.operation !== addPoints.name) {
    return NextResponse.json({ status: 'error', terminal: false, code: 'unknown-operation' }, { status: 400 });
  }

  try {
    const reply = await execute({
      db,
      operation: addPoints,
      actor,
      requestId: body.requestId as string,
      input: body.input,
      timestamp: () => FieldValue.serverTimestamp(),
    });
    return NextResponse.json(reply, { status: 200 });
  } catch (error) {
    const status = error instanceof LedgerError ? 400 : 500;
    const reqId = typeof body.requestId === 'string' ? body.requestId : undefined;
    return NextResponse.json(errorReply(error, reqId), { status });
  }
}
```

---

## 4. Minimal React Hook (`useRequestTracker.ts`)

This hook creates a tracker scoped to the signed-in `actor`, subscribes to both same-tab and cross-tab updates, and guards submissions with `stillValid` so unmounted views or account switches do not send stale requests.

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createRequestTracker,
  type LookupFunction,
  type RequestTracker,
  type SendFunction,
  type SubmitOutcome,
  type TrackedRequest,
} from 'firestore-request-ledger/client';

export interface TrackerSnapshot {
  readonly requests: TrackedRequest[];
  readonly brokenCount: number;
  readonly brokenSlots: string[];
  readonly durable: boolean;
  readonly readable: boolean;
}

function readSnapshot(tracker: RequestTracker): TrackerSnapshot {
  return {
    requests: tracker.list(),
    brokenCount: tracker.brokenCount(),
    brokenSlots: tracker.brokenSlots(),
    durable: tracker.durable(),
    readable: tracker.readable(),
  };
}

export function useRequestTracker(actor: string | null, namespace = 'frl') {
  const tracker = useMemo(
    () => (actor ? createRequestTracker({ actor, namespace }) : null),
    [actor, namespace],
  );

  const [snapshot, setSnapshot] = useState<TrackerSnapshot>(() =>
    tracker
      ? readSnapshot(tracker)
      : { requests: [], brokenCount: 0, brokenSlots: [], durable: true, readable: true },
  );

  const mountedRef = useRef(true);
  const activeActorRef = useRef(actor);
  activeActorRef.current = actor;

  useEffect(() => {
    mountedRef.current = true;
    if (!tracker) {
      setSnapshot({ requests: [], brokenCount: 0, brokenSlots: [], durable: true, readable: true });
      return () => {
        mountedRef.current = false;
      };
    }

    const sync = () => setSnapshot(readSnapshot(tracker));
    sync();
    const unsubscribe = tracker.subscribe(sync);
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [tracker]);

  const submit = useCallback(
    async <I, R = unknown>(
      slot: string,
      operation: string,
      input: I,
      send: SendFunction<I>,
    ): Promise<SubmitOutcome<R>> => {
      if (!tracker || !actor) throw new Error('No authenticated actor');
      return tracker.submit<I, R>({
        slot,
        operation,
        input,
        send,
        stillValid: () => mountedRef.current && activeActorRef.current === actor,
      });
    },
    [tracker, actor],
  );

  const retry = useCallback(
    async <R = unknown>(requestId: string, send: SendFunction): Promise<SubmitOutcome<R>> => {
      if (!tracker || !actor) throw new Error('No authenticated actor');
      return tracker.retry<R>(requestId, {
        send,
        stillValid: () => mountedRef.current && activeActorRef.current === actor,
      });
    },
    [tracker, actor],
  );

  const check = useCallback(
    async <R = unknown>(requestId: string, lookup: LookupFunction): Promise<SubmitOutcome<R>> => {
      if (!tracker) throw new Error('No authenticated actor');
      return tracker.check<R>(requestId, { lookup });
    },
    [tracker],
  );

  return {
    tracker,
    ...snapshot,
    submit,
    retry,
    check,
    acknowledge: (requestId: string) => tracker?.acknowledge(requestId) ?? false,
    discard: (requestId: string) => tracker?.discard(requestId) ?? false,
    discardBroken: () => tracker?.discardBroken() ?? Promise.resolve(0),
    resetSlot: (slot: string) => tracker?.resetSlot(slot) ?? Promise.resolve([]),
  };
}
```

### Handling Outcomes in Your Component

- **`outcome.status === 'completed'`**: Display the result, then call `acknowledge(outcome.requestId)`.
- **`outcome.status === 'rejected'`**: Display `outcome.message` (this is a confirmed terminal refusal), then call `acknowledge(outcome.requestId)`.
- **`outcome.status === 'unconfirmed'`**: Do **not** show "failed" or let the user generate a new request id. Show an "Outcome pending / unconfirmed" banner with **Check status** (`check`) and **Retry same request** (`retry`) actions.
- **`NotSentError`**: Catch it separately—nothing left the browser (for example, `slot-busy` or `broken-slot`).
