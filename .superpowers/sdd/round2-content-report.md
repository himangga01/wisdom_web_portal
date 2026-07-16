# Round 2 content/privacy remediation report

## Status

`DONE_WITH_CONCERNS`

The implementation contract is complete and verified. Launch still requires the representative/privacy operator to approve the final four-locale legal text, the full 12/24-month retained-envelope scope, and the English/Chinese professional titles.

## Implemented outcomes

1. The immutable public-content snapshot now captures the exact active consent bundle used by intake: privacy and marketing documents for `ko`, `en`, `zh-Hans`, and `zh-Hant` (8 documents total).
2. The shared schema enforces canonical order, a single bundle/effective date, privacy=`required`/12 months, marketing=`optional`/24 months, exact semantic SHA-256 values, and no extra fields.
3. `consent-bundle.json` is canonical JSON, independently SHA-256 sealed by `manifest.json`, and included in the aggregate publication snapshot identity.
4. The Site loader fails closed for missing, oversized, non-canonical, schema-invalid, symlinked, path-escaping, hash-mismatched, or unexpected consent content. Loaded policies and nested documents are frozen.
5. All eight localized policy routes render the matching activated title, body, version, effective date, retention period, and hash. Policy Markdown is rendered as escaped text in `<pre>`, never interpreted as HTML.
6. Static release verification requires exactly one matching policy article per route and exact version/effective-date/hash/retention attributes plus exact escaped `<h2>` and `<pre>` contents. Added or modified policy text, missing routes, unsafe script/event markup, and metadata changes reject the release.
7. The public marketing-withdrawal explanation now describes the accountless, emailed one-time link. Phone and email are explicitly support contacts, not standalone mutation paths.
8. The hidden portrait placeholder contract was removed and replaced with an intentional bronze/sand/ivory brand illustration with honest localized accessible labels. The representative name, layout, responsive behavior, `portrait` reveal key, 18 reveals, and 500 ms C1 timing remain unchanged.
9. Release documentation now gates launch on approval of the full encrypted 12/24-month envelope scope, final policy parity, and the user-supplied English/Chinese professional titles.

## Publication data flow

```text
Admin activates one complete consent bundle
  -> Control reads the same active rows used by the intake API
  -> shared schema validates 8 exact semantic documents and their hashes
  -> publication snapshot deep-freezes the bundle
  -> write consent-bundle.json + manifest.json SHA-256 descriptor
  -> Site loader validates inventory/path/size/canonical JSON/schema/SHA-256
  -> localized /privacy and /marketing/withdraw render escaped exact content
  -> Control verifies all 8 generated policy pages against the snapshot
  -> verified release manifest is sealed and may be activated
```

The snapshot test compares the captured English privacy and marketing records directly with `getPublicConsentDocuments`, the same service contract used by consultation intake. The build tests then prove the public pages cannot diverge from that snapshot's hash, retention period, version, effective date, title, or body.

## Changed files

### Shared publication contract

- `packages/shared/src/consent-publication.ts` — canonical published consent schemas, types, order, and semantic hash helper.
- `packages/shared/src/consent-publication.test.ts` — 8-document completeness/order/role/hash/consistency tests.
- `packages/shared/src/article.ts` and `article.test.ts` — consent snapshot descriptor required in every published manifest.
- `packages/shared/src/index.ts` — exports the consent publication contract.

### Control snapshot and release verification

- `apps/control/src/consent/service.ts` — uses the shared semantic hash implementation.
- `apps/control/src/articles/publication-snapshot.ts` and `.test.ts` — captures, validates, deep-freezes, writes, and hashes the active 8-document bundle; fails closed when incomplete or inconsistent.
- `apps/control/src/articles/publication-build.ts` and `.test.ts` — includes consent in the aggregate snapshot hash and verifies all localized policy routes and exact content/metadata.
- `apps/control/src/articles/publication-release.test.ts` — release fixtures and activation verification include sealed policies.

### Site loading and rendering

- `apps/site/src/content/published-articles.ts` and `.test.ts` — strict consent bundle loading, inventory enforcement, hash verification, and deep freeze.
- `apps/site/src/test/published-content.ts` — one canonical content fixture builder for Site tests.
- `apps/site/src/content/__fixtures__/published-content/consent-bundle.json` and `manifest.json` — E2E fixture bundle and seal.
- `apps/site/scripts/build.mjs` and the root Site build gate — production builds require
  an absolute Control snapshot; the former tracked production fallback was removed.
- `apps/site/src/lib/static-paths.ts`, `static-paths.test.ts`, `article-routes.test.ts`, `search/search-index.test.ts`, `components/PublishedArticle.test.ts`, and `pages/[...path].astro` — propagate the sealed bundle through every static route/test fixture.
- `apps/site/src/components/PublicPage.astro` and `.test.ts` — exact localized escaped policy surfaces and honest one-time-link/support wording.
- `apps/site/src/content/site-content.ts` — removes hard-coded draft policy bodies/warnings and supplies localized support/withdrawal copy and illustration labels.
- `apps/site/src/components/HomePage.astro` and `styles/global.css` — intentional brand illustration replacing the empty portrait slot.
- `apps/site/tests/public-site.spec.ts` — browser coverage for illustration, sealed policy metadata/escaping, C1, no-JS, and consultation behavior.

### Operations

- `docs/operations/release-candidate.md` — policy parity, full-envelope retention approval, optional portrait, and professional-title sign-off launch gates.
- `ops/runbooks/deployment.md` — pre-publication consent inventory/parity and one-time withdrawal operating procedure.

## TDD evidence

Observed RED before implementation included:

- shared manifest/consent schema tests rejecting manifests without the new sealed bundle contract;
- Site loader tests failing across existing fixtures until the canonical consent artifact and manifest hash were added;
- public-page tests failing while hard-coded draft policy copy and portrait slot semantics remained;
- publication build tests accepting policy metadata/body divergence before exact verification was implemented;
- snapshot immutability test failing because the nested document array and documents were not frozen;
- final metadata RED: Control `46 passed, 2 failed` (nested freeze and version/effective-date tamper), Site `5 passed, 1 failed` (version/effective-date attributes absent);
- exact-content RED: the release verifier accepted appended title/body text until exact `<h2>`/`<pre>` equality was enforced.

All those regression tests are GREEN in the final commands below.

## Verification commands and results

- `npm.cmd run test --workspace @wisdom/shared` — 10 files, 70 tests passed.
- `npm.cmd run typecheck --workspace @wisdom/shared` — passed.
- `npm.cmd exec --workspace @wisdom/control -- vitest run src/articles/publication-snapshot.test.ts src/articles/publication-build.test.ts src/articles/publication-release.test.ts` — 3 files, 48 tests passed.
- `npm.cmd run typecheck --workspace @wisdom/control` — passed.
- `npm.cmd run test --workspace @wisdom/site` — 19 files, 99 tests passed.
- `npm.cmd run typecheck --workspace @wisdom/site` — 60 files, 0 errors, 0 warnings, 0 hints.
- `npm.cmd exec --workspace @wisdom/site -- playwright test tests/public-site.spec.ts --project=chromium --grep "intentional brand|exact C1|without JavaScript|native consultation constraints|unchecked marketing"` — 6 focused Chromium tests passed, including a production Astro build/preview.
- `git diff --check` — passed.
- `git diff --exit-code -- prototypes` — no prototype changes.

### Follow-up fresh verification

- `npm.cmd test` — exit 0: orchestration/Astro/build gates 9/9, Shared 70/70,
  Control 393/393, Site 98/98, and Ops 123/123.
- `npm.cmd run typecheck` — exit 0: Shared and Control passed; Astro checked 60
  files with 0 errors, 0 warnings, and 0 hints.
- `npm.cmd run build` — exit 0: Shared and Control compiled and the explicit Site
  fixture build generated 68 static pages.
- `npm.cmd run test:e2e` — exit 0: 108/108 Playwright tests passed across Chromium,
  Firefox, and WebKit.
- The root gate includes missing and relative production snapshot rejection, an explicit
  real fixture build, and the Control-writer-to-real-Site-build-and-seal boundary test.

## Self-review

- Confirmed the publication path fails closed before writing or sealing when any of 8 documents is missing or inconsistent.
- Confirmed the semantic document hash is computed once in Shared and reused by Control, avoiding two subtly different hash contracts.
- Confirmed the manifest seals the bytes of canonical `consent-bundle.json`, while every document also seals its semantic text/metadata hash.
- Confirmed generated policy verification checks exact version, effective date, hash, retention, title, and body rather than substring presence.
- Confirmed untrusted policy text cannot become a script: Astro escapes it and the release verifier rejects script/event markup in the policy article.
- Confirmed no public `data-asset-slot`, hidden empty picture, or portrait-placeholder accessible copy remains; occurrences are only negative regression assertions.
- Confirmed no search/IndexNow/JSON-LD or macOS release-lock implementation was changed and `prototypes/` is untouched.
- Corrected release wording from impossible “privacy non-consent consultation” to “optional marketing non-consent consultation.”

## Follow-up release-authority remediation

The independent review found that snapshot-level parity alone did not make the currently
served API and static release one authority. The accepted follow-up closes that boundary:

1. The sealed release now inventories canonical `consent-bundle.json` and records its
   bundle ID and byte SHA-256 in both the release manifest and strict database metadata.
2. Production consent reads and consultation acceptance resolve the verified active
   release, exact `public-current` pointer, strict metadata, sealed artifact, and immutable
   database rows. Any mismatch or pending activation fails closed with HTTP 503.
3. Policy-only publication is supported when no article head is eligible, so a consent
   change can move the API and all eight policy DOMs together.
4. Consent activation is fenced while a release activation is prepared or switched. A
   long build rechecks the active bundle inside `BEGIN IMMEDIATE`; final rename, seal
   re-verification, release insert, and activation-journal insert share that boundary.
5. A production Site build has no checked-in fallback. Missing or relative publication
   directories fail before Astro, while fixture builds require the explicit `--fixture`
   path. A boundary test writes a Control snapshot, runs the real Site build, and seals it.
6. Rollback resolves the retained release's historical sealed bundle and verifies it
   against immutable database rows, rather than silently substituting the current candidate.

The operational sequence and failure states are documented in
`docs/operations/consent-publication.md`.

## Final independent-review remediation

The final adversarial review found two remaining authority boundaries. Both are now
closed and regression-tested.

1. Publication checks all 16 consent text boundaries (8 documents × title/body) against
   every retained consultation envelope before snapshot creation. It repeats this check
   inside the final writer transaction so a consultation received during the static build
   cannot turn previously safe policy text into retained PII. Both rejection paths clean
   all temporary output and create no release, activation, or public pointer.
2. Schema v4 makes `(bundle_id, kind, locale)` unique, rejects malformed legacy bundles
   before migration, and enforces immutable content, deletion, effective time, retired
   time, and `draft -> active -> retired` lifecycle transitions. The seed service accepts
   only a canonical eight-document bundle; only an exact reseed is a no-op. Revised text
   or versions require a new bundle ID, and retired bundle reactivation is rejected.
3. Activation revalidates canonical version, fixed retention roles, and every semantic
   content hash before assigning an effective time. Exact reseeding after activation does
   not alter row IDs, creation time, state, effective time, or retired time.
4. Rollback authority now uses one strict verifier for the sealed artifact, release
   metadata, and historical database bundle. It runs before pointer switching, again in
   the immediate commit transaction, in reconciliation, and in the production resolver.
   A valid rollback serves a retired bundle with its original effective time while
   tampered metadata is rejected before the pointer changes.

Observed RED evidence for this follow-up:

- a changed version under the same bundle ID inserted a ninth row;
- reactivating a retired bundle overwrote its original effective time;
- retained consultation PII in consent titles/bodies passed snapshot and release creation;
- the database remained at schema v3 when the new v4 migration test expected the
  immutable bundle boundary.

Final follow-up verification:

- focused consent/snapshot/release/database suite: 4 files, 60/60 passed;
- full `@wisdom/control` suite: 37 files, 403/403 passed;
- root `npm.cmd run typecheck`: Shared and Control passed; Astro checked 60 files with
  0 errors, 0 warnings, and 0 hints;
- `git diff --check`: passed.

## Concerns / launch gates

1. The fixture under `apps/site/src/content/__fixtures__` is deterministic non-launch
   test content, including script-like text used to prove escaping. Production publication
   has no tracked fallback and must use the Control-generated absolute snapshot via
   `WISDOM_PUBLISHED_CONTENT_DIR`; never expose the explicit fixture build through the tunnel.
2. Final Korean, English, Simplified Chinese, and Traditional Chinese consent text still requires representative/privacy-operator review. Professional legal/advertising review is an external approval, not something tests can supply.
3. The approved 24-month marketing path retains the full encrypted consultation envelope, not only contact fields. Launch remains gated on explicit documented approval of that scope.
4. The representative portrait remains optional and was not fabricated. The brand illustration is the truthful launch-safe default until an approved photo asset is supplied.
5. Browser verification here is the requested focused Chromium slice; the parent integration pass remains responsible for any broader multi-browser/full-repository verification.
