# ChatGPT Sites 공개 포털 마이그레이션 구현 계획

기준일: 2026-07-25  
문서 상태: 현재 서비스와 Sites 책임 분리 v1.6

**목표:** 현재 공개 포털의 디자인, 네 언어 콘텐츠, 실무 안내, 정책 화면과
상담 신청 UI를 독립 ChatGPT Sites source로 구현하고, 실제 상담·동의·철회는
분리된 기존 Control backend에 연결합니다.

**구조:** `www → Sites`, `api → Control public API`, `consent → Control
withdrawal`, `admin → Control admin`을 사용합니다. 현재 Astro 포털은 전환
완료 전까지 production과 rollback 대상으로 유지합니다.

**기술 기준:** 현재 Sites starter의 React, Next App Router 호환 vinext/Vite,
TypeScript, Worker-compatible ESM, 기존 Hono/SQLite Control backend와 Caddy/
cloudflared입니다.

## 실행 원칙

- 이 문서의 외부 Sites task는 아직 실행하지 않았습니다. 현재 main service의
  release-ID consent protocol만 별도 remediation 승인으로 구현 중이며 검증
  결과는 실행 후 운영 근거에 기록합니다.
- 각 승인 gate는 다음 gate의 권한을 포함하지 않습니다.
- 사용자에게 승인받지 않은 테스트, 브라우저 검증, 외부 Site 변경, DNS 변경,
  commit 또는 push를 실행하지 않습니다.
- 모든 Sites deployment는 production입니다.
- owner-only access는 production URL의 접근 제한이며 staging이 아닙니다.
- D1, R2와 SIWC를 추가하지 않습니다.
- Base migration에 제3자 analytics SDK, chart package, custom visitor
  cookie와 browser visitor ID를 추가하지 않습니다. 선택적 first-party
  adapter는 별도 승인 전 source와 deployment에 포함하지 않습니다.
- 상담 body를 Sites route handler나 server action으로 proxy하지 않습니다.
- fixture article·policy를 source, archive, version과 deployment에 넣지 않습니다.
- 현재 Astro와 Control을 삭제하거나 덮어쓰지 않습니다.

## root 표기

| 표기 | 기본 경로 | 역할 |
|---|---|---|
| `<CURRENT_ROOT>` | `/Users/wisdom/wisdom_project/gpt/wisdom_web_portal` | Astro, Control, shared, ops |
| `<SITES_ROOT>` | `/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal` | 독립 Sites source |

다른 worktree의 상대경로로 두 root를 다시 해석하지 않습니다.

---

## 현재 main service 선행 작업: release-ID consent protocol

이 작업은 standalone Sites source 생성이나 deployment와 무관하게 현재
Control 저장소에서 수행합니다.

- [x] `sites_release_handoffs` migration과 exact state/identity invariant
- [x] release ID별 consent GET과 release-bound form token
- [x] pending/default/bounded retiring intake authority
- [x] `sites-release prepare`, `record-deployment`, `activate`, `abort`
- [x] rollback state transition과 immutable audit history
- [x] 운영 절차 문서
- [x] 승인된 집중 테스트: 2026-07-25 Control 7 files, 80 tests 통과
- [x] 승인된 전체 검증: 2026-07-25 `npm run verify` exit 0
- [ ] 실제 Sites old/new/rollback drill

Sites source의 `consultation-adapter.ts`에 embedded release ID를 전달하는 변경,
source push, saved version과 deployment는 아래 task의 별도 승인을 받은
뒤에만 실행합니다. Control ledger 구현이 외부 Sites 변경 권한을 포함하지
않습니다.

---

## Task 0. Sites entitlement와 운영 조건 확인

**목적:** 구현 전에 현재 account/workspace에서 필요한 기능을 사용할 수 있는지
확인합니다.

**변경 파일:** 없음

**별도 승인 후 확인할 항목**

- [ ] Sites 기능 사용 가능 여부
- [ ] workspace의 public publishing 허용 여부
- [ ] custom domain 제공 여부
- [ ] Enterprise 정책 적용 여부
- [ ] Enterprise 소유 Site가 아닌지와 Sites Analytics 제공 여부
- [ ] Analytics 화면의 순 방문자, 페이지 조회, 추이, 기간과 granularity
- [ ] 실제 account에서 인기 페이지가 제공되는지
- [ ] 도메인 DNS 수정 권한
- [ ] existing Site와 `.openai/hosting.json` binding 유무
- [ ] 최종 공개 access가 anonymous `public`인지

**중단 조건**

- public publishing이 금지되어 있음
- custom domain이 필요한데 account/workspace에서 제공되지 않음
- 같은 local Site에 이미 다른 `project_id`가 binding되어 있음

이 task는 entitlement 확인만 수행하며 Site 생성이나 access 변경을 하지
않습니다. Enterprise 소유 Site에서 내장 Analytics가 제공되지 않으면 외부
baseline이 없는 것으로 기록하고 migration은 계속할 수 있습니다. 현재 서비스
Analytics 계획의 상태에는 영향을 주지 않습니다.

---

## Task 1. 독립 Sites source scaffold

**목적:** current monorepo와 분리된 빈 root에 현재 starter를 정확히 한 번
초기화합니다.

**생성 예정**

```text
<SITES_ROOT>/
  .openai/hosting.json
  app/
  worker/index.ts
  package.json
  package-lock.json
  vite.config.ts
  .env.example
```

**절차**

- [ ] `<SITES_ROOT>` 경로와 local 디렉터리 생성을 사용자에게 승인받습니다.
- [ ] target이 비어 있고 다른 `.git` 또는 source가 없는지 확인합니다.
- [ ] 현재 Sites initializer를 한 번 실행합니다.
- [ ] starter가 선택한 package manager, lockfile, scripts와 Worker entry를
  보존합니다.
- [ ] starter의 불필요한 preview UI는 기능 구현 task에서만 제거합니다.
- [ ] `.openai/hosting.json`은 다음 상태로 유지합니다.

```json
{
  "project_id": null,
  "d1": null,
  "r2": null
}
```

- [ ] `.env.example`에는 이름만 기록하고 실제 운영값이나 secret을 넣지
  않습니다.

**완료 결과**

- 독립 Git/source 경계
- starter lockfile
- 아직 외부 Site에 binding되지 않은 local source

**이 task에서 하지 않는 것**

- `create_site`
- source push
- version 저장
- deployment
- current monorepo workspace 변경

---

## Task 2. public source inventory와 provenance

**목적:** 현재 정식 public copy와 token만 Sites source로 옮기고 원본 identity를
기록합니다.

**참조**

- `<CURRENT_ROOT>/apps/site/src/content/site-content.ts`
- `<CURRENT_ROOT>/apps/site/src/lib/routes.ts`
- `<CURRENT_ROOT>/packages/shared/src/design-tokens.ts`
- `<CURRENT_ROOT>/apps/site/src/components`

**생성 예정**

```text
<SITES_ROOT>/content/source-provenance.json
<SITES_ROOT>/lib/site-content.ts
<SITES_ROOT>/lib/routes.ts
<SITES_ROOT>/app/globals.css
```

**절차**

- [ ] source repository의 exact commit SHA를 기록합니다.
- [ ] 네 locale의 public copy와 route allowlist를 복사합니다.
- [ ] design token을 CSS custom property로 변환합니다.
- [ ] 복사한 각 파일의 source path와 SHA-256을 provenance에 기록합니다.
- [ ] Node, Control, database, admin과 notification import가 없는지 범위를
  확인합니다.
- [ ] fixture와 prototype brochure asset을 거부 목록에 둡니다.

**결정**

- migration 초기에는 `packages/public-portal`을 새로 만들지 않습니다.
- Astro compatibility refactor를 하지 않습니다.
- 이후 copy 변경은 새 source commit과 provenance update로 관리합니다.

---

## Task 3. locale router와 전역 shell

**목적:** 64개 기본 공개 화면의 route resolution과 공통 header/footer를
구현합니다.

**생성·수정 예정**

```text
<SITES_ROOT>/app/layout.tsx
<SITES_ROOT>/app/page.tsx
<SITES_ROOT>/app/[...segments]/page.tsx
<SITES_ROOT>/app/not-found.tsx
<SITES_ROOT>/components/SiteHeader.tsx
<SITES_ROOT>/components/SiteFooter.tsx
<SITES_ROOT>/lib/routes.ts
<SITES_ROOT>/app/globals.css
```

**구현 항목**

- [ ] 한국어 unprefixed route와 세 locale prefix
- [ ] 15개 base route allowlist
- [ ] 6개 service slug allowlist
- [ ] locale-aware 404
- [ ] 같은 base route를 유지하는 locale link
- [ ] 번역이 없는 article의 locale link 억제
- [ ] desktop/mobile navigation
- [ ] skip link, landmark, focus-visible과 active navigation
- [ ] phone, email, blog, map과 consultation CTA

unknown route를 임의 콘텐츠로 처리하지 않고 404로 반환합니다.

---

## Task 4. 페이지와 디자인 구현

**목적:** 현재 Astro 포털의 public content hierarchy와 visual language를
Sites component로 재구현합니다.

**생성·수정 예정**

```text
<SITES_ROOT>/components/HomePage.tsx
<SITES_ROOT>/components/PublicPage.tsx
<SITES_ROOT>/components/ServiceDetail.tsx
<SITES_ROOT>/components/PolicyDocument.tsx
<SITES_ROOT>/app/globals.css
```

**구현 순서**

- [ ] Home
- [ ] About
- [ ] Services index와 6개 detail
- [ ] Process
- [ ] Insights shell
- [ ] Consultation shell
- [ ] Location
- [ ] Privacy와 marketing information page
- [ ] locale 404

**visual 계약**

- Bronze/Sand/Ivory/Brown/Ink/White
- sans body와 serif heading fallback
- 1180px main shell과 940px reading shell
- 각진 card/button과 가는 border
- 1120/860/700/420px responsive 의도
- `prefers-reduced-motion`
- CSS `智`와 지도 장식

정식 logo, portrait와 webfont가 승인되지 않으면 새 자산을 임의로 만들지
않습니다.

---

## Task 5. approved public snapshot importer

**목적:** fixture를 배제하고 Control의 승인된 article/policy snapshot만 Sites
source version에 포함합니다.

**생성 예정**

```text
<SITES_ROOT>/scripts/import-public-release.mjs
<SITES_ROOT>/lib/published-content.ts
<SITES_ROOT>/components/InsightsIndex.tsx
<SITES_ROOT>/components/PublishedArticle.tsx
<SITES_ROOT>/content/public-release/
<SITES_ROOT>/content/release-ledger.json
```

**입력 계약**

- 절대경로인 production snapshot
- immutable manifest
- file SHA-256
- article·consent schema
- 승인된 release ID

**importer 동작**

- [ ] symlink와 path escape를 거부합니다.
- [ ] fixture realpath와 placeholder canary를 거부합니다.
- [ ] manifest에 없는 파일과 hash mismatch를 거부합니다.
- [ ] unsafe article HTML을 거부합니다.
- [ ] locale, slug와 route collision을 거부합니다.
- [ ] deterministic output만 생성합니다.
- [ ] snapshot manifest SHA를 provenance와 release ledger에 기록합니다.

**rendering**

- locale별 insights 목록
- 승인 article detail
- article metadata와 structured data
- privacy/marketing policy의 exact title, version, effective date, retention과
  content hash

import가 성공해도 source push, saved version과 deployment를 자동으로
실행하지 않습니다.

---

## Task 6. Control origin과 Caddy/cloudflared 분리

**목적:** `www`가 Sites를 향해도 상담 API, withdrawal과 admin이 기존
Control에서 동작하게 합니다.

**주요 수정 후보**

```text
<CURRENT_ROOT>/apps/control/src/config.ts
<CURRENT_ROOT>/apps/control/src/server.ts
<CURRENT_ROOT>/apps/control/src/app.ts
<CURRENT_ROOT>/apps/control/src/notification-worker.ts
<CURRENT_ROOT>/apps/control/src/notifications/worker.ts
<CURRENT_ROOT>/apps/control/src/withdrawal/service.ts
<CURRENT_ROOT>/packages/shared/src/environment.ts
<CURRENT_ROOT>/ops/caddy/Caddyfile.template
<CURRENT_ROOT>/ops/cloudflared/config.yml.template
<CURRENT_ROOT>/ops/lib/runtime-config.mjs
<CURRENT_ROOT>/ops/launchd/*.plist.template
```

**설정 분리**

- [ ] `SITE_ORIGIN`
- [ ] `API_ORIGIN`
- [ ] `WITHDRAWAL_ORIGIN`
- [ ] `ADMIN_ORIGIN`
- [ ] `FORM_ALLOWED_ORIGINS`

기존 `PUBLIC_ORIGIN`을 migration 기간 compatibility alias로 유지할지 구현
직전에 확정합니다.

**host routing**

- [ ] `api` host에는 public API와 승인 health route만 허용합니다.
- [ ] `consent` host에는 withdrawal landing/confirm만 허용합니다.
- [ ] `admin` host 경계를 유지합니다.
- [ ] legacy `www` same-origin API/withdrawal route는 rollback 기간에
  유지합니다.
- [ ] cloudflared ingress에 API와 consent host를 추가합니다.

**CORS**

- [ ] consent GET, consultation POST와 필요한 OPTIONS를 구현합니다.
- [ ] exact Origin allowlist를 사용합니다.
- [ ] `Access-Control-Allow-Origin`과 `Vary: Origin`을 정확히 설정합니다.
- [ ] `GET`, `POST`, `OPTIONS`만 허용합니다.
- [ ] `Content-Type`, `Idempotency-Key`만 허용합니다.
- [ ] wildcard와 credentials를 사용하지 않습니다.
- [ ] disallowed Origin, host와 route는 명시적으로 거부합니다.

**withdrawal**

- [ ] 신규 capability URL을 `WITHDRAWAL_ORIGIN`으로 발급합니다.
- [ ] token path access log를 끕니다.
- [ ] `no-store`, `no-referrer`, `noindex`를 유지합니다.
- [ ] public-only confirm shell에서 admin navigation을 제거합니다.

운영 host, tunnel과 launchd 변경은 코드 구현과 별도의 운영 승인 후에만
적용합니다.

---

## Task 7. Sites 상담 form과 direct API adapter

**목적:** 현재 계약을 유지하면서 browser가 Control API를 직접 호출하게
합니다.

**생성·수정 예정**

```text
<SITES_ROOT>/components/ConsultationForm.tsx
<SITES_ROOT>/lib/consultation-adapter.ts
<SITES_ROOT>/.env.example
<SITES_ROOT>/app/[...segments]/page.tsx
```

**runtime config**

- [ ] `PUBLIC_CONSULTATION_API_ORIGIN`을 server-render 단계에서 읽습니다.
- [ ] HTTPS exact origin인지 확인합니다.
- [ ] 필요한 공개 origin만 client component에 전달합니다.
- [ ] secret과 credential은 전달하지 않습니다.

**form 동작**

- [ ] locale별 consent documents와 form token을 API에서 조회합니다.
- [ ] 조회 완료 전 consent와 submit을 disabled 처리합니다.
- [ ] shared contract와 동일한 client validation을 구현합니다.
- [ ] 같은 body 재시도에는 같은 idempotency key를 사용합니다.
- [ ] body가 바뀌면 새 idempotency key를 사용합니다.
- [ ] `credentials: "omit"`으로 API origin에 직접 전송합니다.
- [ ] schema-valid `201` receipt만 성공으로 처리합니다.
- [ ] stale consent에서 선택을 초기화하고 새 문서를 표시합니다.
- [ ] timeout, network, validation, rate limit과 server error를 locale별로
  구분합니다.

**고지**

- 민감 식별번호 입력 금지
- PHI와 결제카드 정보 입력 금지
- 첨부 미지원
- JavaScript 미사용 시 전화·이메일 대체 경로

Sites server, D1, R2, storage와 analytics는 form body를 받지 않습니다.

---

## Task 8. metadata, machine route와 social card

**목적:** 기존 검색·공유 의미를 Sites에 유지합니다.

**생성·수정 예정**

```text
<SITES_ROOT>/lib/metadata.ts
<SITES_ROOT>/app/sitemap.ts
<SITES_ROOT>/app/robots.ts
<SITES_ROOT>/app/rss.xml/route.ts
<SITES_ROOT>/app/indexnow-key.txt/route.ts
<SITES_ROOT>/public/og.png
<SITES_ROOT>/app/layout.tsx
```

**구현 항목**

- [ ] `PUBLIC_SITE_ORIGIN` 기반 canonical
- [ ] reciprocal hreflang과 한국어 x-default
- [ ] consultation/privacy/marketing/404 noindex
- [ ] `ProfessionalService`, `Person`, `Service`, `Article`,
  `BreadcrumbList`
- [ ] sitemap, RSS와 robots
- [ ] 승인된 Naver/Google ownership value
- [ ] custom domain 기준 IndexNow key와 대상 URL

**social card 승인 단위**

copy와 visual이 확정된 뒤 Sites 지침에 따라 image generation을 정확히 한 번
실행합니다. 생성 이미지의 글자를 확인하고 사용할 수 없을 때만 한 번
재생성합니다. 검수된 결과만 `public/og.png`로 저장합니다.

---

## Task 9. content release ceremony와 cutover blockers

**목적:** Control publish와 Sites version이 달라지는 상태를 막고 기존
withdrawal link를 보호합니다.

**주요 생성·수정 후보**

```text
<CURRENT_ROOT>/apps/control/src/articles/publication-release.ts
<CURRENT_ROOT>/apps/control/src/articles/publication-snapshot.ts
<CURRENT_ROOT>/apps/control/src/articles/sites-release-handoff.ts
<CURRENT_ROOT>/docs/operations/sites-publication.md
<SITES_ROOT>/content/release-ledger.json
```

**두 단계 publication**

- [ ] 승인 콘텐츠로 pending immutable snapshot을 만듭니다.
- [ ] Control consent authority와 IndexNow는 아직 활성화하지 않습니다.
- [ ] Sites importer가 pending snapshot을 source에 포함합니다.
- [ ] source push와 saved version을 만듭니다.
- [ ] 승인 후 version을 배포합니다.
- [ ] deployed Site의 release identity를 확인합니다.
- [ ] 그 다음 Control authority와 IndexNow를 활성화합니다.
- [ ] Control release와 Sites version/deployment identity를 ledger에
  기록합니다.

Control backend에서 Sites를 무인 배포하는 credential이나 자동화 API를
가정하지 않습니다. 운영자 주도 ceremony를 문서화합니다.

**legacy withdrawal hard gate**

- [ ] 기존 `www` capability 중 미사용·미만료 건수를 확인합니다.
- [ ] 실발송 link가 존재하는지 확인합니다.
- [ ] 신규 발송이 `consent` origin으로 전환된 시각을 기록합니다.
- [ ] 10분 confirmation session이 없는 maintenance window를 선택합니다.
- [ ] legacy link가 남아 있으면 cutover를 중지하고 만료·호환 전략을 별도
  승인받습니다.

**content freeze**

release ceremony가 준비되지 않은 기간에는 article·policy publish를
중지합니다. policy-only release도 예외로 두지 않습니다.

---

## Task 10. 승인된 검증

**목적:** 구현 완료 뒤 사용자가 승인한 범위만 검증합니다.

현재는 아래 항목을 실행하지 않았습니다.

### 후보 범위

- Sites source typecheck
- route/content unit test
- production build와 package shape
- current Control origin/CORS/withdrawal test
- consultation staging receipt
- 320px/1440px 핵심 화면
- keyboard, focus, semantic와 selected accessibility check
- locale overflow
- canonical/hreflang/sitemap/RSS/robots
- source에 fixture/secret/PII가 없는지 확인
- release identity와 rollback rehearsal

### 승인 시 확인할 핵심 결과

- `dist/server/index.js` 존재
- package archive에 `dist/.openai/hosting.json` 존재
- D1/R2 binding이 `null`
- form body가 Sites request path를 통과하지 않음
- API CORS가 exact origin만 허용
- 64개 기본 route와 승인 article route가 예상 상태
- fixture canary가 output에 없음
- 별도 analytics/차트 package와 visitor cookie가 없음
- page-view payload에 query, referrer, browser visitor ID와 상담 PII가 없음
- Control DB에 raw event, raw IP·UA와 장기 visitor hash가 없음

브라우저를 열거나 외부 production URL을 호출하는 검증은 별도 명시 승인을
받습니다.

---

## Task 11. 외부 Site 생성과 production environment

**목적:** 검증된 local source를 하나의 Sites project에 정확히 binding합니다.

**사전 조건**

- Task 0 entitlement 통과
- 구현 완료
- 승인된 검증 완료
- `<SITES_ROOT>/.openai/hosting.json` 확인

**절차**

- [ ] 사용자에게 외부 Site 생성 승인을 받습니다.
- [ ] `project_id`가 `null`인지 다시 확인합니다.
- [ ] Site를 정확히 한 번 생성합니다.
- [ ] 반환된 opaque Site ID를 변형하지 않고 `project_id`에 기록합니다.
- [ ] D1/R2가 `null`인지 유지합니다.
- [ ] 새 Site의 access가 owner/admin 범위인지 읽어서 확인합니다.
- [ ] owner-only가 아니면 별도 access-update 승인을 받은 뒤 `custom`
  owner-only로 설정합니다.
- [ ] production env에 `PUBLIC_SITE_ORIGIN`과
  `PUBLIC_CONSULTATION_API_ORIGIN`을 설정합니다.
- [ ] runtime env를 source 또는 hosting file에 복사하지 않습니다.
- [ ] environment revision을 기록합니다.

이 task는 source push, version 저장과 deployment를 포함하지 않습니다.

---

## Task 12. exact source push와 saved version

**목적:** 동일한 source state를 원격 source, archive와 saved version에
일치시킵니다.

**사전 조건**

- Task 11의 project binding
- 사용자 source/version 승인
- 의도한 local commit만 존재

**절차**

- [ ] `.openai/hosting.json`의 `project_id`를 다시 읽습니다.
- [ ] 현재 Site용 단기 source repository write credential을 발급합니다.
- [ ] credential을 파일, remote URL, shell history 또는 로그에 저장하지
  않습니다.
- [ ] per-command authentication으로 exact branch HEAD를 push합니다.
- [ ] push된 exact commit SHA를 기록합니다.
- [ ] 같은 commit에서 production build를 만듭니다.
- [ ] 현재 Sites packaging 도구로 source archive를 만듭니다.
- [ ] archive의 `dist/server/index.js`, hosting metadata와 필요한 migration
  파일을 확인합니다.
- [ ] push된 commit SHA와 같은 source archive로 version을 저장합니다.
- [ ] version ID, commit SHA, archive identity와 environment revision을
  release ledger에 기록합니다.

saved version은 배포하지 않은 상태입니다. 이 task 완료를 production URL
생성으로 표현하지 않습니다.

---

## Task 13. owner-only production deployment

**목적:** 공개 트래픽 전환 없이 접근이 제한된 production URL을 만듭니다.

**사전 조건**

- 사용자에게 owner-only production deployment임을 명시하고 승인받음
- access가 owner-only임을 확인
- 배포할 saved version ID 확정

**절차**

- [ ] owner-only production deployment를 실행합니다.
- [ ] 결과가 non-terminal이면 상태를 확인합니다.
- [ ] terminal success일 때만 deployment URL을 기록합니다.
- [ ] environment revision이 적용된 deployment인지 기록합니다.
- [ ] 사용자가 별도 승인한 경우에만 production URL을 브라우저로 엽니다.
- [ ] generated Sites origin을 기록하되 Control CORS 변경은 이 deployment
  task에 포함하지 않고 Task 14의 consultation/API 운영 승인에서
  처리합니다.
- [ ] 별도 승인되지 않은 first-party Analytics client가 source와 deployment에
  포함되지 않았는지 확인합니다.

이 URL은 private preview가 아니라 access-restricted production입니다.

---

## Task 14. API/consent 운영 준비와 custom domain

**목적:** Sites custom domain을 공개하기 전에 외부 Control 경로와 DNS를
준비합니다.

**별도 운영 승인 항목**

- [ ] API/consent cloudflared ingress
- [ ] Caddy host routing
- [ ] Control runtime origin 설정
- [ ] 신규 withdrawal capability host
- [ ] exact CORS allowlist
- [ ] API/Sites health monitor 분리

**custom domain 절차**

- [ ] 사용자에게 대상 domain 추가와 DNS 변경을 승인받습니다.
- [ ] published Site에 custom domain을 추가합니다.
- [ ] Sites가 반환한 실제 CNAME/A/검증 record를 기록합니다.
- [ ] 해당 record만 DNS에 적용합니다.
- [ ] domain 상태를 갱신해 active를 확인합니다.
- [ ] canonical, machine route와 API/consent host가 같은 release를 가리키는지
  승인된 범위에서 확인합니다.

DNS value를 문서나 코드에서 추측하지 않습니다.

---

## Task 15. anonymous public access와 traffic cutover

**목적:** 준비된 custom domain을 최종 공개 포털로 전환합니다.

**hard gate**

- workspace public publishing 허용
- custom domain active
- legacy `www` withdrawal capability 해결
- content release ceremony 준비
- Astro rollback target 보존
- 사용자 최종 승인

**절차**

- [ ] Site access를 `public`으로 변경합니다.
- [ ] custom domain의 실제 traffic 상태를 확인합니다.
- [ ] 사용하지 않는 generated Sites origin을 Control CORS allowlist에서
  제거할지 별도 승인받습니다.
- [ ] deployment, Site version, Control release와 DNS identity를 기록합니다.
- [ ] 기존 Astro release와 DNS 복귀값을 안정화 기간 동안 보존합니다.

SIWC 또는 ChatGPT login을 요구하지 않습니다.

---

## Task 16. Sites 내장 Analytics baseline과 선택적 adapter

**목적:** 공개된 Site의 내장 Analytics 제공 범위를 기록합니다. 현재 서비스
collector 연동은 필요할 때만 별도 승인으로 수행합니다.

Control schema, aggregate collector, KPI와 React 관리자 화면은 이 task의
범위가 아니며
[`2026-07-24-first-party-analytics.md`](../superpowers/plans/2026-07-24-first-party-analytics.md)의
독립된 현재 서비스 작업입니다. 구현 여부가 Sites migration을 차단하지
않습니다.

**생성 예정**

```text
<CURRENT_ROOT>/docs/gpt-sites-migration/07-sites-analytics-review-log.md
```

**A. Sites 내장 Analytics baseline**

- [ ] Task 15의 public cutover 이후에만 baseline 기록을 시작합니다.
- [ ] ChatGPT web 또는 desktop에서 Site의 `More actions → Analytics`를
  엽니다.
- [ ] total unique visitors와 page views가 표시되는지 확인합니다.
- [ ] 두 지표의 time series가 표시되는지 확인합니다.
- [ ] date range와 granularity 변경이 가능한지 확인합니다.
- [ ] 인기 페이지가 실제 화면에 제공되는지 별도로 기록합니다.
- [ ] 첫 비교 가능한 7일 구간을 baseline으로 기록합니다.
- [ ] period, granularity, 측정 시각과 제한사항을
  `07-sites-analytics-review-log.md`에 기록합니다.

현재 account에 Analytics가 없으면 미제공 사실만 기록하며 migration 실패로
처리하지 않습니다.

**B. 선택적 first-party adapter**

다음 조건을 모두 충족한 경우에만 별도 승인으로 진행합니다.

- 현재 서비스 first-party Analytics가 별도 계획으로 구현·검증·배포됨
- Task 15 public cutover가 완료되고 기존 Astro public traffic이 종료됨
- final public Sites origin과 개인정보 처리방침 검토 완료
- Sites client adapter, Control host/CORS와 활성화 범위 별도 승인

승인된 작업은 다음 경계만 사용합니다.

- [ ] existing collector wire contract와 동일한 최소 payload를 사용합니다.
- [ ] cookie, browser visitor ID, query, hash, referrer와 retry를 추가하지
  않습니다.
- [ ] final public Sites origin만 Control exact CORS에 추가합니다.
- [ ] 선택적 client flag와 API origin을 Sites runtime env에 추가합니다.
- [ ] 새 saved version을 만든 뒤 별도 승인으로 production에 배포합니다.
- [ ] 선택 route의 page-view before→after delta만 확인합니다.
- [ ] owner-only generated origin의 traffic은 수집하지 않습니다.

**공통 운영 경계**

- CLI, IDE와 connector에서 Sites Analytics 자동 조회를 시도하지 않습니다.
- 공식 지원이 확인되지 않은 Sites API, export와 scraping을 사용하지
  않습니다.
- 지표를 근거로 콘텐츠나 UX를 자동 수정하지 않고 별도 승인을 받습니다.
- Sites baseline 정의는
  [`06-sites-analytics-baseline.md`](06-sites-analytics-baseline.md)를
  따릅니다.

---

## Task 17. rollback과 안정화

### application rollback

- [ ] 이전 승인 Sites saved version을 찾습니다.
- [ ] 사용자 승인 후 해당 version을 production에 재배포합니다.
- [ ] deployment status와 environment revision을 기록합니다.

### host rollback

- [ ] 사용자 승인 후 `www` DNS를 기록된 Cloudflare Tunnel/Caddy/Astro
  target으로 되돌립니다.
- [ ] legacy same-origin API/withdrawal route를 사용합니다.
- [ ] Control database restore는 수행하지 않습니다.
- [ ] 신규 API/consent host는 원인 분석 기간 동안 유지합니다.

### 안정화 종료

다음 항목은 별도 사용자 결정 전에는 제거하지 않습니다.

- Astro public release
- legacy Caddy route
- Sites 이전 saved version
- release ledger
- API/consent host

---

## dependency 요약

```text
Task 0 entitlement
  → Task 1 standalone source
  → Task 2~5 Sites content/UI
  → Task 6~9 Control integration and release compatibility
  → Task 10 approved verification
  → Task 11 Site binding/env/access
  → Task 12 source push/saved version
  → Task 13 owner-only production deployment
  → Task 14 custom domain
  → Task 15 public access/cutover
      ├─→ Task 16 Sites built-in Analytics baseline
      └─→ Task 17 stabilization/rollback

Task 15 + independently active current-service Analytics
  └─→ Task 16 optional adapter (separate approval)
```

Task 17의 rollback 절차는 장애가 발생하면 Task 13 이후 어느 시점에서든
우선 실행할 수 있습니다.

## 즉시 다음 승인 단위

Sites migration의 다음 최소 실행 요청은 **Task 0의 entitlement 확인**입니다.
그 결과를 확인한 뒤에만 독립 source root 생성을 요청합니다.

현재 서비스 성과지표 구현은 이 migration의 다음 task가 아니며 별도
[`2026-07-24-first-party-analytics.md`](../superpowers/plans/2026-07-24-first-party-analytics.md)에서
독립적으로 승인합니다.
