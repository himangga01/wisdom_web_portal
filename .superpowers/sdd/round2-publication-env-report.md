# Round 2 Publication Environment Report

## Status

`DONE`

The isolated publication build now receives a Site-compatible production `PUBLIC_ORIGIN` and at most one normalized Naver ownership-verification setting through an explicit, secret-free child environment. The command remains fixed and shell-free, and no ambient environment is inherited.

## Delivered scope

- Added pre-spawn validation for an exact production HTTPS public origin using the same acceptance rules exercised by Site's production search-build parser.
- Threaded `publicOrigin` from `PublicationReleaseConfig` through `defaultPrepareRelease` into `runPublicationBuild` and the child `PUBLIC_ORIGIN` allowlist.
- Extracted the existing Site ownership-verification parser to `@wisdom/shared`; Site re-exports the same parser, while Control uses it to normalize placeholders, reject multiline or malformed values, and enforce mutually exclusive Naver meta/file modes without exposing values in errors.
- Threaded the optional normalized Naver mode from Control production configuration through `PublicationReleaseConfig`, `defaultPrepareRelease`, and the isolated build environment.
- Added a Control-to-Site integration-boundary test that passes the observed child environment to Site's real `createSearchBuildState` production parser.
- Added opt-in Naver examples to `.env.example` and the macOS runtime template, plus both names to the runtime allowlist and focused Ops coverage.
- Left IndexNow, JSON-LD/provenance, content/privacy, and unrelated operations unchanged.

## TDD evidence

- Initial RED: `npm.cmd run test --workspace @wisdom/control -- src/articles/publication-build.test.ts` failed 2/8 because `PUBLIC_ORIGIN` and the Naver setting were absent and Site rejected the observed environment with `PUBLIC_ORIGIN_INVALID`.
- First GREEN: the same focused file passed 8/8 after the minimal child-environment threading.
- Remaining RED:
  - Control publication/config: 3 failures for missing exact-origin validation and missing normalized Naver config.
  - Site verification: 1 failure because a trailing newline was trimmed and accepted.
  - Ops runtime/config: 2 failures because the runtime keys and templates were absent.
- Remaining GREEN:
  - Control publication/config: 19/19 passed.
  - Site verifier: 4/4 passed.
  - Focused Ops runtime/config: 24/24 passed.

## Verification evidence

- `npm.cmd run build:shared` — passed.
- `npm.cmd run test --workspace @wisdom/control -- src/config.test.ts src/articles/publication-build.test.ts src/articles/publication-release.test.ts test/publication-search-boundary.test.mjs` — 4 files, 28/28 passed.
- `npm.cmd run test --workspace @wisdom/site -- src/search/origin.test.ts src/search/verification.test.ts src/search/endpoints.test.ts` — 3 files, 27/27 passed.
- `npm.cmd run build --workspace @wisdom/control` — passed before the Ops integration test consumed `apps/control/dist/config.js`.
- `node --test ops/tests/runtime-launch.test.mjs ops/tests/configuration.test.mjs` — 24/24 passed.
- `npm.cmd run typecheck --workspace @wisdom/shared` — passed.
- `npm.cmd run typecheck --workspace @wisdom/control` — passed.
- `npm.cmd run typecheck --workspace @wisdom/site` — 59 files, 0 errors, 0 warnings, 0 hints.
- `git diff --check` — no whitespace errors; only Windows LF-to-CRLF advisory warnings.

## Self-review

- The publication child request still uses `shell: false`, a fixed npm argument vector, and an environment constructed only from explicit non-secret inputs.
- Validation errors are fixed reason codes and never include Naver values; no logging path was added.
- Placeholder examples remain commented so the runtime parser does not receive empty or ambiguous active settings.
- The shared surface contains the ownership-verification contract plus the exact production public-origin parser; Control and Site consume that single acceptance implementation.
- No out-of-scope review finding was changed.

No blocking concern remains for this brief.

## Review fix evidence

- Review verification confirmed that Control and Site duplicated the exact production-origin acceptance logic. The parser now lives in `@wisdom/shared`; Site re-exports it, while Control maps its value-free `PUBLIC_ORIGIN_INVALID` failure to `PUBLICATION_ORIGIN_INVALID` without duplicating acceptance rules.
- RED: `npm.cmd run test --workspace @wisdom/shared -- src/search-origin.test.ts` failed 1/1 because the required `parsePublicOrigin` shared export was absent.
- GREEN: the same shared origin contract test passed 1/1 after extraction.
- Added the missing Naver file-mode integration boundary. The observed isolated child environment contains only `NAVER_SITE_VERIFICATION_FILE`, and Site's real production `createSearchBuildState` accepts and normalizes it.
- `npm.cmd run build:shared` — passed.
- `npm.cmd run test --workspace @wisdom/control -- test/publication-search-boundary.test.mjs` — 2/2 passed.
- `npm.cmd run test --workspace @wisdom/control -- src/config.test.ts src/articles/publication-build.test.ts src/articles/publication-release.test.ts test/publication-search-boundary.test.mjs` — 4 files, 29/29 passed.
- `npm.cmd run test --workspace @wisdom/site -- src/search/origin.test.ts src/search/verification.test.ts src/search/endpoints.test.ts` — 3 files, 27/27 passed.
- `npm.cmd run typecheck --workspace @wisdom/control` — passed.
- `npm.cmd run typecheck --workspace @wisdom/site` — 59 files, 0 errors, 0 warnings, 0 hints.
- The publication child still uses the fixed shell-free command and explicit environment object; no ambient environment or logging path was introduced.
