# 리뷰 6 · 포털 중심 전체 코드 리뷰 (2026-07-25)

| 항목 | 내용 |
|---|---|
| 대상 | `2026-07-22-claude-admin-jsx-ssr` (HEAD `8da5cfd`) · 운영 소스 약 **44,900줄** |
| 방식 | 코드 전체 정독 + 테스트 직접 실행 + 후보 결함 실행 재현. 포털 기능 중심으로 정리 |
| 결과 | **Critical 2 · Important 3 · Minor 6** |
| 해소 | `19ef015`(Critical) · `cc91065`(Important) · `fa82f41`(Minor) — Minor 2건은 근거를 남기고 미수정 |

행 번호는 리뷰 시점(`8da5cfd`) 기준입니다.

## 1. 리뷰 시점 검증 실행 결과

| 워크스페이스 | 결과 |
|---|---|
| `@wisdom/shared` | 70/70 통과 |
| `@wisdom/site` | 101/101 통과 |
| `@wisdom/control` | 490 통과 / **1 실패** (`test/publication-search-boundary.test.mjs`) |
| Ops (`npm run test:ops`) | 232 통과 / **1 실패** (`ops/tests/runtime-launch.test.mjs:134`) |

README(46행)가 기록한 "control 415/415, Ops 203 pass·0 fail" 상태는 이 시점에 더 이상 유효하지 않았습니다. **실패 2건 모두 환경 문제가 아니라 실제 결함**이며, 아래 Critical 2건이 그 원인입니다.

## 2. 포털 기능 구조 (리뷰 과정에서 정리)

### 공개 포털 — `apps/site` (Astro 정적 생성, 68페이지)

```
[...path].astro ─ 4개 언어(ko / en / zh-hans / zh-hant) × 15개 라우트
  layouts/BaseLayout.astro     canonical·hreflang·x-default·JSON-LD·RSS·theme-color
  components/                  HomePage / ConsultationForm / PublishedArticle / InsightsIndex
  lib/routes.ts                CONTENT_ROUTES 15개 (홈·서비스 6종·상담·인사이트·정책 등)
  lib/analytics-beacon.ts      쿠키리스 페이지뷰 비콘 (#analytics-toggle 로 운영자 제외)
  lib/form-validation.ts       상담 폼 클라이언트 검증
  motion/reveal-controller     최초 1회 리빌 모션 (reduced-motion 대응)
  search/                      sitemap·RSS·robots·JSON-LD·품질 게이트·소유권 검증
```

### 공개 API — `apps/control/src/app.ts` (127.0.0.1 바인딩)

| 라우트 | 보호 장치 |
|---|---|
| `GET /api/v1/consent-documents` | 로케일 검증, IP 버킷당 60회/분, 폼 토큰 발급 |
| `POST /api/v1/pageview` | Origin, 봇 UA, DNT/Sec-GPC, prefetch, 1KiB, 경로 allowlist, 60회/10분·1000회/일 |
| `POST /api/v1/consultations` | Origin, Idempotency-Key, 32KiB, 폼 토큰, honeypot, 동의 버전 대조, IP·전화·이메일 3축 제한 |
| `GET /marketing/withdraw/:token` | 계정 없는 43자 capability → landing 쿠키 → 원샷 POST |
| `POST /internal/v1/article-drafts` | loopback 전용 + 프록시 헤더 거부 + HMAC 서명 + nonce 재생 방지 |

### 상담 접수 — `consultations/service.ts`

단일 `BEGIN IMMEDIATE` 안에서 **멱등성 조회 → 동의 권위 확인 → 폼 토큰 검증 → 활성 동의문 대조 → 속도 제한 → 상담 저장 → 동의 이벤트 2건 → 아웃박스 → 감사 로그 → 멱등성 키**를 원자적으로 처리합니다. PII는 AES-256-GCM 봉투로만 저장하고, 전화·이메일 정확 검색은 HMAC 블라인드 인덱스로 제한합니다.

### 관리자 — `admin/routes.ts` + `admin/ui/` JSX SSR

Argon2id → TOTP/복구 코드 → `__Host-` 세션 쿠키(절대 8h / 유휴 30m), 모든 POST에 strict Origin + HMAC 바인딩 CSRF. 화면: 대시보드 / 상담 목록·상세·연락처 검색 / 방문 통계 / 글 검토·번역·발행 / 릴리스·롤백 / 알림 설정 / 발송 실패 / 동의문 / 상태.

### 콘텐츠·발행 — `articles/`

Hermes 초안 → immutable revision → Codex CLI 번역(읽기 전용·no-shell·PII 가드) → 언어별 승인 → 글 + 활성 동의문 8개를 하나의 snapshot으로 봉인 → 임시 빌드·manifest 검증 → `public-current` 원자 전환 → IndexNow outbox.

### 방문 통계 (신규 5개 커밋)

`site 비콘 → app.ts 수용 → analytics/store.ts 저장 → queries.ts 집계 → 관리자 대시보드 → cli/purge.ts 파기`. 방문자 식별은 **일 단위 salt HMAC(절단 IP + UA)** 이고 salt는 익일 파기되어 교차일 연결이 불가능합니다. 집계는 25개월 보존.

---

## 3. 발견 사항

### 🔴 C-1. 운영 런타임 설정 파서가 자기 템플릿을 거부 — 배포 차단

`ops/lib/runtime-config.mjs:6` `RUNTIME_KEYS` 허용 목록에 `ANALYTICS_DATABASE_PATH`가 없는데, `ops/config/runtime.env.template:6`은 이 키를 설정합니다. `parseRuntimeConfig`가 `RUNTIME_CONFIG_REJECTED`로 예외를 던집니다(`runtime-config.mjs:58`).

```
Error: Runtime config contains an unknown, duplicate, or empty entry
  at parseRuntimeConfig (ops/lib/runtime-config.mjs:58:7)  ← ops/tests/runtime-launch.test.mjs:134
```

런타임 설정을 읽는 launchd 서비스(control·워커·monitor) **전부가 기동에 실패**합니다. 커밋 `8da5cfd`가 템플릿에만 키를 추가하고 허용 목록을 누락한 결과입니다.

**처리 (`19ef015`)**: `RUNTIME_KEYS`에 `ANALYTICS_DATABASE_PATH` 추가(현재 `ops/lib/runtime-config.mjs:9`). 저장소가 배포하는 템플릿이 자기 파서를 통과합니다.

### 🔴 C-2. 발행 빌드의 PATH에 `sh`가 없어 발행이 항상 실패

`apps/control/src/articles/publication-build.ts:222`가 자식 프로세스 PATH를 `dirname(input.nodeBinary)` 한 곳으로 제한합니다. npm은 lifecycle 스크립트를 `sh -c`로 실행하므로, `NODE_BINARY`가 있는 디렉터리에 `sh`가 없으면 빌드가 시작조차 못 합니다. **이 장비에서 그대로 재현**했습니다:

```
status: 254
npm error code ENOENT
npm error syscall spawn sh
npm error enoent spawn sh ENOENT
→ publication-build.ts:231 throw new Error("PUBLICATION_BUILD_FAILED")
```

운영 템플릿이 상정하는 `NODE_BINARY=/opt/homebrew/bin/node`에도 `sh`가 없어 **관리자 발행 버튼이 매번 `PUBLICATION_BUILD_FAILED`로 끝납니다.** `/usr/bin`·`/bin`이 우연히 node를 담고 있는 환경에서만 통과하므로 지금까지 드러나지 않았습니다. 같은 저장소의 `articles/codex-executor.ts:280`은 이미 `PATH = "/usr/bin:/bin"`을 쓰고 있어 내부적으로도 일관되지 않았습니다.

**처리 (`19ef015`)**: `isolatedBuildPath()` 헬퍼를 추가해 격리 자식 PATH에 `/usr/bin`·`/bin`을 포함(중복은 Set 제거, 구분자는 `path.delimiter`). 현재 `publication-build.ts:163`·`:233`. `publication-search-boundary.test.mjs`가 샌드박스 환경에서 실제 Astro 빌드를 완주하며 통과합니다.

### 🟠 I-1. 유입 경로(referrer)에 allowlist가 없어 카디널리티 무제한

`analytics/paths.ts:63` `referrerOriginFrom`은 http(s)·128자 이하이기만 하면 임의 origin을 그대로 반환하고, `analytics/store.ts:56`의 `analytics_referrer_days`는 `(day, referrer_origin)`이 기본키입니다. 경로(`p`)는 발행 라우트 allowlist로 엄격히 막혀 있는데 유입 경로만 열려 있습니다. 비콘 속도 제한이 IP 버킷당 일 1000건이므로 **하나의 /24에서 하루 1000개의 고유 referrer 행**을 생성할 수 있고, 25개월간 누적됩니다. 고전적인 referrer 스팸으로 관리자 "유입 경로" 표가 무력화됩니다. 표시 자체는 JSX 이스케이프로 XSS 위험 없음.

**처리 (`cc91065`)**: `recordReferrer()` 도입 — 일 **200개** origin으로 제한하고 초과분은 `(other)` 단일 버킷으로 접습니다. 괄호는 URL origin에 나올 수 없어 라벨 위조가 불가능하며, **조회수 총합은 보존**됩니다(테스트로 402건 = 402건 확인). 직접 방문(`""`)은 상한에서 면제해 기준선이 밀려나지 않습니다. 관리자 화면에는 `referrerOriginLabel()`로 "기타(집계 상한 초과)"를 표시합니다. 하루 최대 202행으로 저장이 고정됩니다.

### 🟠 I-2. 방문 통계 저장소가 백업에서 제외되어 있고, 그 근거 설명이 사실과 다름

`ops/config/runtime.env.template:4`와 `ops/runbooks/deployment.md:22`가 `analytics.db`를 "재생성 가능(regenerable)"하다며 암호화 백업 대상에서 의도적으로 제외합니다. 그러나 원본 요청은 즉시 폐기되므로 **집계 수치는 재생성이 불가능**합니다. 디스크 장애 시 정책 문서가 약속한 25개월치 통계가 복구 불가로 소실됩니다. 제외 자체는 선택 가능하지만 근거 문구는 정정이 필요합니다.

**처리 (`cc91065`)**: 템플릿과 배포 런북의 표현을 사실대로 정정 — 개인정보가 없고 상담 업무에 영향이 없어 제외하지만 **집계는 재생성 불가이며 디스크 장애 시 최대 25개월치가 복구 없이 소실**된다는 점, 이력 보존이 필요해지면 백업에 편입해야 한다는 조건을 명시.

### 🟠 I-3. 공개 라우트 목록이 두 워크스페이스에 복제되어 있고 드리프트 방지 장치 없음

`apps/site/src/lib/routes.ts:3`의 `CONTENT_ROUTES` 15개와 `apps/control/src/config.ts:42`의 `PUBLIC_CONTENT_ROUTES` 15개가 완전히 동일한 리터럴입니다. `apps/site/src/lib/routes.test.ts:25`는 site 쪽 사본만 자기 워크스페이스 리터럴에 고정할 뿐, 두 목록을 묶는 테스트가 없습니다. 새 페이지를 site에만 추가하면 `classifyPageviewPath`가 `undefined`를 반환해 해당 페이지의 조회수가 **204로 조용히 버려집니다.** 실패가 드러나지 않는 종류의 드리프트입니다.

**처리 (`cc91065`)**: `packages/shared/src/public-routes.ts`를 신설해 `PUBLIC_CONTENT_ROUTES`를 유일한 정의로 만들고, Site(`routes.ts`)와 Control(`config.ts`, `analytics/paths.ts`)이 모두 이를 import하도록 변경. 리터럴 복제가 사라져 드리프트가 **구조적으로 불가능**해졌고, "발행된 모든 라우트가 4개 언어에서 집계 대상으로 분류되는가"를 검증하는 테스트를 추가했습니다.

### 🟡 M-1. 통계 날짜 파라미터가 형식만 맞으면 통과 → 503

`analytics/queries.ts:19` `shiftDay`가 형식만 맞는 불가능한 날짜에서 `RangeError`를 던집니다. `/admin/analytics?from=2026-00-00&to=2026-07-25`는 `dayPattern`과 `from <= to`를 통과하고, `daySpan`이 `NaN`이라 400일 클램프도 우회한 뒤 `siteSeries`의 제로필 루프에서 `new Date(NaN).toISOString()`으로 터집니다 → `app.onError`가 503 반환. **직접 실행해 확인**했습니다. 관리자 세션이 필요하고 `<input type="date">`로는 만들 수 없어 영향은 제한적입니다.

**처리 (`fa82f41`)**: `isCalendarDay()`를 추가해 날짜 입력을 왕복 검증(`queries.ts:25`, `admin/routes.ts:609`). `2026-00-00`(RangeError→503)뿐 아니라 `2026-02-30`이 3월 2일로 조용히 밀려 **요청하지 않은 구간을 보여주던 문제**까지 함께 차단합니다.

### 🟡 M-2. `RenderedElement` 타입이 처리 못 하는 입력을 허용

`admin/ui/render.ts:8`의 `RenderedElement` 타입은 `Promise<HtmlEscapedString>`을 허용하는데 구현은 `String(node)`뿐이라, 비동기 컴포넌트가 하나라도 생기면 화면에 `[object Promise]`가 출력됩니다. 현재 모든 컴포넌트가 동기라 잠재 결함.

**처리 (`fa82f41`)**: `renderToHtml`이 Promise를 받으면 조용히 `[object Promise]`를 출력하는 대신 즉시 예외를 던집니다.

### 🟡 M-3. 환경 변수 문서 불일치

README.md:86이 `PUBLIC_ORIGINS`("쉼표로 구분한 HTTPS 원본 허용 목록")를 운영 필수 항목으로 기재하지만 코드·`.env.example`·ops 어디에도 존재하지 않습니다. 실제 구현은 단일 `PUBLIC_ORIGIN` 하나뿐입니다(`config.ts:281` `allowedOrigins: [publicOrigin]`). 반대로 `ANALYTICS_DATABASE_PATH`는 `.env.example`에 누락되어 있습니다.

**처리 (`fa82f41`)**: 존재하지 않는 `PUBLIC_ORIGINS` 항목 제거, `ANALYTICS_DATABASE_PATH`를 README(`README.md:87`)·`.env.example`(7행)에 문서화.

### 🟡 M-4. 분석 DB 경로만 검증 정책에서 이탈

`config.ts:267`의 `ANALYTICS_DATABASE_PATH`는 같은 파일 `publicationPath`와 달리 절대경로·단일행 검증을 받지 않고, `store.ts:75`가 그 상위 디렉터리를 `mkdirSync(recursive)`로 만듭니다. 운영자 제어 값이라 위험도는 낮지만 검증 정책이 불일치합니다.

**처리 (`fa82f41`)**: `parseAnalyticsDatabasePath()`로 절대 경로·단일 행을 강제(`config.ts:60`). 이 경로의 상위 디렉터리가 `mkdirSync(recursive)`로 생성되므로 데이터 루트 밖 쓰기를 막는 의미가 있습니다.

### 🟡 M-5. 비콘 1건당 `ensureDailySalt` 2회 호출 — **미수정**

`pageviewRateLimited` + `recordPageview`가 각각 `ensureDailySalt`(`store.ts:109`)를 호출해 `DELETE` + `INSERT OR IGNORE` + `SELECT`가 매 요청 중복 실행됩니다. 현재 트래픽 규모에서는 무해하나 불필요한 쓰기입니다.

**미수정 근거**: 이 규모 트래픽에서 이득이 미미한 반면 `store.ts` 공개 API를 건드려야 해 위험 대비 효용이 낮습니다.

### 🟡 M-6. 상담 속도 제한이 폼 토큰·동의문 검증 이후에 적용 — **미수정**

`consultations/service.ts:265`. 폼 토큰 검증에 실패하는 요청은 ROLLBACK되어 카운트되지 않으므로 무제한 반복이 가능합니다. 토큰 발급 쪽에 별도 제한(`app.ts:341`)이 있고 비용이 낮아 실질 위험은 작습니다.

**미수정 근거**: 순서를 바꾸면 토큰이 만료된 정상 사용자가 제한 예산을 소모하게 되어 오히려 나빠집니다. 현 설계가 합리적이라 판단했습니다.

---

## 4. 총평 (리뷰 시점)

보안·개인정보 설계의 핵심부는 이 규모의 프로젝트에서 보기 드물게 견고합니다. PII 봉투 암호화는 AAD를 상담 ID에 바인딩하고 HKDF로 목적별 키를 분리했으며, SMTP는 발송 시점 DNS 전수 검증·공개 IP 고정·원 FQDN SNI로 SSRF와 rebinding을 함께 막고, Hermes 인테이크는 loopback 확인·프록시 헤더 거부·본문 길이를 포함한 정규 서명·nonce 재생 방지를 모두 갖췄습니다. 관리자 JSX SSR 전환도 안전하게 끝났습니다 — `raw()` 사용처가 `ADMIN_STYLE`, 서버 생성 배너, 마이그레이션 심(seam)의 `bodyHtml` 세 곳으로 한정되고 사용자 데이터는 전부 JSX 자식/속성으로 흘러 이스케이프됩니다. 신규 분석 기능의 프라이버시 모델(일 단위 salt 파기, IP /24 절단, 경로 allowlist, 모든 응답 204 통일)도 목적에 잘 맞습니다.

문제는 **가장 최근 커밋들이 애플리케이션 코드와 운영 계층 사이의 이음매를 깨뜨렸다는 점**입니다. C-1과 C-2는 둘 다 "코드는 맞는데 배포 경계에서 죽는" 유형이고, 두 건 모두 저장소의 기존 테스트가 이미 잡아내고 있었습니다.

## 5. 수정 후 최종 검증 — `npm run verify` **EXIT=0**

| 단계 | 수정 전 | 수정 후 |
|---|---|---|
| Root 오케스트레이션 | 11/11 | **11/11** |
| `@wisdom/shared` | 70/70 | **70/70** |
| `@wisdom/control` | 490 통과 / 1 실패 | **496/496** |
| `@wisdom/site` | 101/101 | **101/101** |
| Ops | 232 통과 / 1 실패 | **233/233** |
| Site 프로덕션 빌드 | — | **68페이지** |
| Playwright E2E | — | **132/132** (Chromium·Firefox·WebKit) |

실패 2건이 해소되고 신규 테스트 6건이 추가되어 control 490→496, ops 232→233이 됐습니다. 21개 파일 수정 + 1개 신규, +197/−59줄.

## 6. 커밋

| 커밋 | 내용 | 변경 |
|---|---|---|
| `19ef015` | Critical — `ANALYTICS_DATABASE_PATH` 허용 목록 누락, 발행 빌드 PATH의 `sh` 부재 | 3 files, +15/−4 |
| `cc91065` | Important — referrer 카디널리티 상한, 공개 라우트 목록 shared 통합, 백업 제외 근거 정정, 분석 DB 경로 검증 | 13 files, +175/−52 |
| `fa82f41` | Minor — 통계 날짜 왕복 검증, 비동기 컴포넌트 즉시 실패, 환경 변수 문서 정정 | 6 files, +37/−3 |

세 커밋 모두 개별 타입 체크를 통과해 중간 커밋에서도 빌드가 깨지지 않습니다(개별 revert/cherry-pick 가능).
