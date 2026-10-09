# API reference

Three entry points:

- `firestore-request-ledger/server`: Node.js, runs inside your trusted backend.
- `firestore-request-ledger/client`: browser (or any JS runtime with Web Storage).
- `firestore-request-ledger/wire`: the reply format and helpers, shared by both.

Both `server` and `client` re-export everything from `wire`.

---

## Reply format (`wire`)

```ts
type LedgerReply<R> =
  | { requestId: string; status: 'completed'; result: R; replayed: boolean }
  | { requestId: string; status: 'rejected'; terminal: true; code: string; message: string; replayed: boolean };

type LookupReply<R> = LedgerReply<R> | { requestId: string; status: 'not-found' };

// Suggested body for anything that does not settle the request. Never terminal.
type ErrorReply = { requestId: string | null; status: 'error'; terminal: false; code: string; message: string };
```

The core rule: a reply **settles** a request only when it is a well-formed
`completed` reply, or a `rejected` reply with `terminal: true`, **and** its
`requestId` equals the request's id. Nothing else settles it: thrown errors,
HTTP errors, `ErrorReply`, `not-found`, malformed bodies or replies for other
ids.

| Function | Meaning |
|---|---|
| `settledReplyFor(reply, requestId)` | The validated reply if it settles `requestId`, else `null`. |
| `isTerminalFor(reply, requestId)` | `true` only for a terminal rejection of that id. Error codes alone never count. |
| `isNotFoundFor(reply, requestId)` | `true` for a `not-found` lookup reply of that id. |
| `isValidRequestId(value)` / `REQUEST_ID_PATTERN` | `^[A-Za-z0-9_-]{8,128}$`. |
| `canonicalJson(value)` / `sameJson(a, b)` | JSON text with sorted keys; equality as sent over the wire. |

---

## Server

### `execute(options): Promise<LedgerReply<Result>>`

Runs an operation at most once per `(actor, requestId)` and remembers the
outcome.

| Option | Required | Description |
|---|---|---|
| `db` | yes | A Firestore server SDK instance (`FirestoreLike<Tx>`). |
| `operation` | yes | Your `Operation` (see below). |
| `actor` | yes | Authenticated principal, derived by your server. Up to 512 characters. |
| `requestId` | yes | Client-chosen id matching `REQUEST_ID_PATTERN`. |
| `input` | yes | The complete request content, a JSON value. Fingerprinted together with `operation.name`. |
| `collection` | no | Ledger collection. Default `requestLedger`. |
| `maxResultBytes` | no | Limit for the stored result JSON, in bytes. Default `16384`. |
| `classifyRejection` | no | `(error) => { code, message } \| null`. Decides which errors are definite refusals. Default: only `RequestRejection`. Never called with `LedgerError`s. |
| `timestamp` | no | Value stored in `createdAt`. Default `() => new Date()`. For example `() => FieldValue.serverTimestamp()`. |

**Returns**

- `completed`, with `replayed: false` when this call ran the operation, or
  `replayed: true` when the stored result was returned.
- A terminal `rejected` reply, when a definite refusal is (or already was)
  stored for this id.

**Throws, never terminal**

- `LedgerError`:
  - `invalid-request-id`, `invalid-actor`, `invalid-operation`: bad arguments.
  - `unfingerprintable-input`: cycles or `BigInt` in the input.
  - `content-mismatch`: the same id was used with another operation or input.
  - `actor-mismatch`: the record belongs to someone else (only possible with tampered data).
  - `unreadable-record`: the stored record cannot be read.
  - `invalid-result`: the result is not JSON or is too large.
  - `async-write`: `write` returned a promise.
- Whatever your `authorize` throws during a replay.
- Any other error from your hooks or from Firestore.

### `Operation<Tx, Payload, State, Result>`

```ts
interface Operation<Tx, Payload, State, Result> {
  name: string;
  parse?(input: unknown): Payload;
  authorize?(tx: Tx, ctx: AuthorizeContext): void | Promise<void>;
  read?(tx: Tx, ctx: OperationContext<Payload>): State | Promise<State>;
  write(tx: Tx, ctx: OperationContext<Payload>, state: State): Result;   // synchronous
}
```

Order within one transaction attempt:

| Record for this id | Hooks run |
|---|---|
| exists | `authorize({ replay: true })` → the stored outcome is returned. Content must match. |
| absent | `parse` → `authorize({ replay: false })` → `read` → `write` → the record is created with your writes. |

- Throw `RequestRejection` (`reject(code, message)`) from any hook to refuse.
  When the record is absent, the refusal is stored and returned as terminal.
  During a replay it is thrown and stores nothing.
- `write` must be synchronous. Do all reads in `read` (Firestore transactions
  require reads before writes).
- `ctx.requestId` is a good id for documents the operation creates.
- Transactions can be retried by Firestore. Hooks may run more than once, so
  keep them free of external side effects.

`AuthorizeContext`: `{ actor, requestId, operation, input, replay }`.
`OperationContext<Payload>`: `{ actor, requestId, operation, input, payload }`.

### `lookup(options): Promise<LookupReply<R>>`

Reads the stored outcome without running anything.

| Option | Required | Description |
|---|---|---|
| `db`, `actor`, `requestId` | yes | As in `execute`. |
| `collection` | no | As in `execute`. |
| `authorize` | no | `(tx, { actor, requestId, operation }) => void`. Runs before anything is revealed, including `not-found`. `operation` is `null` when there is no record. |
| `expect` | no | `{ operation, input }`. When given, a stored record must match it, otherwise `LedgerError('content-mismatch')`. |

`not-found` means "no outcome stored yet". The original may not have arrived or
may still be running. Retrying with the same id and content is the safe
follow-up.

### Other server exports

| Export | Description |
|---|---|
| `reject(code, message)` / `RequestRejection` | A definite refusal. |
| `LedgerError` | Errors raised by the ledger. `terminal` is always `false`. |
| `errorReply(error, requestId)` | Builds an `ErrorReply` body. Hides details of unexpected errors. |
| `requestDocId(actor, requestId)` | Ledger document id: SHA-256 of `[actor, requestId]`. |
| `fingerprintRequest(operation, input)` | SHA-256 of the canonical `{ v, operation, input }`. |
| `defaultClassifyRejection` | The default classifier. |
| `DEFAULT_COLLECTION`, `DEFAULT_MAX_RESULT_BYTES` | Defaults. |
| `FirestoreLike`, `TransactionLike`, … | Structural SDK types. |
| `LedgerRecord` | Shape of a stored record. |

Stored record (`LedgerRecord`):

```ts
{ v: 1, actor, requestId, operation, fingerprint, status: 'completed' | 'rejected',
  resultJson?, code?, message?, createdAt }
```

The input itself is not stored.

---

## Client

### `createRequestTracker(options): RequestTracker`

| Option | Default | Description |
|---|---|---|
| `actor` | (required) | The signed-in user. Create a new tracker when the user changes. |
| `namespace` | `'frl'` | Prefix for storage keys and lock names. |
| `storage` | `globalThis.localStorage` | `StorageLike`. With `null`, nothing can be sent. |
| `locks` | `navigator.locks` | `LockManagerLike`. Serialises submit decisions across tabs. |
| `requireLocks` | `false` | Refuse to send when no lock manager is available. |
| `crossTab` | window `storage` event | `CrossTabPort`, for notifications from other tabs. |
| `newRequestId` | `crypto.randomUUID()` | Must match `REQUEST_ID_PATTERN`. |
| `now` | `Date.now` | Clock. |
| `tombstoneTtlMs` | 30 days | How long removal markers are kept. |

### Methods

| Method | Description |
|---|---|
| `submit({ slot, operation, input, send, stillValid? })` | Saves, then sends. See the slot rules below. Resolves with a `SubmitOutcome`. Throws `NotSentError` only when nothing was sent in this call. |
| `retry(requestId, { send, stillValid? })` | Resends the stored request with its original id. A settled request resolves from storage without sending. |
| `check(requestId, { lookup })` | Asks the server for the stored outcome. `not-found` keeps the request unconfirmed. |
| `list()` | This actor's remembered requests, oldest first. |
| `get(requestId)` | One request, or `null`. |
| `acknowledge(requestId)` | Forgets a **settled** request (the user has seen it). Returns `false` for unconfirmed ones. |
| `discard(requestId)` | Forgets a request in any state. Does not cancel anything on the server. |
| `brokenCount()` / `discardBroken()` | Unreadable stored entries for this actor. While any exist, `submit` refuses. `await discardBroken()` removes them (a slot that lists a removed one stays blocked) and restores a slot record copy that cannot be parsed from the other copy; it never removes a slot record. It runs inside the same lock as `submit`'s slot check (with `requireLocks` and no lock manager it rejects with `locks-unavailable`, like `submit`) and resolves with the number of records removed or restored. |
| `brokenSlots()` / `resetSlot(slot)` | Slots that stay blocked (`broken-slot`): neither copy of the slot record can be used, or the slot lists a request that `discardBroken()` removed. `resetSlot(slot)` rebuilds the record from what a listing shows; call it only after making sure no request of that slot is still pending. |
| `subscribe(listener)` | Called after changes in this tab, or in other tabs through `crossTab`. Returns an unsubscribe function. |
| `durable()` | `false` while some change is only held in this tab's memory. |
| `readable()` | `false` when the latest read of this actor's records failed; `list()`/`get()` then show the last state seen in this tab. |

`send` and `lookup` receive `{ requestId, operation, input }`, the complete
stored request. They resolve with the reply body, or reject on network failure.

**`SubmitOutcome<R>`**

```ts
| { status: 'completed'; requestId; result: R; replayed: boolean }
| { status: 'rejected'; requestId; code; message }
| { status: 'unconfirmed'; requestId; error: { code, message } | null }
```

### Slot rules

A slot is a caller-chosen scope, for example a form. Within one `(actor, slot)`:

| Existing request in the slot | Same operation and input | Different content |
|---|---|---|
| unconfirmed | reuses its id (a retry) | `NotSentError('slot-busy')` |
| settled, not acknowledged | returns the stored outcome, nothing sent | a new id |
| none (or acknowledged) | a new id | a new id |

Different slots are independent. Concurrent submits for the same request in one
tab send once and share the result.

### `NotSentError.reason`

| Reason | Meaning |
|---|---|
| `storage-unavailable` | The request could not be saved, so it was not sent. |
| `storage-unreadable` | Remembered requests (or this slot's record) could not be read, so `submit` cannot tell whether this slot already holds a request. Nothing was sent; retry once storage is readable (`readable()`). |
| `locks-unavailable` | `requireLocks` is set and no lock manager is available. |
| `slot-busy` | An unconfirmed request with different content holds the slot. `pending` points at it. |
| `broken-entries` | Unreadable entries exist for this actor (`brokenCount()`, `discardBroken()`). |
| `broken-slot` | This slot's requests are unknown: neither copy of its record can be used, or it lists a request removed as unreadable. Nothing was sent; see `brokenSlots()` and `resetSlot()`. |
| `aborted` | `stillValid()` returned `false`. |
| `invalid-input` | The input is not JSON-serialisable. |
| `invalid-slot` | The slot is empty or too long. |
| `unknown-request` | `retry` or `check` was called for an id that is not tracked. |

### State rules

- States are `unconfirmed`, `completed` and `rejected`. A settled state never
  goes back to `unconfirmed`. When two settled answers race, every tab
  converges on the earliest settled one (ties broken by the writing tab).
- `acknowledge` and `discard` write a removal marker first, then remove the
  request's records. Only `submit` creates a request record, so late replies
  and tabs with an old view cannot recreate the request, during or after the
  marker's lifetime (`tombstoneTtlMs` only limits how long markers take space).
- A reply for a request that is no longer tracked is returned to the caller
  but not stored.
- A key that a listing did not show is never treated as gone: listing keys
  (`Storage.key`) can skip a key, without any error, while another tab removes
  one. Decisions that must not miss a request read keys directly:
  - `list()` reads a request's own keys directly before treating it as removed
    when the listing shows some of its records but not its request record, so
    a settled outcome seen in this tab is not forgotten because of a listing.
  - `submit` takes the slot's requests from the slot record (read directly)
    and reads each listed request's own keys directly; requests that a
    listing also shows are included. When `submit` goes ahead (reuses, replays
    or creates), a request of the slot that only a listing showed is written
    back into the slot record.
  - `get`, `retry`, `check`, `acknowledge`, `discard` and storing a reply read
    the request's own record, removal marker and this tab's records directly.
  - Pruning removes an attempt or outcome record without its request record
    only after direct reads confirm that neither the request record nor a
    removal marker exists, and only when the record is older than
    `tombstoneTtlMs`.
- The slot record is kept in two copies, written only by `submit` (and
  `resetSlot`), inside its lock (when a lock manager is available; see the
  README's limitations), and before the new request record, so every request
  record that exists is listed in its slot record. Readers combine both copies.
  `acknowledge` and `discard` do not change it: a listed id whose request
  record is gone or carries a removal marker does not count, and the next
  `submit` that creates a request in that slot drops ids whose request record a
  direct read shows absent.
- Damage never makes a slot look free. A copy that cannot be parsed is
  restored from the other copy (by `submit`, or by `discardBroken()`). When
  neither copy can be used, the slot's requests are unknown: `submit` refuses
  (`broken-slot`) and `discardBroken()` leaves the record. `discardBroken()`
  first leaves a `lost` marker for each unreadable request record it removes; a
  slot whose record lists such a request is blocked the same way. `resetSlot()`
  is the app's decision to go on.
- `discardBroken()` runs inside the same lock as `submit`'s slot check. Without
  a lock manager the two can interleave, so `submit` checks lost markers after
  all its other reads (a request record it found missing has its marker by
  then), never drops an id that still has a lost marker when it rewrites the
  slot record, and checks the slot once more after saving a new request record.
  When that last check finds another request, the new record is withdrawn and
  the slot's requests are written back into the slot record.
- After saving a new request record, `submit` checks the slot again and
  withdraws the record, without sending, if that finds another request (for
  example one saved meanwhile by a tab without locks).
- `readable()` is false when the latest read of this actor's records failed.
  While reads fail, `list()` and `get()` show the last state seen in this tab;
  settled requests stay settled, and the earliest settled outcome seen stays
  the one shown even if a later read misses its record (the remembered outcome
  takes part in the same earliest-settledAt, then tab-id ordering).
- `submit` refuses with `storage-unreadable` when any read of this actor's
  records fails during its slot check: an unreadable request may be the open
  request of the slot, and a new id would execute again.
- If a write fails, the change is kept in this tab's memory, shown by `list()`
  and `get()`, and retried on every operation.

Storage keys. Apart from the slot record and its copy (written only inside the
lock), no key is written from another tab's data, so a tab acting on an old
view of `localStorage` cannot overwrite what another tab stored:

```
<namespace>/v1/entry/<encoded actor>/<requestId>          the request as created by submit; never rewritten
<namespace>/v1/try/<encoded actor>/<requestId>/<tab id>   attempts and last error, written only by that tab
<namespace>/v1/done/<encoded actor>/<requestId>/<tab id>  a settled outcome, written once, only by that tab
<namespace>/v1/gone/<encoded actor>/<requestId>           removal marker
<namespace>/v1/slot/<encoded actor>/<encoded slot>        { v: 1, ids: [...] }: the slot's request ids
<namespace>/v1/slotcopy/<encoded actor>/<encoded slot>    the same, second copy
<namespace>/v1/lost/<encoded actor>/<requestId>           an unreadable request record removed by discardBroken()
```

Attempt and outcome records whose request record is gone are leftovers of a
removed request: they are ignored and cleaned up when markers are pruned.
`attempts` is the sum over tabs.
