# GitHub Copilot Instructions for `firestore-request-ledger`

This repository is a small, strict TypeScript library providing request deduplication, outcome replay, and unconfirmed-outcome tracking for Firestore transactions and browser clients. Follow these rules in all code suggestions, edits, and pull request reviews.

## Core Architecture & Constraints

- **Zero runtime dependencies**: Never add entries to `dependencies` in `package.json`. Only add `devDependencies` with clear justification.
- **ESM only**: Keep all entry points under `src/server`, `src/client`, and `src/shared` (`./server`, `./client`, `./wire`).
- **Strict TypeScript (`tsconfig.json`)**:
  - `erasableSyntaxOnly: true` (do not use `enum`, `namespace`, or parameter properties).
  - `verbatimModuleSyntax: true` (always use `import type` for type-only imports).
  - `noUncheckedIndexedAccess: true` (handle `undefined` safely on array/record lookups).
  - Always include explicit `.ts` extensions on relative TypeScript imports.
- **Security boundaries**:
  - `actor` must always come from verified server authentication, never from request bodies or unverified headers.
  - Never allow client SDK access to the ledger collection (`firestore.rules`).
  - Never use real Firebase projects, credentials, or real user data in tests, examples, or docs. Only use the local Firestore emulator (`demo-request-ledger`) and synthetic data.

## Testing & Race Control Rules

- **Test runner**: Use Node.js built-in `node:test` and `node:assert/strict`. Do not introduce Jest, Vitest, or `@playwright/test`.
- **Deterministic races only**:
  - Never use `page.waitForTimeout()` or arbitrary `setTimeout()` sleeps to wait for async transitions or race conditions.
  - Use explicit synchronization points: `createDeferred()` gates, Playwright `route` interception (`route.fetch()`, `route.abort()`, `route.fulfill()`), `waitForEvent('requestfailed' | 'response')`, observable DOM/locator states (e.g., `button[type="submit"]:not([disabled])`), and `try / finally` gate cleanup.
  - Every browser E2E test (`test/browser/*.test.ts`) must set a finite `{ timeout: 30_000 }` and assert invariants on **both sides** (browser UI / `localStorage` AND backend Firestore emulator state).
- **Honest documentation**: Never claim a guarantee in `README.md` unless a passing test covers it and its test ID (`S`, `U`, `C`, `E`, `K`, `W`, `P`, `B`) is referenced.

## Verification Commands

Before considering any change complete, verify with:
1. `npm run typecheck`
2. `npm run build`
3. `npm run test:all` (or `npm run test:unit` / `npm run test:integration` / `npm run test:browser:run` for targeted runs)