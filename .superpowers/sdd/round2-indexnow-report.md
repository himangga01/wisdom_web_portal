# Round 2 A2: sealed sitemap to IndexNow report

## Scope delivered

- `verifySealedPublicationRelease` now reads the verified `sitemap.xml`, rejects a missing or empty sitemap and malformed, duplicate, cross-origin, or non-HTTPS URLs, then exposes a sorted `sitemapUrls` set and SHA-256 of `urls.join("\n")`.
- Publication activation no longer reconstructs IndexNow URLs from `release_entries`. It uses the independently verified target sitemap set unioned with the independently verified previous active release set, so removed URLs are submitted for 404 discovery and core URLs remain present even with no articles.
- The durable IndexNow payload includes `urlSetSha256`. Delivery verifies the hash plus the existing byte-count, URL-count, URL-length, host, HTTPS, uniqueness, and shape limits before calling the sender.
- Rollback/reconcile conflicts update the existing release outbox row. A sent/failed row is re-armed; a changed URL-set hash replaces and resets pending/processing payload state. Resetting payload, state, locks, and fencing token prevents an earlier claim from completing.
- Search discovery operations documentation now describes the verified sitemap authority, target/previous union, set hash, removal submission, rollback re-arm, limits, and stale-claim fencing.

## TDD evidence

Observed RED before the corresponding production change for:

- missing sealed URL set/hash;
- duplicate, cross-origin, malformed, empty, non-HTTPS, and missing sitemap behavior;
- missing core `/` URL caused by DB-row derivation;
- removed URL absent from the next activation payload;
- rollback leaving a sent row unchanged under `DO NOTHING`;
- a pre-reset claim completing successfully after rollback;
- hashed outbox payload being rejected by the pre-change strict payload parser.

Each focused RED was followed by a focused GREEN before the next behavior. The explicit empty-article release test confirms core sitemap URLs and their hash do not depend on article rows.

## Self-review

- Re-read `.superpowers/sdd/round2-indexnow-brief.md` line by line and kept changes within Control publication/build/IndexNow plus the named search-discovery documentation.
- Confirmed no build environment, JSON-LD, service provenance, privacy/content, general operations, or schema migration changes.
- Removed the old `release_entries` URL reconstruction helper.
- Tightened all publication/reconcile re-verification call sites to the configured public origin.
- Added the missing-sitemap fail-closed case found during diff review.
- `git diff --check` is clean.

## Verification

- Affected Control publication/build/IndexNow tests: 6 files, 48 tests passed.
- Control typecheck: passed (`tsc -p tsconfig.json --noEmit`).
