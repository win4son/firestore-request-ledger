# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately to: **win4son@gmail.com**

Include what you found, how to reproduce it (synthetic data only, please), and
the impact you expect. You should get an acknowledgement within a reasonable
time; this project is maintained by volunteers and does not offer a formal SLA.

## Supported versions

Only the latest released version receives fixes.

## Security model in short

- **The ledger collection must not be client-accessible.** If a client SDK can
  write ledger records, it can forge replayed results. The repository's
  `firestore.rules` (not part of the npm package) deny all client access;
  integrate an equivalent rule.
- **`actor` must come from verified authentication** on the server, never from
  the request body or an unverified header. (The example's `x-demo-actor`
  header is a demo-only shortcut and is labelled as such.)
- **A request id is not a credential.** Authenticate and authorize every call,
  including retries and lookups. Records are scoped per actor, and `authorize`
  runs again on replays.
- **Stored data:** the server stores a SHA-256 fingerprint of the input (not
  the input) and the result as JSON. The browser tracker stores complete
  request inputs in `localStorage` until they are acknowledged or discarded;
  keep secrets out of inputs and decide how your app handles shared devices.
- Side effects outside the Firestore transaction are not protected by this
  library (see README, "What is not covered").

Reports about these documented limitations are still welcome if you see a way
to make them safer.
