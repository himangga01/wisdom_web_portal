# 공개 포털 콘텐츠와 정보 단위

기준일: 2026-07-24  
문서 상태: 자체 Analytics 구현 계획 반영 v1.3

## 정보 공급 유형

Sites 화면에 나타나는 정보는 네 종류로 분리합니다.

| 유형 | 예 | 공급 시점 | 권위 |
|---|---|---|---|
| 정적 공개 copy | 사무소, 대표, 업무, 절차 | Sites source build | 현재 `apps/site` 정식 코드 |
| 승인된 public snapshot | 게시글, 개인정보·마케팅 정책 | Sites version 생성 전 import | Control release manifest |
| runtime 공개 설정 | canonical, API origin | Sites production env | 승인된 운영값 |
| runtime 응답 | 동의문, form token, receipt | browser가 Control API 직접 호출 | Control |
| 자체 운영 성과지표 | 추정 순 방문자, 페이지 조회, 추이, 인기 페이지 | Control aggregate API → React 관리자 | Control first-party aggregate |
| 외부 성과 기준값 | Sites가 제공하는 방문·조회 지표 | Sites Analytics UI | Sites 자동 집계값 |

상담 입력값과 withdrawal token은 Sites content가 아닙니다. source, version,
storage, analytics와 browser storage에 포함하지 않습니다.

## locale과 route

| Locale | URL prefix | 표시명 |
|---|---|---|
| `ko` | 없음 | 한국어 |
| `en` | `/en` | English |
| `zh-Hans` | `/zh-hans` | 简体中文 |
| `zh-Hant` | `/zh-hant` | 繁體中文 |

기본 콘텐츠 경로는 15개입니다.

```text
/
/about
/services
/services/procurement
/services/credibility
/services/safety-esg
/services/business-certification
/services/licensing-entity
/services/immigration-visa
/process
/insights
/consultation
/location
/privacy
/marketing/withdraw
```

네 locale의 15개 경로와 언어별 404를 합치면 기본 공개 화면은 64개입니다.
게시글 상세 경로는 승인된 public snapshot의 locale·slug에 따라 추가됩니다.

## route별 rendering과 dependency

| 화면 | Sites rendering | 추가 데이터 |
|---|---|---|
| 홈·소개·업무·절차·위치 | source에 포함한 public copy | 없음 |
| 실무 안내 목록·상세 | source version에 import한 snapshot | 승인 release manifest |
| 상담 신청 | Sites client UI | Control consent/API |
| 개인정보·마케팅 안내 | source version의 승인 snapshot | Control의 runtime 동의문과 동일 version이어야 함 |
| 404 | locale-aware Sites route | 없음 |
| token 철회·confirm | Sites가 렌더링하지 않음 | `consent` origin의 Control |
| sitemap·RSS·robots | Sites machine route | canonical과 승인 article 목록 |
| 소유권 확인 파일 | Sites public route/asset | 승인된 verification 값 |

## 전역 정보 단위

### Header

- 사무소명과 `智` monogram
- 홈
- 사무소 소개
- 업무 분야
- 진행 절차
- 실무 안내
- 오시는 길
- 별도 상담 신청 CTA
- locale 전환
- mobile 전화 CTA
- 승인된 Kakao URL이 있을 때만 Kakao CTA

### Footer

- 사무소명, 대표, 주소
- 전화, 팩스와 이메일
- 네이버 블로그와 네이버 지도
- 개인정보 처리방침
- 마케팅 수신 동의 철회 안내
- 현재 연도의 저작권 표시

## 홈 `/`

1. Hero
   - eyebrow: 기업과 사람의 행정 절차를 함께 설계합니다
   - H1: 기업행정·공공조달·출입국 비자
   - 소개문
   - 상담 신청·전화 CTA
   - Kakao·블로그·지도 보조 CTA
   - `智` geometric illustration과 대표 표기
2. 3대 분야
   - 기업행정
   - 공공조달
   - 출입국·비자
3. 6개 업무 navigator
4. 업무 원칙
   - 직접 확인
   - 대안 검토
   - 현장 중심
5. 실무 안내 teaser
   - 조달시장 진입 준비
   - 기업 인증 준비
   - 체류 자격 검토
6. 대표 행정사 공개 프로필
7. 상담 CTA와 사무소 연락처

## 사무소·대표 정보

### 사무소

- 지혜행정사사무소
- JIHYE Administrative Attorney
- 대표 강지혜 행정사
- 전화 `010-8415-0023`
- 팩스 `0504-051-0023`
- 이메일 `kjihye0023@naver.com`
- 서울특별시 송파구 법원로 92, 212호 (문정동, 파트너스1)
- 문정역 인근
- 네이버 블로그 `https://m.blog.naver.com/wisdom_jhk`
- 네이버 지도 `https://naver.me/GprFCirq`

### 대표 공개 프로필

- 한양대학교 경영학 학사·석사
- 아주대학교 대학원 교육학·상담 석사
- 남서울대학교 AI공공조달학 석사과정
- 공공조달연구소 이사
- 제11회 행정사
- ISO 45001 심사원

기관명이 마스킹된 자료는 임의로 복원하지 않습니다.

## 업무 분야

### 공공조달

요약: 조달시장 진입에 필요한 생산·제품 확인과 등록을 지원합니다.

- 직접생산확인증명
- 공장등록
- 다수공급자계약(MAS)
- 혁신제품
- 우수조달물품

### 기업 신뢰도 인증

요약: 기업의 공공성과 품질, 고용 가치를 입증하는 인증을 지원합니다.

- 가족친화인증
- G-PASS 기업 지정
- GS 인증
- KS·단체표준 인증
- 성능인증
- 여성기업 확인
- 장애인 표준사업장 인증
- 사회적협동조합
- 일·생활 균형 우수기업

### 안전·ESG

요약: 안전, 사회적 책임, 지속가능경영 관련 준비를 지원합니다.

- SH평가
- SA평가
- ESG평가
- 안전보건계획서 작성

### 기업 인증

요약: 성장 단계와 사업 목적에 맞는 기업·연구 인증을 지원합니다.

- 벤처기업 확인
- 이노비즈 인증
- 메인비즈 인증
- 기업부설연구소·연구개발전담부서
- ISO 인증
- 병역지정업체 선정

### 인허가·법인·단체

요약: 사업 인허가와 비영리 법인·단체 설립 절차를 지원합니다.

- 평생교육시설 신고
- 여행업 등록
- 비영리 사단법인·재단법인 설립
- 공익법인 지정
- 민간자격 등록
- 화장품 제조업 등록
- 화장품 책임판매업 등록

### 출입국·비자

요약: 취업, 투자, 가족, 공연, 국적과 체류 업무를 지원합니다.

- E-7 특정활동
- E-6 예술흥행
- F-4·F-1·F-2·F-5·F-6
- C-3 단기방문
- C-4 단기취업
- D-10 구직
- D-7 주재
- D-8 기업투자
- 공연비자
- 국적회복
- 영주권
- 체류기간 연장

각 상세 페이지는 같은 순서를 사용합니다.

1. 지원 범위
2. 사전 확인 사항
3. 검토 및 진행 방식

## 진행 절차 `/process`

1. 상담 요청: 연락처와 검토가 필요한 기본 사실 전달
2. 범위 확인: 목표, 현재 상태, 자료와 선행 조건 확인
3. 위임 협의: 업무 범위와 역할 확인 후 위임 여부 결정
4. 진행 안내: 접수, 보완, 결과 확인 상태 안내

## 실무 안내

### 목록

- 현재 locale 게시글만 표시
- 최종 검수일
- 제목과 요약
- 읽기 링크
- 게시글이 없을 때 locale별 empty state

### 상세

- `articleId`
- locale과 slug
- 제목과 요약
- 검증된 HTML
- 최초 공개일과 최종 수정일
- 검수자 이름과 직함
- 출처 URL과 source timestamp
- content SHA-256과 revision identity

게시글은 repository fixture가 아니라 Control이 생성한 승인된 immutable public
snapshot에서 가져옵니다. snapshot manifest SHA와 Sites source commit 및
saved version의 대응을 release ledger에 기록합니다.

## 상담 신청 `/consultation`

### 입력 계약

| 필드 | 필수 조건 | 검증 |
|---|---|---|
| `website` | 비워야 함 | honeypot |
| `locale` | 필수 | `ko`, `en`, `zh-Hans`, `zh-Hant` |
| `category` | 필수 | 6개 업무군 또는 `other` |
| `name` | 필수 | trim 후 2~50자 |
| `phone` | 필수 | 허용 문자를 정규화한 숫자 8~20자리 |
| `email` | 조건부 | 이메일 연락 또는 마케팅 동의 시 필수 |
| `company` | 선택 | 최대 100자 |
| `preferredContact` | 필수 | `phone` 또는 `email`, 기본 `phone` |
| `message` | 필수 | trim 후 20~2,000자 |
| `privacyConsent` | 필수 | 현재 문서 version과 `accepted: true` |
| `marketingConsent` | 선택 | 현재 문서 version과 boolean 결정 |

### 방문자 데이터

이름, 전화, 이메일, 회사명과 문의 내용은 방문자가 제출하는 개인정보입니다.
Site 운영자는 이 데이터의 고지·동의·권리 행사와 처리 흐름에 책임이 있습니다.

폼은 다음을 항상 안내합니다.

- 주민등록번호, 여권번호와 외국인등록번호를 입력하지 않습니다.
- 건강·의료 정보(PHI)와 결제카드 정보를 입력하지 않습니다.
- 이 단계에서는 첨부파일을 받지 않습니다.
- JavaScript를 사용할 수 없으면 전화 또는 이메일로 연락합니다.

### runtime 동작

1. Sites server-render 단계가 runtime env의 공개 API origin을 client에
   전달합니다.
2. browser가 해당 API origin에서 locale별 개인정보·마케팅 동의문과 signed
   form token을 직접 조회합니다.
3. 문서 제목, version, 시행일, 보유기간과 본문을 표시합니다.
4. 동의문을 불러오기 전에는 체크박스와 제출 버튼을 비활성화합니다.
5. browser가 `credentials: "omit"`으로 JSON body와 `Idempotency-Key`를
   Control API에 직접 전송합니다.
6. `201` 응답의 schema-valid `receiptId`만 성공 화면에 표시합니다.
7. `CONSENT_VERSION_STALE`이면 선택을 초기화하고 새 문서를 다시 표시합니다.
8. 오류 시 가짜 접수번호 또는 성공 상태를 만들지 않습니다.

Sites route handler, server action, D1, R2, browser storage와 analytics는 상담
body를 받지 않습니다.

## 오시는 길 `/location`

- 사무소명과 문정역 인근 안내
- 주소
- 전화 링크
- 팩스 표시
- 이메일 링크
- CSS 지도 장식
- 네이버 지도와 블로그 외부 링크

지도 embed와 geolocation API는 사용하지 않습니다.

## 정책 화면

### 개인정보 `/privacy`

- 활성 privacy 문서 제목과 version
- 시행일
- 12개월 보유기간
- 승인된 본문
- 실제 Sites→Control 데이터 흐름
- 이용자 권리 행사와 문의 이메일·전화

### 마케팅 철회 안내 `/marketing/withdraw`

- 활성 marketing 문서 제목과 version
- 시행일
- 24개월 보유기간
- 승인된 본문
- 확인 이메일의 일회용 링크를 이용하는 3단계 안내
- 전화·이메일은 지원 수단이며 철회 실행 자체가 아니라는 고지

실제 token landing과 locale별 confirm GET/POST는 `consent` origin의 Control이
처리합니다. token URL을 Sites에 redirect 또는 proxy하지 않습니다.

## discovery 정보 단위

- locale별 고유 title과 description
- custom domain 기준 canonical
- reciprocal `hreflang`과 한국어 `x-default`
- indexable/noindex 정책
- `ProfessionalService`, `Person`, `Service`, `Article`, `BreadcrumbList`
- sitemap
- RSS
- robots
- Naver/Google ownership verification
- Open Graph social image

상담, 개인정보, 마케팅 철회 안내와 404는 `noindex`입니다.

## 운영 Analytics 정보 단위

자체 Analytics는 React 관리자에서 다음 운영 정보를 제공합니다.

- 추정 순 방문자
- 페이지 조회
- 두 지표의 시간 추이
- date range와 granularity
- normalized public path 기준 인기 페이지
- 같은 기간 상담 접수와 대략적 aggregate 전환율

Sites 내장 Analytics는 ChatGPT web·desktop에서 별도 외부 baseline으로
확인합니다. 현재 CLI, IDE와 connector에서 직접 조회하거나 자체 관리자로
자동 import하지 않습니다.

다음은 분석 정보로 만들지 않습니다.

- 상담자 이름, 전화, 이메일과 문의 내용
- withdrawal token
- 개별 visitor와 consultation의 연결
- visitor cookie, browser visitor ID와 fingerprint SDK
- raw IP, raw User-Agent, referrer, query와 raw page-view event

자체 page-view payload는 schema version과 normalized path만 포함합니다. 같은
기간의 자체 traffic aggregate와 Control 상담 접수 총계는 운영 참고용으로만
비교합니다. 자세한 KPI 정의와 구현 순서는
[`06-analytics-and-kpi-plan.md`](06-analytics-and-kpi-plan.md)와
[`07-first-party-analytics-implementation-plan.md`](07-first-party-analytics-implementation-plan.md)를
따릅니다.

## 디자인 정보 단위

| 항목 | 값 |
|---|---|
| Bronze | `#a78d6c` |
| Sand | `#d8cabb` |
| Ivory | `#fffdfa` |
| Brown | `#5d4936` |
| Ink | `#2f2a25` |
| White | `#ffffff` |
| Sans | Pretendard → Noto Sans KR → system sans |
| Serif | Iropke Batang → Noto Serif KR → Georgia |
| Main shell | 최대 1180px |
| Reading shell | 최대 940px |
| Section rhythm | `clamp(4.5rem, 9vw, 8rem)` |
| Motion | 500ms, 64px, 60ms stagger |
| Breakpoints | 1120px, 860px, 700px, 420px |

운영 포털에는 승인된 raster, SVG, favicon 또는 bundled webfont가 없습니다.
Hero와 지도 시각 요소는 CSS와 `智` 문자를 사용합니다.

Sites visual과 copy가 확정된 뒤, 별도 승인 단위에서 Sites 지침에 따라 social
card를 한 번 생성하고 텍스트를 검수합니다. 사용할 수 없을 때만 한 번
재생성하고, 검수된 결과만 `public/og.png`에 둡니다.

## 운영 콘텐츠 금지 경계

다음 fixture는 local test 전용입니다.

- `apps/site/src/content/__fixtures__/published-content/articles/*`
- `apps/site/src/content/__fixtures__/published-content/consent-bundle.json`
- `apps/site/src/content/__fixtures__/published-content/manifest.json`

`"Exact privacy terms..."`, `"Exact marketing terms..."`는 placeholder입니다.
local/in-product preview, Sites source, package archive, saved version과 모든
production deployment에 포함하지 않습니다.

## 구현 전에 필요한 운영값

- 독립 Sites source root
- 승인된 production article/consent snapshot과 manifest SHA
- `PUBLIC_SITE_ORIGIN`
- `PUBLIC_CONSULTATION_API_ORIGIN`
- `ANALYTICS_ENABLED=false` 기본값과 별도 활성화 승인
- API와 withdrawal host 이름
- workspace의 public publishing과 custom-domain 사용 가능 여부
- DNS 수정 권한
- Sites가 domain 추가 시 반환하는 검증 record
- Kakao 상담 URL
- Google·Naver ownership verification 값
- 정식 logo, portrait, favicon과 social image 사용 여부

Sites public runtime env에 노출하는 값은 origin과 verification 같은 공개값으로
한정합니다. SMTP, notification, database와 API secret은 기존 Control 운영
범위에만 둡니다.
Consultation과 first-party Analytics는 같은
`PUBLIC_CONSULTATION_API_ORIGIN`을 사용하며 별도 analytics API origin은
추가하지 않습니다.
