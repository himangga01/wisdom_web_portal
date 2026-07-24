# ChatGPT Sites 목표 구조

기준일: 2026-07-24  
문서 상태: 자체 Analytics 구현 계획 반영 v1.3

## 구조 원칙

1. 공개 presentation과 form UI만 Sites로 이동합니다.
2. 기존 Astro 포털은 전환과 안정화가 끝날 때까지 삭제하거나 덮어쓰지
   않습니다.
3. 상담·동의·철회의 system of record는 Control과 SQLite입니다.
4. 상담 body는 browser에서 Control API로 직접 보내고 Sites runtime을
   통과시키지 않습니다.
5. Sites source는 현재 monorepo와 분리합니다.
6. approved public snapshot만 Sites source version에 포함합니다.
7. D1, R2와 SIWC는 사용하지 않습니다.
8. 모든 Sites deployment는 production이며 access 제한과 배포 환경을
   혼동하지 않습니다.
9. public access, custom domain과 DNS는 각각 별도 승인으로 변경합니다.
10. 기존 withdrawal capability와 콘텐츠 발행 호환성이 해결되기 전에는
    `www`를 Sites로 전환하지 않습니다.

## 논리 구조

```text
Anonymous browser
  │
  ├─ https://www.<domain> ───────────────→ ChatGPT Sites
  │                                         ├─ four-locale pages
  │                                         ├─ service information
  │                                         ├─ imported articles/policies
  │                                         └─ consultation form UI
  │
  ├─ https://api.<domain> ───────────────→ Cloudflare Tunnel → Caddy → Control
  │                                         ├─ GET /api/v1/consent-documents
  │                                         ├─ POST /api/v1/consultations
  │                                         └─ POST /api/v1/analytics/page-views
  │
  └─ https://consent.<domain> ───────────→ Cloudflare Tunnel → Caddy → Control
                                            ├─ GET /marketing/withdraw/:token
                                            ├─ GET /{locale}/marketing/withdraw/confirm
                                            └─ POST /{locale}/marketing/withdraw/confirm

Administrator
  └─ https://admin.<domain> ─────────────→ existing Control admin
                                             └─ GET /admin/api/v1/analytics/overview

Site operator
  └─ ChatGPT web/desktop Sites Analytics
       ├─ unique visitors
       ├─ page views
       ├─ traffic over time
       └─ date range / granularity
```

`apex`는 기존 Caddy에서 `www`로 redirect할 수 있습니다. 실제 host 이름은
승인 전 placeholder이며 DNS target은 Sites connector가 반환한 값을
사용합니다.

## source 경계

### 현재 저장소

```text
wisdom_web_portal/
  apps/site/                 # 현재 Astro production과 rollback
  apps/control/              # API, admin, publication, withdrawal
  packages/shared/           # contracts와 schema
  ops/                       # Caddy, cloudflared, launchd
  docs/gpt-sites-migration/  # 이 계획
```

### 신규 독립 Sites source

고정 후보: `/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal`

```text
wisdom_sites_portal/
  .openai/
    hosting.json
  app/
    layout.tsx
    page.tsx
    [...segments]/
      page.tsx
    not-found.tsx
    sitemap.ts
    robots.ts
    rss.xml/
      route.ts
  components/
    SiteHeader.tsx
    SiteFooter.tsx
    HomePage.tsx
    PublicPage.tsx
    ServiceDetail.tsx
    InsightsIndex.tsx
    PublishedArticle.tsx
    ConsultationForm.tsx
    PolicyDocument.tsx
  content/
    source-provenance.json
    public-release/
      manifest.json
      consent-bundle.json
      articles/
  lib/
    routes.ts
    site-content.ts
    consultation-adapter.ts
    published-content.ts
    metadata.ts
  public/
  scripts/
    import-public-release.mjs
  worker/
    index.ts
  .env.example
  package.json
  package-lock.json
  vite.config.ts
```

starter가 실제 생성한 필수 파일, package manager와 lockfile을 보존합니다.
현재 monorepo 전체나 Control/admin/ops source를 Sites repository로 push하지
않습니다.

## 일반 콘텐츠 공급

초기 migration에서 `packages/public-portal` 공유 package를 새로 추출하지
않습니다. 기존 production 포털을 크게 refactor하지 않고 다음 public-only
자료를 독립 Sites source로 옮깁니다.

- `apps/site/src/content/site-content.ts`
- `apps/site/src/lib/routes.ts`
- `packages/shared/src/design-tokens.ts`
- 공개 화면 composition에 필요한 public-only 구조

`source-provenance.json`에는 다음을 기록합니다.

- 원본 저장소 commit SHA
- 복사한 source path
- 파일 SHA-256
- public release manifest SHA
- import 일시와 operator

Node filesystem, crypto, SQLite, Hono, admin 또는 notification 코드는 Sites
source로 복사하지 않습니다.

## 승인 콘텐츠 release handoff

현재 Control publication은 Astro를 build하고 local release symlink를
활성화합니다. Sites는 source commit, saved version과 production deployment가
필요하므로 현재 publish 작업만으로 Sites 콘텐츠가 갱신되지 않습니다.

초기 전환 전에 다음 수동 release ceremony를 구현합니다.

```text
Control에서 콘텐츠 승인
  → immutable pending public snapshot 생성
  → snapshot manifest/hash 검증
  → Sites source에 import
  → source commit/push
  → 같은 SHA/archive로 Sites version 저장
  → 승인 후 Sites version deploy
  → Sites URL에서 release identity 확인
  → Control consent authority 활성화
  → IndexNow/RSS/sitemap 알림
  → release ledger에 양쪽 identity 기록
```

release ledger에는 최소한 다음을 1:1로 연결합니다.

- Control snapshot/release ID
- snapshot manifest SHA-256
- Sites source commit SHA
- Sites saved version ID
- deployment ID와 environment revision
- custom domain 확인 시각

전환 기간에는 콘텐츠 발행 freeze를 걸거나 위 ceremony만 사용합니다. Sites
배포 전 Control consent authority나 IndexNow가 먼저 활성화되는 순서를
허용하지 않습니다. 무인 자동 Sites deployment는 현재 범위에 포함하지
않습니다.

## route 처리

- `/`는 한국어 홈입니다.
- `/en`, `/zh-hans`, `/zh-hant`는 각 locale 홈입니다.
- 나머지 route는 locale prefix를 제거한 뒤 allowlist와 비교합니다.
- service detail은 6개 slug만 렌더링합니다.
- article detail은 imported manifest에 exact match할 때만 렌더링합니다.
- 알 수 없는 route는 prefix에 맞는 locale 404를 반환합니다.
- locale 전환은 같은 base route를 보존합니다.
- 번역이 없는 article locale 링크는 만들지 않습니다.

## Control origin 분리

현재 `PUBLIC_ORIGIN`은 portal canonical, public request host, form Origin
allowlist와 withdrawal URL의 역할을 동시에 합니다. 목표 설정은 다음 의미로
분리합니다.

| 계획상 설정 | 역할 |
|---|---|
| `SITE_ORIGIN` | Sites canonical과 form 요청을 보내는 browser origin |
| `API_ORIGIN` | Control public API가 수신하는 host |
| `WITHDRAWAL_ORIGIN` | 새 marketing withdrawal capability와 confirm host |
| `ADMIN_ORIGIN` | 기존 관리자 host |
| `FORM_ALLOWED_ORIGINS` | 정확히 허용할 generated Sites origin과 final `www` origin |

기존 `PUBLIC_ORIGIN`을 migration 호환 alias로 유지할 수 있지만 code 내부
의미는 위처럼 분리합니다.

### API host

`api` host는 다음 경로만 Control로 전달합니다.

- `GET /api/v1/consent-documents`
- `POST /api/v1/consultations`
- `POST /api/v1/analytics/page-views`
- `OPTIONS /api/v1/analytics/page-views`
- 승인된 health endpoint
- consent/consultation 요청에 필요한 나머지 `OPTIONS`

admin, internal, withdrawal와 ownership route는 404로 차단합니다.

### exact CORS

- `FORM_ALLOWED_ORIGINS`에 포함된 exact origin만 허용합니다.
- `Access-Control-Allow-Origin`은 요청 origin과 exact match일 때만
  반환합니다.
- `Vary: Origin`을 설정합니다.
- method는 `GET`, `POST`, `OPTIONS`만 허용합니다.
- request header는 `Content-Type`, `Idempotency-Key`만 허용합니다.
- wildcard origin과 credentialed CORS를 사용하지 않습니다.
- browser adapter는 `credentials: "omit"`을 사용합니다.
- form token, honeypot, idempotency와 rate limit은 유지합니다.
- Cloudflare/Caddy의 신뢰된 proxy 경계를 기준으로 client IP를 계산합니다.

generated Sites URL을 owner-only deployment에서 점검하려면 해당 exact origin을
임시 allowlist에 추가해야 합니다. public cutover 후 사용하지 않는 origin은
별도 승인으로 제거합니다.

## 마케팅 철회

새 마케팅 메일의 capability는 `WITHDRAWAL_ORIGIN`에서 발급합니다.

- token landing과 confirm GET/POST는 Control이 직접 렌더링하고 처리합니다.
- `__Host-` cookie는 consent origin에만 설정합니다.
- access log를 끄고 `no-store`, `noindex`, `no-referrer`를 강제합니다.
- 공개 전용 최소 shell을 사용하고 admin navigation을 표시하지 않습니다.
- Sites에는 일반 철회 안내 페이지만 둡니다.
- capability token을 Sites redirect, query, runtime, log와 analytics에
  전달하지 않습니다.

### 기존 `www` withdrawal link 호환 gate

현재 발송된 capability는 기존 `PUBLIC_ORIGIN/marketing/withdraw/:token`에
묶여 있고 상담 보유기간까지 유효할 수 있습니다. `www` DNS를 Sites로
바꾸면 기존 link가 Control에 도달하지 않습니다.

cutover 전에 반드시 다음을 확인합니다.

1. 아직 유효한 기존 capability 수
2. 실제 발송된 `www` link 존재 여부
3. 진행 중인 10분 confirmation cookie 여부
4. 신규 메일이 `consent` origin을 사용하기 시작한 시각

유효한 기존 link가 있으면 `www` direct cutover를 중단하고 만료·호환
전략을 별도 승인합니다. token을 Sites로 받아 다시 넘기는 redirect는 기본
대안으로 사용하지 않습니다.

## Sites runtime과 hosting binding

`.openai/hosting.json`:

```json
{
  "project_id": null,
  "d1": null,
  "r2": null
}
```

- `project_id`는 Site 생성 후 반환값으로 교체합니다.
- runtime env와 secret은 이 파일에 쓰지 않습니다.
- `PUBLIC_SITE_ORIGIN`, `PUBLIC_CONSULTATION_API_ORIGIN`과
  `ANALYTICS_ENABLED=false`는 Sites production environment에서 관리합니다.
- consultation과 first-party Analytics는 같은
  `PUBLIC_CONSULTATION_API_ORIGIN`을 사용하며 별도 analytics API origin을
  만들지 않습니다.
- server-render 단계가 client에 공개 API origin만 전달합니다.
- 환경 revision은 이후 saved version deployment에서 적용합니다.

## Sites access와 앱 auth

- 최초 access는 owner-only `custom`입니다.
- owner-only deployment도 production입니다.
- 최종 공개 포털은 승인 후 `public` anonymous access입니다.
- `workspace_all`과 선택 사용자/그룹은 사용하지 않습니다.
- SIWC는 사용하지 않습니다.
- 관리자 로그인은 Control admin host에만 있습니다.

## 자체 Analytics와 Sites 외부 baseline

외부 analytics SDK를 추가하지 않고 Astro와 Sites browser가 Control의
first-party 수집 API를 직접 호출합니다.

```text
Astro / Sites browser
  → minimal page-view payload
  → Control exact Origin/CORS
  → source별 page-view rollup + aggregate unique register sketch
  → React administrator performance view
```

자체 수집기:

- `schemaVersion`과 normalized pathname만 받습니다.
- raw event, raw IP, raw User-Agent와 장기 visitor identifier를 저장하지
  않습니다.
- client rate subject digest는 요청 처리 중 폐기하고 DB에는 bounded global
  rate aggregate만 저장합니다.
- cookie와 browser visitor ID를 사용하지 않습니다.
- `추정 순 방문자`, page views, time series, popular pages, 기간·단위와
  aggregate consultation reference를 제공합니다.
- 자세한 설계는
  [`07-first-party-analytics-implementation-plan.md`](07-first-party-analytics-implementation-plan.md)를
  따릅니다.

Sites는 배포된 Site traffic을 별도로 자동 기록합니다. 공식 확인 범위는 total
unique visitors, total page views, 두 지표의 time series, date range와
granularity입니다.

현재 Analytics는 Enterprise workspace 소유 Site에서 제공되지 않습니다.
CLI·IDE와 현재 connector에는 analytics 조회 기능이 없으므로 Control admin으로
자동 import하거나 dashboard를 복제하지 않습니다.

Sites의 인기 페이지는 실제 account에서 제공될 때만 외부 baseline에
기록합니다. 자체 Analytics와 Sites 수치는 집계 방법이 다르므로 일치를
강제하지 않으며 개인 단위 attribution을 만들지 않습니다.

## SEO와 machine route

- 각 indexable page에 title, description, canonical과 reciprocal hreflang을
  제공합니다.
- 한국어 동등 페이지를 `x-default`로 사용합니다.
- consultation, privacy, marketing 안내와 404는 `noindex`입니다.
- service와 article의 JSON-LD 의미를 유지합니다.
- sitemap, RSS, robots와 ownership verification을 Sites에서 제공합니다.
- `/indexnow-key.txt`와 IndexNow 대상 URL은 custom domain 기준으로
  일치시킵니다.
- 완성된 copy와 visual이 확정된 뒤 승인된 social card만 사용합니다.

## 개인정보와 보안

- 상담 body는 browser에서 Control API로 직접 보냅니다.
- Sites source, runtime log, D1, R2, analytics와 browser storage에 상담 PII를
  저장하지 않습니다.
- third-party analytics SDK, visitor cookie, browser visitor ID와 fingerprint
  SDK를 추가하지 않습니다.
- custom page-view는 normalized public path만 전송하며 raw event 대신
  aggregate rollup과 fixed register sketch로 저장합니다.
- query, hash, referrer, page title, raw IP와 raw User-Agent를 저장하지
  않습니다.
- API response는 schema validation 후 표시합니다.
- 동의문 조회 실패 시 submit을 차단합니다.
- fixture와 placeholder 정책은 import 단계에서 거부합니다.
- 개인정보 처리방침은 Sites hosting과 실제 Control 데이터 흐름을
  설명합니다.
- PHI, 결제카드 정보, 민감 식별정보와 첨부를 받지 않습니다.

## source, version, 배포

```text
local implementation
  → 사용자 승인 검증
  → Site 생성 1회 / project_id 기록
  → 단기 credential로 exact source push
  → exact commit build/package
  → 같은 SHA/archive로 saved version 생성
  → owner-only access 확인
  → 별도 승인 후 owner-only production deploy
  → API/consent 준비
  → custom domain DNS 적용
  → domain active 확인
  → 별도 승인 후 public access
```

saved version은 배포가 아닙니다. 배포 상태가 terminal success가 된 뒤에만 URL을
사용합니다.

## cutover와 rollback

### application rollback

Sites regression이면 version 목록에서 이전 승인 saved version을 선택해
production에 다시 배포합니다.

해당 version이 다른 article manifest를 포함하면 먼저 대응 Control release를
active authority로 정렬합니다. equality와 exact article route를 확인하기
전에는 그 Sites source의 first-party Analytics client를 `false`로 둡니다.
그렇지 않으면 공개 article view가 Control route validation에서 422로
누락됩니다.

### host rollback

custom domain, access, API 또는 hosting 장애이면 기록한 DNS를 기존
Cloudflare Tunnel/Caddy/Astro origin으로 되돌립니다.

rollback 기간에는 다음을 유지합니다.

- 기존 Astro production release
- `www`의 legacy same-origin API/withdrawal Caddy route
- 신규 `api`와 `consent` host
- 일치하는 consent snapshot
- sitemap, RSS, robots와 ownership file

Control database와 admin은 이동하지 않으므로 database restore는 수행하지
않습니다.
