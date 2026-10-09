# Contributing

Thanks for your interest. This project is small on purpose: request
deduplication, outcome replay and unconfirmed-outcome tracking for Firestore,
with the failure cases tested.

## Setup

- Node.js 22.18 or newer
- Java 21 or newer (Firestore emulator)
- No Firebase account, project or credentials are needed

```sh
npm ci
npm run typecheck          # tsc + README snippet check
npm run test:unit          # fast, no emulator
npm run test:integration   # Firestore emulator, project demo-request-ledger
npm run build              # library, example, package checks
npm run example            # interactive demo on http://127.0.0.1:5191
```

## Ground rules

- **Never point tests or the example at a real project.** Use the emulator and
  a `demo-` project id only. The test helpers refuse to run otherwise.
- **Synthetic data only** in tests, fixtures, examples and issue reports.
- **Keep the runtime dependency-free.** Dev dependencies need a reason.
- **Write the tests before claiming a behaviour.** Every guarantee in the
  README names the tests that cover it; keep that list honest.

## Writing tests

The bugs this library exists to prevent hide in orderings, so:

- Test **both sides of each invariant**: e.g. the reply *and* what was stored;
  what is saved *and* what a reload restores; the complete request *and* not
  just the payload; a refusal that must be terminal *and* one that must not be.
- Make races **deterministic**: use the doubles in `test/helpers` (deferred
  promises, the fake Firestore's `beforeTransaction` / `beforeCommit` hooks, a
  wrapped `FirestoreLike` against the emulator) instead of timing.
- When you add a case, add its neighbour that should behave differently (same
  id vs. different id, same actor vs. different actor, before vs. after commit).
- Give tests an id prefix (`S` server/emulator, `U` server unit, `C` client,
  `E` example, `K`/`W` canonical/wire, `P` release checks) and reference new
  guarantees in the README.

## Pull requests

- One topic per pull request, with a short description of the failure case it
  addresses and the tests that show it.
- CI must pass: clean install, type check, unit tests, emulator integration
  tests, build.
- By contributing you agree that your contribution is licensed under the
  project's license (MIT, see `LICENSE`).

## Releasing

1. The maintainer's decisions are filled in: copyright holder (`LICENSE`),
   security contact (`SECURITY.md`), README status and install section,
   `package.json` metadata. `npm run check:release` lists anything missing;
   `npm publish` runs the same check (`prepublishOnly`) and refuses until it
   passes, then rebuilds `dist/`.
2. Push the release commit to `main` and wait until CI passes **for that exact
   commit**.
3. Only then create the version tag on that commit, as an annotated tag
   (`git tag -a v0.1.0 <commit> -m v0.1.0`), and push it. A tag is never moved:
   if CI fails, fix forward and tag the next commit.
4. Publish from a clean checkout of the tag, in this order: `npm ci`,
   `npm run check:release`, `npm run build` (`dist/` is not in Git: without
   the build the package holds only 3 files), `npm pack --dry-run` (check the
   file list), `npm pack` (keep the tarball), then `npm publish`. Compare the
   published `dist.integrity` with that tarball.
5. When reading the tag back, ask for both refs:
   `git ls-remote <repo> 'refs/tags/v0.1.0' 'refs/tags/v0.1.0^{}'`. The second
   line (the annotated tag's target) must be the release commit.

