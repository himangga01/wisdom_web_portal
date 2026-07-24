# Sites Analytics와 운영 성과지표 계획

기준일: 2026-07-24  
문서 상태: 자체 Analytics 구현 설계 반영 v1.2

## 결론

현재 서비스에는 방문 성과지표 기능이 없습니다. ChatGPT Sites의 내장
Analytics는 외부 기준값으로 유지하되, 우리 서비스가 인기 페이지와 상담
성과를 같은 관리자 화면에서 확인할 수 있도록 first-party aggregate
Analytics를 직접 구현합니다.

자체 수집기는 외부 analytics 제품·SDK, cookie와 browser visitor ID를
사용하지 않습니다. Control은 원본 event, 원본 IP·User-Agent와 장기
analytics visitor identifier를 저장하지 않고 page-view rollup과 병합 가능한
fixed register sketch만 저장합니다. 이 방식의 순 방문자는 정확한 개인 수가
아니므로 모든 화면과 문서에서 `추정 순 방문자`로 표시합니다.

## Sites에서 공식 확인된 기능

Sites 공식 가이드에서 확인된 항목은 다음과 같습니다.

- 총 순 방문자 수
- 총 페이지 조회 수
- 순 방문자와 페이지 조회의 시간 추이 그래프
- 조회 기간 변경
- 집계 단위 변경
- ChatGPT web·desktop의 `Sites → More actions → Analytics` 화면
- 별도 analytics SDK 없이 자동 traffic 기록

현재 Analytics는 Enterprise workspace가 소유한 Site에는 제공되지 않습니다.
또한 CLI와 IDE에는 독립 Analytics 화면이 없고, 현재 Sites connector에도
analytics 조회 도구가 없습니다.

근거:
[ChatGPT Sites 개발 가이드의 Review Site analytics](https://learn.chatgpt.com/docs/sites#review-site-analytics)

## 현재 공식 근거가 부족한 항목

다음 항목은 사용자가 확인한 Sites 화면에는 있을 수 있으나, 현재 공식
가이드와 connector 계약에서는 확인되지 않았습니다.

- 인기 페이지 또는 페이지별 조회 순위
- 순 방문자의 정확한 식별·중복 제거 기준
- 데이터 갱신 주기
- 보관기간
- CSV export
- analytics API
- connector를 이용한 자동 조회

따라서 Sites 내장의 `인기 페이지`는 Task 0에서 실제 account의 Analytics
화면을 확인하는 항목으로 둡니다. 화면에 제공되면 외부 baseline에 포함하고,
없으면 Sites 지원 기능으로 약속하지 않습니다. 자체 인기 페이지는 Control의
normalized route rollup으로 별도 구현합니다.

## 현재 서비스의 공백

| 항목 | 현재 구현 |
|---|---|
| 순 방문자 수 | 없음 |
| 페이지 조회 수 | 없음 |
| 시간별·일별 방문 추이 | 없음 |
| 인기 페이지 | 없음 |
| 기간·집계 단위 선택 | 없음 |
| analytics dashboard/API | 없음 |
| page-view/event 저장 schema | 없음 |
| 방문자 analytics SDK | 없음 |

근거:

- [`apps/site/package.json`](../../apps/site/package.json)에 GA4, Plausible,
  Umami, PostHog 등 방문 analytics dependency가 없습니다.
- [`apps/site/src/layouts/BaseLayout.astro`](../../apps/site/src/layouts/BaseLayout.astro)에
  page-view event 전송이 없습니다.
- [`ops/caddy/Caddyfile.template`](../../ops/caddy/Caddyfile.template)은 public
  host access log를 의도적으로 사용하지 않습니다.
- [`apps/control/src/db/client.ts`](../../apps/control/src/db/client.ts)에
  visitor/page-view/event 집계 table이 없습니다.
- React 관리자 branch `8d96fb4`의
  `apps/admin/src/features/dashboard/DashboardPage.tsx`와
  `apps/control/src/admin/api.ts`는 상담 상태 집계만 제공하며 방문 성과
  분석이 아닙니다.
- 현재 monitoring은 uptime, backup, disk와 worker 상태를 다루며 방문
  analytics를 다루지 않습니다.

## 검토한 접근

| 접근 | 장점 | 단점 | 결정 |
|---|---|---|---|
| Sites 내장 Analytics만 사용 | 구현과 개인정보 범위가 가장 작음 | 자체 관리자·인기 페이지·자동 상담 비교 불가 | 외부 기준값으로 유지 |
| 장기 visitor hash 또는 browser ID 저장 | 기간 순 방문자 계산이 단순함 | pseudonymous 추적 범위와 동의 UX 확대 | 채택하지 않음 |
| aggregate register sketch 자체 수집 | 개별 event·장기 identifier를 보관하지 않음 | unique 수치가 근사값 | **채택** |

## migration 결정

### 채택

- Control에 first-party page-view 수집 API와 aggregate rollup을
  구현합니다.
- React 관리자에 기간·단위 filter, 추정 순 방문자, 페이지 조회, 추이,
  인기 페이지와 상담 전환 참고값을 제공합니다.
- Sites가 자동 제공하는 기본 Analytics는 자체 지표와 독립된 외부
  baseline으로 사용합니다.
- 두 시스템의 수치 차이는 집계 방식 차이로 기록하며 어느 한쪽에 맞추기 위해
  원본 visitor data를 추가 수집하지 않습니다.
- 구체적인 파일·API·schema·검증 순서는
  [`07-first-party-analytics-implementation-plan.md`](07-first-party-analytics-implementation-plan.md)를
  따릅니다.

### 추가하지 않음

- GA4, Meta Pixel, Naver Analytics와 같은 제3자 SDK
- custom visitor cookie, localStorage visitor ID 또는 fingerprint SDK
- raw page-view event와 장기 pseudonymous visitor hash
- D1/R2와 Sites route handler에 analytics data 저장
- 상담 PII와 visitor traffic의 개인 단위 연결
- Sites Analytics 화면 scraping
- 존재가 확인되지 않은 analytics API 연동

Control은 요청 시점에만 서버 IP와 coarse User-Agent family를 keyed digest로
처리하고 register를 갱신한 뒤 원본과 digest를 폐기합니다. client rate
digest도 bounded in-memory counter를 갱신한 직후 폐기합니다. DB에는
validated source origin, normalized public path, locale, 집계 count,
aggregate register sketch와 bounded global rate counter만 남깁니다.

## 운영 KPI

| KPI | 원본 | 계산/해석 |
|---|---|---|
| 추정 순 방문자 수 | Control aggregate register sketch | cookie-less cardinality 근사값 |
| 페이지 조회 수 | Control page-view rollup | 수락된 public route event 합계 |
| 방문 추이 | Control hour/day rollup | 같은 기간·집계 단위의 이전 구간과 비교 |
| 페이지 조회/방문자 | Control 위 두 지표 | `page views ÷ estimated visitors` |
| 인기 페이지 | Control route rollup | 선택 기간 상위 normalized public path |
| 상담 접수 수 | Control 집계 | 같은 기간의 `received` consultation 수 |
| 대략적 상담 전환율 | Control aggregate | `상담 접수 수 ÷ 추정 순 방문자 수 × 100` |
| 외부 baseline | Sites Analytics | Sites 관리 화면 표시값을 별도 기록 |

대략적 상담 전환율은 같은 기간의 서로 다른 aggregate count를 나눈 운영
참고값입니다. 개별 방문자가 실제 상담을 제출했는지 연결하는 값이 아니며
정확한 attribution 지표로 표현하지 않습니다.
source origin filter가 특정 origin이면 상담 접수는 계속 전체 포털 합계이므로
source별 전환율은 계산하지 않습니다. 이 참고값은 source가 `all`일 때만
표시합니다.

## 기간과 집계 단위

운영 기록은 비교 가능한 범위로 고정합니다.

### 주간

- 최근 7일 추정 순 방문자
- 최근 7일 페이지 조회
- 이전 7일 대비 증감
- 시간·일 단위 traffic 추이
- 인기 페이지가 제공될 경우 상위 페이지
- 같은 기간 상담 접수 수
- 대략적 상담 전환율

### 월간

- 최근 28일 또는 calendar month
- 이전 동기간 대비 증감
- locale·service 콘텐츠 우선순위 검토
- 새 article 또는 주요 release 전후 변화
- traffic 증가가 상담 증가로 이어졌는지 점검

기간과 granularity를 바꾸면 이전 비교값도 같은 조건으로 다시 봅니다.

## 운영 인사이트 사용

### 콘텐츠

- 특정 업무 페이지의 조회가 높으면 해당 업무 안내를 우선 보강합니다.
- article 공개 전후 traffic 변화를 확인합니다.
- locale별 page ranking이 실제 제공될 때만 번역 우선순위에 사용합니다.

### 상담 UX

- 방문자는 늘고 상담이 늘지 않으면 CTA, 동의문 로딩과 form completion
  경로를 검토합니다.
- 페이지 조회는 높지만 순 방문자 대비 반복 조회가 과도하면 정보 구조와
  navigation을 검토합니다.

### 운영

- release 직후 비정상적인 traffic 감소를 hosting/domain/route 문제의
  보조 신호로 사용합니다.
- traffic 증가는 availability나 정상 작동을 직접 증명하지 않으므로 기존
  Sites URL·API health monitoring을 대체하지 않습니다.
- 숫자를 성공률, 시장 점유율 또는 서비스 품질 보장 표현으로 사용하지
  않습니다.

## privacy 경계

- Sites가 traffic을 자동 기록한다는 사실을 개인정보 처리방침 검토에
  포함합니다.
- Sites 내장 Analytics는 공식 문서에 unique visitor 산정 방식과 cookie 사용
  여부가 명시되지 않았으므로 임의로 “cookie-free” 또는 “완전 익명”이라고
  표현하지 않습니다.
- 자체 Analytics만 cookie·browser visitor ID 없이 aggregate register sketch로
  집계하며, 이를 정확한 사람 수나 완전 익명 데이터라고 과장하지 않습니다.
- Sites Analytics와 상담 PII를 개인 단위로 결합하지 않습니다.
- 상담 body, 전화, 이메일, 이름과 withdrawal token을 analytics에 보내지
  않습니다.
- query, hash, referrer, page title, raw IP와 raw User-Agent를 저장하지
  않습니다.
- source origin과 collection interval로 수집 완료의 `0`, 일부 수집과
  미수집을 구분합니다.
- client rate subject digest는 DB에 저장하지 않고 process memory의 bounded
  aggregate counter만 window 동안 유지합니다.
- production 자체 Analytics는 개인정보 처리방침 검토와 사용자 활성화 승인
  전에 Control과 public client flag를 모두 `false`로 유지합니다.
- 이 설정들은 자체 collector만 끄며 Sites 플랫폼의 자동 Analytics를
  비활성화하지 않습니다.
- 정책 검토에서 명시적 opt-in이 필요하면 현재 계획으로 활성화하지 않고
  consent UX와 browser state를 별도 승인받아 다시 설계합니다.
- 제3자 analytics SDK 또는 browser visitor ID를 추가하려면 목적, 수집항목,
  cookie, 보관기간과 consent 영향에 대한 별도 승인과 계획이 필요합니다.

## 실행 계획

### A. 자체 Analytics 구현 gate

- [ ] 구현 기준을 React 관리자 branch로 고정합니다.
- [ ] 수집 목적·항목·180일 보존을 개인정보 처리방침에서 검토합니다.
- [ ] exact public client Origin 목록을 승인합니다.
- [ ] `추정 순 방문자` 문구를 승인합니다.
- [ ] `07-first-party-analytics-implementation-plan.md`의 task별 구현을
  승인합니다.

### B. Sites 외부 baseline gate

- [ ] Site가 Enterprise workspace 소유인지 확인합니다.
- [ ] account의 `More actions → Analytics`가 보이는지 확인합니다.
- [ ] 순 방문자, 페이지 조회, 추이, 기간과 granularity가 제공되는지
  확인합니다.
- [ ] 인기 페이지가 실제로 제공되는지 별도로 기록합니다.

### C. 공개 후 baseline

- [ ] 사용자 승인 후 Analytics 화면을 엽니다.
- [ ] 충분한 공개 traffic이 발생한 첫 7일을 baseline으로 기록합니다.
- [ ] 같은 기간 자체 Analytics와 Control consultation count를 확인합니다.
- [ ] `docs/gpt-sites-migration/08-kpi-review-log.md`에 기간, 단위와 수치를
  기록합니다.

### D. 운영 review

- [ ] 주간 review는 동일 기간과 granularity로 비교합니다.
- [ ] 월간 review에서 content/CTA 개선 후보를 도출합니다.
- [ ] 개선은 지표만으로 자동 실행하지 않고 사용자 승인 후 별도 task로
  수행합니다.

## 완료 기준

1. React 관리자에서 추정 순 방문자와 페이지 조회를 확인할 수 있습니다.
2. 두 지표의 시간 추이, 기간과 granularity를 변경할 수 있습니다.
3. 인기 페이지를 normalized public path 기준으로 확인할 수 있습니다.
4. 신규 외부 analytics/차트 package, cookie와 browser visitor ID가 없습니다.
5. raw event, raw IP, raw UA와 장기 visitor hash가 DB에 없습니다.
6. Sites Analytics와 Control 상담 집계를 개인 단위로 연결하지 않습니다.
7. Sites 내장 Analytics의 실제 account 제공 범위가 외부 baseline으로
   기록됩니다.
8. 주간 KPI 기록 양식과 비교 기준이 문서화됩니다.

코드 구현, 테스트, Analytics UI 확인, baseline 수집과 운영 문서 작성은 각각
별도 사용자 승인으로 수행합니다.
