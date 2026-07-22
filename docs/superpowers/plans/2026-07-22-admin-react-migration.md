# Administrator React Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace only the administrator portal with a React and Tailwind CSS application while preserving the Astro public site, Hono control service, database, authentication policy, and existing administrator URLs.

**Architecture:** Add a dedicated `apps/admin` Vite workspace that builds a single-page React application. The existing Hono service remains the same-origin security and business-logic boundary, exposes versioned JSON routes under `/admin/api/v1`, and serves the built administrator shell/assets from the application release. Existing server-rendered administrator routes are removed only after every screen and mutation has a React/API replacement; public withdrawal routes are moved out unchanged.

**Tech Stack:** React 19, React Router 7, Vite 7, Tailwind CSS 4, TypeScript 6, Hono 4, Zod 4, Vitest 4, Testing Library, Playwright.

## Global Constraints

- Change only the administrator portal; `apps/site` remains Astro + Tailwind and its public routes/content are unchanged.
- Keep all administrator browser URLs under `/admin`; place JSON endpoints under `/admin/api/v1`.
- Keep administrator cookies `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- Keep strict `Origin` validation and CSRF validation for every state-changing request.
- Return the CSRF token only from authenticated/pre-auth bootstrap responses and keep it in React memory; never use `localStorage` or `sessionStorage` for credentials or tokens.
- Preserve current database schema, business rules, throttles, row-version checks, confirmation tokens, audit writes, PII encryption, pagination limits, and no-store/no-index policy.
- Do not add RBAC, search, backup automation, new content workflows, or public-site redesign in this migration.
- Do not run installation, tests, builds, verification, commits, or pushes until the user explicitly approves those actions.

---

## Target file map

### New administrator workspace

- `apps/admin/package.json` — workspace scripts and React/Tailwind dependencies.
- `apps/admin/tsconfig.json` — strict browser/test TypeScript settings.
- `apps/admin/vite.config.ts` — `/admin/` base path, fixed build entry points, local API proxy, Vitest config.
- `apps/admin/playwright.config.ts` — browser tests against a seeded control fixture.
- `apps/admin/src/main.tsx` — application bootstrap.
- `apps/admin/src/styles.css` — Tailwind import, tokens, and base accessibility styles.
- `apps/admin/src/app/router.tsx` — route table and authenticated/public route boundaries.
- `apps/admin/src/app/session.tsx` — in-memory session/CSRF state and bootstrap.
- `apps/admin/src/api/client.ts` — typed same-origin JSON client and normalized errors.
- `apps/admin/src/components/*` — focused layout, navigation, table, form, alert, pagination, loading, empty, and confirmation components.
- `apps/admin/src/features/auth/*` — sign-in and MFA screens.
- `apps/admin/src/features/dashboard/*` — dashboard.
- `apps/admin/src/features/consultations/*` — consultation list/detail/status workflow.
- `apps/admin/src/features/articles/*` — article list/detail/revisions/diff/translation/review workflow.
- `apps/admin/src/features/releases/*` — publish preview/publish/rollback workflow.
- `apps/admin/src/features/operations/*` — notification config/test, consents, failures, and health screens.
- `apps/admin/src/**/*.test.tsx` — component and interaction tests.
- `apps/admin/tests/admin.spec.ts` — real browser smoke/accessibility workflow.

### Shared and control service

- `packages/shared/src/admin-api.ts` — administrator API DTO schemas/types and stable error codes.
- `packages/shared/src/index.ts` — export administrator API contracts.
- `apps/control/src/admin/http.ts` — bounded JSON parsing, API responses, Origin/CSRF/session guards.
- `apps/control/src/admin/queries.ts` — read models for dashboard, consultations, articles, releases, notifications, consents, failures, and health.
- `apps/control/src/admin/api.ts` — `/admin/api/v1` route registration and mutation orchestration.
- `apps/control/src/admin/spa.ts` — safe static asset handling and SPA shell response.
- `apps/control/src/withdrawal/routes.ts` — unchanged localized withdrawal browser routes moved from the legacy file.
- `apps/control/src/admin/admin-api.test.ts` — API contracts, auth, security, pagination, read, and mutation tests.
- `apps/control/src/admin/admin-spa.test.ts` — shell, asset, cache, CSP-compatible markup, and fallback tests.
- `apps/control/src/app.ts` — register the new API, SPA, and withdrawal routes.
- `apps/control/src/admin/routes.ts` — delete after route parity is complete.
- `apps/control/src/admin/admin-http.test.ts` — replace HTML assertions with API assertions or split focused cases into the new test files.

### Build and operations

- `package.json` — include the admin workspace in build/test/typecheck/e2e orchestration.
- `package-lock.json` — pin the approved React/Tailwind/testing packages.
- `ops/lib/release-system.mjs` — require administrator build outputs in application releases.
- `ops/tests/release-system.test.mjs` — assert release inventory includes the administrator bundle.
- `ops/caddy/Caddyfile.template` — keep reverse proxying the administrator host; add immutable cache handling only for `/admin/assets/*` while keeping shell/API no-store.
- `ops/tests/configuration.test.mjs` — assert administrator host cache and routing policy.
- `ops/runbooks/deployment.md` — add administrator bundle verification to deployment checks.
- `docs/operations/release-candidate.md` — add administrator login/navigation/mutation smoke gates.

## API contract

All responses use `Cache-Control: no-store`. Successful responses use `{ "data": ... }`; failures use the following shape and do not include stack traces, SQL, secrets, cookies, decrypted PII outside the authorized consultation detail response, or request bodies:

```ts
export interface AdminApiErrorBody {
  error: {
    code: AdminApiErrorCode;
    message: string;
    fieldErrors?: Record<string, string>;
  };
}

export type AdminApiErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "FORBIDDEN"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "ROW_VERSION_CONFLICT"
  | "CONFIRMATION_REQUIRED"
  | "OPERATION_UNAVAILABLE"
  | "INTERNAL_ERROR";
```

The route inventory is fixed for this migration:

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/api/v1/session` | Return authenticated admin metadata and CSRF token |
| POST | `/admin/api/v1/auth/login` | Validate password, set pre-auth cookie, return MFA CSRF token |
| GET | `/admin/api/v1/auth/preauth` | Restore MFA stage and CSRF token after refresh |
| POST | `/admin/api/v1/auth/mfa` | Complete TOTP/recovery authentication and set session cookie |
| POST | `/admin/api/v1/auth/logout` | Revoke session and clear cookie |
| GET | `/admin/api/v1/dashboard` | Consultation status counts |
| GET | `/admin/api/v1/consultations?page=N` | Paginated consultation list |
| GET | `/admin/api/v1/consultations/:id` | Authorized decrypted consultation detail and next states |
| POST | `/admin/api/v1/consultations/:id/status` | Status transition with row version and notification flags |
| GET | `/admin/api/v1/articles?page=N` | Paginated article locale heads |
| GET | `/admin/api/v1/articles/:id?revisionPage=N` | Article heads and paginated revisions |
| GET | `/admin/api/v1/articles/:id/revisions/:revisionId/diff` | Revision comparison, including page-boundary predecessor |
| POST | `/admin/api/v1/articles/:id/locales/:locale/slug` | Update slug |
| POST | `/admin/api/v1/articles/:id/locales/:locale/:action` | Review-state action |
| POST | `/admin/api/v1/articles/:id/translations` | Queue translation |
| GET | `/admin/api/v1/publish/preview?page=N` | Bounded approved/excluded preview |
| POST | `/admin/api/v1/publish/confirm` | Issue one-time publish confirmation |
| POST | `/admin/api/v1/publish` | Consume confirmation and publish |
| GET | `/admin/api/v1/releases?page=N` | Paginated releases |
| POST | `/admin/api/v1/releases/:id/rollback/confirm` | Issue one-time rollback confirmation |
| POST | `/admin/api/v1/releases/:id/rollback` | Consume confirmation and rollback |
| GET | `/admin/api/v1/notifications` | Read redacted notification configuration |
| POST | `/admin/api/v1/notifications` | Save validated notification configuration |
| POST | `/admin/api/v1/notifications/test` | Send explicit test notification |
| GET | `/admin/api/v1/consents` | Read active consent bundle metadata |
| GET | `/admin/api/v1/failures?page=N` | Paginated failed jobs |
| POST | `/admin/api/v1/failures/:id/requeue` | Requeue a failed notification |
| GET | `/admin/api/v1/health` | Return redacted readiness/queue summary |

---

### Task 1: Add shared API contracts and the administrator workspace

**Files:**
- Create: `packages/shared/src/admin-api.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/admin/package.json`
- Create: `apps/admin/tsconfig.json`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/src/main.tsx`
- Create: `apps/admin/src/styles.css`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `packages/shared/src/admin-api.test.ts`

**Interfaces:**
- Produces: `AdminApiResponse<T>`, `AdminApiErrorBody`, `adminApiErrorCodeSchema`, pagination DTOs, and feature DTOs consumed by both Hono and React.
- Produces: an `@wisdom/admin` workspace that builds to `apps/admin/dist/admin/index.html` and `apps/admin/dist/admin/assets/*`.

- [ ] **Step 1: Write contract tests** that parse one valid success response, reject unknown error codes, reject negative pagination values, and ensure consultation list DTOs never accept PII fields.

```ts
expect(adminPageSchema.parse({ page: 1, pageSize: 20, total: 0, pageCount: 1 })).toEqual({
  page: 1, pageSize: 20, total: 0, pageCount: 1,
});
expect(() => adminConsultationListItemSchema.parse({
  id: "c-1", receiptId: "R-1", status: "received", name: "must-not-pass",
})).toThrow();
```

- [ ] **Step 2: Run the focused shared test after explicit approval.**

Run: `npm run test --workspace @wisdom/shared -- admin-api.test.ts`

Expected: FAIL because `admin-api.ts` is not implemented.

- [ ] **Step 3: Implement strict Zod DTOs and exports.** Use `.strict()` objects, finite non-negative integers for counts/timestamps, existing shared locale/status schemas, and separate list/detail types so PII cannot enter list responses.

- [ ] **Step 4: Scaffold React/Vite/Tailwind.** Configure `base: "/admin/"`, `@tailwindcss/vite`, React plugin, no inline assets, and deterministic entry/chunk names below.

```ts
build: {
  assetsInlineLimit: 0,
  rollupOptions: {
    output: {
      entryFileNames: "admin/assets/[name]-[hash].js",
      chunkFileNames: "admin/assets/[name]-[hash].js",
      assetFileNames: "admin/assets/[name]-[hash][extname]",
    },
  },
},
```

- [ ] **Step 5: Update root orchestration.** Build in this order: shared, control, admin, site. Include admin scripts through existing `--workspaces --if-present` test/typecheck/e2e commands.

- [ ] **Step 6: Run the focused contract test and admin typecheck after explicit approval.**

Run: `npm run test --workspace @wisdom/shared -- admin-api.test.ts`

Run: `npm run typecheck --workspace @wisdom/admin`

Expected: both PASS.

- [ ] **Step 7: Commit after explicit approval.**

```bash
git add package.json package-lock.json packages/shared apps/admin
git commit -m "feat: scaffold React administrator portal"
```

### Task 2: Build JSON request and administrator security primitives

**Files:**
- Create: `apps/control/src/admin/http.ts`
- Test: `apps/control/src/admin/admin-api.test.ts`

**Interfaces:**
- Produces: `parseAdminJson<T>(context, schema)`, `adminSuccess(context, data, status?)`, `adminFailure(context, status, code, message, fieldErrors?)`, `requireAdminSession(context, dependencies, renew?)`, and `requireAdminMutation(context, dependencies, schema)`.
- Consumes: `ResolvedAdminSession`, `verifyAdminCsrf`, `AdminApiErrorCode`, and strict Zod schemas.

- [ ] **Step 1: Write failing security tests** for wrong content type, oversized `Content-Length`, chunked body over 16 KiB, invalid UTF-8/JSON/schema, wrong Origin, absent/invalid session, absent/invalid `X-CSRF-Token`, and successful session renewal only after validation.

- [ ] **Step 2: Run the focused test after explicit approval.**

Run: `npm run test --workspace @wisdom/control -- admin-api.test.ts`

Expected: FAIL because the JSON helpers do not exist.

- [ ] **Step 3: Implement bounded parsing and normalized responses.** Keep `MAX_FORM_BYTES` equivalent at `16 * 1024`; accept only `application/json`; set `Cache-Control: no-store`; never redirect an API request.

```ts
export type AdminMutation<T> = {
  session: ResolvedAdminSession;
  input: T;
};

export async function requireAdminMutation<T>(
  context: Context<AdminEnvironment>,
  dependencies: AdminRouteDependencies,
  schema: ZodType<T>,
): Promise<AdminMutation<T> | Response>;
```

- [ ] **Step 4: Make API auth status explicit.** Return `401 AUTH_REQUIRED`, `403 FORBIDDEN`, `400 INVALID_REQUEST`, and `409 ROW_VERSION_CONFLICT` without leaking which credential or CSRF comparison failed.

- [ ] **Step 5: Run the focused security test after explicit approval.**

Expected: PASS.

- [ ] **Step 6: Commit after explicit approval.**

```bash
git add apps/control/src/admin/http.ts apps/control/src/admin/admin-api.test.ts
git commit -m "feat: add secure administrator JSON primitives"
```

### Task 3: Migrate login, MFA, session bootstrap, and logout to JSON

**Files:**
- Create: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-api.test.ts`
- Modify: `apps/control/src/app.ts`

**Interfaces:**
- Produces: `registerAdminApiRoutes(app, dependencies)` and the five auth/session endpoints in the API inventory.
- Preserves: `beginAdminLogin`, `completeAdminMfa`, login throttling, pre-auth/session cookies, recovery-code behavior, and session revocation.

- [ ] **Step 1: Write failing auth API tests.** Cover generic invalid credentials, throttle response, pre-auth refresh, TOTP, recovery code, replay rejection, session bootstrap, logout, cookie attributes, strict Origin, and CSRF.

- [ ] **Step 2: Run only the auth API cases after explicit approval.**

Run: `npm run test --workspace @wisdom/control -- admin-api.test.ts -t "administrator auth API"`

Expected: FAIL with missing routes.

- [ ] **Step 3: Add strict request schemas.** Login accepts `username` and `password`; MFA accepts `username`, `method`, and `code`; mutation CSRF comes only from `X-CSRF-Token`, not the JSON body.

- [ ] **Step 4: Implement the endpoint state transitions.** Successful password login returns HTTP 202 with `{ stage: "mfa", csrfToken }`; successful MFA returns HTTP 200 with `{ stage: "authenticated", adminId, csrfToken, expiresAtMs, idleExpiresAtMs }`; logout returns HTTP 204.

- [ ] **Step 5: Run auth API tests after explicit approval.**

Expected: PASS and no HTML body/redirect assertions remain for these routes.

- [ ] **Step 6: Commit after explicit approval.**

```bash
git add apps/control/src/admin/api.ts apps/control/src/admin/admin-api.test.ts apps/control/src/app.ts
git commit -m "feat: expose administrator authentication API"
```

### Task 4: Extract bounded administrator read models

**Files:**
- Create: `apps/control/src/admin/queries.ts`
- Modify: `apps/control/src/admin/admin-api.test.ts`

**Interfaces:**
- Produces: `getDashboard`, `listConsultations`, `getConsultation`, `listArticles`, `getArticle`, `getRevisionDiff`, `getPublishPreview`, `listReleases`, `getNotificationSettings`, `getConsents`, `listFailures`, and `getAdminHealth`.
- Every list returns `{ items, page: { page, pageSize, total, pageCount } }` and enforces the existing page sizes.

- [ ] **Step 1: Write failing query tests** for empty/non-empty states, page clamping, deterministic ordering, missing records, purged PII, article revision predecessors across pagination boundaries, bounded publish preview, redacted SMTP secrets, and redacted health output.

- [ ] **Step 2: Run the query test cases after explicit approval.**

Run: `npm run test --workspace @wisdom/control -- admin-api.test.ts -t "administrator read models"`

Expected: FAIL because query functions do not exist.

- [ ] **Step 3: Move SQL and mapping out of `routes.ts`.** Use named DTO fields (`receiptId`, `rowVersion`, `updatedAtMs`) and ISO strings only at the React presentation boundary; API timestamps remain integer milliseconds.

- [ ] **Step 4: Fix only migration-blocking query defects already identified.** Fetch the previous revision independent of the current revision page, and paginate publish preview instead of loading every locale head.

- [ ] **Step 5: Run query tests after explicit approval.**

Expected: PASS with no raw database row names in returned DTOs.

- [ ] **Step 6: Commit after explicit approval.**

```bash
git add apps/control/src/admin/queries.ts apps/control/src/admin/admin-api.test.ts
git commit -m "refactor: extract administrator read models"
```

### Task 5: Expose read and mutation APIs with behavior parity

**Files:**
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-api.test.ts`

**Interfaces:**
- Consumes: Task 4 query functions and existing workflow/publication/notification functions.
- Produces: every non-auth endpoint in the API inventory.

- [ ] **Step 1: Write failing API route tests** that preserve the legacy expectations for host separation, session enforcement, Origin, CSRF, row versions, legal state transitions, notification flags, translation queuing, SMTP validation, test notifications, failure requeue, publish/rollback confirmations, and confirmation expiry/replay.

- [ ] **Step 2: Run the focused route tests after explicit approval.**

Expected: FAIL on missing API endpoints.

- [ ] **Step 3: Implement GET endpoints as thin query adapters.** Validate every path/query parameter before calling Task 4 functions; return `404 NOT_FOUND` for absent resources.

- [ ] **Step 4: Implement mutation endpoints as thin workflow adapters.** Keep the one-time confirmation map bounded at 256 entries with a two-minute TTL and bind tokens to action, target, admin ID, and session token.

- [ ] **Step 5: Normalize known conflicts.** Convert stale row versions to `409 ROW_VERSION_CONFLICT`, invalid workflow transitions to `400 INVALID_REQUEST`, and unavailable publication actions to `503 OPERATION_UNAVAILABLE`; allow unexpected errors to reach the existing redacted application error handler.

- [ ] **Step 6: Run all administrator API tests after explicit approval.**

Run: `npm run test --workspace @wisdom/control -- admin-api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit after explicit approval.**

```bash
git add apps/control/src/admin/api.ts apps/control/src/admin/admin-api.test.ts
git commit -m "feat: expose administrator workflow APIs"
```

### Task 6: Build the React API client, session boundary, and application shell

**Files:**
- Create: `apps/admin/src/api/client.ts`
- Create: `apps/admin/src/app/session.tsx`
- Create: `apps/admin/src/app/router.tsx`
- Create: `apps/admin/src/components/AppShell.tsx`
- Create: `apps/admin/src/components/AsyncState.tsx`
- Create: `apps/admin/src/components/Alert.tsx`
- Create: `apps/admin/src/components/Pagination.tsx`
- Modify: `apps/admin/src/main.tsx`
- Modify: `apps/admin/src/styles.css`
- Test: `apps/admin/src/api/client.test.ts`
- Test: `apps/admin/src/app/session.test.tsx`
- Test: `apps/admin/src/components/AppShell.test.tsx`

**Interfaces:**
- Produces: `adminApi.request<T>(path, options)`, `AdminApiError`, `SessionProvider`, `useSession()`, `RequireSession`, and shared responsive navigation/states.

- [ ] **Step 1: Write failing client/session/shell tests.** Cover JSON parsing, non-JSON failure rejection, CSRF header injection only on mutations, 401 session reset, initial loading, authenticated route rendering, keyboard navigation, active-link state, mobile menu, and focus transfer after navigation.

- [ ] **Step 2: Run administrator unit tests after explicit approval.**

Run: `npm run test --workspace @wisdom/admin`

Expected: FAIL because components are absent.

- [ ] **Step 3: Implement the typed API client.** Always use relative same-origin URLs, `credentials: "same-origin"`, `Accept: application/json`, `Content-Type: application/json` for bodies, and `X-CSRF-Token` for mutations.

```ts
const response = await fetch(`/admin/api/v1${path}`, {
  ...init,
  credentials: "same-origin",
  headers,
});
```

- [ ] **Step 4: Implement in-memory session bootstrap.** On first load call `/session`; on 401 call `/auth/preauth`; render sign-in only when neither state exists. Clear all in-memory auth state on logout or 401.

- [ ] **Step 5: Implement the responsive shell.** Use semantic landmarks, a skip link, visible focus styles, minimum 44px interactive targets, Korean administrator labels, current-route indication, and no font smaller than 14px.

- [ ] **Step 6: Run admin unit tests and typecheck after explicit approval.**

Run: `npm run test --workspace @wisdom/admin`

Run: `npm run typecheck --workspace @wisdom/admin`

Expected: PASS.

- [ ] **Step 7: Commit after explicit approval.**

```bash
git add apps/admin/src
git commit -m "feat: add administrator React shell"
```

### Task 7: Implement React authentication, dashboard, and consultations

**Files:**
- Create: `apps/admin/src/features/auth/LoginPage.tsx`
- Create: `apps/admin/src/features/auth/MfaPage.tsx`
- Create: `apps/admin/src/features/dashboard/DashboardPage.tsx`
- Create: `apps/admin/src/features/consultations/ConsultationListPage.tsx`
- Create: `apps/admin/src/features/consultations/ConsultationDetailPage.tsx`
- Create: `apps/admin/src/components/FormField.tsx`
- Create: `apps/admin/src/components/DataTable.tsx`
- Create: `apps/admin/src/components/StatusBadge.tsx`
- Test: matching `*.test.tsx` files

**Interfaces:**
- Consumes: Task 6 session/client and consultation/dashboard DTOs.
- Produces: `/admin/login`, `/admin/mfa`, `/admin`, `/admin/consultations`, and `/admin/consultations/:id` React routes.

- [ ] **Step 1: Write failing interaction tests.** Verify labels/autocomplete, generic auth errors, MFA method selection, submit pending state, dashboard counts, pagination, empty/error states, purged PII messaging, legal next statuses, row-version conflict recovery, and no PII in list DOM.

- [ ] **Step 2: Run the focused feature tests after explicit approval.**

Expected: FAIL on missing pages.

- [ ] **Step 3: Implement auth pages.** Disable duplicate submission, show a visible pending message with `aria-live`, preserve generic credential failure wording, and move focus to the error summary.

- [ ] **Step 4: Implement dashboard and consultation pages.** Format timestamps using the browser locale, keep PII only in detail state, clear detail state on unmount/navigation, and refetch after a successful status mutation.

- [ ] **Step 5: Run focused feature tests after explicit approval.**

Expected: PASS.

- [ ] **Step 6: Commit after explicit approval.**

```bash
git add apps/admin/src/features apps/admin/src/components
git commit -m "feat: migrate administrator auth and consultations"
```

### Task 8: Implement React article review and release workflows

**Files:**
- Create: `apps/admin/src/features/articles/ArticleListPage.tsx`
- Create: `apps/admin/src/features/articles/ArticleDetailPage.tsx`
- Create: `apps/admin/src/features/articles/RevisionDiffPage.tsx`
- Create: `apps/admin/src/features/releases/PublishPreviewPage.tsx`
- Create: `apps/admin/src/features/releases/ReleaseListPage.tsx`
- Create: `apps/admin/src/components/ConfirmDialog.tsx`
- Test: matching `*.test.tsx` files

**Interfaces:**
- Produces: article list/detail/diff routes plus `/admin/publish/preview` and `/admin/releases`.
- Preserves: locale state machine, slug rules, row versions, translation target rules, publish/rollback confirmation, and explicit destructive-action wording.

- [ ] **Step 1: Write failing workflow tests.** Cover list and revision pagination, cross-page diff links, slug validation, available state actions, stale row versions, translation queueing, preview included/excluded sections, publish confirmation expiry/replay, rollback confirmation, and focus restoration after dialogs.

- [ ] **Step 2: Run focused tests after explicit approval.**

Expected: FAIL on missing feature pages.

- [ ] **Step 3: Implement article pages.** Keep article metadata, locale heads, revisions, diff, and action forms in separate focused components; refetch the relevant resource after each mutation.

- [ ] **Step 4: Implement publish/release pages.** Confirmation dialogs first request a one-time token, then submit it exactly once; discard tokens on close, navigation, error, or completion.

- [ ] **Step 5: Run focused tests after explicit approval.**

Expected: PASS.

- [ ] **Step 6: Commit after explicit approval.**

```bash
git add apps/admin/src/features/articles apps/admin/src/features/releases apps/admin/src/components/ConfirmDialog.tsx
git commit -m "feat: migrate administrator publishing workflows"
```

### Task 9: Implement React operations screens

**Files:**
- Create: `apps/admin/src/features/operations/NotificationsPage.tsx`
- Create: `apps/admin/src/features/operations/ConsentsPage.tsx`
- Create: `apps/admin/src/features/operations/FailuresPage.tsx`
- Create: `apps/admin/src/features/operations/HealthPage.tsx`
- Test: matching `*.test.tsx` files

**Interfaces:**
- Produces: `/admin/notifications`, `/admin/consents`, `/admin/failures`, and `/admin/health`.

- [ ] **Step 1: Write failing interaction tests.** Cover redacted secret display, inline SMTP field errors, test-send pending/result messages, consent metadata, failure pagination/requeue, health summary labels, raw secret/PII absence, and retry after fetch failure.

- [ ] **Step 2: Run focused tests after explicit approval.**

Expected: FAIL on missing pages.

- [ ] **Step 3: Implement the four pages.** Render structured definition lists/tables instead of raw JSON or `<pre>` output; retain server error codes for diagnostics while presenting concise Korean messages.

- [ ] **Step 4: Run focused tests after explicit approval.**

Expected: PASS.

- [ ] **Step 5: Commit after explicit approval.**

```bash
git add apps/admin/src/features/operations
git commit -m "feat: migrate administrator operations screens"
```

### Task 10: Serve the React application and retire legacy administrator HTML

**Files:**
- Create: `apps/control/src/admin/spa.ts`
- Create: `apps/control/src/admin/admin-spa.test.ts`
- Create: `apps/control/src/withdrawal/routes.ts`
- Modify: `apps/control/src/app.ts`
- Delete: `apps/control/src/admin/routes.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`

**Interfaces:**
- Produces: SPA shell fallback for known `/admin` browser routes and safe asset responses for `/admin/assets/*`.
- Preserves: localized marketing withdrawal routes and their exact security behavior.

- [ ] **Step 1: Write failing SPA tests.** Verify known administrator routes return the shell, unknown `/admin` routes return the shell for React’s 404 page, API routes never fall through, missing/traversal asset paths return 404, hashed assets use immutable caching, shell uses no-store, and public-origin host requests remain 404.

- [ ] **Step 2: Run SPA tests after explicit approval.**

Expected: FAIL because SPA serving is absent.

- [ ] **Step 3: Implement safe asset serving.** Resolve the administrator dist directory relative to the built control module, reject decoded paths containing `..`, backslashes, NUL, or symlinks, and set content types from an allowlist for `.js`, `.css`, `.svg`, `.png`, `.woff2`, and `.map` (maps disabled in production responses).

- [ ] **Step 4: Implement the shell.** Read the generated Vite manifest, emit only external stylesheet/module references, escape every path, and produce no inline script so the current CSP remains effective.

- [ ] **Step 5: Move withdrawal routes unchanged.** Preserve localized text, capability handling, Origin policy, forms, status codes, and tests; only the source module changes.

- [ ] **Step 6: Remove legacy administrator HTML.** Delete `page()`, `/admin/styles.css`, HTML form parsing, HTML list/detail rendering, and old GET/POST administrator routes only after their API/React replacements pass focused tests.

- [ ] **Step 7: Run control administrator and withdrawal tests after explicit approval.**

Run: `npm run test --workspace @wisdom/control -- admin-api.test.ts admin-spa.test.ts admin-http.test.ts withdrawal.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit after explicit approval.**

```bash
git add apps/control/src/admin apps/control/src/withdrawal apps/control/src/app.ts
git commit -m "feat: serve React administrator portal"
```

### Task 11: Integrate release checks, browser coverage, and runbooks

**Files:**
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/tests/release-system.test.mjs`
- Modify: `ops/caddy/Caddyfile.template`
- Modify: `ops/tests/configuration.test.mjs`
- Create: `apps/admin/playwright.config.ts`
- Create: `apps/admin/tests/admin.spec.ts`
- Create: `apps/control/test/admin-e2e-server.ts`
- Modify: `ops/runbooks/deployment.md`
- Modify: `docs/operations/release-candidate.md`

**Interfaces:**
- Produces: release failure when `apps/admin/dist/admin/index.html` or its manifest/assets are absent/tampered.
- Produces: one browser workflow that uses the real Hono auth/session/API boundary and built React bundle.

- [ ] **Step 1: Write failing release/configuration tests.** Require the admin index and Vite manifest in `RUNTIME_REQUIRED_FILES`; assert `/admin/assets/*` may be immutable while `/admin`, `/admin/api/*`, and all other administrator responses remain no-store/no-index.

- [ ] **Step 2: Run focused ops tests after explicit approval.**

Run: `node --test ops/tests/release-system.test.mjs ops/tests/configuration.test.mjs`

Expected: FAIL because administrator artifacts are not yet enforced.

- [ ] **Step 3: Update the application release inventory and Caddy policy.** Continue reverse proxying all administrator requests to Hono; add only the path-specific asset cache header and do not enable access logs.

- [ ] **Step 4: Add a seeded E2E fixture.** Use a temporary SQLite database, static test keys, one active admin with TOTP, deterministic sample consultations/articles/failures, and loopback-only ports; delete the temporary fixture through test teardown.

- [ ] **Step 5: Write browser tests.** In Chromium, Firefox, and WebKit: sign in, complete MFA, navigate every screen, update one consultation using row version, verify success/error focus behavior, verify keyboard navigation, run axe on login/dashboard/list/detail, and confirm no secrets appear in DOM/network bodies.

- [ ] **Step 6: Update runbooks.** Add exact checks for administrator artifact presence, host separation, sign-in/MFA, one read workflow, one reversible test workflow, asset caching, no-store API responses, and rollback behavior.

- [ ] **Step 7: Run focused ops and E2E tests after explicit approval.**

Run: `node --test ops/tests/release-system.test.mjs ops/tests/configuration.test.mjs`

Run: `npm run test:e2e --workspace @wisdom/admin`

Expected: all PASS.

- [ ] **Step 8: Commit after explicit approval.**

```bash
git add ops apps/admin/playwright.config.ts apps/admin/tests apps/control/test/admin-e2e-server.ts docs/operations/release-candidate.md
git commit -m "test: verify React administrator release"
```

### Task 12: Final migration verification and handoff

**Files:**
- Modify only files required by failures that the user separately approves fixing.

- [ ] **Step 1: Review route parity manually.** Compare every legacy route in the API inventory with its React route, API route, status codes, security guard, and existing business function.

- [ ] **Step 2: Search for retired server-rendered administrator code after explicit approval.**

Run: `rg -n "context\.html\(|/admin/styles\.css|application/x-www-form-urlencoded" apps/control/src/admin apps/admin/src`

Expected: no administrator HTML/form implementation remains; any withdrawal HTML is located only under `apps/control/src/withdrawal`.

- [ ] **Step 3: Run focused workspace verification after explicit approval.**

Run: `npm run typecheck --workspace @wisdom/shared && npm run typecheck --workspace @wisdom/control && npm run typecheck --workspace @wisdom/admin`

Run: `npm run test --workspace @wisdom/shared && npm run test --workspace @wisdom/control && npm run test --workspace @wisdom/admin`

Run: `npm run build`

Run: `npm run test:e2e --workspace @wisdom/admin`

Expected: all commands exit 0; admin build output exists under `apps/admin/dist/admin`; public Astro build output remains unchanged in ownership and routing.

- [ ] **Step 4: Run full repository verification only after separate explicit approval.**

Run: `npm run verify`

Expected: exit 0 across shared, control, admin, site, ops, and browser suites.

- [ ] **Step 5: Inspect the final diff and status.**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only planned files are changed.

- [ ] **Step 6: Create the final commit and push only after explicit approval.**

```bash
git add package.json package-lock.json packages/shared apps/admin apps/control ops docs/operations
git commit -m "feat: migrate administrator portal to React"
git push origin 2026-07-21-codex-code-review-fixes
```

## Self-review result

- Scope coverage: administrator UI, same-origin API, authentication/CSRF, all existing screens/actions, asset serving, release integrity, browser accessibility, and operations documentation each map to a task.
- Scope exclusions: public Astro migration, RBAC, backup automation, consultation form changes, search, and unrelated audit findings are intentionally absent.
- Type consistency: shared DTOs are created before Hono/React consumers; session and CSRF interfaces are stable across Tasks 2, 3, 5, and 6; all list APIs use one pagination shape.
- Migration safety: legacy HTML is deleted only in Task 10 after API and React parity is implemented and focused tests pass.
- Approval boundary: this document creates no implementation authorization; installation, code changes, tests, commits, and pushes remain separately approval-gated.
