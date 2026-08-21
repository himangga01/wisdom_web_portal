# Full Code Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2026-07-25 전체 코드 리뷰에서 확인된 프로덕션 차단 문제와 정확성·UX 결함을 위험도 순서로 수정하고, 현재 서비스와 Sites 마이그레이션의 release authority를 일관되게 만든다.

**Architecture:** 현재 Astro 공개 사이트, React 관리자, Hono/SQLite Control, macOS 운영 구조를 유지한다. 발행은 build·pointer·DB authority·consent cache를 하나의 복구 가능한 상태 전이로 묶고, 개인정보와 restore 작업은 명시적인 generation·lock·권한 경계로 보호한다. Sites는 최초 owner-only 전환과 공개 후 반복 발행을 구분하고, release ID에 묶인 동의 bundle protocol로 정적 화면과 Control API의 불일치 구간을 제거한다.

**Tech Stack:** TypeScript, React, Astro, Hono, Zod, SQLite/better-sqlite3, Node.js ESM, Caddy, launchd, Vitest, Playwright

## Global Constraints

- 작업 브랜치는 `2026-07-21-codex-code-review-fixes` 하나만 사용한다.
- 기준 리뷰는 `docs/code-review/2026-07-25-full-code-review.md`, 기준 코드 커밋은 `62c11ce5646dc71e063c8610f798a3d3964d3bca`다.
- 이 문서는 수정계획만 정의한다. 현재 단계에서는 코드 수정, 테스트, build, lint, 브라우저, 배포, commit, push를 실행하지 않는다.
- 각 Task의 코드 구현은 사용자 승인 후에만 실행한다.
- 집중 테스트와 전체 검증은 코드 구현 승인과 별개의 사용자 승인을 받은 경우에만 실행한다.
- 새 npm 패키지와 외부 오픈소스 의존성을 추가하지 않는다.
- 현재 작업 트리의 Analytics 및 Sites 문서 변경을 보존하고, 관련 없는 파일을 정리하거나 되돌리지 않는다.
- master 브랜치에서 작업하지 않고, 모든 승인된 변경은 현재 작업 브랜치에 누적한다.
- Sites 생성, source push, saved version, production deployment, access, custom domain, DNS 변경은 이 계획의 코드 작업 승인에 포함되지 않는다.
- 실제로 실행하지 않은 검증 결과를 README나 릴리스 문서에 성공으로 기록하지 않는다.

## Corrected Issue Baseline

| 분류 | 적용 방식 |
|---|---|
| High 유지 | H-01, H-03, H-04, H-06 |
| High/Medium 경계 | H-05, H-07 |
| Medium으로 조정 | H-02 |
| 조건부 운영 High | H-08: 저장소가 지원하는 자동 offsite와 전체 secret recovery 부재만 확정 |
| 부분 타당 | M-03, M-05, L-03, Sites |
| Low로 조정 | M-08, M-12, M-14, M-16, M-19 |
| Medium/Low 경계 | M-09, M-11, M-13 |

M-03은 공개 authority와 DB 후보의 불일치를 수정하되 관리자 health 자체를 공개 health와 동일시하지 않는다. M-05는 “발송 성공” 문구 문제가 아니라 비활성 채널 테스트의 최종 취소 상태 미노출과 SMTP 없는 비활성 저장 불가를 수정한다. L-03의 RSS 결함은 title·summary를 중심으로 고치고 reviewer는 공용 문자열 위생 규칙으로 함께 제한한다. Sites의 최초 owner-only 전환은 기존 access gate를 유지하고, 공개 후 반복 발행·rollback만 새 protocol 대상으로 삼는다.

## Approach Decision

1. **위험도 우선 단계 적용 — 채택**
   - 정상 발행과 최초 공개 경로를 먼저 복구한다.
   - pointer·DB·consent authority를 다음 단계에서 정렬한다.
   - 개인정보와 restore 안전성을 완료한 뒤 UX·SEO를 정리한다.
   - 각 단계가 독립적으로 review·rollback 가능하다.
2. **전체 일괄 수정 — 제외**
   - 발행, DB migration, restore, UI 변경을 한 커밋에 섞어 실패 원인과 rollback 범위를 구분하기 어렵다.
3. **UX 우선 수정 — 제외**
   - 공개 화면 품질은 개선되지만 발행 불가와 restore race가 남아 프로덕션 준비 상태가 달라지지 않는다.

## Phase and Dependency Order

```text
Phase 1: Task 1-4
  publication build → bootstrap 차단 → first publication CLI → runtime/migration guard

Phase 2: Task 5-8
  activation 복구 → consent handoff → 발행 batch → rollback PII generation

Phase 3: Task 9, Task 10A-10D, Task 11
  만료 PII 접근 → restore writer → secret/path/권한 경계 → offsite recovery

Phase 4: Task 12-16
  관리자 계약/UX → 콘텐츠/SEO → 상담 UX → withdrawal 화면

Phase 5: Task 17
  Sites 공개 후 반복 발행 protocol

Phase 6: Task 18
  승인된 집중 검증 → 승인된 전체 검증 → 운영 drill
```

---

### Task 1: Publication Builder와 임시 파일 생명주기 복구

**Covers:** H-01, M-06, M-08

**Files:**

- Modify: `apps/site/package.json`
- Modify: `package-lock.json`
- Modify: `apps/control/src/articles/publication-build.ts`
- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/config.ts`
- Modify: `apps/control/src/config.test.ts`
- Modify: `apps/control/src/articles/publication-build.test.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `ops/lib/mac-release-adapter.mjs`
- Modify: `ops/config/runtime.env.template`
- Modify: `ops/scripts/monitor-db-check.mjs`
- Modify: `ops/tests/security-bootstrap.test.mjs`
- Modify: `ops/tests/release.test.mjs`
- Modify: `ops/tests/monitoring.test.mjs`

**Interfaces:**

- Produces: production-pruned application release에서도 실행 가능한 `@wisdom/site` builder
- Produces: `cleanupPublicationTemporaries()`의 원본 오류 보존형 정리 결과
- Produces: `article.release.build_failed` 및 `article.release.cleanup_failed` audit event
- Consumes: 기존 `PublicationReleaseConfig`, `safeFailureCode()`, `audit_events`

- [ ] **Step 1: prune 이후 builder dependency 계약 테스트 작성**

`@tailwindcss/vite`와 `tailwindcss`가 production dependency로 남고, prune argument가 builder를 제거하지 않는지 고정한다.

```ts
expect(sitePackage.dependencies).toMatchObject({
  "@tailwindcss/vite": expect.any(String),
  "tailwindcss": expect.any(String),
});
expect(sitePackage.devDependencies).not.toHaveProperty("@tailwindcss/vite");
```

- [ ] **Step 2: build dependency를 production 범위로 이동**

`apps/site/package.json`과 lockfile에서 Tailwind build plugin 두 개만 `dependencies`로 이동한다. Playwright, Vitest, TypeScript와 `@astrojs/check`는 devDependency로 유지한다.

- [ ] **Step 3: staged release에서 post-prune builder gate 실행**

`ops/lib/mac-release-adapter.mjs`가 `npm prune --omit=dev`를 마친 직후, 아직 current pointer를 바꾸기 전에 staged destination에서 임시 output directory를 지정해 아래 fixture build를 실행한다.

```bash
npm run build:fixture --workspace @wisdom/site -- --outDir <temporary-output>
```

fixture output은 검증 뒤 제거한다. build가 실패하면 staged release를 활성화하지 않고 기존 application pointer를 유지한다. 이 gate는 workspace 원본이 아니라 실제 production-pruned staged release의 dependency 완결성을 증명한다.

- [ ] **Step 4: publication build env allowlist 확장**

`PUBLIC_KAKAO_CHAT_URL`은 실제 운영 설정이 있을 때만 runtime template → Control config → publication config로 전달한다. 설정된 값은 현재 URL validator를 통과해야 하며 child env에는 이 값만 명시적으로 추가한다. 임의의 host env 상속은 추가하지 않는다.

```ts
env: {
  ...existingBuildEnvironment,
  ...(config.kakaoChatUrl ? { PUBLIC_KAKAO_CHAT_URL: config.kakaoChatUrl } : {}),
}
```

- [ ] **Step 5: 모든 pre-commit 실패 경로에서 임시 디렉터리 정리**

`.snapshot-*`, `.home-*`, `.building-*`를 하나의 `try/finally` 경계에서 관리한다. 정리 실패가 원래 build·검증 오류를 덮지 않도록 안전한 오류 코드만 별도 audit로 기록한다.

```ts
interface PublicationCleanupResult {
  removed: string[];
  failures: Array<{ kind: "snapshot" | "home" | "building"; code: string }>;
}
```

- [ ] **Step 6: activation commit 이후 cleanup 실패를 성공 응답과 분리**

DB activation이 commit된 뒤의 snapshot/home 정리 실패는 publication 결과를 실패로 바꾸지 않는다. audit와 monitor backlog에는 남기되 API는 실제 활성화 결과를 반환한다.

- [ ] **Step 7: build 실패를 monitor가 읽는 audit에 기록**

기존 `failed-publication.log`는 운영자 보조 로그로 유지하되, monitor의 `publicationFailures`에 마지막 성공 발행 이후 `article.release.build_failed` event를 합산한다. metadata에는 path·stderr·secret을 넣지 않고 `releaseId`, `version`, safe error code만 기록한다.

- [ ] **Step 8: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/config.test.ts src/articles/publication-build.test.ts src/articles/publication-release.test.ts
node --test ops/tests/security-bootstrap.test.mjs ops/tests/release.test.mjs ops/tests/monitoring.test.mjs
```

Expected: production-pruned staged release의 실제 fixture build, build env allowlist, 세 임시 디렉터리 정리, post-commit cleanup 결과, publication failure backlog 테스트가 모두 통과한다.

- [ ] **Step 9: 승인 후 커밋**

```bash
git add apps/site/package.json package-lock.json apps/control/src/config.ts apps/control/src/config.test.ts apps/control/src/articles/publication-build.ts apps/control/src/articles/publication-release.ts apps/control/src/articles/publication-build.test.ts apps/control/src/articles/publication-release.test.ts ops/config/runtime.env.template ops/lib/mac-release-adapter.mjs ops/scripts/monitor-db-check.mjs ops/tests/security-bootstrap.test.mjs ops/tests/release.test.mjs ops/tests/monitoring.test.mjs
git commit -m "fix(publication): preserve the production builder"
```

---

### Task 2: Bootstrap Seed 재실행 차단

**Covers:** H-02

**Files:**

- Modify: `ops/scripts/seed-public.mjs`
- Modify: `ops/lib/public-release.mjs`
- Modify: `ops/lib/release-operation-lock.mjs`
- Modify: `ops/tests/public-release.test.mjs`
- Modify: `ops/tests/security-bootstrap.test.mjs`
- Modify: `ops/runbooks/deployment.md`

**Interfaces:**

- Produces: `assertBootstrapSeedAllowed(publicReleaseRoot, currentLink)`
- Consumes: public release root 전용 operation lock
- Consumes: `createMacServiceAdapter({ labels: ["com.jihye.portal.cloudflared"] })`

- [ ] **Step 1: 정상 Wisdom release 존재 시 seed 거부 테스트 작성**

public root 안에 검증된 Wisdom seal이 하나라도 있거나 `public-current`가 Wisdom release를 가리키면 dry-run과 apply 모두 `PUBLIC_BOOTSTRAP_DOWNGRADE_FORBIDDEN`으로 실패해야 한다.

- [ ] **Step 2: public root 전용 lock 획득**

`seed-public --apply`가 source 검증이나 pointer 변경 전에 `<public-release-root>/.release-operation.lock`을 획득하도록 한다. application release root와 lock 경로를 공유하지 않는다.

- [ ] **Step 3: Tunnel unloaded 증명 추가**

apply는 cloudflared LaunchAgent가 unloaded임을 확인한다. 단순 stopped 또는 상태 확인 불가는 실패로 처리한다.

- [ ] **Step 4: pointer 전환 직전 조건 재검사**

초기 검사와 source copy 사이에 Wisdom release가 생기는 경우를 막기 위해 lock을 유지한 상태에서 `atomicSwitchRelease()` 직전에 같은 조건을 다시 검사한다.

- [ ] **Step 5: runbook을 실제 차단 동작과 일치**

“되돌아갈 수 없다”는 운영 설명을 코드 오류명, lock, Tunnel 조건과 연결한다.

- [ ] **Step 6: 승인 후 집중 검증**

```bash
node --test ops/tests/public-release.test.mjs ops/tests/security-bootstrap.test.mjs
```

Expected: 최초 seed는 성공하고, Wisdom release 생성 후 재실행·동시 실행·Tunnel loaded 상태는 모두 pointer 변경 전에 실패한다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add ops/scripts/seed-public.mjs ops/lib/public-release.mjs ops/lib/release-operation-lock.mjs ops/tests/public-release.test.mjs ops/tests/security-bootstrap.test.mjs ops/runbooks/deployment.md
git commit -m "fix(ops): forbid bootstrap public downgrades"
```

---

### Task 3: Tunnel 없이 실행 가능한 First Publication CLI

**Covers:** H-03

**Files:**

- Create: `apps/control/src/cli/publication-first.ts`
- Create: `ops/scripts/first-publication.mjs`
- Modify: `apps/control/src/cli/arguments.ts`
- Modify: `apps/control/src/cli/arguments.test.ts`
- Modify: `apps/control/package.json`
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`
- Modify: `ops/tests/security-bootstrap.test.mjs`
- Modify: `ops/runbooks/deployment.md`
- Modify: `docs/operations/consent-publication.md`

**Interfaces:**

- Produces: dry-run `FirstPublicationPlan`
- Produces: apply command requiring exact plan fingerprint
- Consumes: Keychain wrapper, existing publication service, verified bootstrap pointer

```ts
interface FirstPublicationPlan {
  action: "first-publication";
  bootstrapReleaseId: string;
  consentBundleId: string;
  eligiblePromotionCount: number;
  fingerprint: string;
  tunnelDisabledVerified: true;
}
```

- [ ] **Step 1: CLI argument와 one-time 조건 테스트 작성**

다음 조건을 모두 고정한다.

- active Wisdom release가 없어야 한다.
- `public-current`는 검증된 bootstrap release여야 한다.
- active consent DB bundle이 완전해야 한다.
- dry-run은 mutation하지 않는다.
- apply는 dry-run의 exact fingerprint와 `--confirm-first-publication`이 일치해야 한다.
- 두 번째 apply는 `FIRST_PUBLICATION_ALREADY_COMPLETED`로 실패한다.

- [ ] **Step 2: Control CLI에 dry-run plan 생성**

CLI는 승인 콘텐츠와 consent snapshot fingerprint만 출력한다. 상담 PII, article body, secret, 절대 private path를 출력하지 않는다.

- [ ] **Step 3: Ops wrapper에서 Tunnel과 Keychain 경계 적용**

`ops/scripts/first-publication.mjs`가 cloudflared unloaded를 확인한 뒤 Keychain wrapper를 통해 compiled Control CLI를 실행한다. 브라우저 cookie나 로컬 HTTP admin origin을 사용하지 않는다.

- [ ] **Step 4: publication service의 기존 검증 재사용**

새 CLI용 별도 발행 구현을 만들지 않는다. `publishApprovedArticles()`와 동일한 snapshot, PII, seal, activation 경계를 호출하고 actor는 명시적인 system actor `first-publication-operator`로 audit한다.

- [ ] **Step 5: 배포 runbook 순서 수정**

```text
bootstrap seed
→ application release
→ consent bundle 준비
→ first-publication dry-run
→ 사용자 확인 후 exact fingerprint apply
→ 일반 preflight
→ Tunnel bootstrap
```

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/cli/arguments.test.ts src/articles/publication-release.test.ts
node --test ops/tests/cli-dry-run.test.mjs ops/tests/security-bootstrap.test.mjs
```

Expected: Tunnel 없이 최초 Wisdom release가 생성되고, confirmation·bootstrap·one-time 조건 중 하나라도 다르면 mutation 전에 실패한다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/cli/publication-first.ts apps/control/src/cli/arguments.ts apps/control/src/cli/arguments.test.ts apps/control/package.json ops/scripts/first-publication.mjs ops/lib/release-system.mjs ops/tests/cli-dry-run.test.mjs ops/tests/security-bootstrap.test.mjs ops/runbooks/deployment.md docs/operations/consent-publication.md
git commit -m "feat(publication): add guarded first publication CLI"
```

---

### Task 4: Runtime Configuration과 Migration Guard 정렬

**Covers:** M-07, M-09, M-15, L-05

**Files:**

- Modify: `apps/control/src/runtime.ts`
- Modify: `apps/control/src/config.ts`
- Modify: `apps/control/src/config.test.ts`
- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/database.test.ts`
- Modify: `packages/shared/src/public-origin.ts`
- Modify: `packages/shared/src/search-origin.test.ts`
- Modify: `ops/lib/mac-release-adapter.mjs`
- Modify: `ops/lib/mac-services.mjs`
- Modify: `ops/lib/runtime-config.mjs`
- Modify: `ops/tests/runtime-launch.test.mjs`
- Modify: `ops/tests/mac-services.test.mjs`
- Modify: `ops/tests/security-bootstrap.test.mjs`
- Modify: `README.md`
- Modify: `ops/runbooks/deployment.md`

**Interfaces:**

- Produces: `assertDatabaseSchemaCurrent(db)`
- Produces: `readyUrlFromRuntimeConfig(runtimeConfigPath)`
- Produces: stricter `parsePublicOrigin()`

- [ ] **Step 1: 일반 runtime이 migration하지 않는 실패 테스트 작성**

이전 schema DB로 server·worker runtime을 열면 schema를 변경하지 않고 `DATABASE_MIGRATION_REQUIRED`로 종료해야 한다. 전용 `db:migrate --require-rollback-compatible`만 migration을 실행한다.

- [ ] **Step 2: `createControlRuntime()`에서 `runMigrations()` 제거**

DB open 후 current schema fingerprint와 version을 읽기 전용으로 확인한다. guard 또는 runtime 초기화가 실패하면 열린 DB handle을 `finally`/오류 경계에서 닫는다. `apps/control/src/cli/migrate.ts`의 명시적 migration 경로만 schema를 변경한다.

```ts
const db = openDatabase(config.databasePath);
assertDatabaseSchemaCurrent(db);
return { config, db };
```

- [ ] **Step 3: readiness URL을 runtime config의 `CONTROL_PORT`로 생성**

release adapter가 runtime config를 parse해 `createMacServiceAdapter({ readyUrl })`에 명시적으로 전달한다. deploy shell environment의 우연한 `CONTROL_PORT`는 사용하지 않는다.

- [ ] **Step 4: production origin 제한 강화**

production에서는 다음을 거부한다.

- IPv4·IPv6 literal
- loopback, link-local, RFC1918/ULA
- `.local`
- dot이 없는 single-label hostname

HTTPS, 무포트, exact origin, 기존 placeholder 차단은 유지한다.

- [ ] **Step 5: README의 미구현 `PUBLIC_ORIGINS` 제거**

현재 runtime 계약인 `PUBLIC_ORIGIN`, `ADMIN_ORIGIN`만 설명한다. Sites cross-origin 설정은 Task 17의 `FORM_ALLOWED_ORIGINS` 구현과 함께 별도로 문서화한다.

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/config.test.ts src/db/database.test.ts
npm --workspace @wisdom/shared test -- src/search-origin.test.ts
node --test ops/tests/runtime-launch.test.mjs ops/tests/mac-services.test.mjs ops/tests/security-bootstrap.test.mjs
```

Expected: runtime은 schema를 바꾸지 않고, non-default port readiness와 production origin 거부 행렬이 통과한다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/runtime.ts apps/control/src/config.ts apps/control/src/config.test.ts apps/control/src/db/client.ts apps/control/src/db/database.test.ts packages/shared/src/public-origin.ts packages/shared/src/search-origin.test.ts ops/lib/mac-release-adapter.mjs ops/lib/mac-services.mjs ops/lib/runtime-config.mjs ops/tests/runtime-launch.test.mjs ops/tests/mac-services.test.mjs ops/tests/security-bootstrap.test.mjs README.md ops/runbooks/deployment.md
git commit -m "fix(runtime): enforce deployment configuration gates"
```

---

### Task 5: Pointer와 DB Activation의 요청 내 복구

**Covers:** H-04

**Files:**

- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `apps/control/src/server.ts`

**Interfaces:**

- Produces: `settlePublicationActivation()`
- Produces: 실제 복구 상태를 담는 `PublicationActivationOutcome`

```ts
type PublicationActivationOutcome =
  | { kind: "committed"; result: PublicationActionResult }
  | { kind: "reverted"; activationId: string; previousReleaseId: string | null }
  | { kind: "manual-recovery-required"; activationId: string; errorCode: string };
```

- [ ] **Step 1: after-switch와 before-commit fault 테스트 작성**

publish와 rollback 각각에서 pointer 전환 후 commit 실패를 주입한다. 요청 반환 전에 결과가 `committed`, `reverted`, `manual-recovery-required` 중 하나로 확정되어야 한다.

- [ ] **Step 2: switch 이후 모든 예외를 `settlePublicationActivation()`으로 전달**

현재 pointer가 target이면 commit 재시도, previous이면 activation failed 확정, 둘 다 아니면 manual recovery 상태를 유지한다. target/previous seal을 다시 검증하지 못하면 임의 전환하지 않는다.

- [ ] **Step 3: previous pointer 복구를 원자적으로 실행**

DB commit을 확정하지 못하고 previous release가 검증되면 pointer를 previous로 되돌리고 activation을 `failed`로 기록한다. 복구 실패는 원본 commit 오류와 구분된 안전한 error code를 남긴다.

- [ ] **Step 4: 관리자 응답을 실제 outcome에 맞춤**

“현재 릴리스는 유지됩니다” 고정 문구를 제거한다.

- `committed`: 성공
- `reverted`: 이전 release로 복구됐음을 명시한 503
- `manual-recovery-required`: 발행 중단과 activation ID를 표시한 503

- [ ] **Step 5: unresolved activation에서 readiness fail-closed 유지**

프로세스를 계속 실행하더라도 public `/health/ready`와 consent intake는 authority 일치가 복구될 때까지 503을 유지한다.

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/articles/publication-release.test.ts src/admin/admin-http.test.ts
```

Expected: publish·rollback의 모든 fault point에서 pointer와 DB가 요청 종료 전에 일치하거나 명시적 manual recovery 상태가 된다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/articles/publication-release.ts apps/control/src/articles/publication-release.test.ts apps/control/src/admin/api.ts apps/control/src/admin/admin-http.test.ts apps/control/src/server.ts
git commit -m "fix(publication): settle partial activations in request"
```

---

### Task 6: Consent Authority 무중단 Handoff와 관리자 상태 분리

**Covers:** M-01, M-03

**Files:**

- Create: `apps/control/src/articles/publication-authority-worker.ts`
- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `apps/control/src/server.ts`
- Modify: `apps/control/src/app.ts`
- Modify: `apps/control/src/app.test.ts`
- Modify: `apps/control/src/admin/types.ts`
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `packages/shared/src/admin-api.ts`
- Modify: `apps/admin/src/features/operations/ConsentsPage.tsx`

**Interfaces:**

- Produces: `AuthorityActivationHandoff`
- Produces: async worker verification response
- Produces: 관리자용 DB candidate/public authority 비교 DTO

```ts
interface AuthorityActivationHandoff {
  releaseId: string;
  activationGeneration: number;
  manifestSha256: string;
  bundle: PublishedConsentBundle;
}
```

- [ ] **Step 1: activation 직후 첫 요청 503 재현 테스트 작성**

발행 성공 직후 `/health/ready`와 `/api/v1/consent-documents`의 첫 요청이 새 authority를 사용해야 한다. 외부 pointer 변경이나 변조 상황은 계속 503이어야 한다.

- [ ] **Step 2: server 시작 시 resolver를 먼저 만들고 activation hook에 주입**

`apps/control/src/server.ts`에서 하나의 resolver를 먼저 생성한 뒤 public route와 publication activation dependency가 같은 instance를 사용하게 한다. resolver가 없는 publication 경로를 만들지 않는다.

- [ ] **Step 3: commit 시 검증된 authority를 resolver에 전달**

`commitActivation()`에서 이미 검증한 release와 consent bundle을 `AuthorityActivationHandoff`로 전달한다. resolver는 현재 DB/pointer key가 handoff와 일치할 때만 cache를 원자적으로 교체한다.

- [ ] **Step 4: 60초 full verification을 worker로 이동**

main event loop에서는 file identity와 DB key만 읽는다. 최대 256MiB hash·inventory 검증은 `worker_threads` worker가 수행하고, 응답 수신 후 main thread가 activation generation과 release key를 다시 비교한 뒤 cache를 갱신한다. 더 최신 activation이 끝난 뒤 도착한 stale worker 결과는 폐기한다.

- [ ] **Step 5: 관리자 consent 상태를 두 authority로 표시**

관리자 API는 다음을 구분한다.

```ts
interface AdminConsentAuthorityDto {
  databaseCandidate: { bundleId: string } | null;
  publicAuthority: { releaseId: string; bundleId: string } | null;
  inSync: boolean;
}
```

`ConsentsPage`에서만 DB candidate와 실제 public authority를 구분한다. 관리자 health는 관리자 runtime 상태라는 기존 의미를 유지하며 public health와 동일한 값으로 바꾸지 않는다.

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/articles/publication-release.test.ts src/app.test.ts src/admin/admin-http.test.ts
npm --workspace @wisdom/admin test -- src
```

Expected: 정상 activation 직후 최초 readiness·consent 요청도 200이고, stale worker 결과는 폐기되며, 외부 변경 검증은 비동기이고, 관리자 consent 화면은 DB 후보와 공개 authority를 혼동하지 않는다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/articles/publication-authority-worker.ts apps/control/src/articles/publication-release.ts apps/control/src/articles/publication-release.test.ts apps/control/src/server.ts apps/control/src/app.ts apps/control/src/app.test.ts apps/control/src/admin/types.ts apps/control/src/admin/api.ts apps/control/src/admin/admin-http.test.ts packages/shared/src/admin-api.ts apps/admin/src/features/operations/ConsentsPage.tsx
git commit -m "fix(consent): hand off verified release authority"
```

---

### Task 7: 승인 콘텐츠 64개 Batch 발행

**Covers:** M-02

**Files:**

- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/articles/publication-snapshot.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `apps/control/src/articles/publication-snapshot.test.ts`
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `packages/shared/src/admin-api.ts`
- Modify: `apps/admin/src/features/releases/PublishPreviewPage.tsx`

**Interfaces:**

- Produces: deterministic `PublicationBatchPreview`
- Consumes: 최대 64개 promotion 또는 명시적 policy-only action

```ts
interface PublicationBatchPreview {
  eligibleTotal: number;
  batchCount: number;
  remainingAfterBatch: number;
  mode: "next-batch" | "policy-only";
  fingerprint: string;
}
```

- [ ] **Step 1: 65개 승인 head 재현 테스트 작성**

preview는 첫 64개와 remaining 1개를 반환하고, 첫 발행 후 다음 preview가 마지막 1개를 반환해야 한다. policy-only action은 승인 head 수와 무관하게 consent snapshot만 발행해야 한다.

- [ ] **Step 2: `approvedPromotions()`에 deterministic limit 적용**

`ORDER BY article_id, locale LIMIT 64`를 사용하고 전체 건수는 별도 count한다. `publication-release.ts`의 metadata validation과 `publication-snapshot.ts`의 input도 정확히 선택된 batch만 검사하도록 맞춘다. silent truncation이 되지 않도록 preview와 audit에 remaining count를 포함한다.

- [ ] **Step 3: confirmation fingerprint를 batch에 결합**

fingerprint는 mode, 정확한 64개 identity, row version, consent bundle ID를 포함한다. preview 이후 head가 바뀌면 publish를 409로 거부한다.

- [ ] **Step 4: React preview에서 두 action을 구분**

- “다음 승인 묶음 게시”
- “정책만 게시”

남은 수와 현재 batch 수를 표시하며 한 번의 action이 64개를 넘지 않게 한다.

- [ ] **Step 5: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/articles/publication-snapshot.test.ts src/articles/publication-release.test.ts src/admin/admin-http.test.ts
npm --workspace @wisdom/admin test -- src
```

Expected: 65개 이상에서도 순차 발행과 policy-only 발행이 가능하고, 중복 locale·PII·stale row version 방어는 유지되며 confirmation race는 거부된다.

- [ ] **Step 6: 승인 후 커밋**

```bash
git add apps/control/src/articles/publication-release.ts apps/control/src/articles/publication-snapshot.ts apps/control/src/articles/publication-release.test.ts apps/control/src/articles/publication-snapshot.test.ts apps/control/src/admin/api.ts apps/control/src/admin/admin-http.test.ts packages/shared/src/admin-api.ts apps/admin/src/features/releases/PublishPreviewPage.tsx
git commit -m "fix(publication): publish approved heads in bounded batches"
```

---

### Task 8: Rollback PII 재검사와 Privacy Generation Fence

**Covers:** H-07, L-04

**Dependencies:** Task 4의 migration guard와 Task 5의 activation 복구가 먼저 완료돼야 한다.

**Files:**

- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/schema.ts`
- Modify: `apps/control/src/db/database.test.ts`
- Modify: `apps/control/src/articles/no-pii.ts`
- Modify: `apps/control/src/articles/no-pii.test.ts`
- Modify: `apps/control/src/articles/publication-snapshot.ts`
- Modify: `apps/control/src/articles/publication-snapshot.test.ts`
- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `apps/control/src/admin/types.ts`
- Modify: `apps/control/src/server.ts`

**Interfaces:**

- Produces: singleton `publication_privacy_generation`
- Produces: `collectReleasePiiSegments(verifiedRelease)`
- Changes: `rollbackPublication(db, keyProvider, input, config, dependencies)`

- [ ] **Step 1: privacy generation migration 테스트 작성**

consultation insert와 PII envelope·retention expiry·purge 상태 변경이 generation을 증가시키고, 무관한 상태 변경은 증가시키지 않아야 한다.

```sql
CREATE TABLE publication_privacy_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
```

- [ ] **Step 2: publication PII segment에 slug와 route 추가**

신규 publish의 title, summary, body, source뿐 아니라 locale slug와 완성 route도 검사한다.

- [ ] **Step 3: rollback 대상 release 전체를 현재 retained PII와 검사**

sealed article documents, policy documents, slug, route를 검증된 release에서 읽고 `checkArticleForRetainedConsultationPii()`에 전달한다. decrypt 실패는 fail-closed다.

- [ ] **Step 4: generation fence를 pointer 전환과 결합**

긴 PII scan 전에 generation을 읽고, pointer 전환 직전 `BEGIN IMMEDIATE` 안에서 같은 generation인지 확인한다. 같은 transaction이 끝날 때까지 consultation writer가 generation을 바꾸지 못하게 한다. generation이 달라지면 pointer를 바꾸지 않고 재검사를 요구한다.

- [ ] **Step 5: rollback service에 key provider 전달**

admin publication adapter가 runtime PII key provider를 전달하고, key가 없거나 대상 release scan이 실패하면 rollback action을 생성하지 않는다.

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/db/database.test.ts src/articles/no-pii.test.ts src/articles/publication-snapshot.test.ts src/articles/publication-release.test.ts
```

Expected: 전화형 slug, route, retired 뒤 새로 들어온 PII, scan 중 generation 변경이 모두 switch 전에 차단된다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/db/client.ts apps/control/src/db/schema.ts apps/control/src/db/database.test.ts apps/control/src/articles/no-pii.ts apps/control/src/articles/no-pii.test.ts apps/control/src/articles/publication-snapshot.ts apps/control/src/articles/publication-snapshot.test.ts apps/control/src/articles/publication-release.ts apps/control/src/articles/publication-release.test.ts apps/control/src/admin/types.ts apps/control/src/server.ts
git commit -m "fix(publication): fence rollback against retained PII"
```

---

### Task 9: 만료 PII 관리자 접근 차단

**Covers:** H-05

**Files:**

- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `packages/shared/src/admin-api.ts`
- Modify: `apps/admin/src/features/consultations/ConsultationDetailPage.tsx`

**Interfaces:**

- Produces: `piiAvailability: "available" | "expired" | "purged"`
- Consumes: request 처리 시점의 `dependencies.now()`

- [ ] **Step 1: 만료와 철회 단축 보존기한 테스트 작성**

`retention_expires_at_ms <= now`인 row, `purged_at_ms IS NOT NULL`인 row, marketing withdrawal로 보존기한이 단축된 row는 envelope가 남아 있어도 decrypt function을 호출하지 않아야 한다.

- [ ] **Step 2: 상세 query에 retention 상태 포함**

`retention_expires_at_ms`, `purged_at_ms`를 읽고 decrypt 전에 판정한다.

```ts
const piiAvailability = row.purged_at_ms !== null
  ? "purged"
  : row.retention_expires_at_ms <= nowMs
    ? "expired"
    : "available";
```

- [ ] **Step 3: 관리자 DTO와 화면을 명시적으로 표시**

expired/purged는 `pii: null`을 반환하고 화면에는 각각 “보존기한 만료”, “파기 완료”를 표시한다. 서버 envelope 존재 여부는 노출하지 않는다.

- [ ] **Step 4: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/admin/admin-http.test.ts
npm --workspace @wisdom/admin test -- src
```

Expected: 만료 시각부터 관리자 PII 접근이 즉시 차단되고 purge 지연과 무관하게 유지된다.

- [ ] **Step 5: 승인 후 커밋**

```bash
git add apps/control/src/admin/api.ts apps/control/src/admin/admin-http.test.ts packages/shared/src/admin-api.ts apps/admin/src/features/consultations/ConsultationDetailPage.tsx
git commit -m "fix(privacy): deny expired consultation PII access"
```

---

### Task 10A: Restore에서 모든 DB Writer 정지

**Covers:** H-06

**Files:**

- Modify: `ops/lib/mac-services.mjs`
- Modify: `ops/lib/restore.mjs`
- Create: `ops/scripts/retention.mjs`
- Modify: `ops/scripts/restore.mjs`
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/launchd/com.jihye.portal.retention.plist.template`
- Modify: `ops/tests/backup-restore.test.mjs`
- Modify: `ops/tests/mac-services.test.mjs`
- Modify: `ops/tests/configuration.test.mjs`
- Modify: `ops/tests/release-system.test.mjs`
- Create: `ops/tests/retention-maintenance.test.mjs`
- Modify: `ops/runbooks/recovery.md`

- [ ] **Step 1: retention/restore race 테스트 작성**

sidecar 검사 직후 retention이 시작되는 경우 restore가 writer를 unload했거나 lock 획득 실패로 purge를 중단해야 한다. 기존 DB inode와 staged DB 모두 mutation되지 않아야 한다.

- [ ] **Step 2: scheduled writer를 restore unload 대상에 추가**

retention은 상시 `running`일 필요가 없는 scheduled label로 분류한다. restore는 persistent services와 retention label을 모두 bootout하고 unloaded를 확인한 뒤 진행하며, 종료 후 원래 plist를 bootstrap한다.

- [ ] **Step 3: retention wrapper에 공용 maintenance lock 추가**

`ops/scripts/retention.mjs`는 DB를 열기 전에 `acquireDatabaseMaintenanceLock(databasePath)`을 획득한 상태로 built `apps/control/dist/cli/purge.js`를 실행한다. child 종료까지 lock을 유지하고, lock busy이면 purge를 시작하지 않는다.

- [ ] **Step 4: DB 교체 직전 writer와 sidecar 재검사**

staged DB 검증 뒤 quarantine/rename 직전에 services unloaded와 `-wal`, `-shm`, `-journal` 부재를 다시 확인한다.

- [ ] **Step 5: 승인 후 집중 검증 및 커밋**

```bash
node --test ops/tests/backup-restore.test.mjs ops/tests/mac-services.test.mjs ops/tests/configuration.test.mjs ops/tests/release-system.test.mjs ops/tests/retention-maintenance.test.mjs
npm --workspace @wisdom/control test -- src/retention/purge.test.ts
git add ops/lib/mac-services.mjs ops/lib/restore.mjs ops/scripts/retention.mjs ops/scripts/restore.mjs ops/lib/release-system.mjs ops/launchd/com.jihye.portal.retention.plist.template ops/tests/backup-restore.test.mjs ops/tests/mac-services.test.mjs ops/tests/configuration.test.mjs ops/tests/release-system.test.mjs ops/tests/retention-maintenance.test.mjs ops/runbooks/recovery.md
git commit -m "fix(restore): quiesce every database writer"
```

Expected: restore critical section 동안 retention을 포함한 모든 writer가 unloaded이거나 동일 maintenance lock으로 차단된다.

---

### Task 10B: age Child 환경에서 Secret 제거

**Covers:** M-16

**Files:**

- Modify: `ops/lib/runtime-config.mjs`
- Modify: `ops/lib/system-adapters.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`

- [ ] **Step 1: secret env 상속 실패 테스트 작성**

age adapter child 환경에 `AGE_IDENTITY`, Keychain secret, application secret이 없고 필요한 non-secret 실행 환경만 allowlist되는지 확인한다.

- [ ] **Step 2: age identity 전달을 stdin 하나로 제한**

```js
await run(executable, args, {
  env: minimalExecutableEnvironment,
  shell: false,
  stdio: ["pipe", "ignore", "ignore"],
  stdin: identityBytes,
});
```

- [ ] **Step 3: 승인 후 집중 검증 및 커밋**

```bash
node --test ops/tests/backup-restore.test.mjs
git add ops/lib/runtime-config.mjs ops/lib/system-adapters.mjs ops/tests/backup-restore.test.mjs
git commit -m "fix(backup): isolate age child secrets"
```

Expected: identity는 stdin으로만 전달되고 child environment나 argv에 남지 않는다.

---

### Task 10C: APFS 실제 경로 기준 Backup 격리

**Covers:** M-17

**Files:**

- Modify: `ops/lib/backup.mjs`
- Modify: `ops/lib/restore.mjs`
- Modify: `ops/lib/safe-paths.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`

- [ ] **Step 1: 대소문자 alias와 symlink 경로 테스트 작성**

backup root, plaintext temp root, DB parent가 문자열로는 달라도 같은 APFS object나 상하위 경로를 가리키면 거부해야 한다.

- [ ] **Step 2: canonical identity 비교 구현**

필요한 root를 안전하게 생성·해석한 뒤 realpath와 `dev`/`ino`를 비교한다. 문자열 소문자화만으로 identity를 판단하지 않는다.

- [ ] **Step 3: 승인 후 집중 검증 및 커밋**

```bash
node --test ops/tests/backup-restore.test.mjs
git add ops/lib/backup.mjs ops/lib/restore.mjs ops/lib/safe-paths.mjs ops/tests/backup-restore.test.mjs
git commit -m "fix(backup): enforce canonical path isolation"
```

Expected: 기본 case-insensitive APFS에서도 alias를 이용한 plaintext/backup root 중첩이 차단된다.

---

### Task 10D: Data Root·SQLite 파일 Owner-only Gate

**Covers:** M-18

**Operational Gate:** 실제 운영 계정과 기존 data root/DB/WAL/SHM mode를 읽기 전용으로 확인하고, 필요한 mode 변경 범위를 사용자에게 보고해 별도 승인을 받은 뒤 적용한다.

**Files:**

- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/database.test.ts`
- Modify: `ops/lib/monitor-files.mjs`
- Modify: `ops/scripts/monitor-db-check.mjs`
- Modify: `ops/launchd/com.jihye.portal.control.plist.template`
- Modify: `ops/launchd/com.jihye.portal.notification-worker.plist.template`
- Modify: `ops/launchd/com.jihye.portal.content-worker.plist.template`
- Modify: `ops/launchd/com.jihye.portal.retention.plist.template`
- Modify: `ops/tests/monitor-files.test.mjs`
- Modify: `ops/tests/runtime-launch.test.mjs`
- Modify: `ops/tests/configuration.test.mjs`

- [ ] **Step 1: owner-only mode 실패 테스트 작성**

기존 data root가 `0700`이 아니거나 DB/WAL/SHM이 존재하면서 `0600`이 아니면 preflight와 monitor가 fail-closed해야 한다.

- [ ] **Step 2: DB 생성과 launchd umask 고정**

SQLite DB를 생성·연결할 때 mode를 `0600`으로 고정하고 DB-writing launchd plist에 `Umask` decimal `63`(`077`)을 지정한다. group/world read도 protected-path 위반으로 처리한다.

- [ ] **Step 3: 승인 후 집중 검증 및 커밋**

```bash
npm --workspace @wisdom/control test -- src/db/database.test.ts
node --test ops/tests/monitor-files.test.mjs ops/tests/runtime-launch.test.mjs ops/tests/configuration.test.mjs
git add apps/control/src/db/client.ts apps/control/src/db/database.test.ts ops/lib/monitor-files.mjs ops/scripts/monitor-db-check.mjs ops/launchd/com.jihye.portal.control.plist.template ops/launchd/com.jihye.portal.notification-worker.plist.template ops/launchd/com.jihye.portal.content-worker.plist.template ops/launchd/com.jihye.portal.retention.plist.template ops/tests/monitor-files.test.mjs ops/tests/runtime-launch.test.mjs ops/tests/configuration.test.mjs
git commit -m "fix(runtime): enforce owner-only data files"
```

Expected: 신규·기존 DB와 sidecar의 group/world read가 배포·monitor gate를 통과하지 못한다.

---

### Task 11: 자동 Offsite Backup과 Secret Recovery Bundle

**Covers:** H-08

**External Approval Gate:** 구현 전에 provider 또는 독립 장비, 별도 계정 소유자, immutable/versioned 보존 정책, RPO/RTO, recovery key 보관 주체를 먼저 결정해 사용자 승인을 받아야 한다. 승인된 provider adapter나 독립 mount가 확정되지 않으면 이 Task를 구현하지 않고 provider별 세부 계획을 별도로 작성한다. 같은 Mac 내부 경로는 offsite로 인정하지 않는다.

**Files:**

- Create: `ops/lib/offsite-backup.mjs`
- Create: `ops/scripts/offsite-backup.mjs`
- Create: `ops/scripts/recovery-bundle.mjs`
- Create: `ops/launchd/com.jihye.portal.offsite-backup.plist.template`
- Create: `ops/tests/offsite-backup.test.mjs`
- Modify: `ops/scripts/backup.mjs`
- Modify: `ops/lib/backup.mjs`
- Modify: `ops/lib/runtime-config.mjs`
- Modify: `ops/config/runtime.env.template`
- Modify: `ops/monitoring/checks.json.template`
- Modify: `ops/lib/monitoring.mjs`
- Modify: `ops/tests/configuration.test.mjs`
- Modify: `ops/tests/cli-dry-run.test.mjs`
- Modify: `ops/tests/monitoring.test.mjs`
- Modify: `ops/runbooks/recovery.md`
- Create: `docs/operations/recovery-key-inventory.md`
- Modify: `docs/superpowers/specs/2026-07-17-admin-backup-control-and-mac-mini-setup-design.md`

**Interfaces:**

- Produces: verified local pair를 승인된 독립 provider/account에 create-only로 복제하는 `replicateVerifiedBackup()`
- Produces: recovery 전용 public key로 암호화된 secret inventory bundle
- Consumes: 승인된 provider adapter 설정과 `RECOVERY_AGE_RECIPIENT`

- [ ] **Step 1: 승인된 provider·독립 root 계약과 실패 정책 테스트 작성**

mounted adapter를 선택한 경우 offsite root가 local backup root, temp root, data root와 같은 device 또는 내부 경로이면 거부한다. 다만 `dev`/`ino` 검사는 계정·지역 독립성을 증명하지 않으므로 승인된 계정/장비 식별자를 별도 운영 evidence로 기록한다. provider API adapter를 선택한 경우에는 account/container identity와 create-only/versioning capability를 검증한다. offsite 복제 실패는 local verified backup을 삭제하지 않지만 monitor를 unhealthy로 만든다.

- [ ] **Step 2: encrypted artifact와 status를 create-only pair로 복제**

`.age` artifact와 hash/size status만 복제한다. plaintext DB와 age identity는 offsite에 쓰지 않는다. mounted adapter는 pending copy·fsync·hash 검증 후 rename하고, provider API adapter는 versioned/create-only upload 뒤 remote size/hash를 다시 확인한다. 같은 artifact의 idempotent 재확인 외 overwrite는 거부한다.

- [ ] **Step 3: recovery bundle을 plaintext 파일 없이 생성**

Keychain에서 필요한 service 값을 memory로 읽고 recovery recipient로 즉시 age 암호화한다. bundle manifest에는 secret 이름과 version만 기록하고 값은 로그·argv·임시 파일에 남기지 않는다.

- [ ] **Step 4: monitor에 offsite freshness 추가**

최근 verified offsite artifact가 26시간보다 오래됐거나 local/offsite hash가 다르면 별도 `OFFSITE_BACKUP_STALE` 상태를 만든다.

- [ ] **Step 5: 독립 launchd 복제 job과 dry-run 추가**

local backup 성공 주기와 분리된 bounded job으로 최근 verified pair만 복제한다. dry-run은 network, Keychain, filesystem mutation 없이 선택될 artifact·provider identity·remote key만 표시한다.

- [ ] **Step 6: 장비 분실 복구 절차 문서화**

새 Mac, 독립 recovery identity, repository release, offsite artifact만으로 DB와 Keychain 항목을 복구하는 순서를 작성한다. `recovery-key-inventory.md`에는 비밀값이 아니라 필요한 Keychain service, key custodian, rotation/drill 날짜만 기록한다. 실제 drill 결과는 Task 18에서 승인 후에만 기록한다.

- [ ] **Step 7: 승인 후 집중 검증**

```bash
node --test ops/tests/offsite-backup.test.mjs ops/tests/backup-restore.test.mjs ops/tests/configuration.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/monitoring.test.mjs
```

Expected: local 장비 손실을 가정해도 암호화 DB와 필수 secret inventory를 독립 경로에서 복구할 수 있다.

- [ ] **Step 8: 승인 후 커밋**

```bash
git add ops/lib/offsite-backup.mjs ops/scripts/offsite-backup.mjs ops/scripts/recovery-bundle.mjs ops/launchd/com.jihye.portal.offsite-backup.plist.template ops/tests/offsite-backup.test.mjs ops/scripts/backup.mjs ops/lib/backup.mjs ops/lib/runtime-config.mjs ops/config/runtime.env.template ops/monitoring/checks.json.template ops/lib/monitoring.mjs ops/tests/configuration.test.mjs ops/tests/cli-dry-run.test.mjs ops/tests/monitoring.test.mjs ops/runbooks/recovery.md docs/operations/recovery-key-inventory.md docs/superpowers/specs/2026-07-17-admin-backup-control-and-mac-mini-setup-design.md
git commit -m "feat(backup): add verified offsite recovery artifacts"
```

---

### Task 12: 관리자 Logout·Notification UX 정정

**Covers:** M-04, M-05

**Files:**

- Modify: `apps/admin/src/app/session.tsx`
- Modify: `apps/admin/src/components/AppShell.tsx`
- Modify: `apps/admin/src/features/operations/NotificationsPage.tsx`
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `packages/shared/src/admin-api.ts`

**Interfaces:**

- Produces: logout 성공 후에만 anonymous 전환
- Produces: disabled channel test의 동기 409
- Produces: email enabled 상태에 연동된 SMTP required 규칙

- [ ] **Step 1: logout network/API 실패 테스트 작성**

logout 실패 시 session state와 CSRF token을 유지하고 AppShell에 실패 메시지를 표시해야 한다. 성공한 경우에만 anonymous로 이동한다.

- [ ] **Step 2: logout의 `finally` 상태 초기화 제거**

```ts
await apiRequest<void>("/auth/logout", { method: "POST", body: {} });
setCsrfToken(undefined);
setState({ stage: "anonymous" });
```

오류는 caller가 표시하고 session state를 바꾸지 않는다.

- [ ] **Step 3: 비활성 채널 test enqueue 차단**

관리자 API가 현재 setting을 확인해 disabled이면 notification row를 만들지 않고 409 `NOTIFICATION_CHANNEL_DISABLED`를 반환한다. UI test 버튼도 disabled 상태로 표시한다.

- [ ] **Step 4: SMTP required를 enabled 상태와 연결**

email checkbox를 React controlled state로 바꾸고 enabled일 때만 host/from/to/secretRef를 required로 둔다. disabled 저장 body는 SMTP 값을 생략할 수 있다.

- [ ] **Step 5: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/admin/admin-http.test.ts
npm --workspace @wisdom/admin test -- src
```

Expected: logout 실패가 성공처럼 보이지 않고, disabled test는 enqueue되지 않으며, SMTP 없이 disabled 저장이 가능하다.

- [ ] **Step 6: 승인 후 커밋**

```bash
git add apps/admin/src/app/session.tsx apps/admin/src/components/AppShell.tsx apps/admin/src/features/operations/NotificationsPage.tsx apps/control/src/admin/api.ts apps/control/src/admin/admin-http.test.ts packages/shared/src/admin-api.ts
git commit -m "fix(admin): report logout and notification state accurately"
```

---

### Task 13: 관리자 성공 응답 Runtime Schema와 실제 Control E2E

**Covers:** L-06, L-07

**Dependencies:** Task 6의 consent DTO와 Task 12의 notification/logout 응답 계약을 먼저 확정한 뒤 decoder와 실제 Control smoke suite를 추가한다.

**Files:**

- Modify: `packages/shared/src/admin-api.ts`
- Create: `packages/shared/src/admin-api.test.ts`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/api/client.test.ts`
- Modify: `apps/admin/src/api/use-resource.ts`
- Modify: `apps/admin/src/app/session.tsx`
- Modify: `apps/admin/src/features/articles/ArticleDetailPage.tsx`
- Modify: `apps/admin/src/features/articles/ArticleListPage.tsx`
- Modify: `apps/admin/src/features/articles/RevisionDiffPage.tsx`
- Modify: `apps/admin/src/features/consultations/ConsultationDetailPage.tsx`
- Modify: `apps/admin/src/features/consultations/ConsultationListPage.tsx`
- Modify: `apps/admin/src/features/dashboard/DashboardPage.tsx`
- Modify: `apps/admin/src/features/operations/ConsentsPage.tsx`
- Modify: `apps/admin/src/features/operations/FailuresPage.tsx`
- Modify: `apps/admin/src/features/operations/HealthPage.tsx`
- Modify: `apps/admin/src/features/operations/NotificationsPage.tsx`
- Modify: `apps/admin/src/features/releases/PublishPreviewPage.tsx`
- Modify: `apps/admin/src/features/releases/ReleaseListPage.tsx`
- Create: `apps/admin/playwright.control.config.ts`
- Create: `apps/admin/tests/control-server.mjs`
- Create: `apps/admin/tests/admin-control.spec.ts`
- Modify: `apps/admin/package.json`

**Interfaces:**

- Produces: 각 Admin DTO의 Zod runtime schema
- Changes: `apiRequest(path, schema, options)`
- Produces: 실제 Hono `createApp()`을 사용하는 별도 integration E2E

```ts
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T>;
```

- [ ] **Step 1: malformed 200 success body 거부 테스트 작성**

필수 field 누락, 잘못된 enum, 과도한 array, unknown key를 가진 200 응답을 `ADMIN_API_RESPONSE_INVALID`로 거부해야 한다.

- [ ] **Step 2: shared runtime schema 정의**

기존 interface 이름과 schema inferred type이 일치하도록 `z.infer`를 사용한다. session, dashboard, consultation, article, release, publish, notification, failure, consent authority, health를 모두 포함한다.

- [ ] **Step 3: 모든 Admin API 호출에 schema 전달**

`useResource<T>` generic-only 사용을 제거하고 page가 exact schema를 전달하도록 바꾼다. 204 응답은 `z.void()`만 허용한다.

- [ ] **Step 4: 실제 Control E2E harness 추가**

기존 `tests/server.mjs` suite는 빠른 UI fixture suite로 유지한다. 별도 config는 임시 SQLite, 실제 `createApp()`, 실제 session/CSRF/Origin 처리를 사용한다.

- [ ] **Step 5: 최소 실제 통합 경로 고정**

- login → MFA → dashboard
- consultation list/detail
- publish preview read
- notification disabled save
- logout 성공과 cookie 폐기

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/shared test -- src/admin-api.test.ts
npm --workspace @wisdom/admin test -- src/api/client.test.ts
npm --workspace @wisdom/admin run test:e2e -- --config playwright.control.config.ts
```

Expected: malformed success response가 UI state에 들어오지 않고 실제 Hono 경계의 핵심 관리자 흐름이 통과한다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add packages/shared/src/admin-api.ts packages/shared/src/admin-api.test.ts apps/admin/src/api/client.ts apps/admin/src/api/client.test.ts apps/admin/src/api/use-resource.ts apps/admin/src/app/session.tsx apps/admin/src/features apps/admin/playwright.control.config.ts apps/admin/tests/control-server.mjs apps/admin/tests/admin-control.spec.ts apps/admin/package.json
git commit -m "test(admin): validate API responses against Control"
```

---

### Task 14: Article Heading·Reviewer·Insights·RSS 정확성

**Covers:** M-10, M-11, M-12, L-01, L-03

**Files:**

- Modify: `packages/shared/src/article-markdown.ts`
- Modify: `packages/shared/src/article-markdown.test.ts`
- Modify: `packages/shared/src/article.ts`
- Modify: `packages/shared/src/article.test.ts`
- Modify: `apps/control/src/articles/publication-snapshot.ts`
- Modify: `apps/control/src/articles/publication-snapshot.test.ts`
- Modify: `apps/site/src/search/quality-gate.ts`
- Modify: `apps/site/src/search/quality-gate.test.ts`
- Modify: `apps/site/src/search/json-ld.ts`
- Modify: `apps/site/src/search/json-ld.test.ts`
- Modify: `apps/site/src/search/surface-registry.ts`
- Modify: `apps/site/src/search/surface-registry.test.ts`
- Modify: `apps/site/src/search/search-index.ts`
- Modify: `apps/site/src/search/search-index.test.ts`
- Modify: `apps/site/src/content/published-articles.ts`
- Modify: `apps/site/src/content/published-articles.test.ts`
- Modify: `apps/site/src/components/InsightsIndex.astro`
- Modify: `apps/site/src/search/feeds.ts`
- Modify: `apps/site/src/search/feeds.test.ts`

**Interfaces:**

- Produces: AST 기반 article heading contract
- Produces: locale별 reviewer role과 inline JSON-LD Person
- Produces: modifiedAt 내림차순 Insights listing
- Produces: XML 1.0 안전 문자열 gate

- [ ] **Step 1: heading 계약 테스트 작성**

- body H1은 거부
- plain H2 통과
- `## **강조 제목**` 통과
- H2가 하나도 없으면 거부
- page에는 정확히 하나의 H1

- [ ] **Step 2: Markdown AST에서 heading 구조 검증**

정규식 검사를 제거하고 parsed AST의 heading depth를 사용한다. sanitizer allowlist에서도 body `h1`을 제거한다.

- [ ] **Step 3: reviewer identity를 실제 의미에 맞춤**

role은 article locale에 맞는 고정 번역을 사용한다. JSON-LD `reviewedBy`에서 `/#representative`를 제거하고 실제 reviewer name/role의 inline `Person`을 사용한다.

- [ ] **Step 4: Insights lastmod와 정렬을 콘텐츠에서 계산**

목록은 `modifiedAt DESC`, 그다음 canonical route 순으로 정렬한다. `search-index.ts`가 locale별 최신 `modifiedAt`을 surface registry에 전달하고, `/insights` sitemap lastmod는 해당 locale article의 최대 `modifiedAt`으로 계산하며 글이 없을 때만 base revision을 사용한다.

- [ ] **Step 5: mixed-locale RSS channel language 제거**

optional channel `<language>ko</language>`를 제거하고 각 item의 `dc:language`를 유지한다.

- [ ] **Step 6: XML 1.0 금지 문자를 publication에서 거부**

title·summary·reviewer name/role schema에 XML 1.0 허용 문자 predicate를 추가한다. `feeds.ts`도 방어적으로 invalid control을 발견하면 build를 실패시킨다.

- [ ] **Step 7: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/shared test -- src/article-markdown.test.ts src/article.test.ts
npm --workspace @wisdom/control test -- src/articles/publication-snapshot.test.ts
npm --workspace @wisdom/site test -- src/search/quality-gate.test.ts src/search/json-ld.test.ts src/search/surface-registry.test.ts src/search/search-index.test.ts src/content/published-articles.test.ts src/search/feeds.test.ts
```

Expected: 정상 강조 H2는 통과하고 body H1·XML control은 차단되며 reviewer·listing·RSS metadata가 실제 콘텐츠와 일치한다.

- [ ] **Step 8: 승인 후 커밋**

```bash
git add packages/shared/src/article-markdown.ts packages/shared/src/article-markdown.test.ts packages/shared/src/article.ts packages/shared/src/article.test.ts apps/control/src/articles/publication-snapshot.ts apps/control/src/articles/publication-snapshot.test.ts apps/site/src/search/quality-gate.ts apps/site/src/search/quality-gate.test.ts apps/site/src/search/json-ld.ts apps/site/src/search/json-ld.test.ts apps/site/src/search/surface-registry.ts apps/site/src/search/surface-registry.test.ts apps/site/src/search/search-index.ts apps/site/src/search/search-index.test.ts apps/site/src/content/published-articles.ts apps/site/src/content/published-articles.test.ts apps/site/src/components/InsightsIndex.astro apps/site/src/search/feeds.ts apps/site/src/search/feeds.test.ts
git commit -m "fix(content): align article and discovery semantics"
```

---

### Task 15: 상담 Validation·Consent Refresh·Rate Limit UX

**Covers:** M-13, M-19, L-02

**Files:**

- Modify: `apps/control/src/abuse/rate-limit.ts`
- Modify: `apps/control/src/abuse/rate-limit.test.ts`
- Modify: `apps/site/src/components/ConsultationForm.astro`
- Modify: `apps/site/src/lib/consultation-adapter.ts`
- Modify: `apps/site/src/lib/form-validation.ts`
- Modify: `apps/site/src/lib/consultation-adapter.test.ts`
- Modify: `apps/site/tests/public-site.spec.ts`

**Interfaces:**

- Produces: trim 이후 field별 client error
- Produces: stale consent refresh 성공/실패 분리
- Produces: 모든 위반 window의 최종 해제 시각

- [ ] **Step 1: trim·stale refresh·receipt 상태 테스트 작성**

- trim 전에는 길이를 만족하지만 trim 후에는 최소 길이 미만인 name/message는 해당 field 오류
- stale consent refresh 성공은 “문서 변경” 안내
- refresh 실패는 configuration failure 안내 유지
- 성공 receipt 뒤 input 수정 시 receipt 상태 제거

- [ ] **Step 2: Zod issue path를 field control에 적용**

`buildConsultationSubmission()` 실패를 generic catch로 버리지 않고 issue path를 `applyServerFieldErrors()`와 같은 control mapping에 전달한다. 서버 영문 message는 화면에 노출하지 않는다.

- [ ] **Step 3: stale consent 결과를 검사**

```ts
const refreshed = await refreshConsent(submissionLocale);
terminalStatus = refreshed
  ? { state: "error", message: consentUpdatedMessage }
  : undefined;
```

refresh 실패가 이미 표시한 configuration error를 final block이 덮지 않게 한다.

- [ ] **Step 4: 성공 receipt를 편집 시 초기화**

성공 상태일 때 input/change가 발생하면 status를 숨기고 새 body의 idempotency identity를 사용한다.

- [ ] **Step 5: `Retry-After`를 가장 늦은 제한 종료로 계산**

`retryAtMs` 초기값을 0으로 두고 위반한 모든 subject/window에 `Math.max`를 적용한다.

```ts
retryAtMs = Math.max(retryAtMs, start + sizeMs);
```

- [ ] **Step 6: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/abuse/rate-limit.test.ts
npm --workspace @wisdom/site test -- src/lib/consultation-adapter.test.ts
npm --workspace @wisdom/site run test:e2e -- public-site.spec.ts
```

Expected: field 오류와 consent 장애가 정확히 구분되고 receipt 오인이 사라지며, 10분·일일 제한 동시 위반에서도 Retry-After가 일일 boundary보다 짧지 않다.

- [ ] **Step 7: 승인 후 커밋**

```bash
git add apps/control/src/abuse/rate-limit.ts apps/control/src/abuse/rate-limit.test.ts apps/site/src/components/ConsultationForm.astro apps/site/src/lib/consultation-adapter.ts apps/site/src/lib/form-validation.ts apps/site/src/lib/consultation-adapter.test.ts apps/site/tests/public-site.spec.ts
git commit -m "fix(consultation): align validation and retry state"
```

---

### Task 16: Withdrawal 전용 스타일 제공

**Covers:** M-14

**Files:**

- Create: `apps/control/src/withdrawal/styles.ts`
- Modify: `apps/control/src/withdrawal/routes.ts`
- Modify: `apps/control/src/withdrawal/withdrawal.test.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`

**Interfaces:**

- Produces: admin asset과 분리된 public withdrawal stylesheet route

- [ ] **Step 1: public withdrawal HTML asset 테스트 작성**

landing, confirm, success, error HTML이 `/admin/styles.css`를 참조하지 않고 `/marketing/withdraw/styles.css`를 참조해야 한다. stylesheet 응답은 `text/css`, owner-owned static content, public-origin 경계와 기존 CSP를 만족해야 한다.

- [ ] **Step 2: 공개 CSS 경로와 정적 style module 추가**

사용자 입력을 CSS에 삽입하지 않는다. `styles.ts`의 고정 CSS를 `GET /marketing/withdraw/styles.css`에서 반환하고 모든 철회 HTML이 이 경로를 참조하게 한다. 현재 CSP의 `style-src 'self'`를 유지하며 inline style 허용을 추가하지 않는다.

- [ ] **Step 3: 접근성 상태 유지**

focus-visible, readable width, button contrast, error/success heading을 포함하고 admin navigation과 script는 추가하지 않는다.

- [ ] **Step 4: 승인 후 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/withdrawal/withdrawal.test.ts src/admin/admin-http.test.ts
```

Expected: 모든 withdrawal 화면이 admin asset 없이 스타일되고 기능·CSP·no-store 계약이 유지된다.

- [ ] **Step 5: 승인 후 커밋**

```bash
git add apps/control/src/withdrawal/styles.ts apps/control/src/withdrawal/routes.ts apps/control/src/withdrawal/withdrawal.test.ts apps/control/src/admin/admin-http.test.ts
git commit -m "fix(withdrawal): serve standalone public styles"
```

---

### Task 17: Sites 공개 후 Release-ID Consent Protocol

**Covers:** Sites migration split-brain

**Scope Boundary:** 최초 owner-only production deployment와 최종 public access gate는 현재 계획대로 유지한다. 이 Task는 public 전환 이후 article/policy 반복 발행과 Sites version rollback에만 적용한다.

**Files:**

- Create: `apps/control/src/consent/release-authority.ts`
- Modify: `apps/control/src/consent/service.ts`
- Modify: `apps/control/src/consent/service.test.ts`
- Modify: `apps/control/src/app.ts`
- Modify: `apps/control/src/app.test.ts`
- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/schema.ts`
- Modify: `apps/control/src/db/database.test.ts`
- Modify: `apps/control/src/abuse/form-token.ts`
- Modify: `apps/control/src/abuse/form-token.test.ts`
- Modify: `apps/control/src/consultations/service.ts`
- Modify: `apps/control/src/consultations/service.test.ts`
- Create: `apps/control/src/articles/sites-release-handoff.ts`
- Create: `apps/control/src/articles/sites-release-handoff.test.ts`
- Create: `apps/control/src/cli/sites-release.ts`
- Modify: `apps/control/src/cli/arguments.ts`
- Modify: `apps/control/src/cli/arguments.test.ts`
- Modify: `apps/control/package.json`
- Create: `docs/operations/sites-publication.md`
- Modify: `docs/gpt-sites-migration/03-target-architecture.md`
- Modify: `docs/gpt-sites-migration/04-implementation-plan.md`
- Modify: `docs/gpt-sites-migration/05-decision-and-risk-register.md`
- Future Sites source modify after separate migration approval: `lib/consultation-adapter.ts`
- Future Sites source modify after separate migration approval: `content/release-ledger.json`

**Interfaces:**

- Produces: `GET /api/v1/consent-documents?releaseId=<id>`
- Produces: release ID에 묶인 form token
- Produces: bounded old/new acceptance window와 release ledger state machine

```ts
interface ConsentReleaseBinding {
  releaseId: string;
  bundleId: string;
  manifestSha256: string;
  state: "pending" | "default" | "retiring";
  acceptUntilMs: number | null;
}
```

- [ ] **Step 1: 공개 후 다음 release split-brain 테스트 작성**

old Sites version, new Sites version, new deployment 전·후, rollback 순서를 각각 재현한다. 각 화면은 자신의 embedded `releaseId`로 정확한 정책과 form token을 받아야 한다.

- [ ] **Step 2: handoff 상태를 DB migration으로 영속화**

`sites_release_handoffs`는 Control release ID, consent bundle ID, manifest SHA-256, Sites source commit, saved version ID, deployment ID, environment revision, state와 전환 시각을 저장한다. incomplete handoff는 하나만 존재하도록 unique invariant를 둔다. migration fingerprint와 schema inventory를 함께 갱신한다.

- [ ] **Step 3: pending bundle을 조회 가능하지만 default로는 비활성 등록**

Sites deploy 전에 new release binding을 `pending`으로 등록한다. 기존 기본 API는 old default를 유지하고, exact new release ID 요청만 new bundle을 받을 수 있다.

- [ ] **Step 4: form token과 consultation submit을 release ID에 결합**

token payload에 `releaseId`, `bundleId`, privacy/marketing version을 포함한다. submit은 token release가 `default`, `pending`, 아직 만료되지 않은 `retiring` 중 하나이고 exact bundle hash가 일치할 때만 수락한다.

- [ ] **Step 5: Sites version에 release ID 내장**

imported snapshot의 release ID를 consultation adapter에 전달하고 consent GET에 query로 사용한다. 상담 body는 계속 browser에서 Control API로 직접 전송한다.

- [ ] **Step 6: operator CLI로 상태 전이를 제한**

`sites-release prepare`, `record-deployment`, `activate`, `abort` 명령을 추가한다. 각 명령은 expected current state와 exact release/deployment identity 확인값을 요구하고, 잘못된 전이·중복 incomplete handoff·identity mismatch를 fail-closed 처리한다.

- [ ] **Step 7: activation ceremony를 상태 전이로 고정**

```text
Control pending binding 등록
→ Sites source/version에 같은 release ID 포함
→ Sites deploy
→ deployed release identity 확인
→ new binding을 default로 전환
→ old binding을 bounded retiring으로 전환
→ ledger commit
```

- [ ] **Step 8: rollback ceremony를 역순 불일치 없이 고정**

이전 binding이 retiring window 안에 있어야 rollback을 허용한다. 이전 Sites version을 재배포한 뒤 default를 이전 binding으로 바꾸고 실패한 새 binding을 retiring 처리한다.

- [ ] **Step 9: 기존 release ledger 권고 중복 정리**

현재 계획에 이미 있는 ledger를 새 기능처럼 표현하지 않고, ledger가 원자성 대신 state·identity·복구 이력을 제공한다는 역할을 명시한다.

- [ ] **Step 10: 승인 후 현재 서비스 집중 검증**

```bash
npm --workspace @wisdom/control test -- src/db/database.test.ts src/consent/service.test.ts src/app.test.ts src/abuse/form-token.test.ts src/consultations/service.test.ts src/articles/sites-release-handoff.test.ts src/cli/arguments.test.ts
```

Sites source가 별도 승인으로 생성된 뒤에만 해당 source의 adapter test와 build를 추가 실행한다.

Expected: old/new/rollback Sites 화면이 각자의 release ID와 일치하는 동의문·token을 받고 공개 mismatch window가 없다.

- [ ] **Step 11: 승인 후 현재 저장소 커밋**

```bash
git add apps/control/src/consent/release-authority.ts apps/control/src/consent/service.ts apps/control/src/consent/service.test.ts apps/control/src/app.ts apps/control/src/app.test.ts apps/control/src/db/client.ts apps/control/src/db/schema.ts apps/control/src/db/database.test.ts apps/control/src/abuse/form-token.ts apps/control/src/abuse/form-token.test.ts apps/control/src/consultations/service.ts apps/control/src/consultations/service.test.ts apps/control/src/articles/sites-release-handoff.ts apps/control/src/articles/sites-release-handoff.test.ts apps/control/src/cli/sites-release.ts apps/control/src/cli/arguments.ts apps/control/src/cli/arguments.test.ts apps/control/package.json docs/operations/sites-publication.md docs/gpt-sites-migration/03-target-architecture.md docs/gpt-sites-migration/04-implementation-plan.md docs/gpt-sites-migration/05-decision-and-risk-register.md
git commit -m "feat(consent): bind Sites forms to release authority"
```

---

### Task 18: 승인 기반 검증과 릴리스 근거 갱신

**Covers:** 현재 HEAD 검증 증거 부재

**Files:**

- Modify after successful approved verification: `docs/operations/release-candidate.md`
- Modify after successful approved verification: `README.md`
- Modify after successful approved drills: `ops/runbooks/deployment.md`
- Modify after successful approved drills: `ops/runbooks/recovery.md`

- [x] **Step 1: 구현 완료 후 집중 테스트 승인 요청**

Task별 명령을 모아 사용자에게 실행 범위를 먼저 제시한다. 승인되지 않은 명령은 실행하지 않는다.

- [x] **Step 2: 승인된 집중 테스트만 실행**

실패 시 해당 Task 구현으로 돌아가고 다음 Phase 테스트로 확대하지 않는다.

- [x] **Step 3: 전체 검증 별도 승인 요청**

```bash
npm run verify
```

Expected: shared/control/admin/site/ops 및 승인된 브라우저 suite가 현재 commit에서 모두 통과한다.

- [ ] **Step 4: macOS 운영 drill 별도 승인 요청**

코드 테스트와 별개로 다음 실제 환경 작업을 각각 승인받는다.

- prune된 release에서 publication build
- bootstrap → first publication → Tunnel start
- after-switch fault recovery
- retention schedule과 restore 상호배제
- non-default CONTROL_PORT deploy readiness
- offsite artifact로 새 장비 restore
- Sites old/new/rollback release handoff

- [x] **Step 5: 실행한 사실만 릴리스 근거에 기록**

실행 시각, commit SHA, 명령, 실제 pass/fail, artifact/release identity를 기록한다. 실행하지 않은 drill은 pending으로 남긴다.

- [ ] **Step 6: 승인 후 검증 근거 커밋**

```bash
git add docs/operations/release-candidate.md README.md ops/runbooks/deployment.md ops/runbooks/recovery.md
git commit -m "docs: record approved remediation verification"
```

## Completion Criteria

- production prune 이후 article·policy publication build가 실행된다.
- 정상 Wisdom release 존재 후 bootstrap seed 재실행이 차단된다.
- Tunnel 없이 첫 정상 publication을 수행하는 one-time 지원 경로가 있다.
- runtime은 schema를 자동 변경하지 않고 전용 migration gate만 사용한다.
- pointer와 DB activation은 요청 종료 전에 commit·revert·manual recovery 중 하나로 확정된다.
- 정상 activation 뒤 consent API의 첫 요청 503 공백이 없다.
- 65개 이상의 승인 locale head를 bounded batch로 발행할 수 있다.
- rollback은 현재 retained PII와 slug·route를 재검사하고 generation race를 차단한다.
- 보존기한 만료 즉시 관리자 PII decrypt가 중지된다.
- restore 중 retention을 포함한 모든 writer가 unload되고 maintenance lock에 참여한다.
- age identity가 child env에 남지 않고 backup/temp/data path의 실제 identity와 owner-only mode가 검증된다.
- 독립 offsite artifact와 secret recovery bundle의 freshness를 monitor가 확인한다.
- logout·notification·Admin API success body가 실제 서버 상태와 일치한다.
- 실제 Hono Control을 사용하는 관리자 integration E2E 경로가 존재한다.
- article heading, reviewer JSON-LD, Insights sort/lastmod, RSS/XML 계약이 일치한다.
- 상담 validation, stale consent, receipt, Retry-After 안내가 실제 처리 상태와 일치한다.
- withdrawal 화면은 admin asset에 의존하지 않는다.
- 공개 후 Sites 반복 발행과 rollback에서 정적 정책과 Control consent authority가 release ID로 일치한다.
- 현재 commit에서 실제 실행한 승인 검증만 릴리스 근거에 기록된다.

## Explicit Non-Scope

- 관리자 포털이나 공개 사이트의 전면 재설계
- Analytics 구현 또는 Sites Analytics 수집 변경
- 상담 첨부, 결제, 회원 기능 추가
- D1/R2 기반 Sites 데이터 저장
- 승인되지 않은 외부 backup provider 가입·credential 생성
- Sites project 생성, 배포, access 또는 DNS 변경
- master merge, PR 생성, push
