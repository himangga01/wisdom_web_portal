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
- `GET /api/v1/consent-documents`, form tokens, and consultation acceptance resolve the
  same sealed release. If the release row, pointer, metadata, artifact, or database copy
  disagrees, readiness and consent endpoints fail closed rather than mixing versions.

## Publish a new policy bundle

1. Seed one complete bundle containing privacy and marketing documents for `ko`, `en`,
   `zh-Hans`, and `zh-Hant`. Record the confirmation SHA printed by `consent:seed`.
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

## Builds and fixtures

- A production Site build requires an absolute `WISDOM_PUBLISHED_CONTENT_DIR` generated
  by Control. Missing or relative paths are rejected before Astro starts.
- `npm run build:fixture --workspace @wisdom/site` is only for tests and local visual QA.
  The fixture is under `apps/site/src/content/__fixtures__` and must never be tunneled as
  a production release.
- There is no tracked production fallback under `apps/site/published-content`.

## Rollback

Rollback re-verifies the retained release and its sealed historical consent bundle before
switching the pointer. The API then serves that same historical bundle. Database consent
rows may be retired; their immutable ID, text, metadata, and hashes must still match the
sealed artifact. Never reconstruct policy text manually during rollback.
