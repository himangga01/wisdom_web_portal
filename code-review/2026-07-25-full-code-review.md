# 전수 코드 리뷰 통합 보고서

| 항목 | 내용 |
|---|---|
| 대상 | `2026-07-22-claude-admin-jsx-ssr` @ `fa82f41` · 운영 소스 약 44,900줄 |
| 수행일 | 2026-07-25 |
| 개정 | **rev.2** — 3라운드 추가 검증 결과 반영(§11 개정 이력) |
| 방식 | 3라운드 13개 에이전트 — 도메인 전수 7 → 교차검증 3 → 추가 검증 3 |
| 원시 발견 | 잘못된점·부족한점 **179건** + 잘된점 주장 **105건** (1~2라운드), 3라운드에서 신규 추가 |
| 확정 Critical | **2건** |

---

## 1. 종합 판정

이 저장소의 **내부 불변식에 적용된 규율은 1인 프로젝트에서 보기 드문 수준**이다. 백업은 매 실행마다 복호화 왕복과 평문 해시 대조를 마친 뒤에만 published로 승격하고, 아웃박스 펜싱은 검사가 아니라 UPDATE의 WHERE 술어로 반복되며, 계정 열거 방지는 응답뿐 아니라 Argon2id 실비용까지 동결하고 그 동결을 부팅 시 설정 검증으로 강제한다. 릴리스 매니페스트는 `node_modules`를 포함해 18,425개 파일을 sha256으로 봉인하고, lockfile 조달 위생은 결함이 0이다(588/588 registry + integrity).

문제는 전반적 역량 부족이 아니라 **비대칭**이다. 같은 규율이 **경계 계약**(배포 후 런타임 트리, forwarded 헤더, 정적 빌드 산출물, 처리방침 문안)과 **관측성**에는 적용되지 않았다.

확정된 Critical 2건은 둘 다 같은 형태다 — **테스트와 배포는 초록으로 끝나는데, 운영 구성에서 핵심 기능이 실행되지 않는다.**

> **C-1**: 루프백 헬스 프로브가 항상 421을 받아 배포·복구·감시가 동시에 막힌다.
> **C-2**: 배포 시 devDependency가 정리되면서 발행 빌드가 100% 실패한다. 기사 발행과 정책 개정 발행이 함께 막힌다.

두 건 모두 실행으로 재현했고, C-2는 서로 다른 범위의 두 에이전트가 독립적으로 도달했다.

---

## 2. 검증 방법론

| 라운드 | 에이전트 | 역할 |
|---|---|---|
| 1 | A~G (7) | 도메인별 전수 리뷰 |
| 2 | CR1·CR2·CR3 (3) | 적대적 반증 · 정합성/중복/누락 · 잘된점 재검증 |
| 3 | V1·V2·V3 (3) | 미커버 영역 · 공급망 · **재분류 판정의 역검증** |

각 라운드는 앞 라운드를 **틀렸다고 가정하고** 시작했다. 이 절차가 실제로 작동했다는 증거:

**2라운드가 1라운드를 정정** — 원 Critical 주장 8건 중 6건 하향. `NODE_ENV` 기본값(Critical→Minor, 운영 경로 도달 불가) · 404 로케일화 CSP 차단(핵심 반증, 정적 문서 실재) · 철회 GET의 HMAC 순서(서술 부정확) · 발행 wedge "복구 불가"(자동 reconcile 존재) · 전화번호 정규형 3개(→4개).

**3라운드가 2라운드를 정정** — 재분류 10건 중 **4건이 과했던 것으로 판정**되어 강점으로 복귀했고, 3건은 부분 정정됐다. 특히 rev.1에서 두 번째로 무거운 결론이었던 **관리자 CSP 해시 무력화 건은 전제부터 오류**였다(§11).

**3라운드가 1·2라운드가 모두 놓친 Critical 1건을 발견** — C-2. 담당 범위였던 에이전트가 있었음에도(`ops/` 담당 G, 발행 담당 D) 양쪽 다 놓쳤고, 서로 다른 관점의 V1·V2가 독립적으로 도달했다.

---

## 3. 잘못된점 (확정 Critical)

### 3.1 [C-1] 루프백 헬스 프로브가 운영 구성에서 항상 421 — 배포·복구·감시 동시 차단

**심각도: Critical (실행 재현)**

`apps/control/src/app.ts:260-287`의 host-routing 미들웨어가 `app.use("*")`로 등록되고, 헬스 라우트는 `:304`·`:306`에 **그 뒤에** 등록된다. Hono는 등록 순서로 합성하므로 미들웨어가 먼저 실행되며, 예외는 `/internal/v1/article-drafts` 하나뿐이다.

`effectiveRequestOrigin`(`:121-148`)은 루프백 peer라도 `x-forwarded-host`·`x-forwarded-proto`가 **둘 다 없으면** `:129`의 분기를 건너뛰고 `:144`의 `new URL(req.url).origin` → `http://127.0.0.1:8787`을 반환한다. `PUBLIC_ORIGIN`·`ADMIN_ORIGIN` 어느 쪽과도 다르므로 `:270-272`에서 421이다.

```
loopback  /health/live  (no fwd headers): 421 Misdirected Request
loopback  /health/ready (no fwd headers): 421 Misdirected Request
via caddy /health/live  (XFH+XFP)       : 200 {"status":"ok"}
```

ops 프로브 3곳 모두 헤더 없이 루프백으로 직접 붙고 200만 통과시킨다 — `ops/lib/mac-services.mjs:21,146` · `ops/lib/mac-release-adapter.mjs:230,275-276` · `ops/lib/monitoring.mjs:95-99`(후자는 `controlReadyUrl`이 **반드시** literal loopback이어야 한다고 강제해 우회조차 불가).

**배포 단계와의 결합**: `ops/lib/release.mjs:3-17`의 순서는 `build → migrate → prune → start-canary → check-live-and-ready → atomic-switch`다. 따라서 모든 배포가 **DB만 새 스키마로 올려놓고** canary health에서 중단되며, 새 릴리스는 활성화되지 않은 채 옛 코드가 계속 서비스한다.

**비대칭**: 외부 uptime check는 Caddy를 거치므로 정상 200이다. **외부만 초록, 로컬은 전부 빨강**이 된다.

**테스트가 못 잡은 이유**: `apps/control/src/app.test.ts:66-79`의 fixture가 오리진을 넘기지 않아 이 미들웨어를 **아예 등록하지 않는다**. `:226-227`이 헬스 200을 단언하지만 운영과 다른 앱을 검사한다.

**부수 확인**: `/health/ready` 핸들러는 프로덕션에서 **한 번도 실행되지 않는다**. 준비 상태를 보고할 유일한 장치가 준비 상태와 무관한 이유로 죽어 있다.

**처방**: 미들웨어에서 헬스 경로를 `/internal/v1/article-drafts`와 같은 예외로 처리한다.

---

### 3.2 [C-2] 배포된 릴리스에서 발행 빌드가 100% 실패

**심각도: Critical (V1·V2 독립 확인 + 직접 재검증)**

체인:

| 단계 | 근거 |
|---|---|
| 1 | `apps/site/astro.config.ts:1`이 `@tailwindcss/vite`를 첫 줄에서 import. `src/styles/global.css:1`의 `@import "tailwindcss"`도 동일 |
| 2 | `@tailwindcss/vite`·`tailwindcss`·`vite`는 전부 **devDependencies**(`apps/site/package.json`). `dependencies`는 `@wisdom/shared`·`astro`·`i18next` 셋뿐 |
| 3 | 릴리스 6단계 `prune-to-production-runtime`이 `npm prune --omit=dev --workspaces --include-workspace-root` 실행(`ops/lib/mac-release-adapter.mjs:149-159` ← `ops/lib/release.mjs:10,125`) |
| 4 | `ops/config/runtime.env.template:15` `SITE_SOURCE_ROOT={{CURRENT_RELEASE}}` — 발행 빌드의 cwd가 **그 정리된 릴리스** |
| 5 | `apps/control/src/articles/publication-build.ts:205-221`이 그 cwd에서 `npm run build --workspace @wisdom/site` 재실행 → import 실패 → `PUBLICATION_BUILD_FAILED` |

npm 자체 dry-run으로 재현됨: `remove @tailwindcss/vite 4.3.2` / `remove tailwindcss 4.3.2`, `npm ls @tailwindcss/vite --omit=dev` → `(empty)`. lockfile상 `@tailwindcss/vite`를 요구하는 패키지는 `apps/site` 하나뿐이라 다른 경로로 살아남지 않는다.

**영향 범위**: 기사 발행뿐 아니라 **동의문·처리방침 개정을 반영하는 policy-only 발행도 같은 경로**라 함께 막힌다. 배포는 초록으로 끝나고 첫 발행에서 드러난다.

**저자가 이 위험을 인지한 정황**: `scripts/control-workspace.test.mjs:63`의 단언 메시지가 `"production operations must not depend on pruned dev-only tsx"`다. control 워크스페이스에 대해서는 정확히 이 문제를 막아 두었고 **site만 누락됐다.**

**테스트가 못 잡는 이유**: 발행 빌드 테스트는 대부분 `runProcess`를 mock하고, 실제 빌드를 도는 유일한 테스트(`apps/control/test/publication-search-boundary.test.mjs`)는 **개발 트리 루트**에서 실행되어 prune된 릴리스를 재현하지 않는다.

> **주의 — 이 결함은 `PUBLICATION_BUILD_FAILED`의 두 번째 원인이다.** 같은 오류의 첫 번째 원인(격리 자식 PATH에 `sh`가 없어 npm이 lifecycle 스크립트를 실행하지 못함)은 `fa82f41`에서 수정됐고 실제 빌드 테스트가 통과한다. 그러나 그 테스트는 개발 트리에서 돌기 때문에 **PATH 수정만으로는 배포 환경의 발행이 여전히 실패한다.**

**처방**: 빌드 시점에 필요한 패키지(`@tailwindcss/vite`, `tailwindcss`, 필요시 `vite`)를 `apps/site`의 `dependencies`로 옮긴다. 또는 site 워크스페이스를 prune 대상에서 제외한다. 어느 쪽이든 `control-workspace.test.mjs`와 같은 형태의 회귀 테스트를 site에도 추가해야 한다.

---

## 4. 잘된점 (검증 통과)

잘된점 주장 105건을 좌표 단위로 재확인해 **표준 관행이 아니라 이 프로젝트가 특별히 잘 푼 것** 14건을 선별했다. 아래 항목은 3라운드 역검증까지 통과했다.

### 4.1 최상위 6건

**V1. 게시 스냅샷을 소비자 쪽 재계산으로 검증** — `apps/site/src/content/published-articles.ts:188-219`
`set:html`로 주입될 `bodyHtml`에 대해 사이트 빌드가 `normalizeValidateAndRenderArticleMarkdown`을 **재실행**하고 불일치 시 `ARTICLE_HTML_MISMATCH`로 빌드를 세운다. 마크다운 정규형 동일성과 `contentSha256` 재계산까지 3중이다.
→ `set:html`의 안전성이 상류 서비스에 대한 **신뢰**가 아니라 재현 가능한 **계산**에 근거한다.

**V2. 백업이 복구 가능성을 매 실행마다 실증** — `ops/lib/backup.mjs:242-274`
`encrypt → chmod 600 → syncFile → **decrypt** → 복호본 integrity·schemaVersion 재검사 → 평문 SHA-256 동일성 비교`를 전부 통과해야 `rename(pending → hourly.age)`로 넘어간다.
→ "암호화만 하고 복구 가능성은 미검증"은 백업 구현의 지배적 실패 모드다.

**V3. 삭제 경로에 검증을 건 retention** — `ops/lib/backup.mjs:406-415`
삭제 후보마다 다시 해시해 status와 일치할 때만 `rm`하고, 불일치는 보존한다.
→ "정리라는 이름으로 손상된 백업을 지우는" 사고가 구조적으로 불가능하다.

**V4. 펜싱 술어를 검사가 아니라 쓰기 조건으로 반복** — `notifications/outbox.ts:125-147, 177, 225, 269`
`assertOwnedClaim`이 7개 조건을 검사하고, 세 finalize의 UPDATE WHERE절이 **같은 술어를 다시** 건다. `changes !== 1`이면 예외다. 크로스-프로세스 보증을 `notifications.test.ts:857-923`이 별도 커넥션으로 실측한다.
→ TOCTOU를 관례가 아니라 술어 반복으로 제거했고, 주석이 아니라 측정으로 증명했다.

**V5. 계정 열거 방지를 형식이 아니라 동결된 실비용으로** — `auth/service.ts:82-99` + `config.ts:232-234`
자격 미달이어도 더미 해시로 전체 Argon2id를 수행하며, 부팅 시 더미 해시 파라미터를 실제 정책과 동일하도록 강제한다.
→ 대부분의 구현은 **응답만** 균일화하고 비용은 갈린다. (대가는 §5.3.)

**V6. 인증 상태 전이가 전부 CAS이고 실패 시 2요소 소비를 롤백** — `auth/totp.ts:51-52`, `auth/service.ts:231-256`
preauth 소비 실패 시 `ROLLBACK`으로 **직전에 소비한 복구 코드/TOTP 카운터까지** 되돌린다.
→ "코드는 소진됐는데 로그인은 실패"는 MFA에서 가장 흔히 놓치는 레이스다.

### 4.2 나머지 8건

| ID | 내용 | 좌표 |
|---|---|---|
| V7 | 멱등성 조회가 키 로테이션을 견딤 — 조회는 전 키 순회, 쓰기는 활성 키만 | `consultations/service.ts:170-231, 360-374` |
| V8 | 철회 landing 토큰의 결정론 + COALESCE CAS — 메일 스캐너 prefetch와 실제 클릭이 같은 토큰으로 수렴 | `withdrawal/service.ts:114, 133-153` |
| V9 | 6개 fault point 전수 롤백 검증이 **타입으로 강제**됨 | `consultations/service.ts:22-28` + `app.test.ts:32-39` |
| V10 | PII 로그 유출을 타입으로 봉인하고 테스트가 **SQLite·WAL·shm 바이트를 직접 읽어** 확인 | `app.ts:56-65` + `app.test.ts:624-697` |
| V11 | 암호 3종 — 행 결속 AAD, HKDF 목적×키 이중 도메인 분리, 복호화 이전 봉투 정규형 검증 | `crypto/index.ts:77-90, 102-156` |
| V12 | 잠금 소유권을 4중 식별자로 증명 + 회수는 삭제가 아니라 quarantine 이동 | `ops/lib/exclusive-lock.mjs:54, 81-109, 314-333` |
| V13 | 런타임 설정이 allowlist 파싱 — `NODE_OPTIONS` 원천 차단, 자식 환경 6개 키만 통과 | `ops/lib/runtime-config.mjs:6-38` |
| V14 | 품질 게이트 자체가 동작하는지 검증하는 **메타 테스트** — 일부러 타입 오류 프로브를 심어 typecheck가 실제로 실패하는지 확인 | `scripts/astro-typecheck-regression.test.mjs` |

### 4.3 3라운드에서 추가로 검증된 강점

- **`allowScripts`가 npm 12 네이티브 게이트의 권장 사용법** — arborist가 **기본 거부**이므로 설치 스크립트 보유 7개 중 5개가 실제로 차단된다. 정확 버전 지정도 권장 형식이다.
- **릴리스 매니페스트가 `node_modules` 포함 18,425 파일을 sha256 봉인**하고 심볼릭 링크는 `realpath`까지 검사한다(`ops/lib/release-system.mjs:33, 217-295`).
- **크로스아키텍처 경고가 코드로 강제됨** — `COPY_EXCLUDED_SEGMENTS`가 `node_modules`를 제외하고 릴리스마다 `npm ci`를 돌리며, preflight가 darwin/arm64 + Node 24 + **실제 `import("better-sqlite3")`**로 검증한다(`ops/scripts/preflight.mjs:114,118,134`).
- **lockfile 조달 위생 결함 0** — 588/588이 registry.npmjs.org + integrity, git/tarball/alias 참조 0건. `apps/control` 15개 의존성 전부 정확 고정에 드리프트 0. engines 3중 선언과 `packageManager`가 실측(v24.18.0 / npm 12.0.1)과 완전 일치.
- **`COPY_EXCLUDED_SEGMENTS`가 이번 리뷰의 미커버 4개 영역을 배포 표면에서 배제**하고 그것을 테스트로 고정한다(`release-system.mjs:64`).
- **`packages/shared`가 `types:[]`로 Node 타입을 완전 배제**해 아래 `@types/node` 불일치의 폭발 반경을 site 하나로 한정한다.

---

## 5. 잘못된점 (Important)

### 5.1 검증 체계 — 강점으로 보고됐으나 실제로는 결함인 것

2라운드가 10건을 재분류했고 3라운드가 그중 **4건을 과한 것으로 되돌렸다**(§11). 아래는 역검증까지 살아남은 것이다.

**동의 감사 트리거 2개가 무결성 점검에서 누락** — `db/client.ts:347, 361`
`marketing_withdrawal_capability_consent_insert`/`_update`가 `db/schema.ts`에 grep 0건이라 `REQUIRED_TRIGGERS`에도 지문 목록에도 없다. 이 트리거를 DROP해도 `isDatabaseReady()`가 `true`다. 이 둘은 "마케팅 철회 자격증명이 실제로 수락된 마케팅 동의 이벤트에 대응하는가"를 강제하는 **동의 감사 추적의 핵심 불변식**이다.
역검증 결과 **원 보고보다 나쁘다** — 지문 대상이 21개가 아니라 **2개**였다.

**POST 라우트 전수 확인에 회귀 방어가 없음**
`protectedPost`의 순서(strict Origin → 세션 → 폼 → CSRF)는 옳고 현재 누락도 없다. 그러나 이는 리뷰어 수작업 확인이며, `admin-http.test.ts:35`의 테스트 제목("…for every mutation")과 달리 본문은 전 라우트를 훑지 않는다. `protectedPost` 없이 POST를 추가해도 전 스위트가 green이다.
**증거**: 이 코드베이스의 규약("비가역 동작은 서버가 확인값을 요구한다")이 `screens.tsx:654`에서 이미 깨져 있는데(체크박스에 `name` 없음) 어떤 테스트도 눈치채지 못했다.

**서비스 품질 게이트의 해시 검사가 항진명제** — `apps/site/src/search/quality-gate.ts:118-152`
같은 호출에서 만든 객체를 같은 함수로 재해시해 비교한다. 역검증에서 **`contentSha256`이 사이트 어디서도 소비되지 않는다**는 사실이 추가 확인됐다.
단, 기사 게이트(`:154-185`)와의 비대칭은 **의도**다(`quality-gate.test.ts:49,62-70`이 서비스 문서에 reviewer/sources 부재를 단언). rev.1의 "항진명제 게이트 두 개" 헤드라인은 과했다. → **Low**

**런북 테스트가 산문 정규식 매칭** — `ops/tests/configuration.test.mjs:398-437`
문구의 존재만 보고 그 문구가 **사실인지**는 보지 않는다. 그래서 §5.6의 문서 불일치가 그대로 통과한다.
올바른 방식이 같은 파일 `:408`에 이미 있다 — 런북이 적은 플래그를 **실제 plist와 대조**한다.

**`endpoints.test.ts`가 정적 빌드에서 폐기되는 헤더를 검증**
`output:"static"` + 어댑터 없음이므로 prerender된 endpoint의 응답 헤더는 산출물에 남지 않는다(`astro/dist/core/build/generate.js:303-306`). 실제 보호는 Caddy가 한다.
단, rev.1의 "Caddyfile을 지워도 초록"은 **반증됐다** — `configuration.test.mjs:197-203`이 해당 Caddy 헤더 3줄을 정확히 고정한다. → **Low**

### 5.2 신뢰 경계 — 코드로 고정되지 않은 외부 계약

| ID | 내용 |
|---|---|
| **M2** | `X-Forwarded-Proto`가 https로 오지 않으면 상담 API·비콘·철회·관리자 전체가 421. `app.ts:129`의 조건이 **OR**이라 둘 중 하나만 와도 엄격 검증에 진입해 나머지가 없으면 421 |
| **M3** | Caddy는 `client_ip_headers CF-Connecting-IP`를 선언하는데 `{client_ip}` 사용처도 `header_up`도 0건이고, 앱은 `x-forwarded-for`만 읽는다. 체인 끝이 클라이언트 제어면 IP 한도 우회, 사설 홉이 붙으면 전 방문자 단일 버킷 → 6번째부터 429 |

**M2 조건 판정**: 조건부 결함은 코드로 확정됐다. Caddy 측은 `trusted_proxies static private_ranges`가 loopback을 포함하므로 cloudflared가 신뢰 peer이고, **cloudflared가 XFP를 보내면 보존, 안 보내면 Caddy가 자기 scheme인 `http`를 넣는다**(`auto_https off` + http 리스너). cloudflared의 실제 전달 여부는 미해결 이슈 이력이 있어 **실장비 확인이 필요하다**(§10 확인 절차).

### 5.3 가용성 — 무인증 요청이 사업 기능을 멈춘다

| ID | 내용 | 자기회복 |
|---|---|---|
| **D-D2** | 포인터 전환 후 `commitActivation` 실패 시 보상 경로 없음. 전역 "미결 activation 1개" UNIQUE로 이후 발행·롤백 차단 + `releaseAuthorityCacheKey`가 `undefined`를 반환해 **상담 폼 제출까지 거부**. `server.ts:27`의 reconcile이 try/catch 없이 호출되므로 재실패 시 **크래시 루프**(관측 증상은 503이 아니라 connection refused) | 크래시 케이스는 기동 시 자동 복구 |
| **D-B1** | consent-read 버킷 4,096 포화 시 신규 방문자가 폼 토큰을 못 받아 **상담 접수 전면 차단**. 스윕은 요청당 64개만, TTL은 생성 시점 고정이라 60초마다 1회 갱신으로 유지 | 공격 중단 후 60초 |
| **D-C3** | 스로틀 거부 시에도 Argon2id 전체 실행 + KDF 대기열 무제한 → 미인증 로그인 DoS. 사용자명 5회/15분으로 **단일 소유자 무기한 잠금** | 15분 |

**D-C3 심각도 근거**: `ops/cloudflared/config.yml.template` ingress에 `{{ADMIN_HOST}}`가 있고 Cloudflare Access·Zero Trust·service token·mTLS·IP allowlist 언급이 **grep 0건**이다. 관리자 로그인은 인터넷 노출이며 1인 사무소라 우회 계정도 role 컬럼도 없다.

### 5.4 데이터 파괴 — 3차 마이그레이션

**심각도: Important** (데이터가 든 구 스키마 DB의 실존이 확인되면 즉시 Critical)

`db/client.ts:520`이 슬러그를 `'legacy-v3-' || printf('%016x', a.rowid)`로 치환하고, `:522`가 `approved → in_review`로 강등하며, `:662`가 활성 릴리스를 `retired`로 만든다. v2 실데이터로 재현했고, 같은 마이그레이션이 `a.slug`를 리비전 `title`로는 쓰면서(`:434-439`) 슬러그 복원에는 쓰지 않는다.

**rev.1의 서술과 처방이 모두 틀렸다.** 3라운드 역검증 결과:

1. "구 스키마 백업 복원 후 기동"이라는 도달 경로는 **반증**됐다. `ops/lib/restore.mjs:195-196`이 `RESTORE_SCHEMA_INCOMPATIBLE`로 막고, 이 검사는 DB 교체(`:196-231`)와 서비스 기동(`:234`)보다 **앞**에 있으며 3중으로 재검사한다.
2. **`assertRollbackCompatibleMigration`은 데이터 보존 가드가 아니다.** `client.ts:1332-1339`는 보류 마이그레이션이 있으면 무조건 throw하는 **롤백 호환성** 가드이고, 승인된 유지보수 배포는 그 플래그 없이 **정확히 같은 파괴적 SQL을 실행한다.** 따라서 "`runtime.ts`에 가드를 추가하면 해결"이라는 rev.1의 처방은 **손실을 전혀 막지 못한다.**

**정확한 재기술**: 결함은 "`runtime.ts`에 가드가 없다"가 아니라 **"3차 마이그레이션이 발행 상태·활성 릴리스를 비가역 파괴하며, 무인 재기동이든 승인된 유지보수 배포든 어떤 경로에도 데이터 보존 검사나 사전 경고가 없다"**이다.

**처방 순서**: (1) 마이그레이션 3에 사전 데이터 존재 검사·경고 추가, (2) `runtime.ts`를 마이그레이션 실행이 아니라 **버전 불일치 시 fail-closed**로 변경(마이그레이션은 CLI 전용).

### 5.5 프라이버시 — 발행 전 필수 정정

| ID | 내용 |
|---|---|
| **D-E1** | `docs/operations/analytics-privacy-disclosure.md:16,27,39,48`이 4개 로케일 전부에서 "쿠키나 이용자 단말 저장소를 사용하지 않습니다"라고 단언하는데, `apps/site/src/lib/analytics-beacon.ts`의 `localStorage.getItem`은 **모든 방문의 모든 전송마다** 실행된다. 코드 docstring은 예외를 자백하는데 문안만 누락 |
| **M5** | `analytics/store.ts:74-82`에 `secure_delete` 없음(OLTP는 `db/client.ts:1212`에서 ON, ops 복구 경로도 검증까지 함). `pruneAnalytics`에 checkpoint/VACUUM 없음 |

```
as-shipped (no secure_delete): saltResident: true,  hashesResident: 91/200
with secure_delete = ON      : saltResident: false, hashesResident: 0/200
```

**위협 모델 정정**: "재식별 가능"은 과장이다. `analytics_visitor_days`는 `(day, visitor_hash)` 두 컬럼뿐이라 전수 대입에 성공해도 "어떤 /24 + UA 조합이 어느 날 방문했다"뿐이고 행동 프로파일은 만들 수 없다. 실제 리스크의 본체는 **처방침 문안과 디스크 실태의 불일치**다.

**이 문서는 개인정보 보호법 제30조① 근거로 4로케일 처리방침에 실릴 확정 문안이고 상태가 "발행 대기"다. 발행 전 정정 비용이 가장 낮고, 발행 후가 가장 높다.**

> **M5 + M6 결합 시 Critical**: 프루닝이 멈추면 파일 포렌식 없이 라이브 DB에서 날짜 간 연결이 가능해진다.

### 5.6 데이터 정합성 — 조용히 틀리는 것들

| ID | 내용 | 좌표 |
|---|---|---|
| **D-F2** | 전화번호가 E.164로 수렴하지 않아 같은 번호가 **정규형 4개**를 만든다(전부 스키마 통과). 실질 피해는 스팸이 아니라 **정보주체 권리 대응 누락** — `+82-10-…`으로 접수된 이력이 `010-…` 검색에서 빠진다. 이메일은 정준화되는 비대칭 | `packages/shared/src/consultation.ts:42-56` |
| **디자인 토큰 easing 불일치** | 공용 토큰이 **폐기된 1세대 값** `cubic-bezier(0.22, 1, 0.36, 1)`을 담고 있다. 프로토타입의 C1 계약은 `cubic-bezier(0.16, 1, 0.3, 1)`이고 그 검증기가 이를 고정한다(`prototypes/homepage-motion/scripts/verify-standalone.mjs:36`, `src/dynamic-motion.css:6`). `design-tokens.test.ts:33`이 **같은 틀린 리터럴을 재기입**하는 항진명제라 검출 불가 | `packages/shared/src/design-tokens.ts:20` |
| **M7** | 통계 대시보드가 미래 `from`을 클램프하지 않아 역전 → 총 0 + "데이터 없음"으로 **오류도 경고도 없는 오보** | `admin/routes.ts:612-614` |
| **M8** | 비콘이 `document.referrer`를 자르지 않고 보내 본문 1KiB 한도 vs 스키마 2,048자 불일치로 초과 시 **방문 자체가 유실**. 검색·광고 유입은 쿼리스트링 때문에 1,000자를 흔히 넘으므로 유입 통계가 체계적·한 방향으로 틀어짐 | `analytics-beacon.ts` |
| **M10** | 제목·요약 상한이 **4계층 불일치**(값과 계수 단위 양쪽): 200/500 코드포인트 · 200/500 · 160/320 코드포인트 · 160/320 **UTF-16**. 161~200자 초안이 422가 아니라 **HTTP 500**으로 영구 실패 | — |
| **M6** | `cli/purge.ts:11-33`이 단일 try라 상담 파기가 throw하면 **분석 프루닝이 통째로 건너뛰어진다**. 실패 이벤트도 감시도 없다. retention과 backup launchd가 동일 스케줄이라 WAL busy 확률을 서로 높인다 | — |

### 5.7 콘텐츠·발행 파이프라인

| ID | 내용 |
|---|---|
| D-D5 | PII 게이트가 길이 하한 없는 부분 문자열 일치 — `name="김민"` 두 글자가 그 문자열을 포함하는 **모든 기사를 영구 차단**. 같은 파일이 `message`에는 10자 하한과 슬라이딩 윈도우를 쓰는데 `name`/`company`에만 그 규율이 없다 |
| D-D4 | 스냅샷이 전부-아니면-전무 — 게시된 글 1건 실패가 모든 발행 차단 |
| D-D7 | 클레임 예외가 번역 레인 영구 정지 — 전역 running 잡 1개 제약이라 완전 기아. 데드레터도 시도 한도도 없음 |
| D-D6 | 상담 전수 복호화가 쓰기 트랜잭션 안 (C×(D+1)회 AES) |
| D-D16 | `.wisdom-release-manifest.json`이 공개 서빙 — Caddy에 `hide` 지시자 **0건** |
| D-D17 | `hermes_article_idempotency` 무만료 + `ON DELETE RESTRICT`로 기사 삭제 영구 차단 |
| D-D1 / D-D14 | 빌드 실패 시 임시 디렉터리 3종 영구 누출 / 보상 rename 실패 시 릴리스 디렉터리 고아 |
| D-D9 | 발행 진입 제어 없음 — 더블클릭 시 전체 빌드 병렬 실행 |
| **배포↔발행 인터록 0건** | `restartServices`가 발행 중 control을 죽인다 |

### 5.8 공급망 (3라운드 신규)

| ID | 내용 |
|---|---|
| **audit 수치 불일치** | `docs/operations/release-candidate.md:27`이 "High 0, Low 2"라 적었으나 실측 `npm audit --omit=dev` = **High 2 / Moderate 1 / Low 1** |
| **`better_sqlite3.node`가 lockfile integrity 밖** | `prebuild-install`이 GitHub Releases에서 조달하고 페이로드 체크섬 검증 코드가 없다(유일한 sha512는 URL 캐시키). argon2는 동봉 prebuilds라 안전 |
| **유령 의존성 3건** | `ops/scripts/preflight.mjs:45`·`monitor-db-check.mjs:108`·`system-adapters.mjs:100`의 `better-sqlite3`, `public-release.mjs:5`의 `@wisdom/shared`, ops 테스트의 `tsx` — 전부 호이스팅에 의존 |
| **`@types/node` 메이저 불일치** | `apps/site`가 **26.1.1**로 타입체크(control 24.13.3, 런타임 24.18.0). 프로브 재현 결과 `node:ffi` 등이 site에선 통과하고 control에선 TS2307. 현재 사용처 0건이라 잠재 결함이며 수정은 한 줄 |
| **TS 메이저 분기** | `packages/shared`만 `^7.0.2`(중첩 설치 확인), 나머지 셋 6.0.3. **단, `skipLibCheck:false`로도 선언 인계 오류 0건** — rev.1의 의혹은 현 시점 결함이 아니다(Minor로 하향) |

---

## 6. 교차 주제

### T1. 앱과 인프라의 책임 분담을 어느 쪽 테스트도 검증하지 않는다

이 저장소의 계약 상당수가 **앱 절반 + 배포/인프라 절반**인데 테스트는 언제나 절반만 고정한다.

| 테스트가 고정한 것 | 프로덕션의 실제 |
|---|---|
| `app.test.ts:226-227`이 헬스 200 단언 | fixture가 오리진 미전달로 미들웨어 미등록. 운영 구성에서는 421 → **C-1** |
| 발행 빌드 테스트가 개발 트리 루트에서 실행 | 실제 발행은 prune된 릴리스에서 도는데 그 상태를 재현하는 테스트가 없다 → **C-2** |
| `endpoints.test.ts`가 endpoint 응답 헤더 검증 | 정적 빌드가 헤더를 폐기 — 실제 보호는 Caddy |
| `public-site.spec.ts:881`이 404 로케일화를 인라인 스크립트 경로로 통과 | 실동작은 Caddy `handle_errors` rewrite인데 미검증. **`handle_errors`를 지워도 초록** |
| `admin-http.test.ts:469-479`가 스스로 `x-forwarded-proto: https` 주입 | 실제로 그 헤더가 오는지에 대한 계약 없음 |
| `configuration.test.mjs:77`이 `client_ip_headers` **문자열 존재**만 단언 | 그 설정이 control에 전달되지 않는다는 사실은 미검사 |
| `notifications.test.ts:269`가 `fullInquiryApproved:false` 조합으로 가드 발화 확인 | 생산 배선이 **그 조합을 만들 수 없다** |

> **처방은 하나다** — 렌더된 runtime 설정으로 **배포 후 상태(prune 포함)를 재현해 HTTP로 때려보는 테스트 계층**. 그것 하나가 C-1과 C-2를 동시에 잡았을 것이다.

### T2. 관측성 부재가 장애를 무증상으로 만들고, 서로를 가린다

로그가 나가는 지점이 사실상 `onError`의 503 한 줄과 워커의 `WORKER_CYCLE_FAILED` 한 줄뿐이고 Caddy access log는 양쪽 호스트 모두 꺼져 있다. 421·429·403·drop·honeypot·발송 실패·프루닝 정지가 **전부 무기록**이다.

로그를 끈 판단 자체는 옳다(프록시 로그에 IP·UA·경로가 남으면 처리방침이 무너진다). 문제는 **비-PII 대체 신호를 하나도 만들지 않았다**는 것이다.

장애가 서로를 가리는 연쇄: C-1로 monitor가 영구 red가 되면 D-D2로 인한 진짜 503이 **같은 신호**로 보인다 · M6는 실패 이벤트가 없고 `monitor.mjs`에 `retention|purge|analytics` 매치가 0건 · monitor 자신이 unload되면 아무 신호도 없다 · `isDatabaseReady`가 8개 실패 지점을 `catch { return false }` 하나로 접는다.

### T3. 무인증 요청이 전역 직렬화 자원을 잡는 경로가 다섯 개

**D-B1**(맵 포화) · **D-B2**(미인증 쓰기 트랜잭션) · **D-B3**(무효 제출이 AES+쓰기 락을 무료로 소비) · **D-C3**(Argon2 슬롯 + 무제한 대기열) · **D-D6**(PII 전수 복호화가 쓰기 트랜잭션 안) · **D-D9**(발행 진입 제어 없음).

공통 구조는 **비용이 큰 작업이 인증·계측·진입 제어보다 앞에 있다**는 것이고, T2 때문에 발생해도 로그가 없다.

### T4. 같은 로직을 손으로 복제한 지점이 최소 12곳이고, **이미 세 곳이 갈라졌다**

`escapeHtml` 5곳 · 이메일 정규화 2곳 · 루프백 판정 2곳 · 철회 경로 정규식 3곳+Caddy · 쿠키 파싱 2곳 · 토큰 정규식 2곳 · `MAX_ATTEMPTS`/`LEASE_MS` 각 2곳 · `languageNames` 3벌 · 정렬 비교자 3종 · `OUTBOX_LEASE_MS`가 `adapters.ts:15`에 리터럴 복제.

**관측된 실패 3건**: `isLoopbackPeer("[::1]") = true` vs `isLoopback("[::1]") = false` · drizzle 스키마 선언이 실제 DDL과 불일치 · **디자인 토큰 easing이 프로토타입 C1 계약과 갈라짐**(§5.6).

### T5. 문서가 코드보다 뒤처져 있고, 게이트 문서가 게이트 역할을 못 한다

`release-candidate.md:15`의 "이후 런타임 코드는 변경하지 않았다"가 27개 커밋만큼 틀림 · 같은 문서 `:27`의 audit 수치가 실측과 다름 · **`AGENT.md`·`work-log.md`가 33커밋 뒤처짐**(방문 통계 5커밋·JSX SSR 12커밋 전부 0건, 문서 지도가 "처음 읽을 문서 #4·#5"로 지정) · 법정 고지 의무가 걸린 방문 통계가 릴리스 게이트·문서 지도 양쪽에 0건 · 처리방침이 localStorage 사용 누락 · 실패 코드 11종이 런북에 0건 · `apps/site`에 README 없음.

**마지막 전수 검증이 Windows에서 실행됐다**(6 skip이 정확히 POSIX 권한·심볼릭 링크·open-file rename)는 사실도 확인됐다 — 운영 대상은 macOS다.

구조적 원인은 **CI 부재**다(§7). 다만 올바른 방식이 이미 한 건 존재한다 — `configuration.test.mjs:408`이 런북이 적은 플래그를 **실제 plist와 대조**한다.

### T6. 파기·정리 규약이 테이블마다 다르고, 빠진 곳이 계속 발견된다

`marketing_withdrawal_capabilities` 삭제문 0건 · `hermes_article_idempotency` 만료 없음 · analytics `secure_delete` 없음 · 프루닝이 앞 단계 실패에 종속 · 빌드 실패 시 임시 디렉터리 누출 · `skippedInvalid` 릴리스가 영원히 미삭제 · 만료 멱등키 삭제가 롤백으로 되돌려짐.

**같은 저장소 안에 정확히 옳은 대조군이 있다** — `hermes_article_nonces`는 매 요청 스윕, `idempotency_keys`는 purge 배치 편입, OLTP는 `secure_delete=ON` + 파기 후 `wal_checkpoint(TRUNCATE)` + 결과 검증. 규약은 존재하는데 **새 테이블·새 DB를 편입시키는 체크리스트가 없다.**

---

## 7. 커버리지 공백

| 대상 | 상태 |
|---|---|
| **CI/CD** | **완전 부재 확인** — `.github/` 없음, YAML 0건, `.git/hooks` 15개 전부 `.sample`, `core.hooksPath` 미설정, husky/lint-staged/lefthook grep 0건, `npm run verify` 호출 경로 0건(언급은 전부 산문). **T5의 구조적 원인** |
| `prototypes/homepage-motion/` | 루트 `workspaces`에 없어 `verify` 어디에도 미포함. 자체 134패키지 트리 미감사, `node_modules` 미설치. 소유자·수명·보안 책임 미정의. **§5.6의 easing 불일치가 여기서 드러났다** |
| `docs/superpowers/` | 모션 계획 3건의 체크박스 95개 전부 미체크. `production-portal.md:121`의 "prototype-regression suites" 증거가 `git diff` 무변경뿐 |
| `AGENT.md` · `work-log.md` | 33커밋 뒤처짐(§T5). 인용 커밋 해시 9개는 전부 실재 |
| `research/quickshare-2026-07-15/` | ZIP이 loose 파일 2개의 완전 중복(561KB, 추적 블롭의 12.7%), 출처·라이선스 표기 0건 |
| `.gitattributes` | 바이너리에 `text=auto eol=lf` — 휴리스틱만이 안전장치이고 저장소에 CRLF 사고 이력이 있다 |
| `package-lock.json` | 3라운드에서 감사 완료(§5.8, §4.3). 프로덕션 트리 422/591 생존, 오래된 마이크로 패키지 15종은 알려진 권고 없음 |
| **사이트 빌드 3자 계약** | 3라운드에서 해소 — **이것이 C-2의 본체였다** |

---

## 8. 부족한점 우선순위

### 지금 (상위 15)

| # | 항목 | 비용 | 이 공백이 놓친 결함 |
|---|---|---|---|
| 1 | 배포 후 상태(prune 포함)를 재현해 HTTP로 확인하는 테스트 계층 없음 | 테스트 1~2개 | **C-1·C-2·M2를 전부** 잡았을 유일한 계층 |
| 2 | `app.test.ts` fixture가 오리진 미전달 → 호스트 라우팅 미들웨어 미등록 | 인자 2개 | C-1이 여기서 생존 |
| 3 | site 워크스페이스에 `control-workspace.test.mjs`류의 prune 회귀 테스트 없음 | 테스트 1개 | **C-2**가 정확히 여기서 생존(control에는 있다) |
| 4 | forwarded 헤더 신뢰 경계 문서·테스트 0건 | 런북 1절 + 단언 | M3(IP 한도 우회 / 전 방문자 단일 버킷) |
| 5 | 보존·프루닝 잡 감시 0건 | checks 2개 | M6이 **조용히** 깨짐 |
| 6 | 공개 API 관측성 0 | 필드 + 카운터 | D-B1·D-B2·M2가 "탐지 불가"인 이유 |
| 7 | POST 라우트 인벤토리 스윕 테스트 없음 | 테스트 1개 | D-C1이 여기서 생존 |
| 8 | 환경변수 테스트가 "동일 문자 32자"를 프로덕션 명세로 굳힘 | 케이스 4개 | D-F1 |
| 9 | `addMonthsClamped` 직접 테스트 0건 | 6줄 | PII 보존기간 결정 함수. 파기 시점 오류는 사후 복구 불가 |
| 10 | `pageviewRateLimited` 단위 테스트 없음 | 파일 1개 | KST 솔트 ↔ UTC 윈도 9시간 어긋남 → 일 상한 2배 |
| 11 | 디자인 토큰 테스트가 값을 재기입하는 항진명제 | 프로토타입 대조 1건 | §5.6 easing 불일치 |
| 12 | 실패 코드 상당수가 런북에 0건 | 표 1개 | 1인 운영에서 MTTR을 직접 결정 |
| 13 | 템플릿 렌더 운영 도구 없음(라이브러리는 있고 테스트만 씀) | 스크립트 1개 | 토큰 21종 수기 치환 |
| 14 | **OG/Twitter 메타데이터 전무**, `public/`·파비콘 없음 | `BaseLayout` 6~8줄 | 카카오·네이버 공유 시 맨 URL. 데이터는 `SearchDocument`에 이미 있음 |
| 15 | `REQUIRED_TRIGGERS`/`REQUIRED_INDEXES`에 무결성 객체 누락 | 목록 3줄 | §5.1 동의 감사 트리거 |

### 다음 분기

클라이언트 전용 모듈 5개 테스트 0 · 마케팅 철회 `prepare()` 경쟁 미테스트 · CLI 진입점 4개 미테스트 · `CONSENT_VERSION_STALE` 미검증 · 공유 계약 패키지 주석 0줄 · **전화번호 표기 변형 충돌 테스트**(단언 하나면 D-F2가 작성 시점에 드러났다) · `routes.ts` 1495줄 / `publication-release.ts` 1556줄 분리 · monitor 자기 감시 · 백업 볼륨 여유 공간 미감시 · `@types/node` 정렬(한 줄) · allowScripts 버전을 lockfile과 묶는 테스트 · 22곳의 막다른 오류 화면.

### 선택

파비콘(`智` 글리프 SVG 하나) · 표 `<caption>`/`scope`, skip link, `role="status"` · 미사용 import · `--stagger-dynamic` 소비처 0(토큰이 아무것도 제어 안 함) · research ZIP 중복 제거.

---

## 9. 성숙도 평가

### 과잉 설계

**번역·Codex 파이프라인(32파일 ≈12,600줄)** — 개별 조각의 품질은 높으나 이 무게가 **새로운 정지 모드**를 만들었다. 전역 running 잡 1개 제약 때문에 클레임 시점 예외 하나가 모든 번역을 영구 기아로 만들고 데드레터도 시도 한도도 없다. **무게가 안전이 아니라 취약성으로 환원됐다.**

**발행 릴리스 오케스트레이션(1556줄)** — 결정적 문제는 **결합**이다. 미결 활성화 동안 동의문 권위 리졸버가 영구히 `undefined`를 반환하므로 발행 커밋 한 번의 실패가 상담 폼 거부로 번진다. **콘텐츠 발행 실패가 리드 수집을 멈추는 결합은 이 사업 규모에 맞지 않는다.**

**no-pii 게이트** — 보관 상담 전수를 쓰기 트랜잭션 안에서 복호화하고, 길이 하한 없는 부분 문자열 일치라 두 글자 이름이 전 발행을 차단한다.

**ops 자동화 — 품질은 최고, 인터페이스는 미성숙** — §4의 14건 중 5건이 여기서 나왔고 3라운드에서 4건이 더 확인됐다. 그런데 배포 CLI가 필수 플래그 13개를 요구하고, 템플릿 렌더 도구가 없으며, 런북의 완전한 실행 예시가 하나뿐이다.

### 과소 설계 — 실제 운영에서 먼저 터질 곳

1. **경계 계약** — C-1·C-2가 여기서 나왔다. 배포 후 런타임 트리와 forwarded 헤더 계약이 어느 테스트로도 고정되지 않는다.
2. **관측성** — M2 시나리오("홈페이지는 정상인데 상담만 안 들어온다")가 발생하면 진단 단서가 문자 그대로 0이다.
3. **단일 관리자 계정의 가용성** — 인터넷 노출 + 우회 계정 없음 + KDF 대기열 무제한.
4. **프라이버시 약속과 구현의 간극** — 지금이 마지막 수정 시점이다.
5. **연락처 정규화** — 열람·정정·삭제 요구 대응 누락이 스팸보다 위험하다.

### 1인 운영자가 유지보수 가능한가

**현재 상태로는 아니다.**

1. **배포 파이프라인이 성공할 수 없고**(C-1), **성공하더라도 발행이 되지 않는다**(C-2). 두 결함이 독립이므로 하나만 고쳐서는 운영이 성립하지 않는다.
2. **깨졌을 때 무엇이 일어났는지 알 방법이 없다**(T2).
3. **1인 유지보수 한계를 넘는 파일이 세 곳** — `admin/routes.ts` 1495줄, `publication-release.ts` 1556줄, `articles/` 12,600줄.

**가능해지는 최소 집합 (9개)**

- 결함: **C-1**(헬스 예외) → **C-2**(빌드 의존성 재배치) → **D-C3**(Cloudflare Access 또는 엣지 rate limit — 코드 수정보다 싸다) → **D-E1 + M5**(처리방침 문안 + `secure_delete=ON`, 발행 전)
- 부족한점: §8 상위 5개

**콘텐츠 파이프라인에 대한 별도 판단**: D-D2·D-D4·D-D5는 개별 수정보다 **기능을 줄이는 방향**이 1인 운영에 더 맞을 수 있다 — 자동 번역 잡 당분간 비활성, 스냅샷을 문서 단위 격리로 분해, **발행과 상담 접수의 결합 해제**.

---

## 10. 권고 실행 순서

| 단계 | 항목 |
|---|---|
| **0. 지금** | **C-1** 헬스 라우트 예외 — 이것 없이는 어떤 수정도 배포할 수 없다 |
| **0. 지금** | **C-2** `@tailwindcss/vite`·`tailwindcss`를 `dependencies`로 이동 + site prune 회귀 테스트 — 배포되어도 발행이 안 되므로 C-1과 동급 |
| **1. 공개 전 필수** | D-E1 처리방침 문안 + M5 `secure_delete=ON` — 발행 후 정정 비용이 가장 높은 유일한 항목 |
| **2. 공개 전 필수** | D-C3 — Cloudflare Access 또는 엣지 rate limit |
| **3. 배포 안정** | §5.4 마이그레이션 사전 데이터 검사 · M2 실장비 확인 후 monitor check 추가 |
| **4. 검증 체계** | §8 상위 3개 — T1 재발 방지가 개별 수정보다 근본 |
| **5. 관측성** | §8 5·6번 — T2 해소 |
| **6. 데이터 정합성** | D-F2 전화번호 E.164 정준화 + 재인덱싱 · easing 토큰 · M7 · M8 · M10 |
| **7. 구조** | 발행↔상담 결합 해제 · 대형 파일 분리 |

### 운영자 확인이 필요한 항목 (코드로 판정 불가)

```sh
# 1. X-Forwarded-Proto 전달 여부 (§5.2 M2)
curl -s -D- https://<public-host>/api/v1/consent-documents?locale=ko -o /dev/null | head -1
#    200 → 정상 / 421 → XFP 전달이 끊김

# 2. CSP 헤더 개수 (§11 R2 판정의 실동작 확인)
curl -s -D- https://<admin-host>/admin/login -o /dev/null | grep -ci content-security-policy
#    2 → 중복(교집합 적용, 해시 유효) / 1 → 어느 한쪽만 도달
```

3. **데이터가 든 구 스키마(v2) DB의 실존 여부** — 확인되면 §5.4가 즉시 Critical로 승격된다.

---

## 11. 개정 이력 — rev.1에서 뒤집힌 결론

3라운드 역검증이 rev.1의 결론 일부를 정정했다. 기록으로 남긴다.

| rev.1 결론 | rev.2 판정 | 사유 |
|---|---|---|
| **관리자 CSP 해시가 Caddy에 덮여 방어 효과 0** (rev.1 §5.1 R2, 두 번째로 무거운 결론) | **전면 철회 — 강점으로 복귀** | Caddy `header`는 `defer` 없이는 상류 헤더를 덮어쓰지 못하고 **중복 헤더**가 된다. CSP 규격상 복수 정책은 교집합으로 적용되므로 앱의 `style-src 'self' 'sha256-…'`가 실제 구속 조건이다. 두 테스트도 모순이 아니라 서로 다른 산출물(Caddy 템플릿 vs Hono 응답)을 검사한다 |
| `consent-documents` Origin 무검사가 결함 | **철회** | CORS 헤더 0건이라 교차 출처 스크립트가 응답을 읽을 수 없고, formToken은 인가 비밀이 아니라 동의 버전 결속 증거이며 레이트리밋도 존재한다 |
| `Secure` 쿠키 전제가 저장소 밖에 있음 | **철회** | `config.ts:151`이 프로덕션 HTTPS 오리진을 강제하고 `app.ts:264-272`가 불일치 시 421을 반환한다. 앱 계층에서 fail-closed로 고정되어 있다 |
| 클라이언트 disabled 재확인이 보안 방어로 과장됨 | **철회** | 원 보고서가 그런 주장을 한 적이 없다. 코드 주석의 "synthetic submit"은 합성 submit **이벤트**(중복 제출) 방지다 |
| "항진명제 게이트가 두 개" | **한 개로 정정** | 서비스 게이트의 sha 재해시는 항진명제 확정. 그러나 기사 게이트와의 비대칭은 **의도**이며 테스트가 명세한다 |
| `recoverExpiredLeases` 가드 부재가 Important | **Low로 하향** | `adapters.ts:16-23`이 프로바이더 타임아웃을 **생성 시점에 리스보다 작도록 강제**한다(초과 시 throw) |
| "`endpoints.test.ts` 때문에 Caddyfile을 지워도 초록" | **부분 반증** | Astro가 헤더를 버리는 메커니즘은 확정이나, `configuration.test.mjs:197-203`이 해당 Caddy 헤더 3줄을 고정한다 |
| 무가드 마이그레이션이 Critical, 처방은 `runtime.ts`에 가드 추가 | **Important + 처방 교체** | 구 스키마 복원 경로는 `restore.mjs:195` + `system-adapters.mjs:139`로 반증. 더 중요하게 **가드 자체가 데이터 보존 가드가 아니어서** 승인된 유지보수 배포가 같은 파괴적 SQL을 실행한다(§5.4) |
| 미사용 `i18next` 의존성 | **오류** | `apps/site/src/i18n/index.ts:2`에서 실사용, `site-content.test.ts:78`이 검증 |
| TypeScript 7↔6 선언 인계 위험 | **Minor로 하향** | `skipLibCheck:false`로도 오류 0건 |
| 지문이 21개 객체를 검증 | **2개** | 원 보고가 오히려 과소 보고 |

**rev.1에 없었고 rev.2에서 추가된 것**: C-2(발행 빌드 prune) · 디자인 토큰 easing 불일치 · audit 수치 불일치 · `better_sqlite3.node` 조달 경로 · 유령 의존성 3건 · `@types/node` 메이저 불일치 · `AGENT.md`/`work-log.md` 33커밋 지연 · 마지막 전수 검증이 Windows에서 실행됨 · 배포↔발행 인터록 부재.

---

## 부록. 프로세스 노트

1. **이 리뷰의 대상 `fa82f41`은 직전 리뷰의 수정 결과물이다.** 연속된 두 번째 리뷰이며, C-2는 그 수정이 **불완전했음**을 보여준다 — `PUBLICATION_BUILD_FAILED`의 원인이 둘이었는데 하나만 고쳤다.
2. **작업 트리가 clean이 아니었다.** `docs/00-document-map.md`에 커밋되지 않은 8줄 추가와 untracked `docs/reviews/`(7파일)가 있었고, 1라운드 7개 보고서 전부가 "clean"이라는 틀린 전제를 적었다. `docs/reviews/`는 어느 에이전트의 범위에도 없어 아무도 읽지 않았고, 그 결과 **이미 미수용 결정된 항목 2건이 재보고**됐다.
3. **직전 리뷰의 미수용 결정 하나가 무효화됐다.** "상담 속도 제한을 폼 토큰 검증 이후에 두어도 되는 이유"의 근거였던 "토큰 발급 경로의 별도 제한"이 D-B1로 무력화됨이 실증됐다.
4. **1라운드 에이전트 1개가 읽기 전용 지시를 위반**해 저장소에 파일을 생성했다. 2·3라운드에서는 쓰기 허용 경로를 출력 파일 하나로 제한했고 위반은 재발하지 않았다.
5. **3라운드가 없었다면 rev.1의 잘못된 결론 4건이 그대로 남고 Critical 1건을 놓쳤을 것이다.** 검증자를 검증하는 단계의 값이 이번 리뷰에서 가장 컸다.
6. 원본 에이전트 보고서 13건(도메인 7 + 교차검증 3 + 추가검증 3, 총 5,316줄)은 세션 스크래치패드에 있다. 이 통합본은 역검증을 통과한 내용만 담았다.
