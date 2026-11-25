# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-26

### Added
- Playwright multi-tab headless Chromium E2E test suite (`B01`–`B10`) verifying native Web Locks, cross-tab storage events, and recovery against the local Firestore emulator.
- Automated npm publishing workflow (`.github/workflows/release.yml`) using npm Trusted Publishing (GitHub Actions OIDC) with SLSA provenance.
- `CHANGELOG.md`, GitHub Copilot repository instructions, and structured bug report issue template.

### Changed
- Updated `README.md` with CI, npm, license, and zero-dependency status badges, `B01`–`B10` browser verification documentation, and updated `Project layout`.
- Upgraded GitHub Actions workflow dependencies and development toolchain (`firebase-tools`, `@google-cloud/firestore`, `vite`, `react`).
- Tuned Dependabot to group `github-actions` updates and keep `@types/node` aligned with Node.js 22 LTS.

## [0.1.0] - 2026-10-25

### Added
- Initial public release of `firestore-request-ledger` with zero runtime dependencies and strict ESM entry points (`./server`, `./client`, `./wire`).
- Server-side Firestore transaction deduplication, canonical payload fingerprinting, replay, and lookup (`execute()`, `lookup()`).
- Browser-side unconfirmed-outcome tracking, cross-tab synchronization, and damaged-slot protection (`createRequestTracker()`).
- Unit test doubles, Firestore emulator integration tests, and runnable local example app.
