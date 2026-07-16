# Round 2 A3: truthful structured data and provenance report

## Scope delivered

- Every `BreadcrumbList.itemListElement` now has the strict nested Schema.org type `ListItem`, a sequential position, a localized name, and an absolute canonical item URL.
- Article approval administrators are represented only as reviewers. The unsupported Article JSON-LD `author` claim and the duplicate public “Authored by” row were removed, while the approval-backed `reviewedBy`, reviewer display, dates, and sources remain.
- Static service publications no longer manufacture reviewer identities, review/publication/modification dates, revision IDs, or broad institution-homepage citations. The corresponding visible evidence footer and Service JSON-LD `reviewedBy`, `dateModified`, and `citation` properties were removed.
- Service descriptions, all three localized answer sections, Service/ProfessionalService schemas, canonical and hreflang behavior, sitemap inclusion, four locales, and accessibility behavior remain intact.
- Search operations guidance now permits claim-level reviewer/source labels only when an actual approval record backs the content and documents the absence of author claims when no distinct author field exists.

## TDD evidence

The focused pre-change run reproduced five intended failures across 19 tests:

- missing `ListItem` typing on service and article breadcrumbs;
- fabricated service provenance still present in the DTO, public UI, and Service JSON-LD;
- approval reviewer still duplicated as Article author in JSON-LD and public UI.

After the production changes, the same focused test set passed 19/19. A repository-wide breadcrumb assertion additionally checks every indexable document for `ListItem` typing and sequential positions.

## Self-review

- Re-read `.superpowers/sdd/round2-provenance-brief.md` and confined changes to Site structured data, service/article presentation, quality tests, discovery E2E, and the named search-discovery document.
- Confirmed no publication environment, IndexNow, consent/policy, Control, database, or operations code changed.
- Confirmed actual approval-backed article reviewer, approval dates, revision identity, content hash, and sources remain validated.
- Confirmed static service factual content and localized search graph behavior remain present while only unsupported provenance was removed.
- `git diff --check` is clean.

## Verification

- Focused Site provenance tests: 4 files, 19 tests passed.
- Full Site unit suite: 19 files, 98 tests passed.
- Site typecheck: 59 files, 0 errors, 0 warnings, 0 hints.
- Playwright `search discovery|published insight`: 39 tests passed across Chromium, Firefox, and WebKit, including 320/390/768/1440 overflow and accessibility coverage.
