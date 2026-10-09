# firestore-request-ledger

Request deduplication, outcome replay and "result unknown" tracking for
Firestore transactions and browser clients.

> **Status: 0.1.0, the first release.** The API can still change before 1.0;
> read the limitations below before relying on it.

## The problem

A user presses "Pay". The server commits the payment, then the response is lost:
a timeout, a dropped connection, a closed laptop. What should the page say?

- **Not "failed".** The server may well have succeeded. Showing an error invites
  a second click and a second payment.
- **Resending must not run it twice.** The same request, sent again with the
  same request id, should get the original outcome back.
- **A refused retry proves nothing.** If the retry is rejected because the
  session expired, that says nothing about whether the first attempt succeeded.
- **Late answers must not undo known ones.** A slow first attempt that times out
  after a retry succeeded must not turn "completed" back into "unknown", and a
  result the user already acknowledged must not come back from another tab.

This package gives you both halves of that contract:

| Part | What it does |
|---|---|
| `firestore-request-ledger/server` | Runs your operation inside a Firestore transaction **at most once per (actor, request id)**, checks that a reused id carries the same content, stores the outcome in the same transaction and replays it on later calls. |
| `firestore-request-ledger/client` | Saves the complete request in `localStorage` **before** sending, keeps it "unconfirmed" until a reply settles that exact request id, offers same-id retry and status lookup, survives reloads and works across tabs. |

There are no runtime dependencies. The server part talks to any Firestore server
SDK instance through a small structural interface (tested with
`@google-cloud/firestore`); the client part uses Web Storage and, when
available, Web Locks.

## How it works

**Server: `execute()`**

1. One Firestore transaction reads the ledger record for `(actor, requestId)`.
2. If a record exists: `authorize` runs again (request ids are not credentials),
   the record's fingerprint must match the operation name and input, and the
   stored outcome is returned with `replayed: true`.
3. If not: `parse` → `authorize` → `read` → `write` run in the same
   transaction, and the ledger record is created together with your business
   writes. Either both commit or neither does.
4. If your hooks throw a `RequestRejection` (a definite "no") while no record
   exists, the refusal is stored in a second transaction that re-checks the
   record first. If another call with the same id committed in between, **its
   success wins** and is what this call returns.
5. Any other error (network, contention, bugs, `authorize` refusing a replay)
   is thrown and stores nothing. Thrown errors are never terminal.

**Client: `createRequestTracker()`**

1. `submit()` snapshots the input as JSON and saves `{requestId, operation,
   input}` to `localStorage` before calling your `send` function. If it cannot
   be saved, nothing is sent.
2. The request stays `unconfirmed` until a reply arrives that is `completed`, or
   `rejected` with `terminal: true`, **for that same request id**. Network
   errors, HTTP 401/403/5xx and malformed bodies leave it unconfirmed.
3. Settled states never go back to unconfirmed. When two answers race, every
   tab converges on the earliest settled one.
4. `acknowledge()` / `discard()` leave a removal marker and remove the request's
   records. A late reply or a tab with an old view cannot bring the request
   back, also after the marker expires.
   Each tab writes only its own attempt and outcome records; the request record
   itself is never rewritten after `submit`. A tab acting on an old view of
   `localStorage` therefore cannot overwrite what another tab stored. The one
   shared record is each slot's list of request ids, kept in two copies and
   written only by `submit` inside its lock (see the limitations without Web
   Locks), before the new request record.
5. Whether a slot already holds a request is decided from that slot record and
   each listed request's own keys, all read directly. Listing keys
   (`Storage.key`) can skip a key without any error while another tab removes
   one, so listings are only used to show requests and to clean up, and "not
   listed" never makes a request (or its settled outcome) count as gone.
   Damage never makes a slot look free: a copy that cannot be parsed is
   restored from the other; if neither can be used, or a request the slot lists
   was removed by `discardBroken()` as unreadable, the slot stays blocked
   (`broken-slot`) until the app has checked and calls `resetSlot()`.
   `discardBroken()` runs inside the same lock as `submit`'s slot check, and
   leaves its marker before it removes a record, so a check that runs anyway
   (without Web Locks) still sees one or the other.
6. Writes that fail after sending (quota, blocked storage) are kept in this
   tab's memory, retried on every operation, and reported by `durable()`.
7. Reads that fail (blocked storage) are reported by `readable()`. Meanwhile
   `list()` and `get()` show the last state seen in this tab, and a settled
   request is never shown as unconfirmed because of a failed read.

## What is verified

Every claim below has tests in this repository. `test/unit` uses deterministic
doubles to order races precisely. `test/integration` runs the real
`@google-cloud/firestore` SDK against the local Firestore emulator. Test ids
are in brackets.

- One execution and one ledger record for repeated or concurrent same-id
  requests, with identical replies [S02, S03, U09].
- The reply equals the stored outcome, and the stored outcome is what later
  replays return [S01, C27].
- Same id with different content, or with another operation name, is refused
  without writing and without becoming terminal [S04, S05, U06]. Object key
  order does not matter [S06, K01, U02].
- Ids are scoped per actor: two users can never replay or block each other's
  requests [S07, U01, C20].
- Definite refusals are stored and replayed as terminal. Refusals raised after
  writes were staged commit none of them [S08, S09, S12].
- Non-definite errors store nothing, so the same id can still succeed. Only the
  refusal that actually ended the transaction is stored [S10, U08, U10, U16, U17].
- A replay re-checks authorization. Being refused then is not stored and is not
  terminal [S11, U07].
- Refusal versus a concurrent success with the same id: the success wins [S13, U04, U05].
- `lookup` authorizes before revealing anything, can verify content, is
  actor-scoped and writes nothing [S15, U15].
- The repository's `firestore.rules` (not part of the npm package) deny client
  SDK access to ledger records [S16].
- The tracker saves before sending and always sends the complete stored request
  [C01, C02]. If the request cannot be saved, it is not sent [C03, C04, C25].
- After a lost response, the request survives a reload. A same-id retry or
  `check()` recovers the outcome [C05, C06, E2, E3].
- A retry refused by sign-in or permission stays unconfirmed [C07, E4]. Only a
  terminal rejection for the same id settles it [C08, C09, W02].
- Late errors, late successes, contradicting late replies and stale unsaved
  changes from other tabs cannot override a settled or removed request
  [C10–C13, C16, C28]. With per-tab storage caches that lag behind (each tab
  reads its own copy): a late error from a tab with an old view does not undo a
  result [X1]; two settled answers racing converge on the first [X2]; late
  writes around the expiry of a removal marker do not bring the request back
  [X3, X4]; attempt counts from several tabs are not lost [X5]; pruning from a
  view that shows a result before its request keeps the result [X6].
- Another tab changing storage while keys are listed: pruning does not delete a
  result whose request record the listing skipped [R1]; `submit` does not open
  a second request in a slot whose open request the listing skipped [R3].
  Failed reads keep settled outcomes and are reported by `readable()` [R2]; a
  partial read keeps the earliest outcome already seen, in either order and
  with equal times [R5]; `submit` refuses (`storage-unreadable`) instead of
  creating a new id when the slot's old request cannot be read [R4], also
  end to end against the emulator after a committed request whose response
  was lost [E6].
- Listings that skip the slot's old request (one, two, or every listing during
  `submit`; its request record only, or all its records): same content reuses
  its id, different content waits, a settled one replays, and nothing runs
  twice [R6]; end to end against the emulator after a committed request whose
  response was lost, the server runs once [E7]. `get()`, `acknowledge()` and a
  reply stored meanwhile find a request whose record a listing skips [R7]; a
  settled outcome seen once stays after `list()` skips the request record and
  a later read misses the outcome [R11]. The slot record: one damaged copy is
  restored from the other; both unusable keep the slot blocked, also after
  `discardBroken()`, until `resetSlot()`; the two copies are combined;
  unreadable or unsaved copies send nothing [R8]. It keeps settled requests
  that are not acknowledged and drops removed ones [R9]; a skipped request
  whose direct read fails is refused [R10]; a damaged slot record followed by
  `discardBroken()` and listings that skip everything of the old request runs
  nothing twice [R12], also end to end against the emulator for one or both
  copies damaged [E8]; a request removed by `discardBroken()` as unreadable
  keeps its slot blocked until `resetSlot()` [R13]; a request that only a
  listing shows is written back into the slot record [R14].
- `discardBroken()` in another tab during `submit`'s slot check, started after
  each single storage read of the check: the old request never runs again and
  its slot stays blocked, without a lock that keeps the tabs apart [R15] and
  with a shared exclusive lock, where the cleanup waits for the check [R16];
  end to end against the emulator for no cleanup, cleanup first, and cleanup
  in the middle of the check [E9]. Without locks, another tab's whole submit
  between two reads of this tab's submit runs only one request, and the slot
  record still lists it [R17].
- Cross-tab visibility and notifications [C14]. Storage failure after sending
  [C15]. Slot rules [C17]. Same-tab double submit sends once [C18].
  Unmount/user switch before sending [C19]. Unreadable entries [C21]. Lock
  usage [C22].

## What is not covered (limitations)

- **No end-to-end exactly-once for anything outside the transaction.** E-mail
  (SMTP), creating, enabling or deleting Auth users, calls to other HTTP APIs,
  queues and similar side effects cannot join a Firestore transaction. If you
  run them after a fresh (`replayed: false`) reply, they can be lost (a crash
  after commit) and they are not repeated on replay. Track them separately.
- **Request ids are not authorization.** Authenticate every call, including
  retries and lookups, and derive `actor` on the server from verified
  credentials, never from the request. Use `authorize` for scoped checks; it
  runs on replays too.
- **The deduplication window is the record's lifetime.** The library never
  deletes ledger records. If you add a TTL policy or delete records, the same id
  can execute again.
- **Content equality means JSON equality, ignoring object key order.** It
  mirrors `JSON.stringify`, so `NaN` and `null` compare equal and a `Date`
  compares as its ISO string. Only a SHA-256 fingerprint of the input is
  stored, not the input itself.
- **Results are stored as JSON text**, 16 KiB by default (`maxResultBytes`).
  Return identifiers, not documents.
- Firestore's own limits apply: transaction size and contention retries. A call
  that exhausts contention retries fails without a record, so it is not
  terminal.
- **Cross-tab exclusivity relies on Web Locks.** Without `navigator.locks`, two
  tabs submitting different content into the same slot within the same
  instant could both create ids, and one tab's slot record can miss the
  other's id (listings still show it, and a later `submit` in that slot that
  goes ahead writes it back). Same-tab submits are always serialised. Set
  `requireLocks: true` to refuse sending instead.
- **The slot record assumes that a tab holding the lock reads what the
  previous holder wrote.** Browsers keep per-process copies of
  `localStorage` and do not promise this. If a tab ever acts on an older copy,
  a request missing from its slot record is still found by listings.
- **A settled outcome stored by another tab is found through listings.** While
  every listing skips it, this tab sees the request as unconfirmed; a
  same-content `submit` then sends the same id again and the server replays
  the stored outcome (nothing runs twice).
- **`resetSlot()` and `discardBroken()` are decisions for the app.**
  `discardBroken()` removes unreadable request records, whose content is lost;
  a slot that lists one stays blocked. `resetSlot()` rebuilds a blocked slot's
  record from what a listing shows, which can miss requests. Call it only after
  making sure (for example with your server) that no request of that slot is
  still pending. Records removed or rewritten by other code in the same
  origin are outside what the tracker can protect.
- **The tracker keeps complete inputs in `localStorage`** until they are
  acknowledged or discarded. Do not put secrets in inputs. Decide what your
  app does on sign-out on shared computers.
- Acknowledgement applies per actor and browser profile, not per tab.
- If one tab's request was acknowledged by another tab while still in flight, a
  late network error in the first tab reports `unconfirmed`, because the
  outcome is no longer held locally. `check()` recovers it from the server.
- A reply that arrives after the request was removed (or after `localStorage`
  was cleared) is returned to that call but not stored, so it never reappears
  in `list()`.
- The cross-tab tests model each tab's view of `localStorage` as a cache that
  can lag behind; single storage operations are atomic in the model. Real
  browsers are not driven by these tests.
- Not exercised by the automated tests: the `firebase-admin` Firestore
  instance (the same class, re-exported), named databases, production latency,
  and real browsers. The tracker is tested with in-memory Storage/Locks doubles
  (a manual spot check in Chrome was done outside this repository). The example
  UI is built and served, but no browser automation drives it.

## Requirements

Using the package:

- ES modules only, imported from the subpaths `firestore-request-ledger/server`,
  `/client` and `/wire` (there is no root entry point). The code is ES2022.
- Server part: tested on Node.js 22 with `@google-cloud/firestore`.
- Client part: a browser with Web Storage; Web Locks when available. The
  automated tests use in-memory doubles (see the limitations above).

Developing the library:

- Node.js 22.18 or newer (tests and the example run TypeScript directly).
- Java 21 or newer for the Firestore emulator (firebase-tools 15).
- No Firebase project, account or credentials. Everything runs against the
  local emulator under the `demo-request-ledger` project id.

## Install and run

```sh
npm install firestore-request-ledger
```

There are no runtime dependencies. The server part takes the Firestore
instance you already use (see Usage); the client part runs in the browser.

To work on the library itself, from a checkout:

```sh
npm ci
npm run typecheck
npm run test:unit
npm run test:integration   # starts and stops a local Firestore emulator
npm run build              # dist/, example/dist/, package checks
```

The emulator uses ports 8190 (Firestore), 9190 (websocket), 4190 (hub) and
4590 (logging). The example uses 5190 (API) and 5191 (UI). They are set in
`firebase.json`, `example/dev.ts` and `example/vite.config.ts`.

### Example

```sh
npm run example
```

Open http://127.0.0.1:5191. The page adds points to a synthetic account. Fault
switches let you lose the response after the server commits, or refuse a
request before it reaches the ledger. Then use "Check status" and "Retry with
same id" to recover. Open a second tab to see the same pending request there.
Stop with Ctrl+C. The data lives only in the emulator and disappears when it
stops.

## Usage

### Server

```ts
import { Firestore, FieldValue, type Transaction } from '@google-cloud/firestore';
import { LedgerError, execute, errorReply, reject, type Operation } from 'firestore-request-ledger/server';

const db = new Firestore();

const addPoints: Operation<Transaction, { amount: number }, { balance: number }, { balance: number }> = {
  name: 'addPoints',
  parse(input) {
    const amount = (input as { amount?: unknown })?.amount;
    if (!Number.isSafeInteger(amount) || (amount as number) < 1) reject('invalid-argument', 'amount must be a positive integer');
    return { amount: amount as number };
  },
  async authorize(tx, { actor }) {
    const member = await tx.get(db.doc(`members/${actor}`));
    if (member.data()?.active !== true) reject('permission-denied', 'not a member');
  },
  async read(tx, { actor }) {
    const account = await tx.get(db.doc(`accounts/${actor}`));
    return { balance: account.data()?.balance ?? 0 };
  },
  write(tx, { actor, requestId, payload }, { balance }) {
    const next = balance + payload.amount;
    tx.set(db.doc(`accounts/${actor}`), { balance: next }, { merge: true });
    tx.set(db.doc(`accounts/${actor}/entries/${requestId}`), { amount: payload.amount });
    return { balance: next };
  },
};

// Inside your request handler, after verifying who the caller is:
try {
  const reply = await execute({
    db,
    operation: addPoints,
    actor: verifiedUserId,           // from your auth layer, never from the body
    requestId: body.requestId,
    input: body.input,
    timestamp: () => FieldValue.serverTimestamp(),
  });
  respond(200, reply);               // completed (fresh or replayed) or a terminal rejection
} catch (error) {
  respond(error instanceof LedgerError ? 409 : 500, errorReply(error, body.requestId)); // never terminal
}
```

Deny all client access to the ledger collection in your security rules (see
`firestore.rules` in the repository; it is not part of the npm package). A
client that could write ledger records could forge replayed results.

### Client

```ts
import { createRequestTracker, NotSentError, type SendFunction } from 'firestore-request-ledger/client';

const tracker = createRequestTracker({ actor: currentUser.uid });

const post = (path: string): SendFunction => async (request) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await getIdToken()}` },
    body: JSON.stringify(request),   // { requestId, operation, input }
  });
  return response.json();            // the tracker decides whether this settles the request
};
const send = post('/api/execute');
const lookup = post('/api/lookup');  // server side: lookup({ db, actor, requestId, expect })

try {
  const outcome = await tracker.submit({
    slot: 'add-points-form',
    operation: 'addPoints',
    input: { amount: 5 },
    send,
    stillValid: () => isMounted() && auth.currentUser?.uid === currentUser.uid,
  });
  if (outcome.status === 'completed') { show(outcome.result); tracker.acknowledge(outcome.requestId); }
  if (outcome.status === 'rejected') { showError(outcome.message); tracker.acknowledge(outcome.requestId); }
  if (outcome.status === 'unconfirmed') { showUnknown(outcome.requestId); } // offer check / retry, not "failed"
} catch (error) {
  if (error instanceof NotSentError) showNotSent(error.reason); // nothing left the browser in this call
}

// Later, or in another tab:
tracker.list();                                      // remembered requests for this user
await tracker.retry(requestId, { send });            // same id, same stored content
await tracker.check(requestId, { lookup });          // ask the server without running anything
tracker.subscribe(() => render(tracker.list()));     // this tab and other tabs
```

Any transport works (fetch, a Firebase callable, a WebSocket) as long as the
reply body reaches the tracker unchanged. Full reference: [docs/API.md](docs/API.md).

## Project layout

```
src/server   execute(), lookup(), errors, structural Firestore types
src/client   createRequestTracker() and its storage/lock ports
src/shared   canonical JSON and the reply format shared by both sides
example/     React page + small Node API server, emulator only, synthetic data
test/        unit (doubles) and integration (Firestore emulator) suites
```

## Origin

The design comes from patterns used in a private production web app. Those
patterns went through several rounds of review of their failure cases. This
repository is a fresh, independent implementation with its own tests. It
contains no code, data or history from that app. It has no external users yet.

## 繁體中文摘要

這是一個 Firestore 請求防重複與結果待確認的小型套件，0.1.0 是第一個公開版本（`npm install firestore-request-ledger`）。1.0 之前介面仍可能調整。

- 伺服器端：同一使用者、同一請求鍵只會執行一次。業務寫入與請求紀錄在同一筆交易提交；之後以相同內容重送時回放原結果，改了內容就拒絕。重送時仍會重新核對權限。
- 前端：送出前先把完整請求存進 localStorage。在收到「同一請求鍵」的確定結果前，一律顯示結果未確認，可以查詢或用同一請求鍵重試。連線中斷、逾時或登入／權限拒絕，都不會被當成先前那次失敗。晚到的回應不能推翻已確認的結果；各分頁只寫自己的紀錄，舊畫面的分頁也蓋不掉其他分頁存下的結果；已移除的請求不會因晚到的寫入重新出現。同一表單（slot）是否已有請求，以直接讀取的槽位紀錄（存兩份）判定，不依賴可能漏看的鍵列舉；紀錄損壞時，該表單維持阻擋，直到應用程式核對後呼叫 resetSlot()。紀錄跨分頁可見，寫入儲存失敗時也有對應處理。
- 不宣稱外部服務能做到端到端 exactly-once。寄信（SMTP）、Auth 帳號建立／啟用／刪除等交易外副作用都不在保證範圍內。請求鍵不是授權。
- 測試只使用本機 Firestore emulator 與合成資料，不需要任何正式專案或憑證。

## License

MIT. See [LICENSE](LICENSE).
