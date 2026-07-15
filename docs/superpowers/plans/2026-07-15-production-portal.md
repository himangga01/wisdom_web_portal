# Wisdom Web Portal Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every behavior change follows test-driven development.

**Goal:** Build and operate the multilingual public website, local consultation intake, separate administrator portal, Hermes notifications and article workflow, and search-discovery outputs described in the approved production plan.

**Architecture:** Use an npm-workspaces modular monolith. Astro emits the public static site; a loopback-only Hono service owns SQLite, consultation intake, administration, jobs, and integration adapters. Caddy exposes both through Cloudflare Tunnel on a Mac mini without Docker.

**Tech Stack:** Node.js 24 LTS, TypeScript strict, Astro 6, Tailwind CSS 4, i18next, Hono, Zod, Drizzle with better-sqlite3, Vitest, Playwright, axe-core.

## Global Constraints

- Work only on `feat/production-portal`; keep `prototypes/homepage-motion` as a frozen visual and motion reference.
- Use `apps/site`, `apps/control`, and `packages/shared`; root commands must install, build, test, and verify the whole workspace.
- Korean is canonical at `/`; launch locales are `ko`, `en`, `zh-Hans`, and `zh-Hant`; no runtime machine translation and no indexed locale fallback.
- Use the approved bronze/sand/ivory visual language, Tailwind CSS, 18 homepage C1 reveals at 500ms, and reduced-motion/no-JavaScript fallbacks.
- Consultation PII remains in local SQLite by default. Never log request bodies or raw contact data. Telegram never receives PII.
- Email supports `receipt-only` and gated `full-inquiry`; the safe mode is default. Marketing consent is separate, unchecked, and withdrawable without an account.
- Hermes can create drafts but cannot publish. Codex CLI translation runs only on explicit administrator request and never receives consultation data.
- Public content is static semantic HTML. Admin and token pages are `noindex`; search ranking or AI citation is never promised.
- No Docker, attachments, analytics cookies, CSV export, automatic publishing, managed external database, or router port forwarding in v1.
- All new behavior is implemented test-first. Each task ends with focused tests, root verification where available, and an intentional commit.

---

### Task 1: Production workspace and shared contracts

**Files:** Create root workspace configuration, `packages/shared`, repository README, environment example, and update activity logs.

**Produces:** Typed locale/category/status/consent/notification/article contracts; consultation Zod schema; centralized design tokens; root `build`, `test`, `test:e2e`, and `verify` commands.

- [ ] Add failing contract tests for accepted locales, category/status enums, required privacy consent, conditional email, message limits, and response/error shapes.
- [ ] Scaffold npm workspaces on Node 24 and implement only enough shared code to pass those tests.
- [ ] Add environment parsing that fails closed for missing production secrets while supporting safe test defaults.
- [ ] Document Windows `npm.cmd` and macOS `npm` workflows, then run shared tests and root type checking.
- [ ] Commit the independently working foundation.

### Task 2: Astro public site, content model, i18n, and approved motion

**Consumes:** Task 1 locale/content contracts and design tokens.

**Produces:** Four-locale public routes, reusable layout/components, real navigation, service catalog, contact/location/privacy pages, and production motion behavior.

- [ ] Write failing unit and browser tests for route generation, locale links, no missing core translations, semantic navigation, 18/500ms C1 motion, reduced motion, no-JavaScript visibility, and no horizontal overflow.
- [ ] Build the Astro/Tailwind site with Korean canonical routes and `/en`, `/zh-hans`, `/zh-hant` alternates.
- [ ] Seed the approved office identity, representative profile, six service groups and full service list, Naver Blog and Naver Map links; keep Kakao configurable.
- [ ] Move the prototype visual language into small components and a single token source; do not import the low-resolution brochure portrait as a production asset.
- [ ] Add responsive images, accessible forms/navigation, localized validation copy, and real 404 behavior.
- [ ] Run unit, build, Playwright Chromium/WebKit/Firefox, and accessibility checks; commit.

### Task 3: Durable consultation intake, consent ledger, encryption, and retention

**Consumes:** `ConsultationRequest`, `ConsultationReceipt`, validation and error contracts from Task 1.

**Produces:** SQLite migrations/repositories, encrypted PII, public consent endpoint, idempotent consultation endpoint, abuse controls, purge jobs, and health endpoints.

- [ ] Write failing repository/API tests for transactional commit, idempotent replay, key conflict, stale consent version, validation, rate limiting, storage failure, and raw-PII-free logs.
- [ ] Add WAL SQLite tables for consultations, consent documents/events, idempotency, notification outbox/settings, admins/sessions, articles/revisions/jobs/releases, and redacted audit events.
- [ ] Encrypt PII with AES-256-GCM and Keychain-supplied versioned keys; add HMAC exact-search indexes without free-text indexing messages.
- [ ] Implement `GET /api/v1/consent-documents`, `POST /api/v1/consultations`, `GET /health/live`, and `GET /health/ready` with documented error codes.
- [ ] Apply honeypot, minimum-fill-time, 32KB limit, 10-minute/day rate limits, and 12/24-month configured retention with safe purge behavior.
- [ ] Verify migrations, API integration tests, restart recovery, and commit.

### Task 4: Administrator authentication, consultation workflow, notifications, and withdrawal

**Consumes:** Task 3 repositories/outbox; Task 1 notification and status contracts.

**Produces:** Separate-host admin login/dashboard, TOTP sessions, consultation workflow, selectable SMTP/Hermes channels, retries, and accountless marketing withdrawal.

- [ ] Write failing tests for Argon2id login, TOTP and recovery codes, CSRF, session expiry, login throttling, status transitions, outbox retry schedule, token withdrawal, and requeue.
- [ ] Build server-rendered Hono admin pages for dashboard, list/detail/status, notification settings/test, consent versions, failures, and health.
- [ ] Seed the first owner through a local CLI; keep password reset and secret installation CLI-only.
- [ ] Implement SMTP `receipt-only` and gated `full-inquiry` modes, plus a loopback HMAC Hermes adapter whose Telegram payload is metadata-only.
- [ ] Implement hashed 256-bit withdrawal tokens with GET confirmation and POST mutation; cancel pending marketing work immediately.
- [ ] Apply secure host-only cookies, CSRF, CSP, HSTS, noindex headers, audit events, and PII-safe rendering/logging; verify and commit.

### Task 5: Hermes article intake, Codex translation, review, publish, and rollback

**Consumes:** Task 1 content/locale contracts; Task 2 static build; Task 3 content/job tables.

**Produces:** HMAC internal draft intake, admin review, serialized Codex jobs, deterministic static publication, IndexNow hook, and atomic rollback.

- [ ] Write failing tests for HMAC/idempotency, Markdown sanitization, article state transitions, translation schema, no-PII guard, serialized jobs, failed build preservation, and rollback.
- [ ] Implement `POST /internal/v1/article-drafts` on loopback only and store immutable revisions with source links.
- [ ] Add administrator draft review/reject, explicit translate, per-locale approve, publish, and rollback actions.
- [ ] Run Codex CLI with fixed prompts and structured output in an isolated public-content directory; record prompt/model/source versions and two-pass review output.
- [ ] Export approved revisions, build in a temporary release directory, verify it, atomically switch `current`, retain three releases, and notify IndexNow only after success.
- [ ] Verify failure paths and commit.

### Task 6: Search, AI discovery, structured data, and content quality gates

**Consumes:** Task 2 routes/content and Task 5 published revisions.

**Produces:** Localized metadata/canonicals/hreflang, JSON-LD, sitemap/RSS/robots policies, crawler tests, and content quality rules.

- [ ] Write failing snapshot/DOM tests for unique titles, descriptions, self-canonical, reciprocal hreflang, `x-default`, visible-content-matching JSON-LD, sitemap/RSS, robots, and noindex surfaces.
- [ ] Generate `ProfessionalService`, `Person`, `Service`, `Article`, and `BreadcrumbList` data without Attorney, fake review, rating, or unsupported claims.
- [ ] Allow Googlebot, Yeti, OAI-SearchBot and Google-Extended; disallow GPTBot and all admin/API/token surfaces; never emit `nosourceinfo`.
- [ ] Require reviewer/date/sources and complete answer sections before a service detail or article can publish; do not create thin placeholder URLs.
- [ ] Add DNS-verification configuration and an operator checklist for Search Console and Search Advisor; verify and commit.

### Task 7: macOS no-Docker deployment, backup, monitoring, and recovery

**Consumes:** Tested production builds and health endpoints.

**Produces:** Caddy/Cloudflare host routing, launchd services, Keychain bootstrap, versioned releases, encrypted SQLite backup/restore, and operations runbooks.

- [ ] Write failing configuration tests for loopback binding, separate public/admin hosts, security headers, static cache policy, API no-store, and health routing.
- [ ] Add parameterized Caddy, cloudflared, launchd, release, rollback, backup, restore, log-rotation, and secret-bootstrap templates/scripts without embedding credentials.
- [ ] Route apex to canonical `www`, public `/api/v1` to control, admin host to control, and both tunnel hostnames to loopback Caddy; expose no router ports.
- [ ] Implement hourly encrypted online backups with 24 hourly/14 daily retention and a destructive-restore guard requiring an explicit target.
- [ ] Document FileVault unlock limits, UPS/wired/sleep/autorestart settings, RPO/RTO, independent uptime alerting, and incident steps.
- [ ] Validate scripts in dry-run/test directories, run a backup/restore drill, and commit.

### Task 8: Release-candidate hardening and two-round critical review

**Consumes:** All previous tasks.

**Produces:** Verified release candidate, requirements matrix, launch-input checklist, two independent review rounds, and final branch review.

- [ ] Run complete unit, integration, E2E, accessibility, SEO, security, build, backup/restore, and prototype-regression suites from a clean install.
- [ ] Perform manual 320/390/768/1440 checks and document Samsung Internet, Safari, Kakao/Naver in-app smoke steps.
- [ ] Round 1: dispatch three parallel reviewers for security/privacy, UX/accessibility, and architecture/recovery; reproduce and fix valid findings.
- [ ] Round 2: dispatch three parallel reviewers for SEO/AI/i18n, content/legal claims, and operations/release; reproduce and fix valid findings.
- [ ] Verify all launch inputs are explicit configuration gates: domain, Cloudflare credentials, Kakao URL, original logo/portrait, SMTP, Hermes HMAC endpoint, admin enrollment, and approved privacy/marketing text.
- [ ] Run a broad whole-branch code review, fix all Critical/Important findings, re-run fresh verification, update logs, and commit the release candidate.
