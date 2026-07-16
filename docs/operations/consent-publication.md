# Consent publication runbook

This runbook keeps the policy text shown on the four-locale public Site identical to the
policy authority accepted by consultation intake.

## Authority model

- The active, sealed public release is the only production consent authority.
- `consent:activate` selects the complete eight-document database bundle for the next
  publication snapshot. It does not immediately replace the authority served by the
  public API.
- A release contains canonical `consent-bundle.json`, its content SHA-256 descriptor,
  all eight policy pages, and the strict `.wisdom-release-manifest.json` inventory.
- A bundle ID is permanent. It owns exactly one privacy and one marketing document for
  each of the four locales. Document IDs, versions, text, semantic hashes, retention
  roles, creation metadata, and assigned effective/retired times are immutable.
- `GET /api/v1/consent-documents`, form tokens, and consultation acceptance resolve the
  same sealed release. If the release row, pointer, metadata, artifact, or database copy
  disagrees, readiness and consent endpoints fail closed rather than mixing versions.

## Publish a new policy bundle

1. Choose a new bundle ID and new canonical document versions. Never reuse a bundle ID
   for revised text. Seed one complete bundle containing privacy and marketing documents
   for `ko`, `en`, `zh-Hans`, and `zh-Hant`. Record the confirmation SHA printed by
   `consent:seed`. An exact eight-document reseed is a no-op; any changed, missing, or
   additional identity is rejected atomically.
2. Obtain the representative/privacy operator's recorded approval of the exact four-
   locale text and of the 12-month privacy / 24-month marketing retained-envelope scope.
3. Run `consent:activate --bundle <id> --confirm-sha <sha>`. The command reports
   `publicAuthority: pending-publication`.
4. Open `/admin/publish/preview`. Review the candidate bundle and eligible articles.
   Use the policy-only publish action when no article head is awaiting publication.
5. The build captures one immutable snapshot, builds Astro from its absolute directory,
   verifies every policy DOM and file hash, renames the verified output, journals the
   activation, switches `public-current`, and commits the active release.
6. Check `/health/ready`, then compare all four localized consent API responses with the
   corresponding `/privacy` and `/marketing/withdraw` DOM metadata and text.

Do not activate another consent bundle while a publication activation is `prepared` or
`switched`; the CLI is intentionally rejected until reconciliation completes. A bundle
change detected during a long build rejects the build with
`PUBLICATION_CONSENT_BUNDLE_CHANGED_DURING_BUILD` and leaves the public pointer unchanged.

Activation is one-way: `draft -> active -> retired`. An active or retired bundle cannot
be activated again. To change policy text, create and publish a new bundle. A static
release rollback does not reactivate database rows; it serves the verified historical
bundle retained by that release with its original effective time.

Before a snapshot is written, Control compares every one of the eight policy titles and
bodies against retained consultation PII. It repeats the comparison inside the final
writer transaction after the build. `PUBLICATION_CONSENT_PII_REJECTED` or
`PUBLICATION_PII_CHANGED_DURING_BUILD` therefore leaves no release row, activation
journal, final directory, or public pointer.

## Database migration safety

Schema v4 adds the bundle identity index and immutable content/lifecycle triggers. The
migration first converts every existing v3 bundle through the same canonical validator
used by consent publication. It requires exactly eight identities, one coherent lifecycle
state and effective/retired time, fixed 12/24-month roles, canonical versions, nonblank
bounded text, and a matching semantic content hash. Malformed legacy data aborts the
whole migration and keeps both `schema_migrations` and SQLite `user_version` at v3 for
operator repair; it is never marked ready under a partially applied schema. Canonical
active and retired historical bundles retain their original timestamps during upgrade.

## Builds and fixtures

- A production Site build requires an absolute `WISDOM_PUBLISHED_CONTENT_DIR` generated
  by Control. Missing or relative paths are rejected before Astro starts.
- `npm run build:fixture --workspace @wisdom/site` is only for tests and local visual QA.
  The fixture is under `apps/site/src/content/__fixtures__` and must never be tunneled as
  a production release.
- There is no tracked production fallback under `apps/site/published-content`.

## Rollback

Rollback re-verifies the retained release, strict database release metadata, and its
sealed historical consent bundle before switching the pointer. The same checks run again
inside the activation writer transaction and during recovery. The API then serves that
same historical bundle. Database consent rows may be retired; their immutable ID, text,
metadata, effective time, and hashes must still match the sealed artifact. Never
reconstruct policy text manually during rollback.
