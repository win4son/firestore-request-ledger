# Production Operations & Maintenance Guide

This guide covers how to operate `firestore-request-ledger` safely in production: security rules, retention and cleanup, result sizing, and client-side recovery.

---

## 1. Security Rules (Mandatory)

Clients must **never** read or write the ledger collection (`requestLedger` by default, or the custom `collection` passed to `execute()` / `lookup()`).
If a client could write to the ledger collection, it could forge a replayed `completed` outcome without executing your server transaction.

> **Critical — Firestore Security Rules do NOT have deny-overrides-allow:**
> Overlapping `allow` statements are combined with logical **OR**. If your rules contain a broad wildcard allow (such as `match /{document=**} { allow read, write: if request.auth != null; }`), adding `match /requestLedger/{document=**} { allow read, write: if false; }` will **not** protect the ledger.

Use a **default-deny allowlist** structure with no broad `/{document=**}` allow rule, and explicitly deny the ledger collection:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Deny all client access to the ledger collection.
    // Ensure no broader wildcard match (e.g. /{document=**}) grants allow here.
    match /requestLedger/{document=**} {
      allow read, write: if false;
    }

    // Explicitly allow only the application collections clients should access:
    match /accounts/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow write: if false;
    }
  }
}
```

If you pass a custom `collection` name in `ExecuteOptions` / `LookupOptions`, mirror that exact path in `firestore.rules` and verify with the Rules emulator that no other `match` block allows client access to it.

---

## 2. Retention, Cleanup & Why Not to Put Firestore TTL Directly on `createdAt`

The library never deletes ledger records automatically. The lifetime of a ledger document defines the **deduplication window**: once a record is deleted, re-sending that same `(actor, requestId)` will execute the operation again as a brand-new request.

### Important warning about native Firestore TTL

`LedgerRecord` stores `createdAt` (using `FieldValue.serverTimestamp()` when you pass `timestamp: () => FieldValue.serverTimestamp()`, or `new Date()` by default). It does **not** currently store a separate future `expiresAt` timestamp field.

- **Do NOT attach a Firestore native TTL policy directly to `createdAt`.**
  Firestore TTL deletes documents as soon as the configured timestamp field is in the past—attaching TTL to `createdAt` would mark fresh ledger records eligible for deletion immediately.

### Recommended cleanup strategy: Scheduled Batch Pruning

Store server timestamps by passing `timestamp: () => FieldValue.serverTimestamp()` to `execute()`, then run a scheduled job (for example, Cloud Scheduler invoking a Cloud Function or Cloud Run Job daily) to delete records older than your chosen deduplication window:

```ts
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const RETENTION_DAYS = 90;
const BATCH_LIMIT = 400;

export async function pruneExpiredLedgerRecords(collection = 'requestLedger'): Promise<number> {
  const db = getFirestore();
  const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let deleted = 0;

  while (true) {
    const snap = await db
      .collection(collection)
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt', 'asc')
      .limit(BATCH_LIMIT)
      .get();

    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted += snap.size;

    if (snap.size < BATCH_LIMIT) break;
  }

  return deleted;
}
```

### Choosing a Deduplication Window

- **Client tombstone default**: The browser client keeps removal markers (`tombstoneTtlMs`) for **30 days** by default.
- **Server ledger retention**: Keep server records at least as long as a client could reasonably return and retry an unconfirmed request—**30 to 90 days** is a practical baseline for most web apps, or indefinitely if audit retention is required and storage volume is modest.
- Make sure `createdAt` is always a Firestore `Timestamp` (or JS `Date`) across all writers so range queries (`where('createdAt', '<', cutoff)`) work consistently.

---

## 3. Result Sizing & Transaction Contention

- **Keep stored results small (`maxResultBytes`)**:
  `execute()` serializes the return value of `write()` into `resultJson` and rejects results larger than `maxResultBytes` (**16 KiB** UTF-8 by default). Return identifiers, updated totals, or concise summaries—not full document payloads.
- **Ledger record size & transaction cost**:
  - **Fresh completion**: Runs in the same Firestore transaction as your business writes (+1 ledger read + 1 ledger create).
  - **Replay**: Runs in a single transaction with 1 ledger read (plus any reads performed by your `authorize` hook) and no writes.
  - **Fresh terminal rejection (`RequestRejection`)**: Uses **two** transactions—the first transaction reads the ledger and aborts on `RequestRejection` without committing any business writes; a second transaction then re-reads the ledger and creates the `rejected` record (2 ledger reads + 1 ledger create total, unless a concurrent attempt with the same id succeeded in between, in which case that success is returned instead).
- **Contention retries**:
  Firestore automatically retries transactions on contention. Keep `read()` and `write()` focused on the minimum set of documents needed, and keep `write()` strictly synchronous. If a transaction exhausts contention retries, no ledger record is written and the error propagates as non-terminal, so the client can safely retry with the same `requestId`.

---

## 4. Client Storage Hygiene & Recovery Procedures

- **Never put secrets in `input`**:
  `createRequestTracker()` stores the complete JSON `input` in `localStorage` until the request is acknowledged or discarded. Keep credentials, tokens, and sensitive secrets in auth headers, never in `input`.
- **Sign-out on shared devices**:
  Ledger records in `localStorage` are scoped by `actor`. On shared devices, decide whether sign-out should leave unconfirmed records for that user or notify the user before clearing browser storage.
- **Monitoring `durable()` and `readable()`**:
  If a browser blocks `localStorage` or hits quota after a request was already sent, `durable()` becomes `false` and the tracker retries persistence on subsequent operations. Surface a clear banner telling the user not to close the tab until the pending request settles.
- **Recovering damaged slots (`discardBroken()` vs. `resetSlot()`)**:
  - `discardBroken()` removes unreadable request entries and repairs a single damaged slot-record copy from its backup copy, while leaving doubly-damaged slots blocked.
  - `resetSlot(slot)` rebuilds a blocked slot's record from key listings. Because `Storage.key()` listings are not guaranteed to be complete under concurrent mutation, only invoke `resetSlot()` after confirming (for example, via your server or user verification) that no request for that slot is still pending.
