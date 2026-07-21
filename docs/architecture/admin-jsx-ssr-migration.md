# 관리자 SSR을 JSX 컴포넌트로 전환 (설계·계획)

작성일: 2026-07-22 · 상태: 제안(착수 전, 2차 실측 반영) · 범위: `apps/control` 관리자 표현 계층

## 1. 배경과 동기

- 팀 유지보수 표준을 React/JSX로 통일하려 함(공개 사이트는 이미 Astro에서 React island 사용 가능, 관리자는 순수 HTML 문자열 연결).
- 관리자 UI(`apps/control/src/admin/routes.ts`, 약 1,258줄)는 `page()` 헬퍼 + 화면별 템플릿 문자열로 구성되어, 갭 분석에서 나온 다수의 신규 화면(상담 메모·검색·이력·알림 이력 등)을 얹기에 확장성이 낮고, 수동 `escapeHtml` 부담이 크다.
- **CSP 취약 구조**가 확인됨(§3.1): 앱 CSP가 자기 인라인 스타일을 허용하지 못해 Caddy의 `replace`에 의존한다.

이 문서는 위 세 문제를 **동작 불변(리팩터)** 원칙 아래 다룬다. 이전 초안(`react-dom/server` 권장, CSP를 마이그레이션에 포함)을 재점검 결과에 따라 **정정**한 확정본이다.

## 2. 목표 / 비목표

**목표**
- 관리자(+공유 `page()`를 쓰는 고객 철회 페이지)의 HTML 생성 계층을 **JSX 컴포넌트 + 서버 렌더**로 교체.
- 라우트·핸들러 로직·폼 target·CSRF·세션·상태코드·PRG(`?saved=1`) 규약은 **불변**.
- 자동 escape 도입으로 수동 `escapeHtml` 제거, XSS 표면 축소.
- CSP를 앱 계층에서 **자기정합**하게 만들어 Caddy 의존 제거(별도 선행 작업).

**비목표**
- 공개 사이트(Astro) 변경 없음.
- 클라이언트 JS/번들 도입 없음(관리자는 여전히 번들 0의 서버 렌더).
- 갭 분석의 신규 기능(메모·검색·이력·알림 이력 표시 등)은 **이 작업에 포함하지 않음**(후속). 본 작업은 순수 표현 계층 이관.

## 3. 핵심 결정 (재점검 근거 포함)

### 3.1 CSP 자기정합화 — React와 분리한 **선행 독립 작업**

확인된 현재 상태:
- 앱: `apps/control/src/app.ts:236` — `default-src 'none'; style-src 'self'; …` (인라인 `<style>` 불가, unsafe-inline·해시·nonce 없음).
- Caddy: `ops/caddy/Caddyfile.template:19` — `style-src 'self' 'unsafe-inline'`.
- Caddy `header` 지시자는 업스트림 헤더를 **replace(set)** 하므로 **프로덕션(Caddy 경유)에서는 스타일이 렌더**된다. 그러나 앱 직접 접근·Caddy 설정 변경 시 차단된다 → **우연히 동작하는 취약 구조.**

결정: `ADMIN_STYLE`(`routes.ts:81`)의 sha256을 시작 시 계산해 앱 CSP `style-src`에 `'sha256-…'`을 추가한다.
- 두 origin(관리자 + 고객 철회, 둘 다 `isSensitivePath`)과 Caddy 유무에 무관하게 correct.
- unsafe-inline보다 엄격(정확한 스타일 블록만 허용).
- **React 마이그레이션과 독립적**이며 단독으로 shippable. **0단계로 먼저 처리한다.**

구현 메모:
- CSP 해시는 `<style>` 태그를 제외한 **내용(ADMIN_STYLE 문자열) 바이트**에 대해 계산: `createHash("sha256").update(ADMIN_STYLE).digest("base64")` → 토큰 `'sha256-<base64>'`.
- `ADMIN_STYLE`(또는 그 해시)을 admin 모듈에서 export하여 `app.ts`의 CSP 구성에서 참조. `style-src 'self' 'sha256-…'` 형태(`'self'`는 미래 외부 CSS 라우트 대비로 유지).
- 기존 테스트 `admin-http.test.ts:405`(`toContain("default-src 'none'")`)는 해시 추가 후에도 생존. 신규 계약 테스트: "CSP `style-src`가 실제 `ADMIN_STYLE` 해시를 포함"을 고정.
- **실측 확인**: 관리자·철회 마크업에 인라인 `style=` 속성이 **0건**(`grep 'style="'` → 0)이므로, 단일 `<style>` 블록의 sha256 해시 하나로 전 스타일이 커버된다. 추가 해시나 `'unsafe-hashes'`는 불필요.

### 3.2 렌더러: **`hono/jsx`** (이전 초안의 `react-dom/server`에서 정정)

`hono/jsx` 실제 직렬화를 실행해 확인한 근거:
```
<input type="checkbox" name="enabled" value="1" checked="" class="x" readonly=""/>
<option value="full-inquiry" selected="">Full</option>
```
- **HTML 속성명 그대로 유지**(`class`/`for`/`readonly`/`maxlength`/`inputmode`…) → camelCase 전면 개명 불필요.
- **작성 순서 보존**, `<option selected>` 를 option에 직접 허용(React의 controlled `<select defaultValue>` 모델 불필요).
- boolean 속성은 `attr=""`, 태그는 자기닫힘(`<input …/>`)으로 직렬화.
- children 자동 escape.

`react-dom/server`는 `className`/`htmlFor`/`readOnly` 전면 개명 + `<select defaultValue>` 재구성 + 속성 재정렬을 강제해 **마이그레이션·테스트 마찰이 훨씬 크다**. 관리자는 서버 전용이라 React **라이브러리** 자체의 실익이 없으므로 `hono/jsx`가 명백히 우월하다.

트레이드오프(명시): `hono/jsx`는 "React식 JSX·멘탈모델"이며 React 라이브러리는 아니다. 팀 지식(JSX·함수 컴포넌트·props)은 그대로 이전된다. 의존성 추가 **0**(Hono 4.12 내장). 만약 조직 표준이 "React 라이브러리 그 자체"를 강제한다면 `jsxImportSource`만 `react`로 바꾸고 `react`/`react-dom` 의존성을 추가하면 되나, 위 마찰 비용을 감수해야 한다.

### 3.3 레이아웃 분리

`page()`는 관리자와 **고객 철회 페이지**(공개 origin)가 공유한다. 전환 시 `AdminLayout`(관리자 크롬 포함)과 `WithdrawalLayout`(고객용, 관리자 내비 없음)으로 분리해, 관리자 내비가 고객 페이지에 노출되던 기존 residual도 함께 정리한다.

## 4. 아키텍처

신규 디렉터리 `apps/control/src/admin/ui/`:
- `AdminLayout.tsx` — 기존 `page()`의 관리자 버전(`<html lang><head><style/><header nav/></head><body>{children}`). `renderDocument(el)` = `"<!doctype html>" + render(el)`.
- `WithdrawalLayout.tsx` — 고객 철회용 최소 레이아웃(관리자 내비 제외).
- `Banner.tsx`(saved/sent/error), `BackLink.tsx`, `ErrorPage.tsx`(forbidden/actionError/validation), `EmptyState.tsx`.
- 화면: `Dashboard`, `ConsultationList`, `ConsultationDetail`, `ArticleList`, `ArticleDetail`, `RevisionDiff`, `PublishPreview`, `Releases`, `NotificationSettings`, `Consents`, `Failures`, `Health`, 로그인/MFA.
- 헬퍼 컴포넌트화: `consultationDetail`, `actionForms`, `statusForm`, `piiMarkup` 등 문자열 반환 헬퍼 → 컴포넌트/엘리먼트.

`routes.ts`는 **핸들러 로직만 유지**하고 응답을 `context.html(renderDocument(<Screen .../>))` 형태로 바꾼다. `SEOUL_TIME`/`formatSeoulTime`, `resultMessage` 맵, CSRF hidden input, `?saved=1` 쿼리 규약, 상태코드는 그대로 재사용한다. `escapeHtml` 호출은 `{value}` 보간으로 대체(자동 escape). 의도적 마크업 삽입(예: `sent` 배너의 `<a>`)은 JSX로 자연 표현하며 `dangerouslySetInnerHTML` 사용처는 사실상 0.

## 5. 툴링 변경

1. `apps/control/tsconfig.json`:
   - `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"` 추가.
   - **`include`를 `.tsx`까지 확장(정정)**: 현재 `["src/**/*.ts", "test/**/*.ts", ...]`는 `.ts`만 잡으므로 `src/**/*.{ts,tsx}`·`test/**/*.{ts,tsx}`로 변경해야 컴포넌트가 컴파일·타입체크된다. `tsconfig.build.json`의 `exclude`(`src/**/*.test.ts`)도 `.test.tsx` 포함하도록 확인.
2. `apps/control/vitest.config.ts`: `esbuild: { jsx: "automatic", jsxImportSource: "hono/jsx" }` 추가(테스트에서 컴포넌트 직접 렌더 가능하게). 기존 `fileParallelism:false` 등 유지.
3. 빌드(`tsc -p tsconfig.build.json`) 영향 없음(JSX가 `.js`로 트랜스파일). `tsx` 개발 실행도 JSX 지원. **의존성 추가 0.**
4. 작성 규칙: `verbatimModuleSyntax` 하에서 타입 심볼(`FC`, `PropsWithChildren` 등)은 `import type { FC } from "hono/jsx"`로만 임포트.

**렌더 경로(실측 확정)**: 관리자 컴포넌트는 전부 sync(데이터는 props로 주입, async 컴포넌트 없음)라 JSX 노드의 `.toString()`이 문자열을 반환한다. 따라서 핸들러는 기존 시그니처 그대로 `context.html("<!doctype html>" + renderDocument(<Screen .../>))` 형태로 유지한다(`renderDocument`는 `String(node)` 래퍼). 대안으로 `hono/jsx-renderer`의 `jsxRenderer(Layout, { docType: true })` + `c.render()`가 있으나, 레이아웃이 2종(Admin/Withdrawal)이라 경로별 스코프가 필요해 명시적 `renderDocument` 방식을 기본으로 한다.

## 6. 테스트 영향 (재산정 — 상향)

- `admin-http.test.ts`(현재 27개): 대부분 가시 텍스트·속성 부분문자열 단언이라 구조 동형이면 생존하나, `hono/jsx`의 직렬화 차이로 **정확 표기 의존 단언이 다수 갱신 필요**:
  - boolean 속성: `value="1" checked` → `value="1" checked=""`, `selected` → `selected=""`, `disabled`/`required`/`readonly` 동일.
  - 자기닫힘 태그(`<input>` → `<input …/>`), 공백/개행 차이 가능성.
  - 속성 **순서·이름은 보존**되므로 재정렬성 대량 수정은 없음(react-dom 대비 이점).
- 규모: "일부"가 아니라 **상당수**의 기계적·예측가능 갱신으로 계획한다. 단계별로 27개 green 유지 확인.
- 신규: 핵심 컴포넌트 단위 렌더 테스트 추가(escape·배너·확인 체크박스·레이아웃 분리).
- Playwright e2e(공개 사이트)는 무영향.

## 7. 단계별 순서 (증분·항상 green)

- **0단계 — CSP 자기정합화(독립·선행)**: §3.1의 sha256 해시 적용 + 계약 테스트. 단독 shippable. React와 무관.
- **1단계 — 툴링 스파이크**: `hono/jsx` tsconfig/vitest 설정 + leaf 1개(`ErrorPage`) 전환. `tsc --noEmit` · `vitest run src/admin` · `build --workspace @wisdom/control` green 확인. 되돌리기 쉬움. **여기까지가 "지금 착수" 최소 단위.**
- **2단계 — 레이아웃·공용 헬퍼**: `AdminLayout`/`WithdrawalLayout`·`Banner`·`BackLink`·오류/검증 페이지군 전환. `escapeHtml` 축소 시작.
- **3단계 — 화면 증분**: 라우트별로 하나씩(대시보드 → 상담 목록/상세 → 알림 설정 → 발행/릴리스 → 나머지). 각 전환마다 해당 테스트 갱신.
- **4단계 — 정리**: 문자열 헬퍼(`page`,`escapeHtml` 잔여) 제거, 컴포넌트 테스트 보강, 전체 회귀.

RC 단계 고려: 0단계는 즉시 처리 가치가 있는 독립 수정. 1~4단계는 순수 리팩터라 기능 리스크는 낮으나 보안 표면(CSP·escape) 변화가 있어 리뷰 필수이며, launch를 막지 않도록 병행 또는 출시 후 진행 가능.

## 8. 리스크와 완화

- **escape 의미 변화**: JSX는 children을 자동 escape(속성명은 개명 없이 통과). 현재 전부 값 escape라 순이득이며 XSS 리스크 감소. 의도적 마크업 주입처가 없어 회귀 위험 낮음.
- **테스트 표기 차이**: §6대로 예측가능·기계적. 단계마다 27개 유지로 흡수.
- **NodeNext/verbatimModuleSyntax/isolatedModules + JSX**: **스파이크로 실증 완료**(control이 `"type":"module"` ESM이라 `.tsx` + `hono/jsx`가 `tsc` 통과). 참고: 만약 패키지가 CommonJS였다면 `verbatimModuleSyntax`가 top-level `export`를 막았을 것 — ESM 확인이 전제.
- **CSP 해시 드리프트**: `ADMIN_STYLE` 변경 시 해시가 자동으로 재계산되도록 상수에서 런타임 산출(하드코딩 금지). 계약 테스트로 고정.
- **레이아웃 분리 회귀**: 철회 페이지 4개 언어 카피(`WITHDRAWAL_COPY`)·라우트 유지 확인.

## 9. 검증 (단계별)

- 매 단계: `npx tsc --noEmit -p tsconfig.json` + `npx vitest run src/admin` + `npm run build --workspace @wisdom/control`.
- 종료 시: 전체 `npm run test` + 실제 브라우저 스팟체크(로그인 → 대시보드 → 상담 상세 → 알림 설정) — 스타일 적용, escape, **CSP 콘솔 에러 0**(관리자 직접 접근 시에도), 철회 페이지 렌더 확인.

## 10. 이전 초안 대비 변경점(재점검 반영)

| 항목 | 이전 초안 | 본 확정본 |
|---|---|---|
| 렌더러 | `react-dom/server` 권장 | **`hono/jsx` 권장**(의존성 0·마찰 최소, 근거: 직렬화 실측) |
| "렌더러 차이" | 한 줄(jsxImportSource) | **정정**: 속성명·select 모델·테스트 마찰이 크게 다름 |
| CSP 수정 | 마이그레이션 3단계에 포함 | **독립 선행(0단계) sha256 해시로 분리** |
| CSP 현재 상태 | "무스타일 렌더" | **"Caddy replace에 의존하는 취약 구조"**(직접 접근 시 차단) |
| 테스트 영향 | "일부 갱신" | **"상당수 예측가능 갱신"** |
| 레이아웃 | 단일 `page()` | **AdminLayout / WithdrawalLayout 분리**(고객 페이지 크롬 residual 정리) |

## 11. 2차 재점검(실측) 결과 요약

스파이크로 다음을 검증하여 계획을 정정·확정했다.
- **[정정] tsconfig `include`가 `.ts`만 잡음** → `.tsx` 포함하도록 확장 필요(§5).
- **[확인] `.tsx` + hono/jsx 타입체크 통과**(NodeNext·verbatimModuleSyntax·isolatedModules, control=ESM).
- **[확인] 렌더 경로** `"<!doctype html>" + String(<Layout/>)` 동작(관리자 컴포넌트 전부 sync) — 기존 `context.html(string)` 시그니처 유지.
- **[확인] escape 실동작**: children 자동 escape(`<script>`→`&lt;…`), 자식 엘리먼트는 마크업 유지, boolean은 `checked=""`.
- **[확인] 인라인 `style=` 속성 0건** → `<style>` sha256 해시 하나로 CSP 완전 커버.
