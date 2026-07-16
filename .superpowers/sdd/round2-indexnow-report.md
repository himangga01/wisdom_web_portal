# Round 2 A2: sealed sitemap to IndexNow report

## Scope delivered

- `verifySealedPublicationRelease` now reads the verified `sitemap.xml`, rejects a missing or empty sitemap and malformed, duplicate, cross-origin, or non-HTTPS URLs, then exposes a sorted `sitemapUrls` set and SHA-256 of `urls.join("\n")`.
- Sitemap parsing is namespace-aware XML rather than regex extraction. It accepts only UTF-8 XML in the generated `urlset > url > loc` structure, decodes entities, ignores comments, and rejects malformed XML, invalid nesting, processing instructions, CDATA, DTDs, and external-entity declarations.
- Sealing and delivery share one canonical IndexNow payload validator. It rejects credentials, fragments (including empty userinfo/fragment syntax), canonical-equivalent duplicates such as an explicit default `:443`, URLs over 4,096 characters, more than 10,000 URLs, and payload JSON over 256 KiB.
- Publication activation no longer reconstructs IndexNow URLs from `release_entries`. It uses the independently verified target sitemap set unioned with the independently verified previous active release set, so removed URLs are submitted for 404 discovery and core URLs remain present even with no articles.
- The target/previous union is passed through that same validator before the prepared build is renamed to a final release or any release/activation row is inserted. Independently valid sets whose union exceeds either 10,000 URLs or 256 KiB fail while the prior pointer remains active, leave no extra final release, and clean the build/snapshot/home temporary directories.
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
- regex sitemap extraction accepting malformed XML, comment text, and undecoded entities;
- sealing accepting credentials, fragments, default-port canonical duplicates, overlong URLs, over-count URL sets, and over-byte payloads;
- independently valid target/previous sets switching successfully even though their union exceeded 10,000 URLs or 256 KiB;
- empty credentials and empty fragments being normalized away by `URL` before validation.
- an over-limit union leaving a final release plus hidden build-home and snapshot directories because validation ran after the final rename;
- Node URL normalization accepting a non-absolute `https:@host/path` spelling as a valid HTTPS URL.

Each focused RED was followed by a focused GREEN before the next behavior. The explicit empty-article release test confirms core sitemap URLs and their hash do not depend on article rows.

## Self-review

- Re-read `.superpowers/sdd/round2-indexnow-brief.md` line by line and kept changes within Control publication/build/IndexNow plus the named search-discovery documentation.
- Confirmed no build environment, JSON-LD, service provenance, privacy/content, general operations, or schema migration changes.
- Removed the old `release_entries` URL reconstruction helper.
- Tightened all publication/reconcile re-verification call sites to the configured public origin.
- Added the missing-sitemap fail-closed case found during diff review.
- Corrected the cross-host delivery regression to use an otherwise valid shape and URL-set hash, and added an independent same-host hash-mismatch regression.
- Added exact `saxes@6.0.0` as the XML parser dependency; DTD handling is rejected before any entity can be resolved.
- `git diff --check` is clean.

## Verification

- Focused Control publication/build/IndexNow tests: 3 files, 51 tests passed.
- Full Control test suite: 37 files, 383 tests passed.
- Control typecheck: passed (`tsc -p tsconfig.json --noEmit`).
