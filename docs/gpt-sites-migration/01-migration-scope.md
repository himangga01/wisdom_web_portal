# ChatGPT Sites 마이그레이션 범위

기준일: 2026-07-24  
문서 상태: 자체 Analytics 구현 계획 반영 v1.3

## 목표

현재 공개 포털의 브랜드, 네 언어 페이지, 업무 정보, 실무 안내, 상담 신청
화면과 정책 안내를 ChatGPT Sites에서 의미상 동일하게 구현합니다.

Sites는 공개 presentation과 interaction layer를 담당하고, 상담 데이터와
운영 보안 책임은 기존 Control과 SQLite에 유지합니다.

## 채택한 접근

| 접근 | 장점 | 위험 | 결정 |
|---|---|---|---|
| 기존 `apps/site` 즉시 교체 | 공개 frontend가 하나만 남음 | 장애 시 비교·복귀가 어려움 | 채택하지 않음 |
| monorepo `apps/sites-portal`에 직접 초기화 | 한 저장소에서 보임 | nested Git, starter/root lockfile, Sites source 경계 충돌 | 채택하지 않음 |
| 독립 Sites source root에 병행 구축 | starter와 source/version lifecycle 보존, 기존 서비스 보호 | 두 source를 운영 기간 동안 관리 | 채택 |
| 정적 안내만 Sites로 이전 | 가장 단순함 | 상담과 정책 UX가 분리됨 | 채택하지 않음 |

독립 source root의 고정 후보는
`/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal`입니다. 실제 디렉터리
생성과 initializer 실행은 별도 승인 후 수행합니다.

## Sites 이관 대상

### 전역 공개 UI

- `智` 모노그램과 사무소명
- desktop·mobile navigation
- 한국어, 영어, 중국어 간체, 중국어 번체 전환
- 상담 신청, 전화, 이메일, 네이버 블로그와 네이버 지도 링크
- 개인정보와 마케팅 철회 정책 링크
- skip link, focus 상태와 semantic landmark

### 공개 페이지

- 홈
- 사무소 소개
- 업무 분야 목록
- 6개 업무 분야 상세
- 진행 절차
- 실무 안내 목록과 승인된 상세 게시글
- 상담 신청
- 오시는 길
- 개인정보 처리방침
- 마케팅 수신 동의 철회 안내
- 언어별 404

### 디자인

- Bronze, Sand, Ivory, Brown, Ink, White 색상 체계
- sans 본문과 serif 제목 역할
- 1180px/940px 콘텐츠 폭
- 각진 카드·버튼, 가는 경계선, 번호형 section label
- 현재 반응형 전환과 reduced-motion 안전장치
- CSS 기반 `智` hero illustration과 지도 장식

### 공개 콘텐츠

- 사무소 연락처, 위치와 대표 공개 프로필
- 6개 업무군과 전체 세부 항목
- 4단계 진행 절차와 업무 원칙
- 승인된 published article snapshot
- 승인된 개인정보·마케팅 정책 snapshot

### 상담 UX

- locale별 최신 동의문 조회
- client·server 계약에 맞는 입력 검증
- honeypot, signed form token과 idempotency key 전달
- 실제 Control receipt를 받은 경우에만 성공 표시
- 전화·이메일 대체 연락 경로

### 운영 성과지표

- Control 자체 추정 순 방문자 수
- Control 자체 페이지 조회 수
- 두 자체 지표의 시간 추이 그래프
- 조회 기간과 집계 단위 선택
- normalized public path 기준 자체 인기 페이지
- 같은 기간 Control 상담 접수 집계와의 비식별 운영 비교
- Sites 내장 Analytics의 독립 외부 baseline

## 기존 시스템에 유지할 대상

- 관리자 로그인, MFA, session, CSRF와 상담 관리
- SQLite와 암호화된 개인정보
- 전화·이메일 blind index
- consent ledger, audit event와 idempotency 저장
- rate limit, signed form token과 abuse control
- SMTP, Hermes·Telegram notification outbox와 worker
- PII retention와 purge
- 콘텐츠 작성·번역·검수·승인 workflow
- 일회용 마케팅 철회 capability와 transaction
- 기존 Astro release 생성과 rollback artifact
- Mac mini의 Caddy, cloudflared, launchd, Keychain과 backup/restore

## 명시적 비대상

- 관리자 포털의 Sites 재구현
- D1 또는 Sites database에 상담 개인정보 저장
- R2 또는 Sites file storage에 상담 자료 저장
- SIWC 또는 방문자 계정
- Sites route handler를 통한 상담 body proxy
- 파일 첨부
- 결제, 예약과 채팅 SDK
- PHI 또는 결제카드 데이터 처리
- 현재 범위에 없는 FAQ와 신규 마케팅 문구 작성
- 검증되지 않은 성공률, 사례 수, 순위, 후기 또는 보장 표현
- prototype brochure 이미지를 운영 자산으로 사용
- fixture 게시글과 placeholder 동의문 공개
- Control publication에서 Sites로의 무인 자동 배포
- 관리자 기능, 데이터베이스 또는 background worker의 Sites 이전
- 제3자 analytics SDK와 chart package
- custom visitor cookie, browser visitor ID와 fingerprint SDK
- raw page-view event, raw IP·UA와 장기 visitor hash 저장
- page-view를 D1, R2 또는 Sites route handler에 저장
- Sites visitor와 상담 PII의 개인 단위 연결
- 공식 지원이 확인되지 않은 Analytics API 또는 자동 export

## 권위 있는 원본

| 정보 | 원본 |
|---|---|
| 일반 UI와 네 언어 copy | [`apps/site/src/content/site-content.ts`](../../apps/site/src/content/site-content.ts) |
| 공개 route와 locale prefix | [`apps/site/src/lib/routes.ts`](../../apps/site/src/lib/routes.ts) |
| 색상·글꼴·motion token | [`packages/shared/src/design-tokens.ts`](../../packages/shared/src/design-tokens.ts) |
| 페이지 composition | [`apps/site/src/components`](../../apps/site/src/components) |
| 상담 request/response 계약 | [`packages/shared/src/consultation.ts`](../../packages/shared/src/consultation.ts), [`packages/shared/src/contracts.ts`](../../packages/shared/src/contracts.ts) |
| 상담 browser 동작 | [`apps/site/src/lib/consultation-adapter.ts`](../../apps/site/src/lib/consultation-adapter.ts) |
| 실제 게시글·정책 | Control이 생성한 승인된 immutable public snapshot |
| host routing과 보안 header | [`ops/caddy/Caddyfile.template`](../../ops/caddy/Caddyfile.template) |
| Sites 기능 | [`00-sites-capability-baseline.md`](00-sites-capability-baseline.md) |

## 성공 기준

1. 네 언어의 64개 기본 공개 화면과 승인된 게시글 route가 의미상 동일하게
   제공됩니다.
2. 홈, 업무, 대표, 위치와 정책 정보가 현재 정식 copy와 일치합니다.
3. 승인된 viewport에서 가로 overflow 없이 핵심 CTA와 navigation을 사용할
   수 있습니다.
4. keyboard, screen reader와 reduced-motion 사용자가 핵심 콘텐츠와 폼을
   사용할 수 있습니다.
5. 상담 신청은 Control API의 schema-valid `201` receipt를 받은 경우에만
   성공으로 표시됩니다.
6. 최신 동의문을 불러오지 못하면 제출이 차단됩니다.
7. 상담 body와 withdrawal token이 Sites storage, browser storage, analytics,
   source 또는 로그에 남지 않습니다.
8. fixture 콘텐츠는 local preview, source archive, saved version과 모든
   production deployment에서 제외됩니다.
9. canonical, reciprocal hreflang, noindex와 structured data 의미가
   유지됩니다.
10. 이전 Sites saved version을 재배포할 수 있고, 필요하면 custom domain을
    기존 Astro origin으로 되돌릴 수 있습니다.
11. 개인정보 처리방침은 실제 데이터 흐름, 운영자 책임, 권리 행사와
    보유·삭제 체계를 정확히 설명합니다.
12. PHI, 결제카드 정보, 주민등록번호, 여권번호와 외국인등록번호를 받지
    않는다는 안내가 상담 폼에 표시됩니다.
13. Control snapshot, Sites source commit, saved version과 deployment identity가
    1:1로 기록되고 Sites 배포 전에 Control authority가 먼저 활성화되지
    않습니다.
14. 기존 `www` withdrawal capability가 남아 있으면 direct domain cutover가
    차단됩니다.
15. React 관리자에서 추정 순 방문자, 페이지 조회, 두 지표의 추이와
    기간·granularity 변경을 확인할 수 있습니다.
16. 자체 인기 페이지를 normalized public path 기준으로 확인할 수 있습니다.
17. Sites 내장 Analytics 제공 범위는 실제 account 기준 외부 baseline으로
    기록됩니다.
18. 별도 analytics/차트 package, cookie, browser visitor ID나 개인 단위
    visitor-to-consultation 추적을 추가하지 않습니다.
19. raw event, raw IP·UA와 장기 visitor hash가 DB에 없습니다.

성공 기준을 확인하는 테스트나 브라우저 검증은 계획에 포함하되 사용자 승인
전에는 실행하지 않습니다.

## 승인 경계

| 승인 단위 | 포함 작업 | 현재 상태 |
|---|---|---|
| A. 계획 문서 | 기능 재확인과 문서 전면 수정 | 이번 작업 |
| B. local scaffold | 독립 source root와 starter 생성 | 미승인·미실행 |
| C. 구현 | Sites UI/content, Control 연동과 자체 Analytics 코드 수정 | 미승인·미실행 |
| D. 검증 | typecheck, unit/build/browser/API 검증 | 미승인·미실행 |
| E. 외부 Site 생성 | `create_site` 1회와 `project_id` 기록 | 미승인·미실행 |
| F. source/version | credential 발급, source push, archive와 saved version | 미승인·미실행 |
| G. owner-only deploy | 접근 제한을 확인한 production 배포 | 미승인·미실행 |
| H. domain 준비 | custom domain 추가, DNS와 active 확인 | 미승인·미실행 |
| I. 공개 전환 | `public` access policy와 실제 트래픽 | 미승인·미실행 |
| J. 성과지표 운영 | 자체 관리자·Sites Analytics 확인, baseline과 KPI review | 미승인·미실행 |

한 승인 단위가 다음 단위의 권한을 자동으로 포함하지 않습니다.
