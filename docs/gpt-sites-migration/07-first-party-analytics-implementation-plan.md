# 자체 방문 분석 기능 구현 계획

기준일: 2026-07-24  
문서 상태: 실행 전 계획 v1.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 analytics 제품·SDK·chart package를 추가하지 않고 현재
서비스가 직접 `추정 순 방문자`, 페이지 조회, 방문 추이, 인기 페이지, 기간·
집계 단위, 상담 전환 참고값을 수집하고 React 관리자에서 제공합니다.

**Architecture:** 현재 Astro 포털과 향후 standalone Sites 포털이 브라우저에서
Control의 first-party 수집 API로 최소 page-view payload를 직접 보냅니다.
Control은 원본 event, 원본 IP·User-Agent와 장기 분석 visitor identifier를
저장하지 않고 시간·일 단위 조회수와 병합 가능 register sketch를 SQLite에
저장합니다. abuse 방지는 identifier를 담지 않는 bounded client counter
sketch와 최대 25시간의 global aggregate counter로 처리합니다. React
관리자는 인증된 집계 API를 사용하며 Sites 내장
Analytics는 외부 기준값으로만 별도 확인합니다.

**Tech Stack:** 기존 Node.js 24, TypeScript 6, Hono, Zod, better-sqlite3,
Drizzle schema, Astro, React 19, Tailwind CSS 4, native SVG와 Web Fetch API를
그대로 사용합니다. 신규 npm dependency는 없습니다.

## Global Constraints

### 고정 실행 root

| 기호 | 절대 경로 | 용도 |
|---|---|---|
| `<CURRENT_ROOT>` | `/Users/wisdom/wisdom_project/gpt/wisdom_web_portal` | 현재 `master`의 migration 계획 문서 |
| `<REACT_ROOT>` | `/Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes` | 현재 서비스와 React 관리자 구현 |
| `<SITES_ROOT>` | `/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal` | standalone Sites source |

- Task 1~7과 Task 9의 현재 서비스 파일·명령은 모두 `<REACT_ROOT>`를
  workdir로 사용합니다. 각 Git 명령은 아래 계획처럼 `git -C <절대 경로>`로
  대상 저장소를 고정합니다.
- Task 8의 파일·명령은 `<SITES_ROOT>`만 사용합니다. `<REACT_ROOT>`에서
  `../wisdom_sites_portal`을 해석하지 않습니다.
- 이 migration 문서와 향후 `08-kpi-review-log.md`는 `<CURRENT_ROOT>`에서
  관리합니다. React branch에 문서를 반영하는 작업은 별도 사용자 승인
  없이는 수행하지 않습니다.

- 구현 기준 브랜치는 `2026-07-21-codex-code-review-fixes` 또는 그 브랜치의
  descendant입니다. 현재 `master`에는 `apps/admin` React 코드가 없으므로
  `master`에서 구현을 시작하지 않습니다.
- 이 계획 문서는 현재 `master` working tree의
  `docs/gpt-sites-migration`에 있습니다. 구현 전에 문서를 React branch에
  반영할지, 현재 위치에서 참조만 할지를 사용자가 명시적으로 결정합니다.
- 브랜치 전환·병합, commit, push는 이 계획 승인에 포함되지 않으며 사용자의
  별도 명령이 있을 때만 실행합니다.
- 이 문서는 계획만 정의합니다. 코드 구현, 테스트, 브라우저 확인, 외부 Site
  변경과 배포는 실행하지 않습니다.
- GA4, Plausible, Umami, PostHog, chart library와 신규 분석 package를
  설치하지 않습니다.
- cookie, localStorage, sessionStorage, client-generated visitor ID와
  fingerprint SDK를 사용하지 않습니다.
- query string, hash, referrer, page title, client timestamp, 이름, 전화,
  이메일, 상담 본문, 동의·철회 token을 analytics payload나 DB에 넣지
  않습니다.
- raw page-view event, raw IP, raw User-Agent와 장기 pseudonymous visitor hash를
  저장하지 않습니다. client rate keyed digest는 요청 처리 중 counter
  index를 계산한 뒤 폐기하고 identifier가 없는 fixed-width counter만
  process memory에 둡니다. DB에는 최대 25시간의 global aggregate rate
  counter만 저장합니다.
- 순 방문자는 정확한 개인 수가 아니라 cookie-less 집계의
  `추정 순 방문자`로 표시합니다.
- Sites 내장 Analytics와 자체 Analytics를 개인 단위로 결합하지 않습니다.
- Sites route handler, D1과 R2가 page-view 또는 상담 body를 받지 않습니다.
- production analytics는 Control과 public client를 모두 기본 비활성으로
  배포하고 개인정보 처리방침 검토와 사용자 활성화 승인 후에만 켭니다.
- `ANALYTICS_ENABLED`는 Control 자체 collector,
  `PUBLIC_ANALYTICS_ENABLED`는 현재 Astro client를 제어합니다. 어느 설정도
  Sites 플랫폼이 자동 기록하는 내장 Analytics를 끄지 않습니다.
- 테스트 명령은 계획에 기록하되 실제 실행은 사용자 승인 후에만 수행합니다.
- 전체 `npm run verify`, 브라우저 E2E, deployment와 production traffic
  확인은 각각 별도 승인 단위입니다.

---

## 확정 설계

### 선택지와 결정

| 선택지 | 장점 | 단점 | 결정 |
|---|---|---|---|
| 장기 visitor hash row 저장 | 기간 순 방문자 계산이 단순함 | IP·UA 기반 pseudonymous identifier를 보관 | 채택하지 않음 |
| first-party visitor ID 저장 | 브라우저 단위 집계가 더 정확함 | 저장소·동의 UI·추적 범위가 확대됨 | 채택하지 않음 |
| 병합 가능한 fixed register sketch | 장기 analytics identifier를 보관하지 않음 | 확률적 추정 오차 존재 | **채택** |

### 지표 정의

| 지표 | 정의 |
|---|---|
| 페이지 조회 | 검증된 공개 route에 대해 Control이 수락한 `page_view` 횟수 |
| 추정 순 방문자 | 서버 IP와 coarse User-Agent family의 keyed digest를 16 KiB HLL-style register sketch에 반영해 계산한 근사값 |
| 수집 출처 | 허용된 요청 `Origin`에서 서버가 결정한 공개 포털 origin; client payload에는 포함하지 않음 |
| 방문 추이 | KST 기준 hour/day/week/month bucket별 페이지 조회와 추정 순 방문자 |
| 인기 페이지 | 선택 기간 page-view 합계가 높은 normalized public path 상위 10개 |
| 페이지 조회/방문자 | `pageViews ÷ estimatedUniqueVisitors`; 분모가 0 또는 unavailable이면 `null` |
| 상담 전환 참고값 | source가 `all`일 때만 `선택 기간 전체 상담 접수 ÷ estimatedUniqueVisitors × 100`; source별 상담 attribution이 없거나 unique가 unavailable이면 `null` |

### 데이터 흐름

```text
Astro 또는 Sites public page
  → POST /api/v1/analytics/page-views
  → exact Origin/CORS + body/route/privacy/bot/rate 검증
  → 검증한 Origin을 source_origin으로 서버에서 결정
  → source별 hour/day page-view rollup 증가
  → source별 hour/day unique sketch register 갱신
  → 원본 IP·UA·event body 즉시 폐기
  → GET /admin/api/v1/analytics/overview
  → React /admin/analytics
```

### 보존

- hour rollup과 hour unique sketch: 31일
- day rollup과 day unique sketch: 기본 180일
- global rate aggregate counter: 최대 25시간
- client rate state: process memory의 fixed counter sketch, window 종료 시 초기화
- raw event table: 생성하지 않음
- 보존기간 설정 범위: 30~400일

---

## 파일 책임 지도

### 현재 서비스 저장소

```text
packages/shared/src/analytics.ts
  public request schema와 admin response DTO

apps/control/src/analytics/route-normalization.ts
  locale, static route, active article route 검증

apps/control/src/analytics/unique-sketch.ts
  aggregate register sketch 생성·갱신·병합·cardinality 추정

apps/control/src/analytics/client-rate-sketch.ts
  identifier를 저장하지 않는 bounded in-memory rate counter

apps/control/src/analytics/service.ts
  privacy signal, bot filter, rate-limit과 rollup transaction

apps/control/src/analytics/reporting.ts
  기간 검증, KST bucket, 합계·추이·인기 페이지·상담 참고값

apps/control/src/analytics/routes.ts
  public POST/OPTIONS route registration

apps/control/src/analytics/retention.ts
  만료 aggregate와 rate bucket의 bounded purge

apps/site/src/lib/analytics-client.ts
  현재 Astro 포털의 단일 page-view 전송

apps/admin/src/features/analytics/AnalyticsPage.tsx
  기간·단위 filter, KPI, 추이, 인기 페이지와 방법론

apps/admin/src/features/analytics/AnalyticsTrendChart.tsx
  dependency 없는 accessible SVG chart
```

### standalone Sites 저장소 후보

```text
<SITES_ROOT>/lib/analytics/client.ts
<SITES_ROOT>/components/analytics/PageViewTracker.tsx
<SITES_ROOT>/app/layout.tsx
<SITES_ROOT>/worker/index.ts
```

standalone Sites source가 아직 생성되지 않았으므로 해당 파일은
`04-implementation-plan.md` Task 1과 Task 3 완료 후에만 생성합니다.

---

### Task 0: 구현 기준 branch와 승인 gate 고정

**Files:**

- Reference:
  `<CURRENT_ROOT>/docs/gpt-sites-migration/05-decision-and-risk-register.md`
- Reference:
  `<REACT_ROOT>/apps/admin/src/app/router.tsx`
- Reference:
  `<REACT_ROOT>/apps/control/src/admin/api.ts`

**Interfaces:**

- Consumes: React 관리자 commit `8d96fb4`
- Produces: Analytics 구현이 적용될 정확한 branch 기준

- [ ] **Step 1: 실행 worktree 상태 확인**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes branch --show-current
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes rev-parse HEAD
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes status --short
```

Expected:

```text
2026-07-21-codex-code-review-fixes
8d96fb44766fede2db92b59dfc8659b46f3a00eb
```

두 번째 값은 구현 시작 시 descendant commit으로 바뀔 수 있지만
`apps/admin/src/app/router.tsx`와 `apps/control/src/admin/api.ts`가 존재해야
합니다.

- [ ] **Step 2: 활성화 전 승인 gate 기록**

다음 네 항목을 모두 만족하기 전에는 `ANALYTICS_ENABLED=true`를 production에
적용하지 않습니다.

```text
1. 자체 수집 목적·항목·보존기간을 개인정보 처리방침에서 검토
2. cookie-less 추정 순 방문자라는 UI 문구 승인
3. public client exact Origin 목록 승인
4. targeted verification 범위 승인
```

현재 plan 문서가 React branch에 없으면 코드 작업 전에 문서 반영 또는
외부 참조 방식을 사용자에게 승인받습니다. 자동 merge, cherry-pick과 file
copy를 수행하지 않습니다.

개인정보 처리방침 검토에서 명시적 opt-in이 필요하다고 판단되면 이 계획으로
collector를 활성화하지 않습니다. consent UI와 browser identifier 유무를
별도 설계·승인한 뒤 계획을 개정하며, localStorage나 cookie를 임의로
추가하지 않습니다.

- [ ] **Step 3: 별도 요청이 있을 때만 기준 commit 생성**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal add docs/gpt-sites-migration
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal commit -m "docs: plan first-party portal analytics"
```

이 commit은 문서 작성 요청만으로 실행하지 않습니다.

---

### Task 1: 공유 wire contract와 route grammar

**Files:**

- Create: `packages/shared/src/analytics.ts`
- Create: `packages/shared/src/analytics.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/control/src/analytics/route-normalization.ts`
- Create: `apps/control/src/analytics/route-normalization.test.ts`

**Interfaces:**

- Consumes: `Locale`, 현재 15개 base public route, active
  `release_entries.route`
- Produces:
  `analyticsPageViewRequestSchema`,
  `AdminAnalyticsOverviewDto`,
  `normalizeAnalyticsRoute(path, activeArticleExists)`

- [ ] **Step 1: 실패하는 shared contract test 작성**

```ts
import { describe, expect, it } from "vitest";

import {
  analyticsPageViewRequestSchema,
  type AdminAnalyticsOverviewDto,
} from "./analytics.js";

describe("analytics contract", () => {
  it("accepts only the minimal v1 page-view body", () => {
    expect(analyticsPageViewRequestSchema.parse({
      schemaVersion: 1,
      path: "/en/services/procurement",
    })).toEqual({
      schemaVersion: 1,
      path: "/en/services/procurement",
    });
    expect(() => analyticsPageViewRequestSchema.parse({
      schemaVersion: 1,
      path: "/services?phone=01012345678",
    })).toThrow();
    expect(() => analyticsPageViewRequestSchema.parse({
      schemaVersion: 1,
      path: "/services",
      referrer: "https://example.com/private",
    })).toThrow();
  });

  it("keeps aggregate-only administrator output", () => {
    const value: AdminAnalyticsOverviewDto["methodology"]["uniqueVisitors"] =
      "estimated-cookie-less";
    expect(value).toBe("estimated-cookie-less");
  });
});
```

- [ ] **Step 2: targeted test 명령을 승인 후 실행**

Run:

```bash
npm run test --workspace @wisdom/shared -- src/analytics.test.ts
```

Expected: FAIL because `analytics.ts` is not present.

- [ ] **Step 3: exact public/admin contracts 작성**

```ts
import { z } from "zod";

export const analyticsPageViewRequestSchema = z.object({
  schemaVersion: z.literal(1),
  path: z.string()
    .min(1)
    .max(180)
    .regex(/^\/[\x21-\x7e]*$/u)
    .refine((value) => !/[?#%\\]/u.test(value)),
}).strict();

export type AnalyticsPageViewRequest =
  z.infer<typeof analyticsPageViewRequestSchema>;

export type AnalyticsGranularity = "hour" | "day" | "week" | "month";

export interface AdminAnalyticsOverviewDto {
  schemaVersion: 1;
  range: {
    from: string;
    to: string;
    granularity: AnalyticsGranularity;
    timeZone: "Asia/Seoul";
    sourceOrigin: "all" | string;
  };
  availableSourceOrigins: string[];
  collectionCoverage: {
    state: "complete" | "partial" | "none";
    coveredFrom: string | null;
    coveredTo: string | null;
    hasKeyResetBoundary: boolean;
  };
  totals: {
    estimatedUniqueVisitors: number | null;
    uniqueEstimateQuality:
      | "ok"
      | "saturated"
      | "key-reset-boundary"
      | "not-collected";
    pageViews: number;
    consultations: number;
    consultationsScope: "all-portal-origins";
    pageViewsPerVisitor: number | null;
    approximateConsultationConversionRate: number | null;
  };
  comparison: {
    available: boolean;
    estimatedUniqueVisitorsChangePercent: number | null;
    pageViewsChangePercent: number | null;
    consultationsChangePercent: number | null;
  };
  series: Array<{
    start: string;
    estimatedUniqueVisitors: number | null;
    uniqueEstimateQuality:
      | "ok"
      | "saturated"
      | "key-reset-boundary"
      | "not-collected";
    pageViews: number;
  }>;
  popularPages: Array<{
    path: string;
    locale: "ko" | "en" | "zh-Hans" | "zh-Hant";
    pageViews: number;
    sharePercent: number;
  }>;
  methodology: {
    uniqueVisitors: "estimated-cookie-less";
    storesRawEvents: false;
    storesLongLivedVisitorIdentifiers: false;
    storesRateLimitSubjectDigests: false;
    clientRateLimiter: "bounded-in-memory-counter-sketch";
    botFiltering: "best-effort";
  };
}
```

`packages/shared/src/index.ts`에서 `./analytics.js`를 export합니다.
`sourceOrigin`은 client request body가 아니라 인증된 관리자 조회 filter이며,
응답의 origin 값은 collector가 exact allowlist와 대조한 공개 설정값만
포함합니다.

- [ ] **Step 4: authoritative route normalizer 작성**

허용 static route는 `/marketing/withdraw`와 `/404`를 제외한 현재 public
content route입니다. locale prefix는 `ko=""`, `en="/en"`,
`zh-Hans="/zh-hans"`, `zh-Hant="/zh-hant"`만 인정합니다.

```ts
export interface NormalizedAnalyticsRoute {
  path: string;
  locale: "ko" | "en" | "zh-Hans" | "zh-Hant";
  pageKind:
    | "home"
    | "content"
    | "service"
    | "insights"
    | "article"
    | "consultation"
    | "policy";
}

export function normalizeAnalyticsRoute(
  path: string,
  activeArticleExists: (exactPath: string) => boolean,
): NormalizedAnalyticsRoute | undefined;
```

세부 규칙:

```text
- root 외 trailing slash 1개 제거
- 중복 slash, dot segment, percent encoding, query와 hash 거부
- `/admin`, `/api`, `/health`, `/internal`, machine route 거부
- `/marketing/withdraw`와 그 하위 token route 거부
- article slug는 `[a-z0-9]+(?:-[a-z0-9]+)*`
- article은 active release의 exact route가 존재할 때만 허용
- unknown route는 422 처리하며 임의 path로 저장하지 않음
```

- [ ] **Step 5: route test에 개인정보 경계 포함**

```ts
it("rejects paths that can carry secrets or arbitrary visitor input", () => {
  const active = () => false;
  expect(normalizeAnalyticsRoute(
    "/marketing/withdraw/private-token",
    active,
  )).toBeUndefined();
  expect(normalizeAnalyticsRoute(
    "/services?message=private",
    active,
  )).toBeUndefined();
  expect(normalizeAnalyticsRoute("/unknown/private-name", active))
    .toBeUndefined();
});
```

- [ ] **Step 6: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add packages/shared/src/analytics.ts \
  packages/shared/src/analytics.test.ts \
  packages/shared/src/index.ts \
  apps/control/src/analytics/route-normalization.ts \
  apps/control/src/analytics/route-normalization.test.ts
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: define privacy-minimal analytics contracts"
```

---

### Task 2: SQLite aggregate schema와 migration 7

**Files:**

- Modify: `apps/control/src/db/client.ts`
- Modify: `apps/control/src/db/schema.ts`
- Modify: `apps/control/src/db/database.test.ts`
- Modify: `ops/lib/system-adapters.mjs`
- Modify: `ops/tests/system-adapters.test.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`

**Interfaces:**

- Consumes: normalized path, KST hour/day bucket, fixed register sketch
- Produces:
  `analytics_pageviews`,
  `analytics_unique_sketches`,
  `analytics_rate_buckets`,
  `analytics_state`,
  `analytics_collection_intervals`

`source_origin`은 client body에서 받지 않고 collector가 exact
`FORM_ALLOWED_ORIGINS` 검증을 통과한 `Origin` header에서 결정합니다. 이는
공개 deployment 설정 차원이며 visitor identifier가 아닙니다.

- [ ] **Step 1: migration 6→7 실패 test 작성**

Test assertions:

```ts
expect(SCHEMA_VERSION).toBe(7);
expect(tableNames).toEqual(expect.arrayContaining([
  "analytics_pageviews",
  "analytics_unique_sketches",
  "analytics_rate_buckets",
  "analytics_state",
  "analytics_collection_intervals",
]));
expect(indexNames).toContain("analytics_rate_buckets_expiry_idx");
expect(indexNames).toContain(
  "analytics_collection_intervals_open_idx",
);
```

기존 migration fingerprint와 rollback compatibility test에도 version 7을
추가합니다. v6→v7이 일반 release의
`--require-rollback-compatible`에서 계속 거부되는 test를 유지합니다.

- [ ] **Step 2: migration 7 SQL 추가**

Migration name은 `privacy-preserving-analytics-rollups`로 고정합니다.

```sql
CREATE TABLE analytics_pageviews (
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
  source_origin TEXT NOT NULL CHECK (
    length(source_origin) BETWEEN 8 AND 200
    AND source_origin LIKE 'https://%'
    AND instr(source_origin, '?') = 0
    AND instr(source_origin, '#') = 0
  ),
  path TEXT NOT NULL CHECK (
    length(path) BETWEEN 1 AND 180
    AND path LIKE '/%'
    AND instr(path, '?') = 0
    AND instr(path, '#') = 0
  ),
  locale TEXT NOT NULL
    CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  page_kind TEXT NOT NULL CHECK (
    page_kind IN (
      'home','content','service','insights','article','consultation','policy'
    )
  ),
  page_view_count INTEGER NOT NULL CHECK (page_view_count > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > bucket_start_ms),
  PRIMARY KEY (bucket_kind, bucket_start_ms, source_origin, path)
) WITHOUT ROWID;

CREATE INDEX analytics_pageviews_path_bucket_idx
  ON analytics_pageviews(
    source_origin, path, bucket_kind, bucket_start_ms
  );
CREATE INDEX analytics_pageviews_expiry_idx
  ON analytics_pageviews(expires_at_ms);

CREATE TABLE analytics_unique_sketches (
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
  source_origin TEXT NOT NULL CHECK (
    length(source_origin) BETWEEN 8 AND 200
    AND source_origin LIKE 'https://%'
    AND instr(source_origin, '?') = 0
    AND instr(source_origin, '#') = 0
  ),
  registers BLOB NOT NULL CHECK (length(registers) = 16384),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > bucket_start_ms),
  PRIMARY KEY (bucket_kind, bucket_start_ms, source_origin)
) WITHOUT ROWID;

CREATE INDEX analytics_unique_sketches_expiry_idx
  ON analytics_unique_sketches(expires_at_ms);

CREATE TABLE analytics_rate_buckets (
  window_kind TEXT NOT NULL CHECK (window_kind IN ('minute','day')),
  window_start_ms INTEGER NOT NULL CHECK (window_start_ms >= 0),
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > window_start_ms),
  PRIMARY KEY (window_kind, window_start_ms)
) WITHOUT ROWID;

CREATE INDEX analytics_rate_buckets_expiry_idx
  ON analytics_rate_buckets(expires_at_ms);

CREATE TABLE analytics_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  key_fingerprint BLOB NOT NULL CHECK (length(key_fingerprint) = 32),
  unique_coverage_started_at_ms INTEGER NOT NULL
    CHECK (unique_coverage_started_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

CREATE TABLE analytics_collection_intervals (
  source_origin TEXT NOT NULL CHECK (
    length(source_origin) BETWEEN 8 AND 200
    AND source_origin LIKE 'https://%'
    AND instr(source_origin, '?') = 0
    AND instr(source_origin, '#') = 0
  ),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  ended_at_ms INTEGER CHECK (
    ended_at_ms IS NULL OR ended_at_ms > started_at_ms
  ),
  PRIMARY KEY (source_origin, started_at_ms)
) WITHOUT ROWID;

CREATE UNIQUE INDEX analytics_collection_intervals_open_idx
  ON analytics_collection_intervals(source_origin)
  WHERE ended_at_ms IS NULL;
```

- [ ] **Step 3: schema registry update**

`apps/control/src/db/schema.ts`에 다섯 table의 Drizzle 정의를 추가하고 다음
목록을 정확히 갱신합니다.

`SCHEMA_VERSION`을 `7`로 올리고 기존 `REQUIRED_TABLES` 뒤에
`analytics_pageviews`, `analytics_unique_sketches`,
`analytics_rate_buckets`, `analytics_state`,
`analytics_collection_intervals`를 추가합니다. 기존 `REQUIRED_INDEXES` 뒤에는
`analytics_pageviews_path_bucket_idx`, `analytics_pageviews_expiry_idx`,
`analytics_unique_sketches_expiry_idx`,
`analytics_rate_buckets_expiry_idx`,
`analytics_collection_intervals_open_idx`를 추가합니다.

`drizzleSchema`에도 다섯 table을 포함합니다.

- [ ] **Step 4: restore schema adapter를 v7로 갱신**

`ops/lib/system-adapters.mjs`의 default `expectedSchemaVersion`을 7로
올립니다. restore의 `enforceRetention`은 consultation PII뿐 아니라
analytics hour/day rollup, unique sketch와 global rate counter의 현재
보존정책 만료분도 replacement 전에 삭제합니다. 반환값에는
`analyticsPurgedCount`를 별도 포함하고 restore 결과/감사 로그에 기록합니다.

`ops/tests/system-adapters.test.mjs`와
`ops/tests/backup-restore.test.mjs`는 다음을 고정합니다.

```text
- v7 backup만 새 release와 schema compatible
- v6 backup은 새 release restore에서 fail-closed
- restore replacement 전에 analytics 만료 row 삭제
- current retention이 180→30으로 줄었으면 stored expires_at보다 먼저 삭제
- collection interval과 analytics_state는 visitor data가 아니므로 유지
```

- [ ] **Step 5: migration/restore test를 승인 후 실행**

Run:

```bash
npm run test --workspace @wisdom/control -- src/db/database.test.ts
node --test ops/tests/system-adapters.test.mjs
node --test ops/tests/backup-restore.test.mjs
```

Expected: PASS, migration history가 1~7이고 schema tampering test가 유지됩니다.

- [ ] **Step 6: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/control/src/db/client.ts \
  apps/control/src/db/schema.ts \
  apps/control/src/db/database.test.ts \
  ops/lib/system-adapters.mjs \
  ops/tests/system-adapters.test.mjs \
  ops/tests/backup-restore.test.mjs
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: add aggregate analytics schema"
```

---

### Task 2B: v6→v7 전용 maintenance migration

**Files:**

- Create: `ops/lib/schema-maintenance.mjs`
- Create: `ops/scripts/schema-maintenance.mjs`
- Create: `ops/tests/schema-maintenance.test.mjs`
- Modify: `ops/runbooks/deployment.md`
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/tests/release-system.test.mjs`

**Interfaces:**

- Consumes: stopped v6 production, verified fresh backup, DB maintenance lock,
  staged v7 release
- Produces: rollback-incompatible schema v7와 명시적으로 retired v6 releases

일반 `deploy.mjs`와 `db:migrate --require-rollback-compatible`의 보호를
약화하지 않습니다. v6→v7은 새 전용 maintenance command와 별도 운영 승인으로
한 번만 수행합니다.

- [ ] **Step 1: fail-closed maintenance tool test 작성**

```text
- control/worker/tunnel 중 하나라도 running이면 거부
- fresh backup hash·복호화·integrity·schema v6 증거 없으면 거부
- DB maintenance lock을 획득하지 못하면 거부
- from=6, to=7, exact confirmation이 아니면 거부
- retained v6 release retirement 기록 없으면 거부
- migration 뒤 user_version/history/integrity가 7이 아니면 서비스 재시작 금지
- 같은 DB에 재실행하면 already-complete로 no-op
```

- [ ] **Step 2: 전용 command 구현**

승인 후 사용할 후보 command는 다음처럼 exact target을 요구합니다.

```bash
node ops/scripts/schema-maintenance.mjs \
  --database /Users/wisdom/portal-data/portal.sqlite \
  --from-version 6 \
  --to-version 7 \
  --backup-status /absolute/path/to/verified-backup-status.json \
  --retirement-record /absolute/path/to/v6-retirement-record.json \
  --confirm-action MIGRATE_SCHEMA_6_TO_7
```

script는 maintenance lock 안에서 staged v7의 canonical migration code만
호출합니다. 일반 migration 우회 flag를 추가하거나 retained v6 release를
rollback 후보로 남기지 않습니다.

- [ ] **Step 3: 운영 ceremony를 runbook에 고정**

```text
1. v7 release와 restore tooling을 stage하되 traffic 전환하지 않음
2. control, worker, tunnel 정지 및 stopped 증거 기록
3. fresh backup 생성, hash·복호화·integrity·schema v6 restore drill
4. v6 retained releases 식별 및 rollback retirement 별도 승인
5. DB maintenance lock 획득
6. 전용 schema 6→7 command 실행
7. user_version, migration history, integrity, v7 restore adapter 검증
8. v7 release canary/readiness 후 서비스와 tunnel 재시작
9. v6 binary로 rollback하지 않고 v7 forward-fix 또는 verified v7 backup 복구
```

- [ ] **Step 4: 별도 승인 후 maintenance tooling test**

```bash
node --test ops/tests/schema-maintenance.test.mjs
node --test ops/tests/release-system.test.mjs
```

- [ ] **Step 5: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add ops/lib/schema-maintenance.mjs \
  ops/scripts/schema-maintenance.mjs \
  ops/tests/schema-maintenance.test.mjs \
  ops/runbooks/deployment.md \
  ops/lib/release-system.mjs \
  ops/tests/release-system.test.mjs
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: add schema seven maintenance ceremony"
```

실제 production command, backup, service stop, retirement와 migration은
구현·test·commit 승인에 포함되지 않는 별도 운영 변경입니다.

---

### Task 3: cookie-less unique sketch와 수집 transaction

**Files:**

- Modify: `apps/control/src/crypto/index.ts`
- Modify: `apps/control/src/crypto/crypto.test.ts`
- Create: `apps/control/src/analytics/unique-sketch.ts`
- Create: `apps/control/src/analytics/unique-sketch.test.ts`
- Create: `apps/control/src/analytics/client-rate-sketch.ts`
- Create: `apps/control/src/analytics/client-rate-sketch.test.ts`
- Create: `apps/control/src/analytics/state.ts`
- Create: `apps/control/src/analytics/state.test.ts`
- Create: `apps/control/src/analytics/service.ts`
- Create: `apps/control/src/analytics/service.test.ts`
- Create: `apps/control/src/cli/analytics-key-reset.ts`
- Modify: `apps/control/package.json`

**Interfaces:**

- Consumes:
  `KeyProvider`,
  `NormalizedAnalyticsRoute`,
  trusted proxy가 해석한 client IP,
  최대 512자 User-Agent
- Produces:
  `recordAnalyticsPageView(input)`,
  mergeable 16 KiB HLL-style register sketch,
  raw identifier 없는 rollup

- [ ] **Step 1: analytics key separation과 rotation test 작성**

Analytics digest는 `CONTROL_HMAC_SECRET`에 해당하는 `provider.hmacRoot()`에서
고정 HKDF context로 파생합니다. PII active key ID는 derivation에 넣지
않습니다.

```ts
const root = Buffer.alloc(32, 9);
const before = createStaticKeyProvider(
  { id: "pii-v1", secret: Buffer.alloc(32, 1) },
  [],
  root,
);
const after = createStaticKeyProvider(
  { id: "pii-v2", secret: Buffer.alloc(32, 2) },
  [{ id: "pii-v1", secret: Buffer.alloc(32, 1) }],
  root,
);

expect(analyticsDigest(before, "same-input"))
  .toEqual(analyticsDigest(after, "same-input"));
expect(analyticsDigest(before, "same-input"))
  .not.toEqual(keyedDigest(before, "abuse", "same-input"));
```

구현 계약:

```ts
export function analyticsDigest(
  provider: KeyProvider,
  value: string | Uint8Array,
): Buffer {
  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(provider.hmacRoot()),
    Buffer.from("wisdom-control:v1", "utf8"),
    Buffer.from("wisdom:analytics:v1", "utf8"),
    32,
  ));
  return createHmac("sha256", key).update(value).digest();
}
```

HKDF salt는 `wisdom-control:v1`, info는 `wisdom:analytics:v1`로 고정합니다.
이렇게 해야 PII encryption key ID rotation이 기간 지표를 끊지 않습니다.

`CONTROL_HMAC_SECRET` 자체는 retained unique sketch가 있는 동안
migration-sensitive입니다. 시작 시 derived analytics key의 SHA-256
fingerprint를 `analytics_state`의 비밀이 아닌 verifier와 대조합니다.
fingerprint가 달라졌는데 기존 sketch가 있으면 collector만 fail-closed하고
`analytics:key-reset` maintenance가 필요하다는 상태를 관리자에 반환합니다.
명시적 reset은 client/collector 비활성화, 기존 unique sketch 삭제,
coverage interval 종료, 새 fingerprint와 coverage 시작 기록을 한
transaction에서 수행합니다. page-view rollup은 삭제하지 않습니다.
key reset과 그 검증은 별도 사용자 승인 작업이며 조용히 자동 수행하지
않습니다.

`apps/control/package.json`에는 `analytics:key-reset` script를 추가합니다.
CLI는 analytics client/collector가 모두 false라는 운영 확인과 exact
`RESET_ANALYTICS_UNIQUES` confirmation을 요구하고, 영향받는 sketch/coverage
수를 dry-run으로 먼저 반환합니다. 실제 reset은 별도 운영 승인이 없으면
실행하지 않습니다.

- [ ] **Step 2: register sketch primitive test 작성**

```ts
it("merges repeat visitors without storing their digest", () => {
  const first = createUniqueSketch();
  addUniqueDigest(first, analyticsDigestForTest("visitor-a"));
  addUniqueDigest(first, analyticsDigestForTest("visitor-a"));
  expect(estimateUnique(first).estimate).toBe(1);

  const second = createUniqueSketch();
  addUniqueDigest(second, analyticsDigestForTest("visitor-b"));
  expect(estimateUnique(mergeUniqueSketches([first, second])).estimate)
    .toBe(2);
});
```

- [ ] **Step 3: native fixed register sketch 구현**

```ts
export const UNIQUE_SKETCH_PRECISION = 14;
export const UNIQUE_SKETCH_REGISTERS = 1 << UNIQUE_SKETCH_PRECISION;
export const UNIQUE_SKETCH_BYTES = UNIQUE_SKETCH_REGISTERS;

export function createUniqueSketch(): Buffer {
  return Buffer.alloc(UNIQUE_SKETCH_BYTES);
}

export function addUniqueDigest(
  registers: Buffer,
  digest: Uint8Array,
): void;

export function mergeUniqueSketches(
  inputs: readonly Uint8Array[],
): Buffer;

export function estimateUnique(
  registers: Uint8Array,
): {
  estimate: number | null;
  quality: "ok" | "saturated";
};
```

첫 64 hash bit 중 14 bit를 register index, 나머지를 leading-zero rank로
사용합니다. 같은 register는 최대 rank, merge는 register별 최대값을
취하며 input을 변경하지 않습니다. estimator는 표준 harmonic mean과
small-range correction을 직접 구현합니다. 모든 register가 표현 가능한
최대 rank여서 품질을 보장할 수 없을 때 값을 임의로 낮추지 않고
`{ estimate: null, quality: "saturated" }`를 반환합니다. 신규 package는
추가하지 않습니다.

- [ ] **Step 4: transient visitor digest 계산**

```ts
export function analyticsVisitorDigest(
  provider: KeyProvider,
  clientIp: string,
  userAgent: string,
): Buffer | undefined;
```

규칙:

```text
- clientIp가 empty 또는 "unknown"이면 unique sketch만 갱신하지 않음
- User-Agent는 최대 512자를 읽고 browser family만
  edge/chrome/firefox/safari/other 순서로 축약
- `wisdom:analytics-visitor:v1\0<ip>\0<family>`를 analytics key로 HMAC
- digest는 HLL register 갱신 직후 폐기
- digest, IP와 UA를 DB와 log에 전달하지 않음
```

- [ ] **Step 5: bounded rate-limit state와 test 작성**

고정 rate:

| scope | minute | day |
|---|---:|---:|
| client transient digest | 120 | 2,000 |
| global | 1,500 | 250,000 |

Test cases:

```text
- 같은 visitor가 같은 hour에 3회: pageViews=3, estimated unique=1
- 같은 visitor가 다음 hour에 재방문: 두 hour sketch에 존재, day total≈1
- 다른 path: 각 page count 증가, total sketch는 같은 visitor 1
- 다른 source origin: 별도 rollup/sketch에 저장
- 제한 초과: rate counter만 commit, rollup 불변
- 서로 다른 IP가 대량 유입돼도 DB rate row 수는 minute/day window 수로 제한
- GPC/DNT/bot: 어떤 analytics table도 변경하지 않음
- service error log에 IP, UA와 request body 없음
```

client rate는 DB row-per-IP를 만들지 않습니다. process memory에
minute/day별 fixed-width count-min counter sketch 두 개만 두고 window가
바뀌면 배열을 초기화합니다. rate subject는 다음처럼 domain-separated
digest로 계산하고 네 counter index를 갱신한 직후 digest를 폐기합니다.

```text
client = HMAC(
  "wisdom:analytics-rate-client:v1\0"
  + windowKind + "\0" + windowStartMs + "\0" + clientIp
)
```

counter sketch는 identifier와 digest를 저장하지 않으며 고정 크기를
초과하지 않습니다. process restart 시 client count는 초기화되므로
best-effort 제어이며, SQLite의 global minute/day counter가 총 write 상한을
계속 강제합니다. `analytics_rate_buckets`에는 global window count만 있어
활성 row는 최대 2개이고 expiry 후 최대 1시간 grace 안에 정리합니다.
global count는 limit+1에서 saturating update하여 초과 요청이 INTEGER 값을
계속 키우지 않습니다.

- [ ] **Step 6: atomic `recordAnalyticsPageView` 구현**

```ts
export interface RecordAnalyticsPageViewInput {
  route: NormalizedAnalyticsRoute;
  sourceOrigin: string;
  clientIp: string;
  userAgent: string;
  nowMs: number;
}

export type RecordAnalyticsPageViewResult =
  | { kind: "recorded" }
  | { kind: "ignored"; reason: "privacy-signal" | "bot" | "disabled" }
  | { kind: "rate-limited"; retryAfterSeconds: number };

export function recordAnalyticsPageView(
  db: ControlDatabase,
  provider: KeyProvider,
  input: RecordAnalyticsPageViewInput,
  options: {
    enabled: boolean;
    enabledOrigins: readonly string[];
    retentionDays: number;
    dnt: boolean;
    gpc: boolean;
  },
): RecordAnalyticsPageViewResult;
```

한 `BEGIN IMMEDIATE` transaction에서 다음 순서를 지킵니다.

```text
1. source origin이 enabledOrigins에 없으면 no-write ignored
2. in-memory client minute/day counter sketch 검사
3. SQLite global minute/day counter upsert
4. 제한 초과면 global counter만 commit
5. KST hour/day bucket 계산
6. `(source_origin, path)`별 analytics_pageviews hour/day 각각 +1
7. `source_origin`별 analytics_unique_sketches hour/day register sketch
   read-copy-set-upsert
8. commit
```

hour expiry는 31일, day expiry는 `ANALYTICS_RETENTION_DAYS`를 사용합니다.

- [ ] **Step 7: targeted tests를 승인 후 실행**

```bash
npm run test --workspace @wisdom/control -- \
  src/crypto/crypto.test.ts \
  src/analytics/unique-sketch.test.ts \
  src/analytics/client-rate-sketch.test.ts \
  src/analytics/state.test.ts \
  src/analytics/service.test.ts
```

Expected: PASS, DB row에는 공개 source/path, locale, page kind, aggregate
count, register sketch와 bounded global rate count만 남습니다.

- [ ] **Step 8: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/control/src/crypto/index.ts \
  apps/control/src/crypto/crypto.test.ts \
  apps/control/src/analytics/unique-sketch.ts \
  apps/control/src/analytics/unique-sketch.test.ts \
  apps/control/src/analytics/client-rate-sketch.ts \
  apps/control/src/analytics/client-rate-sketch.test.ts \
  apps/control/src/analytics/state.ts \
  apps/control/src/analytics/state.test.ts \
  apps/control/src/analytics/service.ts \
  apps/control/src/analytics/service.test.ts \
  apps/control/src/cli/analytics-key-reset.ts \
  apps/control/package.json
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: aggregate privacy-minimal page views"
```

---

### Task 4: public collection API, exact CORS와 configuration

**Files:**

- Create: `apps/control/src/analytics/routes.ts`
- Create: `apps/control/src/analytics/routes.test.ts`
- Modify: `apps/control/src/app.ts`
- Modify: `apps/control/src/config.ts`
- Modify: `apps/control/src/config.test.ts`
- Modify: `apps/control/src/server.ts`
- Modify: `apps/control/src/articles/publication-build.ts`
- Modify: `apps/control/src/articles/publication-build.test.ts`
- Modify: `apps/control/src/articles/publication-release.ts`
- Modify: `apps/control/src/articles/publication-release.test.ts`
- Modify: `.env.example`
- Modify: `ops/config/runtime.env.template`
- Modify: `ops/lib/runtime-config.mjs`
- Modify: `ops/tests/runtime-launch.test.mjs`

**Interfaces:**

- Consumes:
  `POST /api/v1/analytics/page-views`,
  `OPTIONS /api/v1/analytics/page-views`,
  exact public client origins
- Produces: accepted page view `204`, aggregate DB update

- [ ] **Step 1: configuration test 작성**

```text
ANALYTICS_ENABLED=false
ANALYTICS_RETENTION_DAYS=180
PUBLIC_ANALYTICS_ENABLED=false
# ANALYTICS_ENABLED_ORIGINS=["https://www.jihye-office.kr"]
```

Parsing rules:

```text
- Control enabled는 exact "true" 또는 "false"; 미설정 default false
- retention은 safe integer 30~400; 미설정 default 180
- enabled origins는 중복 없는 exact HTTPS origin 목록을 JSON array로
  parsing하며 미설정 default `[]`; `FORM_ALLOWED_ORIGINS`의 subset만 허용
- Astro public client flag는 BaseLayout build 단계에서 exact "true"일 때만
  tracker가 request를 보냄
- production secret을 새로 추가하지 않고 CONTROL_HMAC_SECRET에서
  analytics purpose key를 파생
```

- [ ] **Step 2: route test 작성**

Required cases:

```text
- allowed exact Origin POST → 204
- allowed preflight → 204 + ACAO + Vary: Origin
- disallowed/null Origin → 403, ACAO 없음
- accepted request의 `sourceOrigin`은 validated Origin과 정확히 일치
- allowed지만 enabledOrigins 밖 origin → 204, write 없음
- Content-Type != application/json → 415
- body > 1 KiB → 413
- extra field/query/hash/unknown route → 422
- Sec-GPC: 1 또는 DNT: 1 → 204, write 없음
- known bot/headless UA → 204, write 없음
- active article exact route → 204
- withdrawal/admin/API route → 422
- rate limit → 429 + bounded Retry-After
```

- [ ] **Step 3: public route contract 구현**

Request:

```http
POST /api/v1/analytics/page-views
Origin: https://www.jihye-office.kr
Content-Type: application/json

{"schemaVersion":1,"path":"/services/procurement"}
```

Accepted response:

```http
HTTP/1.1 204 No Content
Cache-Control: no-store
Access-Control-Allow-Origin: https://www.jihye-office.kr
Vary: Origin
```

Preflight:

```http
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 600
```

`Access-Control-Allow-Credentials`와 wildcard는 추가하지 않습니다.
검증된 `Origin`은 request body보다 먼저 exact allowlist와 대조하고,
일치한 canonical string만 `RecordAnalyticsPageViewInput.sourceOrigin`으로
전달합니다. body에 `sourceOrigin`을 추가한 요청은 strict schema에서
거부합니다.

- [ ] **Step 4: host/origin migration dependency 반영**

현재 same-origin Astro에서는 existing public origin을 사용합니다. Sites
cross-origin 전환 전에는
[`04-implementation-plan.md`](04-implementation-plan.md) Task 6의
`SITE_ORIGIN`, `API_ORIGIN`, exact public client origin과 host routing 분리가
먼저 완료돼야 합니다.

`apps/control/src/app.ts`에서 `/api/v1/analytics/page-views`는 public API host에
한정하고 admin host에서는 404를 반환합니다.
API host route allowlist에는 collector의 `POST`와 해당 `OPTIONS`를
`consent-documents`, `consultations`, health 경로와 함께 명시합니다.

- [ ] **Step 5: server dependency wiring**

`createControlApp`에 다음 값만 전달합니다.

```ts
analytics: {
  enabled: runtime.config.analytics.enabled,
  enabledOrigins: runtime.config.analytics.enabledOrigins,
  retentionDays: runtime.config.analytics.retentionDays,
}
```

Origin allowlist와 `keyProvider`, `peerAddress`, `now`는 기존 Control
dependency를 재사용합니다.

Control 시작 시 global enable과 `enabledOrigins`를
`analytics_collection_intervals`에 reconcile합니다. 새 enabled origin은
interval을 열고, disabled/제거된 origin은 현재 시각에 interval을 닫습니다.
이 기록으로 관리자 화면이 진짜 0과 수집되지 않은 기간을 구분합니다.
reconcile 실패 시 collector는 fail-closed하며 consultation/admin 기능까지
활성화된 것으로 오인하지 않습니다.

- [ ] **Step 6: Astro build-time flag 전달**

strict runtime allowlist에 `PUBLIC_ANALYTICS_ENABLED`를 추가하되 exact
`true|false`만 허용합니다. `PublicationReleaseConfig`와
`runPublicationBuild` input을 통해 격리된 production build environment에
정확히 전달합니다.

```ts
env: {
  CI: "1",
  HOME: buildHome,
  NODE_ENV: "production",
  PUBLIC_ORIGIN: publicOrigin,
  PUBLIC_ANALYTICS_ENABLED: input.publicAnalyticsEnabled ? "true" : "false",
}
```

미설정은 false이고 host environment의 동명 변수를 상속하지 않습니다.
config/parser, publication build와 release test에서 false 기본값과 true 전달을
고정합니다.

- [ ] **Step 7: targeted tests를 승인 후 실행**

```bash
npm run test --workspace @wisdom/control -- \
  src/config.test.ts \
  src/analytics/routes.test.ts \
  src/app.test.ts \
  src/articles/publication-build.test.ts \
  src/articles/publication-release.test.ts
node --test ops/tests/runtime-launch.test.mjs
```

Expected: PASS, CORS는 요청 exact Origin만 반사하고 visitor credential을
허용하지 않습니다.

- [ ] **Step 8: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/control/src/analytics/routes.ts \
  apps/control/src/analytics/routes.test.ts \
  apps/control/src/app.ts \
  apps/control/src/config.ts \
  apps/control/src/config.test.ts \
  apps/control/src/server.ts \
  apps/control/src/articles/publication-build.ts \
  apps/control/src/articles/publication-build.test.ts \
  apps/control/src/articles/publication-release.ts \
  apps/control/src/articles/publication-release.test.ts \
  .env.example \
  ops/config/runtime.env.template \
  ops/lib/runtime-config.mjs \
  ops/tests/runtime-launch.test.mjs
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: expose first-party analytics collector"
```

---

### Task 5: 현재 Astro 포털 tracker

**Files:**

- Create: `apps/site/src/lib/analytics-client.ts`
- Create: `apps/site/src/lib/analytics-client.test.ts`
- Modify: `apps/site/src/layouts/BaseLayout.astro`

**Interfaces:**

- Consumes:
  browser `location.pathname`,
  `/api/v1/analytics/page-views`
- Produces: 한 document load당 최대 한 번의 best-effort page-view request

- [ ] **Step 1: pure client test 작성**

```ts
it("sends pathname only and never retries", async () => {
  const calls: Array<[string, RequestInit]> = [];
  await sendPageView({
    endpoint: "/api/v1/analytics/page-views",
    pathname: "/services/procurement",
    fetchRef: async (input, init) => {
      calls.push([String(input), init ?? {}]);
      return new Response(null, { status: 204 });
    },
    navigatorState: { doNotTrack: "0", globalPrivacyControl: false },
  });
  expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
    schemaVersion: 1,
    path: "/services/procurement",
  });
});
```

Additional cases:

```text
- DNT/GPC true: fetch 0회
- pathname에서 query/hash를 읽지 않음
- rejected fetch: 사용자 UI와 navigation에 영향 없음
- credentials omit, referrerPolicy no-referrer, keepalive true
```

- [ ] **Step 2: client 구현**

```ts
export async function sendPageView(input: {
  endpoint: string;
  pathname: string;
  fetchRef?: typeof fetch;
  navigatorState?: {
    doNotTrack: string | null;
    globalPrivacyControl: boolean;
  };
}): Promise<void>;
```

Fetch options:

```ts
{
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "omit",
  referrerPolicy: "no-referrer",
  keepalive: true,
  body: JSON.stringify({ schemaVersion: 1, path: input.pathname }),
}
```

response body를 읽거나 retry하지 않습니다.

- [ ] **Step 3: BaseLayout에 한 번 mount**

`PUBLIC_ANALYTICS_ENABLED === "true"`이고
`route !== "/404" && route !== "/marketing/withdraw"`인 정식 public
page에서만 기존 reveal/form 초기화 script에 다음 호출을 추가합니다.

```ts
void sendPageView({
  endpoint: "/api/v1/analytics/page-views",
  pathname: window.location.pathname,
});
```

현재 Astro rollback은 same-origin endpoint를 유지하므로 public CSP의
`connect-src 'self'`와 양립합니다.

- [ ] **Step 4: targeted tests를 승인 후 실행**

```bash
npm run test --workspace @wisdom/site -- src/lib/analytics-client.test.ts
```

Expected: PASS, request body는 `schemaVersion`과 `path` 두 field뿐입니다.

- [ ] **Step 5: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/site/src/lib/analytics-client.ts \
  apps/site/src/lib/analytics-client.test.ts \
  apps/site/src/layouts/BaseLayout.astro
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: collect aggregate portal page views"
```

---

### Task 6: report read model과 authenticated admin API

**Files:**

- Create: `apps/control/src/analytics/reporting.ts`
- Create: `apps/control/src/analytics/reporting.test.ts`
- Modify: `apps/control/src/admin/api.ts`
- Modify: `apps/control/src/admin/types.ts`
- Modify: `apps/control/src/admin/admin-http.test.ts`
- Modify: `apps/control/src/app.ts`
- Modify: `packages/shared/src/analytics.ts`

**Interfaces:**

- Consumes:
  `GET /admin/api/v1/analytics/overview`,
  KST date range, granularity와 source origin
- Produces:
  `parseAnalyticsReportQuery(input, options)`,
  `buildAnalyticsOverview(db, query, nowMs)`,
  `AdminAnalyticsOverviewDto`

- [ ] **Step 1: range parser test 작성**

Supported query:

```text
from=2026-07-01
to=2026-07-24
granularity=day
sourceOrigin=all
```

Rules:

```text
- timezone은 Asia/Seoul 고정
- from/to는 실제 존재하는 YYYY-MM-DD
- inclusive range 1~ANALYTICS_RETENTION_DAYS
- hour는 최대 14일이며 전체 `[from,to]`가 `nowMs` 기준 31일 hour 보존
  범위 안이어야 함
- day/week/month는 retention 범위까지
- week 시작은 월요일
- 누락 시 최근 28일 + day
- sourceOrigin 누락 시 `all`; 그 외에는 current/historical available exact
  source origin만 허용
- invalid input을 조용히 보정하지 않고 400 INVALID_REQUEST
```

- [ ] **Step 2: aggregate report test 작성**

Fixtures:

```text
- 2개 day register sketch를 merge하면 기간 visitor 중복 제거
- hour/day/week/month bucket 경계가 KST와 일치
- page-view total과 인기 페이지 상위 10개
- 인기 페이지 동률은 path ASC
- exact source filter는 해당 origin row만 사용
- source `all`은 origin별 register sketch를 함께 merge해 origin 간 방문
  중복을 근사 제거
- collection interval 전체 포함 → coverage complete와 traffic 0 구분
- 일부/전혀 포함되지 않음 → partial/none
- unique key reset 경계 또는 sketch saturation → unique 값 null과 품질 flag
- 선택 기간 상담 수는 consultations.received_at_ms로만 계산
- PII column은 SELECT하지 않음
- unique 0이면 ratio와 conversion은 null
- 직전 동일 기간이 retention 밖이면 comparison.available=false
```

- [ ] **Step 3: read model interface 구현**

```ts
export interface AnalyticsReportQuery {
  from: string;
  to: string;
  granularity: "hour" | "day" | "week" | "month";
  sourceOrigin: "all" | string;
}

export function parseAnalyticsReportQuery(
  input: {
    from: string | undefined;
    to: string | undefined;
    granularity: string | undefined;
    sourceOrigin: string | undefined;
  },
  options: {
    nowMs: number;
    retentionDays: number;
    availableSourceOrigins: readonly string[];
  },
):
  | { success: true; data: AnalyticsReportQuery }
  | { success: false };

export function buildAnalyticsOverview(
  db: ControlDatabase,
  query: AnalyticsReportQuery,
  nowMs: number,
): AdminAnalyticsOverviewDto;
```

계산:

```text
- total pageViews: day rows sum
- total estimated unique: 선택 source의 daily register sketch 전체 merge 후 estimate
- series pageViews: 선택 granularity로 sum
- series unique: 선택 source의 hour register 또는 daily register group을 merge
  후 estimate
- popularPages: 선택 source의 day rows GROUP BY path, locale
  ORDER BY count DESC, path ASC
- `sourceOrigin=all`이면 source 차원을 합산하고 register는 source 간에도 merge
- consultations: received_at_ms의 동일 KST half-open interval count
- consultation에는 analytics source attribution을 추가하지 않으므로
  consultations는 항상 전체 portal origin 범위
- `sourceOrigin !== "all"`이면 approximate consultation conversion은 null
- comparison: 직전 동일 길이 기간
- 직전 값이 0이면 change percent는 `null`; 0을 무한대나 0%로 표현하지 않음
- collection interval로 선택/비교 기간 coverage를 계산하며 어느 기간이든
  complete가 아니면 comparison.available=false
- key reset 경계를 포함하거나 sketch 품질이 saturated면 unique와 그 파생
  ratio/conversion은 null
```

- [ ] **Step 4: admin route registration**

`apps/control/src/admin/api.ts`에는 인증과 envelope만 둡니다. 집계 SQL은 넣지
않습니다.

```ts
app.get("/admin/api/v1/analytics/overview", (context) => {
  const session = requireSession(context, dependencies);
  if (session instanceof Response) return session;
  const parsed = parseAnalyticsReportQuery(
    {
      from: context.req.query("from"),
      to: context.req.query("to"),
      granularity: context.req.query("granularity"),
      sourceOrigin: context.req.query("sourceOrigin"),
    },
    {
      nowMs: dependencies.now(),
      retentionDays: dependencies.analytics.retentionDays,
      availableSourceOrigins: listAnalyticsSourceOrigins(
        dependencies.db,
        dependencies.analytics.allowedSourceOrigins,
      ),
    },
  );
  if (!parsed.success) {
    return failure(
      context,
      400,
      "INVALID_REQUEST",
      "분석 기간과 집계 단위를 확인하세요.",
    );
  }
  return success(
    context,
    buildAnalyticsOverview(dependencies.db, parsed.data, dependencies.now()),
  );
});
```

`apps/control/src/admin/types.ts`의 `AdminRouteDependencies`에는 다음 required
설정을 추가하고, `apps/control/src/app.ts`가 normalized runtime config와 exact
allowed origin을 전달합니다.

```ts
analytics: {
  retentionDays: number;
  allowedSourceOrigins: readonly string[];
}
```

`listAnalyticsSourceOrigins`는 현재 configured origin과 collection interval의
historical origin union만 반환합니다. 따라서 CORS에서 제거된 이전 generated
origin도 과거 report filter로는 남지만 임의 관리자 query 값은 허용되지
않습니다.

기존 global middleware의 `Cache-Control: no-store`를 유지합니다.

- [ ] **Step 5: HTTP test 작성**

```text
- session 없음 → 401 AUTH_REQUIRED
- valid session → success envelope
- invalid/leap-date/range/granularity → 400
- allowlist 밖 sourceOrigin → 400
- response에 visitor hash, register sketch, IP, UA, PII field 없음
- admin host에서만 route 사용 가능
```

- [ ] **Step 6: targeted tests를 승인 후 실행**

```bash
npm run build:shared
npm run test --workspace @wisdom/control -- \
  src/analytics/reporting.test.ts \
  src/admin/admin-http.test.ts
```

Expected: PASS, response는 `AdminAnalyticsOverviewDto` aggregate field만
포함합니다.

- [ ] **Step 7: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add packages/shared/src/analytics.ts \
  apps/control/src/analytics/reporting.ts \
  apps/control/src/analytics/reporting.test.ts \
  apps/control/src/admin/api.ts \
  apps/control/src/admin/types.ts \
  apps/control/src/admin/admin-http.test.ts \
  apps/control/src/app.ts
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: report aggregate portal performance"
```

---

### Task 7: React 관리자 성과 분석 화면

**Files:**

- Create: `apps/admin/src/features/analytics/AnalyticsPage.tsx`
- Create: `apps/admin/src/features/analytics/AnalyticsTrendChart.tsx`
- Create: `apps/admin/src/features/analytics/date-range.ts`
- Create: `apps/admin/src/features/analytics/date-range.test.ts`
- Modify: `apps/admin/src/app/router.tsx`
- Modify: `apps/admin/src/components/AppShell.tsx`
- Modify: `apps/admin/src/styles.css`
- Modify: `apps/admin/tests/server.mjs`
- Modify: `apps/admin/tests/admin.spec.ts`

**Interfaces:**

- Consumes:
  `useResource<AdminAnalyticsOverviewDto>(
  "/analytics/overview?from=2026-07-01&to=2026-07-24&granularity=day&sourceOrigin=all")`
- Produces: `/admin/analytics`

- [ ] **Step 1: URL date filter test 작성**

Presets:

```text
최근 7일
최근 28일
최근 90일
사용자 지정
```

Granularity:

```text
시간
일
주
월
```

`from`, `to`, `granularity`, `sourceOrigin`은 URL search parameter로
유지합니다. source 선택은 `전체`와 API가 반환한 exact current/historical
origin만 제공합니다. 최근 7일은 오늘을 포함한 KST 7개 calendar date입니다.

- [ ] **Step 2: router와 navigation 추가**

`apps/admin/src/app/router.tsx`:

```tsx
if (pathname === "/analytics") return "성과 분석";

<Route path="analytics" element={<AnalyticsPage />} />
```

`apps/admin/src/components/AppShell.tsx`:

```tsx
["/analytics", "성과 분석", false]
```

기존 root 대시보드는 상담 운영 overview로 유지합니다.

- [ ] **Step 3: 화면 상태와 KPI 구현**

Page header:

```text
eyebrow: PERFORMANCE
title: 성과 분석
description: 공개 포털의 방문 흐름과 상담 접수 변화를 확인합니다.
```

KPI cards:

```text
추정 순 방문자
페이지 조회
페이지 조회/방문자
상담 접수
대략적 상담 전환율
```

각 card는 현재 값, 직전 동일 기간 증감 또는 비교 불가 상태를 함께
표시합니다. `0`은 정상 값으로 표시하고 data 없음과 구분합니다.

`collectionCoverage.state`가 `complete`일 때만 page view `0`을
`방문 없음`으로 표시합니다. `partial`은 수집 일부 기간, `none`은 수집되지
않음으로 표시합니다. `uniqueEstimateQuality`가 `saturated`,
`key-reset-boundary` 또는 `not-collected`면 추정 순 방문자와 그 파생
ratio를 숫자 0으로 대체하지 않고 이유를 표시합니다.
source가 `all`이 아니면 상담 접수는 `전체 포털 기준`으로 표시하고 대략적
상담 전환율은 `source별 attribution 없음`으로 비활성화합니다.

- [ ] **Step 4: dependency 없는 accessible chart 구현**

```tsx
export interface AnalyticsTrendChartProps {
  points: AdminAnalyticsOverviewDto["series"];
}
```

구현 조건:

```text
- native SVG만 사용
- page views와 estimated uniques는 서로 다른 두 panel로 표시
- SVG에 title/desc와 aria-labelledby 제공
- 같은 수치를 가진 semantic table을 함께 제공
- empty series는 Empty component 사용
- reduced motion에서 animation 없음
- 320px에서 horizontal clipping 없이 table scroll
```

- [ ] **Step 5: 인기 페이지와 방법론 panel**

인기 페이지 table:

```text
순위 | 페이지 경로 | 언어 | 페이지 조회 | 비중
```

Methodology copy:

```text
추정 순 방문자는 쿠키 없이 집계한 근사값입니다. 네트워크 변경, 공용
네트워크와 자동화 트래픽 필터에 따라 실제 사람 수와 차이가 날 수 있습니다.
상담 전환율은 개인 방문과 상담을 연결하지 않은 기간 합계 참고값입니다.
```

- [ ] **Step 6: partial/async 상태 구현**

```text
- loading: 기존 Loading
- query/API 실패: ErrorMessage + "다시 시도"로 resource.reload()
- traffic 0, consultation >0 또는 반대 조합을 각각 정상 표시
- popularPages empty: 해당 panel만 Empty
- comparison unavailable: "비교 기간 데이터 없음"
- collection partial/none: "일부 기간 수집"/"수집되지 않음"
- key reset/saturated: unique 지표 unavailable 이유 표시
- stale response: 기존 useResource AbortController 동작 재사용
```

- [ ] **Step 7: E2E fixture와 test 추가**

Test names:

```text
shows aggregate analytics without exposing visitor identifiers
keeps date filters in the administrator URL
renders empty and partial analytics states
recovers the analytics report after a failed request
```

- [ ] **Step 8: targeted tests를 승인 후 실행**

```bash
npm exec --workspace @wisdom/admin -- \
  vitest run src/features/analytics/date-range.test.ts
npm run typecheck --workspace @wisdom/admin
npm exec --workspace @wisdom/admin -- \
  playwright test --grep "analytics"
```

Expected: PASS, 신규 chart dependency가 `apps/admin/package.json`에 추가되지
않습니다.

- [ ] **Step 9: 별도 요청 시 task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/admin/src/features/analytics \
  apps/admin/src/app/router.tsx \
  apps/admin/src/components/AppShell.tsx \
  apps/admin/src/styles.css \
  apps/admin/tests/server.mjs \
  apps/admin/tests/admin.spec.ts
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: add administrator performance analytics"
```

---

### Task 8: standalone Sites tracker 이식

**Files:**

- Create: `<SITES_ROOT>/lib/analytics/client.ts`
- Create:
  `<SITES_ROOT>/components/analytics/PageViewTracker.tsx`
- Modify: `<SITES_ROOT>/app/layout.tsx`
- Modify: `<SITES_ROOT>/worker/index.ts`
- Modify: `<SITES_ROOT>/.env.example`

**Interfaces:**

- Consumes:
  existing public `PUBLIC_CONSULTATION_API_ORIGIN`,
  `usePathname()`
- Produces:
  client navigation마다 normalized pathname page view

이 task는 standalone root 생성과 코드 쓰기를 별도 승인받은 뒤에만
실행합니다.

- [ ] **Step 1: Astro client와 동일한 wire contract 복사**

standalone source는 `@wisdom/shared`를 import하지 않습니다. 다음 body만
provenance와 함께 복사합니다.

```ts
type AnalyticsPageViewV1 = {
  schemaVersion: 1;
  path: string;
};
```

같은 파일에 static route와 article slug grammar만 허용하고 404, withdrawal,
machine route를 제외하는 `isTrackablePublicPath(pathname)`을 복사합니다.
Control의 active release 검사가 최종 authority입니다.

- [ ] **Step 2: client component 작성**

```tsx
"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import {
  isTrackablePublicPath,
  sendPageView,
} from "../../lib/analytics/client";

export function PageViewTracker({ apiOrigin }: { apiOrigin: string }) {
  const pathname = usePathname();
  const previous = useRef<string>();
  useEffect(() => {
    if (
      !pathname ||
      !isTrackablePublicPath(pathname) ||
      previous.current === pathname
    ) return;
    previous.current = pathname;
    void sendPageView({
      endpoint: new URL(
        "/api/v1/analytics/page-views",
        apiOrigin,
      ).toString(),
      pathname,
    });
  }, [apiOrigin, pathname]);
  return null;
}
```

query와 hash change만으로 event를 만들지 않습니다.

- [ ] **Step 3: public configuration과 CSP**

`.env.example`:

```text
PUBLIC_CONSULTATION_API_ORIGIN=https://api.jihye-office.kr
ANALYTICS_ENABLED=false
```

`app/layout.tsx`는 server 단계에서 exact HTTPS origin을 검증하고
`ANALYTICS_ENABLED`가 exact `"true"`일 때만 `PageViewTracker`를 mount합니다.
component에는 기존 consultation과 같은 API origin만 전달합니다.
consultation과 analytics가 모두 같은 Control public API host를 사용한다는
invariant를 유지하며 별도 `ANALYTICS_API_ORIGIN`을 만들지 않습니다.
`worker/index.ts` CSP의 기존 `connect-src 'self'`와 consultation API source를
보존·병합·dedupe하며 다른 source를 추가하지 않습니다.

- [ ] **Step 4: deployed release identity gate**

article route는 Control의 active release exact route가 아니면 422이므로
Analytics를 켜기 전에 다음 equality를 확인합니다.

```text
deployed Sites version의 imported release identity
  == Control active release identity
```

Sites version rollback 시에도 먼저 대응 Control release를 active authority로
정렬하고 article synthetic check를 통과한 뒤 analytics client를 다시
활성화합니다. generated/custom-domain CORS 변경은 이 코드 task가 아니라
Task 10의 별도 운영 gate에서 수행합니다.

- [ ] **Step 5: Sites verification 후보를 승인 후 실행**

```bash
npm run typecheck
npm run build
```

Expected: Sites Worker-compatible build가 성공하고 D1/R2 binding은 계속
`null`입니다.

- [ ] **Step 6: 별도 요청 시 standalone commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_sites_portal add lib/analytics/client.ts \
  components/analytics/PageViewTracker.tsx \
  app/layout.tsx \
  worker/index.ts \
  .env.example
git -C /Users/wisdom/wisdom_project/gpt/wisdom_sites_portal commit -m "feat: send first-party aggregate page views"
```

---

### Task 9: analytics retention과 운영 문서

**Files:**

- Create: `apps/control/src/analytics/retention.ts`
- Create: `apps/control/src/analytics/retention.test.ts`
- Modify: `apps/control/src/retention/purge.ts`
- Modify: `apps/control/src/retention/purge.test.ts`
- Modify: `apps/control/src/cli/purge.ts`
- Modify: `ops/lib/restore.mjs`
- Modify: `ops/scripts/restore.mjs`
- Modify: `ops/tests/backup-restore.test.mjs`
- Create: `docs/operations/first-party-analytics.md`
- Create in `<CURRENT_ROOT>`:
  `docs/gpt-sites-migration/08-kpi-review-log.md`

**Interfaces:**

- Consumes: aggregate `expires_at_ms`, existing `retention:purge`
- Produces: bounded cleanup result와 운영 KPI 기록 양식

- [ ] **Step 1: independent bounded purge test 작성**

Analytics 만료 삭제는 due consultation이 0건이어도 실행돼야 합니다.

```ts
export interface AnalyticsPurgeResult {
  pageViewRowsDeleted: number;
  uniqueSketchRowsDeleted: number;
  rateBucketRowsDeleted: number;
  complete: boolean;
}
```

각 table은 한 실행에서 최대 5,000행을 `rowid`가 아닌 primary key subquery로
삭제합니다. 남은 만료 행이 있으면 `complete=false`입니다.

day row 만료 조건은 저장 당시 `expires_at_ms`만 신뢰하지 않고 현재
`ANALYTICS_RETENTION_DAYS`로 계산한 `bucket_start_ms + retention`과 저장된
expiry 중 이른 시각을 사용합니다. 따라서 180일에서 30일로 줄이면 기존
row도 다음 purge부터 30일 정책을 따릅니다. hour는 항상 31일, global rate
counter는 최대 25시간입니다. `analytics_state`와 collection interval은
개인 traffic row가 아닌 coverage 운영 metadata이므로 이 purge 대상이
아닙니다.

- [ ] **Step 2: existing retention flow에 결합**

Consultation PII purge transaction과 analytics aggregate purge는 서로 다른
bounded transaction으로 실행합니다. analytics purge 실패가 이미 완료된 PII
purge를 rollback한 것처럼 보고하지 않습니다.

CLI JSON 결과에 다음 field를 추가합니다.

```json
{
  "analytics": {
    "pageViewRowsDeleted": 0,
    "uniqueSketchRowsDeleted": 0,
    "rateBucketRowsDeleted": 0,
    "complete": true
  }
}
```

- [ ] **Step 3: restore-before-replace retention 결합**

`ops/scripts/restore.mjs`는 운영 승인된
`--analytics-retention-days <30..400>`를 required input으로 받고
`createSqliteAdapter`에 전달합니다. restore adapter는 staged DB를 교체하기
전에 consultation PII와 analytics current-policy 만료분을 모두
secure-delete하고, bounded maximum을 초과하면 교체하지 않고 fail-closed
합니다.

```text
- expired pageview/sketch/global-rate row가 replacement 뒤 되살아나지 않음
- current 30일 정책이 과거 180일 expires_at보다 우선
- restore 결과에 consultation/analytics 삭제 수를 분리 기록
- retention input 누락·범위 밖이면 target DB를 건드리지 않음
```

- [ ] **Step 4: 운영 문서 작성**

`docs/operations/first-party-analytics.md`에 다음을 고정합니다.

```text
- metric 정의와 "추정" 문구
- 수집 payload와 비수집 항목
- request 처리 중 IP와 coarse User-Agent family를 일시 처리하지만 원본,
  visitor digest와 rate subject digest를 보관하지 않는다는 사실
- client rate control은 bounded in-memory counter sketch이고 DB에는 global
  aggregate counter만 있다는 사실
- 31일/180일 보존
- GPC/DNT와 bot filter
- enable/disable 절차
- Sites built-in Analytics와 수치가 다른 이유
- incident 시 ANALYTICS_ENABLED=false 후 collector 204/no-write
- 개별 visitor 조회와 상담 연결 기능이 존재하지 않음
- CONTROL_HMAC_SECRET rotation 전 analytics:key-reset 별도 승인 절차
```

- [ ] **Step 5: 개인정보 처리방침 release gate**

정식 개인정보 문서는 fixture나 source file을 직접 덮어쓰지 않습니다. 기존
consent publication workflow에서 법률 검토된 새 privacy document를 승인하고
Sites release ceremony로 공개한 뒤 production analytics를 활성화합니다.

- [ ] **Step 6: targeted retention tests를 승인 후 실행**

```bash
npm run test --workspace @wisdom/control -- \
  src/analytics/retention.test.ts \
  src/retention/purge.test.ts
node --test ops/tests/backup-restore.test.mjs
```

Expected: PASS, consultation이 없어도 analytics expiry가 bounded 삭제됩니다.

- [ ] **Step 7: 별도 요청 시 current-service task commit**

```bash
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes add apps/control/src/analytics/retention.ts \
  apps/control/src/analytics/retention.test.ts \
  apps/control/src/retention/purge.ts \
  apps/control/src/retention/purge.test.ts \
  apps/control/src/cli/purge.ts \
  ops/lib/restore.mjs \
  ops/scripts/restore.mjs \
  ops/tests/backup-restore.test.mjs \
  docs/operations/first-party-analytics.md
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes commit -m "feat: operate aggregate analytics retention"
```

`<CURRENT_ROOT>/docs/gpt-sites-migration/08-kpi-review-log.md` 생성과 commit은
위 `<REACT_ROOT>` commit에 섞지 않고 별도 사용자 요청으로 처리합니다.

---

### Task 10: 분리 승인된 검증·배포·활성화

**Files:** 없음

**Interfaces:**

- Consumes: Task 1~9, Task 2B와
  [`04-implementation-plan.md`](04-implementation-plan.md)의 migration
  release 결과
- Produces: 승인된 환경에서만 활성화된 자체 Analytics

- [ ] **Task 10A: local targeted verification 별도 승인**

`<REACT_ROOT>` 후보:

```bash
npm run build:shared
npm run test --workspace @wisdom/shared -- src/analytics.test.ts
npm run test --workspace @wisdom/control -- \
  src/analytics \
  src/db/database.test.ts \
  src/admin/admin-http.test.ts \
  src/config.test.ts
npm run test --workspace @wisdom/site -- src/lib/analytics-client.test.ts
npm exec --workspace @wisdom/admin -- \
  vitest run src/features/analytics/date-range.test.ts
npm run typecheck --workspace @wisdom/control
npm run typecheck --workspace @wisdom/admin
```

이 명령은 계획 작성이나 코드 구현 승인만으로 실행하지 않습니다.

- [ ] **Task 10B: browser verification 별도 승인**

승인 시 확인:

```text
- /admin/analytics 320px와 1440px
- keyboard focus와 filter URL state
- SVG title/description과 numeric table
- loading/error/empty/partial state
- Astro/Sites navigation당 request 1회
- query, referrer와 상담 PII가 request에 없음
```

- [ ] **Task 10C: v7 maintenance와 false-flag Control 배포 별도 승인**

```text
1. Task 2B의 v6→v7 maintenance ceremony와 v6 rollback retirement
2. Control `ANALYTICS_ENABLED=false`
3. `ANALYTICS_ENABLED_ORIGINS=[]`
4. current Astro `PUBLIC_ANALYTICS_ENABLED=false`
5. v7 Control code/schema를 배포하고 consultation/admin readiness 확인
```

schema migration, 서비스 중지, backup, release retirement와 배포는 각각
읽기 전용 검증이나 코드 구현 승인에 포함되지 않습니다.

- [ ] **Task 10D: owner-only Sites 준비 별도 승인**

사전 조건:

```text
- 04 Task 11: Site binding과 production env
- 04 Task 12: exact source/version 저장
- 04 Task 13: owner-only production deployment
- deployed Sites imported release identity == Control active release identity
- 법률 검토된 privacy document가 승인된 Sites release로 공개됨
```

운영 변경을 다음 순서로 각각 기록합니다.

```text
1. generated Sites exact origin을 FORM_ALLOWED_ORIGINS에 추가
2. Control은 ANALYTICS_ENABLED=true,
   ANALYTICS_ENABLED_ORIGINS=[generated Sites origin]으로 재시작
3. Astro PUBLIC_ANALYTICS_ENABLED=false 유지
4. Sites PUBLIC_CONSULTATION_API_ORIGIN은 기존 Control API origin 유지
5. Sites ANALYTICS_ENABLED=true env revision으로 새 version 저장·배포
```

Task 8 코드 구현에는 위 CORS/runtime/env/version/deployment mutation이
포함되지 않습니다. 모든 Sites deployment는 production이므로 owner-only도
production 변경으로 취급합니다.

- [ ] **Task 10E: owner-only synthetic production check 별도 승인**

generated source filter와 한 exact public route의 현재 page-view 값을 먼저
기록하고, 그 route를 한 번 연 뒤 같은 source/route의 delta가 `+1`인지
확인합니다. 전체 `pageViews=1`을 기대하지 않습니다. article도 검증할 경우
deployed/active release identity equality와 exact article route 204를 함께
확인합니다.

승인 범위 안에서 다음도 확인합니다.

```text
- payload가 schemaVersion/path뿐임
- source_origin은 client body가 아니라 validated Origin에서 결정됨
- DB/log/response에 raw IP, UA와 visitor/rate subject digest가 없음
- 다른 Astro source row가 owner-only validation에 섞이지 않음
- collection coverage가 generated origin부터 열림
```

- [ ] **Task 10F: public cutover activation 별도 승인**

`04-implementation-plan.md` Task 14 custom-domain/API 준비와 Task 15 release
ceremony가 완료된 뒤에만 실행합니다.

```text
1. final `www` exact origin을 FORM_ALLOWED_ORIGINS에 추가
2. deployed Sites release identity와 Control active release 재확인
3. ANALYTICS_ENABLED_ORIGINS에 final `www`를 추가
4. public Sites version에서 ANALYTICS_ENABLED=true 유지
5. final source/route before→after delta check
6. generated origin 제거와 interval 종료는 별도 승인
```

Sites version rollback은 대응 Control release authority를 먼저 정렬하고
article synthetic check를 통과하기 전까지 해당 source analytics client를
false로 둡니다.

- [ ] **Task 10G: public baseline 기록 별도 승인**

최초 7일 뒤
`<CURRENT_ROOT>/docs/gpt-sites-migration/08-kpi-review-log.md`에 다음
aggregate만 기록합니다.

```text
기간, granularity, source origin, coverage, 추정 순 방문자, 페이지 조회, 인기 페이지,
상담 접수, 대략적 상담 전환율, Sites 내장 Analytics 비교 메모
```

- [ ] **Task 10H: full verification·commit·push 별도 승인**

```bash
npm run verify
git -C /Users/wisdom/wisdom_project/gpt/wisdom_web_portal/.worktrees/code-review-fixes status --short
```

full verification 뒤의 commit과 push는 사용자가 각각 명령한 경우에만
수행합니다.

---

## dependency 순서

```text
Task 0 correct React branch
  → Task 1 contracts/routes
  → Task 2 schema
      └─→ Task 2B maintenance tooling
  → Task 3 aggregate collector/rate state
  → Task 4 Control API/CORS
      ├─→ Task 5 current Astro tracker
      ├─→ Task 6 admin report API
      │    → Task 7 React analytics UI
      └─→ migration Task 6 origin split
            → Task 8 standalone Sites tracker
  → Task 9 retention/privacy operations
  → Task 10A/B local and browser verification
  → Task 10C v7 maintenance + false-flag Control deploy
  → migration Tasks 11~13 owner-only Sites deploy
  → Task 10D CORS/runtime/Sites activation
  → Task 10E owner-only production check
  → migration Tasks 14~15 public cutover
  → Task 10F public activation
  → Task 10G/H baseline/full verification/commit/push
```

## 완료 기준

1. 신규 analytics/차트 npm dependency가 없습니다.
2. page-view payload는 `schemaVersion`과 normalized `path`만 포함합니다.
3. raw event, raw IP, raw UA, referrer, query, visitor ID와 장기 visitor hash가
   DB에 없습니다.
4. DB의 client별 rate row가 없고 global rate row 수가 window 수로
   제한됩니다.
5. React 관리자에서 source, coverage, 추정 순 방문자, 페이지 조회, 추이,
   인기 페이지, 기간·단위와 상담 전환 참고값을 확인할 수 있습니다.
6. 수집 complete의 0과 partial/none, unique saturation/key reset 경계를
   구분합니다.
7. 순 방문자를 정확한 개인 수로 표현하지 않습니다.
8. GPC/DNT와 알려진 bot 요청은 집계하지 않습니다.
9. analytics retention이 consultation 존재 여부와 무관하게 실행되고,
   restore도 만료 aggregate를 되살리지 않습니다.
10. Sites 내장 Analytics는 외부 비교 기준이며 자동 import·scraping하지
   않습니다.
11. production 활성화, 테스트, 배포, commit과 push가 각각 사용자 승인
   경계를 지킵니다.
