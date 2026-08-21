# 현재 서비스 성과지표 기능 구현 계획

기준일: 2026-07-24  
문서 상태: 실행 전 계획 v2.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 공개 Astro 포털의 방문 흐름을 개인정보 최소화 방식으로
집계하고, `추정 순 방문자`, 페이지 조회, 방문 추이, 인기 페이지, 기간·집계
단위와 상담 전환 참고값을 현재 React 관리자에서 제공합니다.

**Architecture:** 현재 Astro 포털은 same-origin
`POST /api/v1/analytics/page-views`로 최소 payload를 Control에 보냅니다.
Control은 raw event나 장기 visitor identifier 대신 시간·일 단위 rollup과
병합 가능한 16 KiB register sketch를 SQLite에 저장합니다. 인증된 React
관리자는 aggregate reporting API만 사용합니다.

**Tech Stack:** 기존 Node.js 24, TypeScript 6, Hono, Zod, better-sqlite3,
Drizzle schema, Astro, React 19, Tailwind CSS 4, native SVG와 Web Fetch API를
그대로 사용합니다. 신규 npm dependency는 없습니다.

## Global Constraints

- 작업 root는
  `/Users/wisdom/wisdom_project/gpt/wisdom_web_portal` 하나입니다.
- 구현 기준은 `2026-07-21-codex-code-review-fixes` 또는 그 descendant
  branch입니다. `master`에서 작업하지 않습니다.
- 현재 서비스의 `apps/site`, `apps/control`, `apps/admin`,
  `packages/shared`, `ops`만 이 계획의 구현 범위입니다.
- GPT Sites source, generated URL, custom domain, Sites access·version·deploy,
  Sites 내장 Analytics는 이 계획의 범위가 아닙니다.
- 외부 analytics SDK, chart library와 신규 분석 package를 설치하지
  않습니다.
- cookie, localStorage, sessionStorage, client-generated visitor ID와
  fingerprint SDK를 사용하지 않습니다.
- analytics request body에는 `schemaVersion`과 normalized `path`만
  포함합니다.
- query, hash, referrer, page title, client timestamp, 이름, 전화, 이메일,
  상담 본문, 동의·철회 token을 수집하거나 저장하지 않습니다.
- raw page-view event, raw IP, raw User-Agent, visitor digest와 rate subject
  digest를 저장하지 않습니다.
- IP와 coarse User-Agent family는 request 처리 중 keyed digest 계산에만
  사용하고 register 또는 bounded counter 갱신 직후 폐기합니다.
- 순 방문자는 정확한 개인 수가 아니라 `추정 순 방문자`로 표시합니다.
- 상담 PII와 방문자를 개인 단위로 연결하지 않습니다.
- production은 Control과 Astro analytics flag를 모두 기본 `false`로
  배포하고 개인정보 처리방침 검토와 별도 활성화 승인 후에만 켭니다.
- 이 문서는 계획만 정의합니다. 코드 구현, 테스트, 브라우저 검증, schema
  migration, 배포, commit과 push는 각각 사용자의 별도 명령이 있을 때만
  실행합니다.

---

## 1. 범위와 비범위

### 구현 범위

- 현재 Astro 공개 포털의 document load page view
- Control same-origin collector
- KST hour/day page-view rollup
- cookie-less estimated unique register sketch
- 기간별 추이와 인기 페이지 reporting
- 같은 기간의 aggregate 상담 접수·전환 참고값
- React 관리자 `/admin/analytics`
- retention, backup/restore와 운영 runbook
- schema v8→v9 maintenance path

### 구현하지 않음

- 개인 visitor profile, session replay 또는 event timeline
- CTA click, scroll depth, form field interaction과 캠페인 attribution
- visitor별 상담 전환
- 제3자 analytics export/import
- Sites Analytics API 또는 화면 scraping
- Sites 전용 client adapter와 cross-origin CORS
- 성과지표를 근거로 한 자동 콘텐츠·UX 수정

---

## 2. 확정 설계

### 지표 정의

| 지표 | 정의 |
|---|---|
| 페이지 조회 | 현재 `PUBLIC_ORIGIN`의 검증된 공개 route에서 Control이 수락한 page-view 횟수 |
| 추정 순 방문자 | 서버 IP와 coarse User-Agent family의 keyed digest를 16 KiB register sketch에 반영한 cardinality 근사값 |
| 방문 추이 | KST 기준 hour/day/week/month 구간의 페이지 조회와 추정 순 방문자 |
| 인기 페이지 | 선택 기간 page-view 합계가 높은 normalized public path 상위 10개 |
| 페이지 조회/방문자 | `pageViews ÷ estimatedUniqueVisitors`; 분모가 0 또는 unavailable이면 `null` |
| 상담 접수 | 같은 KST 기간에 접수된 전체 consultation 수 |
| 상담 전환 참고값 | `consultations ÷ estimatedUniqueVisitors × 100`; 개인 attribution이 아닌 기간 aggregate |

### 데이터 흐름

```text
Current Astro public page
  → same-origin POST /api/v1/analytics/page-views
  → Control host/origin + body + route + privacy + bot + rate 검증
  → KST hour/day page-view rollup 증가
  → KST hour/day unique register 갱신
  → raw IP·UA·digest와 request body 폐기
  → authenticated GET /admin/api/v1/analytics/overview
  → current React /admin/analytics
```

### 보존정책

- hour page-view rollup과 unique sketch: 31일
- day page-view rollup과 unique sketch: 기본 180일
- day retention 설정 허용 범위: 30~400일
- global rate aggregate: 최대 25시간
- client rate counter: process memory에서 minute/day window 종료 시 초기화
- raw event table: 생성하지 않음
- collection interval과 analytics key state: 운영 coverage metadata로 유지

### 추정 순 방문자 방식

채택 방식은 신규 package 없는 native HLL-style register sketch입니다.

```text
visitor digest input
  = "wisdom:analytics-visitor:v1\0"
  + normalized client IP
  + "\0"
  + coarse browser family

register count = 2^14 = 16,384
storage        = 16,384 bytes per hour/day sketch
merge          = register별 max
```

- browser family는 `edge`, `chrome`, `firefox`, `safari`, `other`만
  사용합니다.
- digest는 register index/rank를 계산한 뒤 저장하지 않습니다.
- 네트워크 변경, 공용 네트워크, bot filtering과 확률적 추정으로 실제 사람
  수와 다를 수 있습니다.
- sketch 품질을 보장할 수 없으면 임의 숫자를 반환하지 않고
  `saturated` 상태를 제공합니다.

### collection coverage

analytics가 기본 비활성이므로 row 없음이 곧 방문 0을 의미하지 않습니다.
Control은 collector가 실제 기록 가능한 interval을 운영 metadata로
기록합니다.

```text
complete: 선택 기간 전체가 수집 interval에 포함
partial:  선택 기간 일부만 포함
none:     선택 기간과 수집 interval이 겹치지 않음
```

- `complete`일 때만 page view `0`을 실제 방문 없음으로 표시합니다.
- `partial` 또는 `none`이면 관리자에서 수집 공백을 명시합니다.
- analytics key reset 경계를 포함하면 unique와 파생 비율은 unavailable로
  표시합니다.

---

## 3. 핵심 wire contract

### Public request

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
```

### Collector 결과

```ts
export type RecordAnalyticsPageViewResult =
  | { kind: "recorded" }
  | {
      kind: "ignored";
      reason: "privacy-signal" | "bot" | "disabled";
    }
  | { kind: "rate-limited"; retryAfterSeconds: number };
```

- success, GPC/DNT, bot와 disabled는 public UX에 영향을 주지 않습니다.
- malformed body/path는 4xx입니다.
- rate limit은 `429`와 bounded `Retry-After`입니다.
- Astro client는 response body를 읽거나 retry하지 않습니다.

### Admin query

```text
GET /admin/api/v1/analytics/overview
  ?from=2026-07-01
  &to=2026-07-24
  &granularity=day
```

- timezone은 `Asia/Seoul` 고정입니다.
- `from`, `to`, `granularity`만 허용합니다.
- source origin filter와 visitor filter는 만들지 않습니다.

---

## 4. 파일 책임 지도

```text
packages/shared/src/analytics.ts
  public request schema와 admin aggregate DTO

apps/control/src/analytics/route-normalization.ts
  locale, static route와 active article route 검증

apps/control/src/analytics/unique-sketch.ts
  16 KiB register sketch 생성·갱신·병합·추정

apps/control/src/analytics/client-rate-sketch.ts
  identifier를 저장하지 않는 bounded in-memory client rate counter

apps/control/src/analytics/state.ts
  analytics key fingerprint와 collection coverage state

apps/control/src/analytics/service.ts
  privacy/bot/rate 검증과 aggregate transaction

apps/control/src/analytics/routes.ts
  current public host의 same-origin collector

apps/control/src/analytics/reporting.ts
  KST range, coverage, 합계·추이·인기 페이지·상담 참고값

apps/control/src/analytics/retention.ts
  current retention 정책에 따른 bounded cleanup

apps/site/src/lib/analytics-client.ts
  current Astro 포털의 best-effort page-view 전송

apps/admin/src/features/analytics/AnalyticsPage.tsx
  기간·단위 filter, KPI, trend, popular pages와 methodology

apps/admin/src/features/analytics/AnalyticsTrendChart.tsx
  dependency 없는 accessible native SVG chart

docs/operations/first-party-analytics.md
  현재 서비스의 privacy, activation, key reset와 incident runbook

docs/operations/analytics-kpi-log.md
  현재 서비스 aggregate KPI review 기록
```

---

### Task 0: 구현 branch와 승인 gate 고정

**Files:**

- Reference: `apps/admin/src/app/router.tsx`
- Reference: `apps/control/src/admin/api.ts`
- Reference: `apps/site/src/layouts/BaseLayout.astro`
- Reference: `docs/superpowers/plans/2026-07-24-first-party-analytics.md`

**Interfaces:**

- Consumes: current React administrator implementation
- Produces: exact repo/branch와 activation prerequisites

- [ ] **Step 1: 구현 시작 위치 확인**

```bash
git branch --show-current
git rev-parse HEAD
git status --short
test -f apps/admin/src/app/router.tsx
test -f apps/control/src/admin/api.ts
test -f apps/site/src/layouts/BaseLayout.astro
```

Expected:

```text
branch = 2026-07-21-codex-code-review-fixes 또는 descendant
repo root = /Users/wisdom/wisdom_project/gpt/wisdom_web_portal
```

`master`, linked worktree와 sibling Sites repository를 구현 위치로 사용하지
않습니다.

- [ ] **Step 2: privacy/제품 승인 gate 기록**

production activation 전에 다음을 모두 승인받습니다.

```text
1. 자체 수집 목적·항목·보존기간
2. request 처리 중 IP와 coarse UA family를 일시 사용하는 범위
3. `추정 순 방문자`와 aggregate 상담 전환 문구
4. GPC/DNT 처리
5. targeted verification 범위
6. schema v9 maintenance와 v8 rollback retirement
7. production activation
```

개인정보 처리방침 검토에서 명시적 opt-in이 필요하면 현재 계획으로
collector를 활성화하지 않습니다. consent UI와 browser state를 별도
설계·승인하며 cookie나 localStorage를 임의로 추가하지 않습니다.

---

### Task 1: shared contract와 authoritative route grammar

**Files:**

- Create: `packages/shared/src/analytics.ts`
- Create: `packages/shared/src/analytics.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/control/src/analytics/route-normalization.ts`
- Create: `apps/control/src/analytics/route-normalization.test.ts`

**Interfaces:**

- Consumes: current `Locale`, current public routes,
  active `release_entries.route`
- Produces:
  `analyticsPageViewRequestSchema`,
  `AdminAnalyticsOverviewDto`,
  `normalizeAnalyticsRoute(path, activeArticleExists)`

- [ ] **Step 1: minimal public request contract test 작성**

```ts
import { describe, expect, it } from "vitest";

import { analyticsPageViewRequestSchema } from "./analytics.js";

describe("analyticsPageViewRequestSchema", () => {
  it("accepts only schemaVersion and normalized path", () => {
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
});
```

- [ ] **Step 2: exact shared contract 작성**

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
  };
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

- [ ] **Step 3: current public route normalizer 작성**

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

Rules:

```text
- root 외 trailing slash 1개 제거
- 중복 slash, dot segment, percent encoding, query와 hash 거부
- `/admin`, `/api`, `/health`, `/internal`과 machine route 거부
- `/marketing/withdraw`와 하위 capability route 거부
- locale prefix는 "", "/en", "/zh-hans", "/zh-hant"만 허용
- service detail은 현재 6개 slug만 허용
- article slug는 `[a-z0-9]+(?:-[a-z0-9]+)*`
- article은 current active release exact route만 허용
- unknown route는 저장하지 않음
```

- [ ] **Step 4: 개인정보 route rejection test 작성**

```ts
it("rejects secret and arbitrary visitor paths", () => {
  const active = () => false;
  expect(normalizeAnalyticsRoute(
    "/marketing/withdraw/private-token",
    active,
  )).toBeUndefined();
  expect(normalizeAnalyticsRoute(
    "/services?message=private",
    active,
  )).toBeUndefined();
  expect(normalizeAnalyticsRoute(
    "/unknown/private-name",
    active,
  )).toBeUndefined();
});
```

- [ ] **Step 5: 승인된 targeted test**

```bash
npm run test --workspace @wisdom/shared -- src/analytics.test.ts
npm run test --workspace @wisdom/control -- \
  src/analytics/route-normalization.test.ts
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

- Consumes: KST hour/day bucket, normalized route, 16 KiB register sketch
- Produces:
  `analytics_pageviews`,
  `analytics_unique_sketches`,
  `analytics_rate_buckets`,
  `analytics_state`,
  `analytics_collection_intervals`

- [ ] **Step 1: schema version test 작성**

```ts
expect(SCHEMA_VERSION).toBe(9);
expect(tableNames).toEqual(expect.arrayContaining([
  "analytics_pageviews",
  "analytics_unique_sketches",
  "analytics_rate_buckets",
  "analytics_state",
  "analytics_collection_intervals",
]));
expect(indexNames).toEqual(expect.arrayContaining([
  "analytics_pageviews_path_bucket_idx",
  "analytics_pageviews_expiry_idx",
  "analytics_unique_sketches_expiry_idx",
  "analytics_rate_buckets_expiry_idx",
  "analytics_collection_intervals_open_idx",
]));
```

v8→v9가 일반 release의 `--require-rollback-compatible`에서 계속 거부되는
test를 유지합니다.

- [ ] **Step 2: migration 7 SQL 추가**

Migration name은 `privacy-preserving-analytics-rollups`로 고정합니다.

```sql
CREATE TABLE analytics_pageviews (
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
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
  PRIMARY KEY (bucket_kind, bucket_start_ms, path)
) WITHOUT ROWID;

CREATE INDEX analytics_pageviews_path_bucket_idx
  ON analytics_pageviews(path, bucket_kind, bucket_start_ms);
CREATE INDEX analytics_pageviews_expiry_idx
  ON analytics_pageviews(expires_at_ms);

CREATE TABLE analytics_unique_sketches (
  bucket_kind TEXT NOT NULL CHECK (bucket_kind IN ('hour','day')),
  bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
  registers BLOB NOT NULL CHECK (length(registers) = 16384),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > bucket_start_ms),
  PRIMARY KEY (bucket_kind, bucket_start_ms)
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
  started_at_ms INTEGER PRIMARY KEY CHECK (started_at_ms >= 0),
  ended_at_ms INTEGER CHECK (
    ended_at_ms IS NULL OR ended_at_ms > started_at_ms
  )
);

CREATE UNIQUE INDEX analytics_collection_intervals_open_idx
  ON analytics_collection_intervals((1))
  WHERE ended_at_ms IS NULL;
```

- [ ] **Step 3: Drizzle/schema registry 갱신**

```text
SCHEMA_VERSION = 9
REQUIRED_TABLES += five analytics tables
REQUIRED_INDEXES += five analytics indexes
drizzleSchema += five analytics tables
```

Migration fingerprint, history, rollback compatibility와 tampering test에
version 9를 포함합니다.

- [ ] **Step 4: restore adapter를 schema v9로 갱신**

`ops/lib/system-adapters.mjs`의 default `expectedSchemaVersion`을 9로
올립니다. restore replacement 전에 다음을 current retention 기준으로
secure-delete합니다.

```text
- expired analytics_pageviews
- expired analytics_unique_sketches
- expired analytics_rate_buckets
- due consultation PII
```

restore 결과에는 consultation과 analytics 삭제 수를 분리해 기록합니다.
v8 backup은 v9 release에서 fail-closed하고, v9 backup만 compatible로
처리합니다.

- [ ] **Step 5: 승인된 schema/restore test**

```bash
npm run test --workspace @wisdom/control -- src/db/database.test.ts
node --test ops/tests/system-adapters.test.mjs
node --test ops/tests/backup-restore.test.mjs
```

---

### Task 2B: v8→v9 전용 maintenance migration

**Files:**

- Create: `ops/lib/schema-maintenance.mjs`
- Create: `ops/scripts/schema-maintenance.mjs`
- Create: `ops/tests/schema-maintenance.test.mjs`
- Modify: `ops/runbooks/deployment.md`
- Modify: `ops/lib/release-system.mjs`
- Modify: `ops/tests/release-system.test.mjs`

**Interfaces:**

- Consumes: stopped v8 production, verified fresh backup, maintenance lock,
  staged v9 release
- Produces: schema v9와 명시적으로 retired v8 rollback releases

일반 `deploy.mjs`와 rollback compatibility gate는 약화하지 않습니다.

- [ ] **Step 1: fail-closed maintenance test 작성**

```text
- control/worker/tunnel 중 하나라도 running이면 거부
- fresh backup hash·복호화·integrity·schema v8 증거가 없으면 거부
- DB maintenance lock을 획득하지 못하면 거부
- from=8, to=9와 exact confirmation이 아니면 거부
- retained v8 release retirement 기록이 없으면 거부
- migration 뒤 user_version/history/integrity가 9가 아니면 재시작 금지
- 이미 v9인 DB에서는 already-complete no-op
```

- [ ] **Step 2: dedicated maintenance command 작성**

```bash
node ops/scripts/schema-maintenance.mjs \
  --database /Users/wisdom/portal-data/portal.sqlite \
  --from-version 8 \
  --to-version 9 \
  --backup-status /absolute/path/to/verified-backup-status.json \
  --retirement-record /absolute/path/to/v8-retirement-record.json \
  --confirm-action MIGRATE_SCHEMA_6_TO_7
```

전용 command는 staged v9의 canonical migration code만 호출합니다. 임시
rollback bypass flag를 추가하지 않습니다.

- [ ] **Step 3: deployment runbook ceremony 기록**

```text
1. v9 release와 restore tooling stage
2. control, worker, tunnel stop 증거 기록
3. fresh backup 생성과 restore drill
4. v8 rollback release 식별·retirement 승인
5. DB maintenance lock 획득
6. dedicated 6→7 command 실행
7. schema/history/integrity와 v9 restore adapter 확인
8. v9 canary/readiness 후 service/tunnel 재시작
9. rollback은 v9 forward-fix 또는 verified v9 backup만 사용
```

- [ ] **Step 4: 승인된 maintenance tooling test**

```bash
node --test ops/tests/schema-maintenance.test.mjs
node --test ops/tests/release-system.test.mjs
```

실제 service stop, backup, retirement, migration과 재시작은 별도 production
승인 작업입니다.

---

### Task 3: unique sketch, bounded rate state와 aggregate transaction

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

- Consumes: `KeyProvider`, `NormalizedAnalyticsRoute`, trusted proxy client IP,
  최대 512자 User-Agent
- Produces:
  `analyticsDigest`,
  `analyticsVisitorDigest`,
  `createUniqueSketch`,
  `mergeUniqueSketches`,
  `estimateUnique`,
  `recordAnalyticsPageView`

- [ ] **Step 1: analytics purpose key 분리**

PII active key ID는 analytics digest에 포함하지 않습니다.

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

Test:

```ts
expect(analyticsDigest(beforePiiRotation, "same-input"))
  .toEqual(analyticsDigest(afterPiiRotation, "same-input"));
expect(analyticsDigest(beforePiiRotation, "same-input"))
  .not.toEqual(keyedDigest(beforePiiRotation, "abuse", "same-input"));
```

- [ ] **Step 2: native 16 KiB register sketch 작성**

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

Implementation rules:

```text
- first 64 digest bits만 사용
- first 14 bits = register index
- remaining bits = leading-zero rank
- update = register별 max
- merge = register별 max, input mutation 금지
- estimate = harmonic mean + small-range correction
- quality를 보장할 수 없으면 estimate=null, quality=saturated
```

Test:

```ts
it("merges repeated visitors without retaining their digest", () => {
  const first = createUniqueSketch();
  addUniqueDigest(first, analyticsDigestForTest("visitor-a"));
  addUniqueDigest(first, analyticsDigestForTest("visitor-a"));
  expect(estimateUnique(first).estimate).toBe(1);

  const second = createUniqueSketch();
  addUniqueDigest(second, analyticsDigestForTest("visitor-b"));
  expect(estimateUnique(
    mergeUniqueSketches([first, second]),
  ).estimate).toBe(2);
});
```

- [ ] **Step 3: transient visitor digest 작성**

```ts
export function analyticsVisitorDigest(
  provider: KeyProvider,
  clientIp: string,
  userAgent: string,
): Buffer | undefined;
```

Rules:

```text
- clientIp empty 또는 "unknown"이면 unique sketch를 갱신하지 않음
- User-Agent는 512자까지만 읽음
- family는 edge/chrome/firefox/safari/other
- input domain = wisdom:analytics-visitor:v1
- digest는 register update 뒤 폐기
- raw IP, raw UA와 digest를 DB/logger에 전달하지 않음
```

- [ ] **Step 4: bounded client/global rate control 작성**

Fixed limits:

| scope | minute | day |
|---|---:|---:|
| client transient digest | 120 | 2,000 |
| global | 1,500 | 250,000 |

client rate subject:

```text
HMAC(
  "wisdom:analytics-rate-client:v1\0"
  + windowKind + "\0"
  + windowStartMs + "\0"
  + clientIp
)
```

client digest는 process memory의 minute/day count-min counter sketch index를
계산한 뒤 폐기합니다. DB에는 subject row를 만들지 않습니다.

```text
- fixed-width arrays only
- minute/day window 변경 시 reset
- restart 시 client counts reset
- global SQLite minute/day count가 persistent write ceiling 제공
- global count는 limit+1에서 saturating update
- active global DB row는 최대 2개
```

- [ ] **Step 5: analytics key state와 reset command 작성**

`CONTROL_HMAC_SECRET` 자체가 바뀌면 기존 unique sketch를 같은 기준으로
merge할 수 없습니다.

```text
startup:
  derived analytics key SHA-256 fingerprint
  ↔ analytics_state.key_fingerprint

match:
  collector can start

mismatch with retained sketches:
  collector fail-closed
  admin methodology reports key reset required
```

`analytics:key-reset` script:

```text
- default dry-run
- ANALYTICS_ENABLED=false 확인
- PUBLIC_ANALYTICS_ENABLED=false 운영 증거 요구
- exact RESET_ANALYTICS_UNIQUES confirmation 요구
- unique sketches 삭제
- current collection interval 종료
- new fingerprint와 unique coverage start 기록
- page-view rollup은 유지
```

- [ ] **Step 6: atomic collection service 작성**

```ts
export interface RecordAnalyticsPageViewInput {
  route: NormalizedAnalyticsRoute;
  clientIp: string;
  userAgent: string;
  nowMs: number;
}

export function recordAnalyticsPageView(
  db: ControlDatabase,
  provider: KeyProvider,
  input: RecordAnalyticsPageViewInput,
  options: {
    enabled: boolean;
    retentionDays: number;
    dnt: boolean;
    gpc: boolean;
  },
): RecordAnalyticsPageViewResult;
```

Transaction order:

```text
1. disabled/GPC/DNT/bot이면 no-write ignored
2. in-memory client minute/day counter 검사
3. SQLite global minute/day counter upsert
4. rate exceeded면 global counter만 commit
5. KST hour/day bucket 계산
6. analytics_pageviews hour/day 각각 +1
7. analytics_unique_sketches hour/day read-copy-update-upsert
8. commit
```

Expiry:

```text
hour = bucket start + 31 days
day  = bucket start + ANALYTICS_RETENTION_DAYS
rate = window end + maximum 1 hour grace
```

- [ ] **Step 7: service test cases 작성**

```text
- same visitor, same hour, 3 views → pageViews=3, estimated unique≈1
- same visitor, next hour → each hour present, merged day unique≈1
- same visitor, different paths → both path counts, total unique≈1
- unknown client IP → page view only, unique unchanged
- GPC/DNT/bot/disabled → no analytics table mutation
- client/global limit → 429 result, rollup unchanged
- many distinct IPs → DB rate rows remain bounded
- log event → no IP, UA, digest or request body
- key mismatch → collector fail-closed
```

- [ ] **Step 8: 승인된 targeted test**

```bash
npm run test --workspace @wisdom/control -- \
  src/crypto/crypto.test.ts \
  src/analytics/unique-sketch.test.ts \
  src/analytics/client-rate-sketch.test.ts \
  src/analytics/state.test.ts \
  src/analytics/service.test.ts
```

---

### Task 4: current same-origin collector와 configuration

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
  current `PUBLIC_ORIGIN`,
  current `allowedOrigins`,
  `POST /api/v1/analytics/page-views`
- Produces: same-origin 204 collector와 collection coverage interval

- [ ] **Step 1: configuration contract 작성**

```text
ANALYTICS_ENABLED=false
ANALYTICS_RETENTION_DAYS=180
PUBLIC_ANALYTICS_ENABLED=false
```

Parsing:

```text
- ANALYTICS_ENABLED: exact true|false, default false
- PUBLIC_ANALYTICS_ENABLED: exact true|false, default false
- ANALYTICS_RETENTION_DAYS: safe integer 30..400, default 180
- production secret 신규 추가 없음
- analytics API origin 또는 origin 목록 설정 추가 없음
```

- [ ] **Step 2: collector HTTP test 작성**

```text
- request Host/Origin == configured PUBLIC_ORIGIN → 204
- wrong/missing Origin in enforced production mode → 403
- admin host → 404
- Content-Type not application/json → 415
- body over 1 KiB → 413
- invalid JSON → 400
- extra field/query/hash/unknown path → 422
- Sec-GPC: 1 or DNT: 1 → 204, no write
- known bot/headless UA → 204, no write
- active article exact route → 204
- withdrawal/admin/API path in body → 422
- rate limit → 429 + bounded Retry-After
```

- [ ] **Step 3: public route 등록**

현재 Caddy가 public host의 `/api/v1/*`를 Control로 전달하므로 새 API host나
cross-origin CORS를 만들지 않습니다.

```ts
registerAnalyticsRoutes(app, {
  db: dependencies.db,
  keyProvider: dependencies.keyProvider,
  publicOrigin: dependencies.publicOrigin,
  allowedOrigins: dependencies.allowedOrigins,
  peerAddress: dependencies.peerAddress,
  now,
  analytics: dependencies.analytics,
});
```

Request validation order:

```text
1. current public host
2. exact current PUBLIC_ORIGIN
3. Content-Type and 1 KiB limit
4. strict shared schema
5. current public route grammar
6. service aggregate transaction
```

- [ ] **Step 4: collection interval reconcile 작성**

Control start/restart에서 current `ANALYTICS_ENABLED`를 DB coverage metadata와
맞춥니다.

```text
false:
  open interval이 있으면 nowMs에 close

true:
  open interval이 없으면 nowMs에 open

unchanged:
  existing interval 유지
```

reconcile 실패 시 collector는 fail-closed하고 consultation/admin 기능이
analytics 활성화로 오인되지 않게 합니다.

- [ ] **Step 5: Astro build flag 전달**

`PUBLIC_ANALYTICS_ENABLED`를 strict runtime key allowlist에 추가합니다.
host environment에서 암묵적으로 상속하지 않고 publication config를 통해
격리된 Astro build에 전달합니다.

```ts
env: {
  CI: "1",
  HOME: buildHome,
  NODE_ENV: "production",
  PUBLIC_ORIGIN: publicOrigin,
  PUBLIC_ANALYTICS_ENABLED:
    input.publicAnalyticsEnabled ? "true" : "false",
}
```

- [ ] **Step 6: 승인된 collector/config test**

```bash
npm run test --workspace @wisdom/control -- \
  src/config.test.ts \
  src/analytics/routes.test.ts \
  src/app.test.ts \
  src/articles/publication-build.test.ts \
  src/articles/publication-release.test.ts
node --test ops/tests/runtime-launch.test.mjs
```

---

### Task 5: current Astro page-view client

**Files:**

- Create: `apps/site/src/lib/analytics-client.ts`
- Create: `apps/site/src/lib/analytics-client.test.ts`
- Modify: `apps/site/src/layouts/BaseLayout.astro`

**Interfaces:**

- Consumes: browser `window.location.pathname`,
  relative `/api/v1/analytics/page-views`
- Produces: current document load당 최대 1회 best-effort request

- [ ] **Step 1: pure client test 작성**

```ts
it("sends only schema version and pathname without retry", async () => {
  const calls: Array<[string, RequestInit]> = [];

  await sendPageView({
    endpoint: "/api/v1/analytics/page-views",
    pathname: "/services/procurement",
    fetchRef: async (input, init) => {
      calls.push([String(input), init ?? {}]);
      return new Response(null, { status: 204 });
    },
    navigatorState: {
      doNotTrack: "0",
      globalPrivacyControl: false,
    },
  });

  expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({
    schemaVersion: 1,
    path: "/services/procurement",
  });
});
```

Additional cases:

```text
- DNT/GPC true → fetch 0
- pathname only; query/hash never read
- invalid/withdrawal/admin/machine path → fetch 0
- rejected fetch → no user-visible error
- response body not read
- retry 0
- credentials omit
- referrerPolicy no-referrer
- keepalive true
```

- [ ] **Step 2: client implementation 작성**

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

Fetch:

```ts
{
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "omit",
  referrerPolicy: "no-referrer",
  keepalive: true,
  body: JSON.stringify({
    schemaVersion: 1,
    path: input.pathname,
  }),
}
```

- [ ] **Step 3: current BaseLayout에 mount**

```text
condition:
  import.meta.env.PUBLIC_ANALYTICS_ENABLED === "true"
  AND current route passes isTrackablePublicPath

endpoint:
  /api/v1/analytics/page-views
```

현재 Astro와 Control이 같은 public origin이므로 CSP
`connect-src 'self'`를 유지합니다.

- [ ] **Step 4: 승인된 client test**

```bash
npm run test --workspace @wisdom/site -- \
  src/lib/analytics-client.test.ts
```

---

### Task 6: aggregate reporting과 authenticated admin API

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
  KST `from`, `to`, `granularity`
- Produces:
  `parseAnalyticsReportQuery(input, options)`,
  `buildAnalyticsOverview(db, query, nowMs)`,
  `AdminAnalyticsOverviewDto`

- [ ] **Step 1: range parser test 작성**

Supported:

```text
from=2026-07-01
to=2026-07-24
granularity=day
```

Rules:

```text
- timezone = Asia/Seoul
- from/to = real YYYY-MM-DD calendar date
- inclusive range = 1..ANALYTICS_RETENTION_DAYS
- hour granularity = maximum 14 days
- hour entire range = current 31-day hour retention 안
- day/week/month = configured retention 안
- week starts Monday
- missing all = recent 28 calendar days + day
- partially missing/invalid = 400 INVALID_REQUEST
```

- [ ] **Step 2: report query interface 작성**

```ts
export interface AnalyticsReportQuery {
  from: string;
  to: string;
  granularity: "hour" | "day" | "week" | "month";
}

export function parseAnalyticsReportQuery(
  input: {
    from: string | undefined;
    to: string | undefined;
    granularity: string | undefined;
  },
  options: {
    nowMs: number;
    retentionDays: number;
  },
):
  | { success: true; data: AnalyticsReportQuery }
  | { success: false };
```

- [ ] **Step 3: aggregate read-model test 작성**

Fixtures:

```text
- two day sketches merge repeat visitor once
- hour/day/week/month boundaries match KST
- page-view total and top 10 popular pages
- popular page tie = path ASC
- consultations count only received_at_ms in same half-open interval
- no PII columns selected
- unique 0 → ratios null
- incomplete collection period → coverage partial/none
- complete collection period + no rows → real zero
- prior period outside retention/coverage → comparison.available=false
- key reset boundary/saturation → unique and derived ratios null
```

- [ ] **Step 4: report calculation 작성**

```text
totals.pageViews:
  selected day page-view rows sum

totals.estimatedUniqueVisitors:
  selected daily register sketches merge + estimate

series.pageViews:
  selected granularity sum

series.estimatedUniqueVisitors:
  each output group register merge + estimate

popularPages:
  GROUP BY path, locale
  ORDER BY page_views DESC, path ASC
  LIMIT 10

consultations:
  received_at_ms in same KST interval

comparison:
  immediately preceding interval with same calendar length
```

Previous value 0은 infinite 또는 0%로 변환하지 않고 percent change를
`null`로 반환합니다.

- [ ] **Step 5: admin dependency와 route 등록**

`AdminRouteDependencies`:

```ts
analytics: {
  retentionDays: number;
}
```

Route:

```ts
app.get("/admin/api/v1/analytics/overview", (context) => {
  const session = requireSession(context, dependencies);
  if (session instanceof Response) return session;

  const nowMs = dependencies.now();
  const parsed = parseAnalyticsReportQuery(
    {
      from: context.req.query("from"),
      to: context.req.query("to"),
      granularity: context.req.query("granularity"),
    },
    {
      nowMs,
      retentionDays: dependencies.analytics.retentionDays,
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
    buildAnalyticsOverview(dependencies.db, parsed.data, nowMs),
  );
});
```

기존 admin middleware의 `Cache-Control: no-store`와 session/CSRF boundary를
그대로 유지합니다. GET report는 state mutation을 만들지 않습니다.

- [ ] **Step 6: admin HTTP test 작성**

```text
- no session → 401 AUTH_REQUIRED
- valid session → success envelope
- invalid/leap-date/range/granularity → 400
- response has no registers, digest, IP, UA or PII
- admin host only
- Cache-Control no-store
```

- [ ] **Step 7: 승인된 reporting test**

```bash
npm run build:shared
npm run test --workspace @wisdom/control -- \
  src/analytics/reporting.test.ts \
  src/admin/admin-http.test.ts
```

---

### Task 7: current React 관리자 성과 분석 화면

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
  "/analytics/overview?from=...&to=...&granularity=...")`
- Produces: current administrator route `/admin/analytics`

- [ ] **Step 1: URL filter contract 작성**

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

`from`, `to`, `granularity`를 URL search parameter로 유지합니다. 최근 7일은
오늘을 포함한 KST 7개 calendar date입니다.

- [ ] **Step 2: route/navigation 등록**

`apps/admin/src/app/router.tsx`:

```tsx
if (pathname === "/analytics") return "성과 분석";

<Route path="analytics" element={<AnalyticsPage />} />
```

`apps/admin/src/components/AppShell.tsx`:

```tsx
["/analytics", "성과 분석", false]
```

현재 root dashboard는 상담 운영 overview로 유지합니다.

- [ ] **Step 3: KPI와 coverage state 구현**

Header:

```text
eyebrow: PERFORMANCE
title: 성과 분석
description: 공개 포털의 방문 흐름과 상담 접수 변화를 확인합니다.
```

KPI:

```text
추정 순 방문자
페이지 조회
페이지 조회/방문자
상담 접수
대략적 상담 전환율
```

Display rules:

```text
coverage complete + 0 = "0"
coverage partial = "일부 기간 수집"
coverage none = "수집되지 않음"
unique saturated = "추정 범위 초과"
key reset boundary = "집계 기준 변경"
comparison unavailable = "비교 기간 데이터 없음"
ratio null = "계산 불가"
```

- [ ] **Step 4: dependency 없는 accessible chart 작성**

```tsx
export interface AnalyticsTrendChartProps {
  points: AdminAnalyticsOverviewDto["series"];
}
```

Requirements:

```text
- native SVG only
- page views와 estimated uniques를 separate panels로 표시
- SVG title/desc + aria-labelledby
- same numbers in semantic table
- reduced-motion에서 animation 없음
- empty series = existing Empty component
- 320px에서 chart clipping 없음
- table은 narrow viewport에서 자체 horizontal scroll
```

- [ ] **Step 5: popular page와 methodology panel 작성**

Popular page columns:

```text
순위 | 페이지 경로 | 언어 | 페이지 조회 | 비중
```

Methodology copy:

```text
추정 순 방문자는 쿠키 없이 집계한 근사값입니다. 네트워크 변경, 공용
네트워크와 자동화 트래픽 필터에 따라 실제 사람 수와 차이가 날 수 있습니다.
상담 전환율은 개인 방문과 상담을 연결하지 않은 기간 합계 참고값입니다.
```

- [ ] **Step 6: async/partial state 작성**

```text
- loading = existing Loading
- failure = ErrorMessage + 다시 시도
- retry = resource.reload()
- popularPages only empty = panel-level Empty
- traffic 0 / consultation >0 = valid state
- traffic >0 / consultation 0 = valid state
- stale request = existing AbortController behavior
```

- [ ] **Step 7: E2E fixture/test 작성**

Test names는 `analytics`를 포함합니다.

```text
analytics shows aggregate metrics without visitor identifiers
analytics keeps date filters in the administrator URL
analytics distinguishes empty partial and uncollected states
analytics recovers after a failed report request
```

- [ ] **Step 8: 승인된 targeted UI test**

```bash
npm exec --workspace @wisdom/admin -- \
  vitest run src/features/analytics/date-range.test.ts
npm run typecheck --workspace @wisdom/admin
npm exec --workspace @wisdom/admin -- \
  playwright test --grep "analytics"
```

신규 chart dependency가 `apps/admin/package.json`에 추가되지 않아야 합니다.

---

### Task 8: retention, restore와 현재 서비스 운영 문서

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
- Create: `docs/operations/analytics-kpi-log.md`

**Interfaces:**

- Consumes: current `ANALYTICS_RETENTION_DAYS`, aggregate `expires_at_ms`,
  existing `retention:purge`
- Produces: bounded purge result와 current-service operations record

- [ ] **Step 1: bounded analytics purge 작성**

```ts
export interface AnalyticsPurgeResult {
  pageViewRowsDeleted: number;
  uniqueSketchRowsDeleted: number;
  rateBucketRowsDeleted: number;
  complete: boolean;
}
```

각 table은 한 실행에서 최대 5,000행을 primary-key subquery로 삭제합니다.
남은 due row가 있으면 `complete=false`입니다.

Effective expiry:

```text
hour row:
  min(stored expires_at_ms, bucket_start_ms + 31 days)

day row:
  min(
    stored expires_at_ms,
    bucket_start_ms + current ANALYTICS_RETENTION_DAYS
  )

rate row:
  stored expires_at_ms, maximum 25 hours
```

따라서 retention을 180일에서 30일로 줄이면 기존 day row도 다음 purge부터
30일 정책을 따릅니다.

- [ ] **Step 2: existing retention flow에 결합**

Consultation PII purge와 analytics aggregate purge는 서로 다른 bounded
transaction입니다.

CLI result:

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

analytics purge 실패가 이미 완료된 PII purge를 rollback한 것으로 보고되지
않게 합니다.

- [ ] **Step 3: restore-before-replace retention 결합**

`ops/scripts/restore.mjs`는
`--analytics-retention-days <30..400>`를 required input으로 받아 staged
database replacement 전에 current-policy expiry를 적용합니다.

```text
- expired analytics rows secure-delete
- consultation/analytics deletion counts separate
- due set exceeds fixed maximum → fail-closed
- missing/invalid retention input → target DB unchanged
- collection interval and analytics_state preserved
```

- [ ] **Step 4: current-service runbook 작성**

`docs/operations/first-party-analytics.md`:

```text
- metric definitions and "추정" wording
- payload and non-collected fields
- transient IP/coarse UA processing
- no stored visitor/rate subject digest
- 31-day/180-day retention
- GPC/DNT and bot filter
- false-by-default enable/disable
- collection coverage interpretation
- CONTROL_HMAC_SECRET rotation and analytics:key-reset
- incident kill switch
- no individual visitor lookup or consultation linkage
- current Astro rollback order
```

`docs/operations/analytics-kpi-log.md`에는 aggregate만 기록합니다.

```text
review period
granularity
collection coverage
estimated unique visitors
page views
popular pages
consultations
approximate consultation conversion
release/incident notes
```

- [ ] **Step 5: 개인정보 처리방침 release gate**

fixture나 source의 policy text를 직접 덮어쓰지 않습니다. 기존 current-service
consent publication workflow에서 법률 검토된 privacy document를 승인하고
verified public release로 공개한 뒤 collector를 활성화합니다.

- [ ] **Step 6: 승인된 retention/restore test**

```bash
npm run test --workspace @wisdom/control -- \
  src/analytics/retention.test.ts \
  src/retention/purge.test.ts
node --test ops/tests/backup-restore.test.mjs
```

---

### Task 9: current service verification, deployment와 activation gates

**Files:** 없음

**Interfaces:**

- Consumes: Task 1~8의 구현과 Task 2B maintenance tooling
- Produces: 현재 Astro/Control/React 서비스에서만 활성화된 Analytics

각 gate는 별도 사용자 승인 단위입니다.

- [ ] **Gate 9A: targeted local verification**

후보:

```bash
npm run build:shared
npm run test --workspace @wisdom/shared -- src/analytics.test.ts
npm run test --workspace @wisdom/control -- \
  src/analytics \
  src/db/database.test.ts \
  src/admin/admin-http.test.ts \
  src/config.test.ts
npm run test --workspace @wisdom/site -- \
  src/lib/analytics-client.test.ts
npm exec --workspace @wisdom/admin -- \
  vitest run src/features/analytics/date-range.test.ts
npm run typecheck --workspace @wisdom/control
npm run typecheck --workspace @wisdom/admin
```

- [ ] **Gate 9B: current admin/browser verification**

```text
- /admin/analytics at 320px and 1440px
- keyboard focus and URL filter state
- SVG title/description and numeric table
- loading/error/empty/partial/none states
- current Astro document load당 request 최대 1
- request body has schemaVersion/path only
- query/referrer/consultation PII absent
```

- [ ] **Gate 9C: v9 maintenance와 disabled deployment**

```text
1. Task 2B v8→v9 maintenance ceremony 승인·실행
2. ANALYTICS_ENABLED=false
3. PUBLIC_ANALYTICS_ENABLED=false
4. v9 Control/application code 배포
5. current consultation/admin/public portal readiness 확인
```

schema migration, service stop, backup과 v8 release retirement는 코드 구현
승인에 포함되지 않습니다.

- [ ] **Gate 9D: privacy document publication**

```text
1. 수집 목적·항목·보존기간 법률 검토
2. `추정 순 방문자`와 aggregate conversion 문구 승인
3. current consent/publication workflow로 privacy document release
4. public policy와 runtime consent authority identity 확인
```

- [ ] **Gate 9E: current Astro tracker activation**

```text
1. PUBLIC_ANALYTICS_ENABLED=true로 current Astro public release build
2. verified public release 활성화
3. ANALYTICS_ENABLED는 아직 false
4. portal/consultation/admin readiness 유지 확인
```

collector가 아직 false이므로 이 단계는 request를 수락해도 aggregate write를
시작하지 않습니다.

- [ ] **Gate 9F: Control collector activation**

```text
1. ANALYTICS_ENABLED=true runtime revision 승인
2. Control restart
3. collection interval open 시각 기록
4. current public route/path count before 값 기록
5. same-origin route를 한 번 열기
6. same path page-view delta +1 확인
7. raw IP/UA/digest가 DB/log/response에 없음을 승인 범위에서 확인
8. /admin/analytics coverage가 complete/partial 규칙대로 표시되는지 확인
```

전체 page view가 `1`일 것으로 기대하지 않고 선택 route의 before→after
delta만 확인합니다.

- [ ] **Gate 9G: rollback**

Pre-analytics Astro release로 rollback할 때는 먼저
`ANALYTICS_ENABLED=false`로 collector를 닫고 collection interval 종료를
기록합니다. 그 다음 current public release를 rollback합니다.

```text
collector off
  → interval close
  → Astro public release rollback
  → readiness
```

tracker가 없는 release에서 coverage가 열린 상태를 만들지 않습니다.

- [ ] **Gate 9H: baseline/full verification/commit/push**

최초 비교 가능한 7일 이후
`docs/operations/analytics-kpi-log.md`에 aggregate baseline을 기록합니다.

```text
period, granularity, coverage, estimated uniques, page views,
popular pages, consultations, approximate conversion, notes
```

전체 `npm run verify`, baseline 기록, commit과 push는 각각 별도 사용자
명령이 있을 때만 수행합니다.

---

## 5. dependency 순서

```text
Task 0 branch/privacy gates
  → Task 1 shared contract + route grammar
  → Task 2 schema + restore compatibility
      └─→ Task 2B maintenance tooling
  → Task 3 unique/rate/key state + aggregate service
  → Task 4 current same-origin collector + config
      ├─→ Task 5 current Astro client
      └─→ Task 6 reporting/admin API
            → Task 7 current React analytics UI
  → Task 8 retention/restore/current-service runbook
  → Gate 9A/B approved verification
  → Gate 9C v9 maintenance + disabled deployment
  → Gate 9D privacy publication
  → Gate 9E Astro tracker activation
  → Gate 9F Control collector activation + synthetic delta
  → Gate 9G/H rollback or baseline
```

---

## 6. 완료 기준

1. 성과지표 구현이 현재 `wisdom_web_portal` repository와 current service만
   대상으로 합니다.
2. GPT Sites project, source, deployment, custom domain과 Sites Analytics에
   의존하지 않습니다.
3. 신규 analytics/차트 npm dependency가 없습니다.
4. public payload는 `schemaVersion`과 normalized `path`만 포함합니다.
5. raw event, raw IP, raw UA, query, referrer, visitor ID, visitor digest와
   rate subject digest가 DB에 없습니다.
6. DB client rate row가 없고 global rate row 수가 window 수로 제한됩니다.
7. React 관리자는 coverage, 추정 순 방문자, 페이지 조회, 추이, 인기 페이지,
   기간·단위와 aggregate 상담 참고값을 제공합니다.
8. 실제 traffic 0, partial/none coverage, key reset과 sketch saturation을
   구분합니다.
9. 순 방문자를 정확한 개인 수로 표현하지 않습니다.
10. GPC/DNT와 알려진 bot 요청은 집계하지 않습니다.
11. current retention 감소가 기존 row에 적용되고 restore가 expired
    analytics data를 되살리지 않습니다.
12. v8→v9 migration은 일반 rollback gate를 우회하지 않고 전용 maintenance
    ceremony로 수행합니다.
13. implementation, test, browser verification, migration, deployment,
    activation, commit과 push가 각각 사용자 승인 경계를 지킵니다.
