# Sites 내장 Analytics baseline

기준일: 2026-07-25  
문서 상태: Sites 전용 기준 v2.0

## 목적

이 문서는 ChatGPT Sites가 배포된 Site에 제공하는 내장 Analytics의 확인
범위와 공개 후 기록 절차만 정의합니다.

현재 Astro·Control·React 관리자의 first-party Analytics 구현은
[`2026-07-24-first-party-analytics.md`](../superpowers/plans/2026-07-24-first-party-analytics.md)의
독립된 현재 서비스 작업입니다. Control collector, DB schema, KPI 계산,
React 관리자 화면과 보존정책은 이 문서와 Sites migration의 구현 범위가
아닙니다.

## 공식 확인 범위

현재 Sites 공식 가이드에서 확인된 항목은 다음과 같습니다.

- 총 순 방문자 수
- 총 페이지 조회 수
- 순 방문자와 페이지 조회의 시간 추이
- 조회 기간 변경
- 집계 단위 변경
- ChatGPT web·desktop의 `Sites → More actions → Analytics` 화면
- 별도 analytics SDK 없이 Sites가 자동으로 기록하는 traffic

현재 공식 기준상 Enterprise workspace 소유 Site에는 Analytics가 제공되지
않습니다. CLI·IDE에는 독립 Analytics 화면이 없고 현재 Sites connector에도
Analytics 조회 도구가 없습니다.

근거:
[ChatGPT Sites 개발 가이드의 Review Site analytics](https://learn.chatgpt.com/docs/sites#review-site-analytics)

## 실제 account에서만 확인할 항목

다음 항목은 현재 공식 가이드와 connector 계약만으로 확정하지 않습니다.

- 인기 페이지 또는 페이지별 조회 순위
- 순 방문자의 식별·중복 제거 방식
- 데이터 갱신 주기
- 보관기간
- CSV export
- Analytics API
- connector를 이용한 자동 조회

실제 account 화면에 인기 페이지가 표시되면 제공 사실만 기록합니다. 표시되지
않으면 Sites 지원 기능으로 약속하지 않습니다.

## Base migration 적용

- Base migration은 Sites 내장 Analytics만 사용합니다.
- GA4, Meta Pixel, Naver Analytics와 같은 제3자 SDK를 추가하지 않습니다.
- custom visitor cookie, browser visitor ID와 fingerprint SDK를 추가하지
  않습니다.
- Sites Analytics를 Control 관리자 화면으로 import하거나 동기화하지
  않습니다.
- 공식 지원이 확인되지 않은 API, export와 scraping을 사용하지 않습니다.
- Sites Analytics와 상담 PII를 개인 단위로 연결하지 않습니다.

현재 서비스 collector를 Sites에서도 사용하기 위한 client adapter는
[`04-implementation-plan.md`](04-implementation-plan.md)의 Task 16에서 별도
승인하는 선택 작업입니다. adapter가 없어도 Sites migration을 완료할 수
있습니다.

## 공개 전 확인

- [ ] Site 소유 workspace 유형을 기록합니다.
- [ ] account에서 `More actions → Analytics` 메뉴가 보이는지 확인합니다.
- [ ] 순 방문자, 페이지 조회, 추이, 기간과 집계 단위가 제공되는지
  기록합니다.
- [ ] 인기 페이지가 실제 화면에 제공되는지 별도로 기록합니다.
- [ ] Analytics가 제공되지 않으면 미제공 사실과 확인 시각만 남깁니다.

이 단계의 화면 확인은 사용자가 별도로 승인한 경우에만 수행합니다.

## 공개 후 baseline 기록

공개 traffic이 발생한 첫 비교 가능한 7일 구간을 기준으로 다음 항목을
`docs/gpt-sites-migration/07-sites-analytics-review-log.md`에 기록합니다.

```text
Site identity
deployment/version identity
custom domain
access policy
measurement period
granularity
total unique visitors
total page views
traffic series availability
popular pages availability
observed timestamp
known limitations
```

Sites가 제공하지 않는 값은 추정하거나 다른 시스템의 값으로 채우지 않습니다.
첫 7일 이후의 추가 주간·월간 기록은 별도 운영 승인으로 수행합니다.

## 해석 경계

- Sites 순 방문자 산정 방식이 공개되지 않았으므로 정확한 개인 수라고
  표현하지 않습니다.
- cookie 사용 여부가 명시되지 않았으므로 `cookie-free` 또는 `완전 익명`이라고
  표현하지 않습니다.
- traffic 증감은 서비스 품질, 성공률, 시장 점유율이나 정상 작동을 직접
  증명하지 않습니다.
- Sites 지표만으로 콘텐츠나 UX를 자동 수정하지 않습니다.
- 현재 서비스 first-party Analytics와 비교할 경우에도 집계 방식이 다르다는
  사실을 먼저 밝히고, 그 비교 작업은 별도 운영 문서와 승인으로 다룹니다.

## 완료 기준

1. 실제 account의 Sites Analytics 제공 여부와 기능 범위가 기록됩니다.
2. 제공되는 경우 첫 비교 가능한 공개 기간의 baseline이 기록됩니다.
3. 제공되지 않는 경우 migration 실패가 아니라 플랫폼 제약으로 기록됩니다.
4. 공식 지원이 확인되지 않은 API, export와 인기 페이지를 약속하지 않습니다.
5. 현재 서비스 Analytics의 구현 세부사항이 이 문서에 중복되지 않습니다.

Analytics UI 확인과 baseline 기록은 각각 별도 사용자 승인 작업입니다.
