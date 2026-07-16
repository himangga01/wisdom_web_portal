# 작업 로그

## 2026-07-15 · 홈페이지 스크롤 모션 설계

- 대상 시안: `.superpowers/brainstorm/mockups/hybrid/h1-recommended-hybrid.html`
- 선택 방향: 차분한 에디토리얼 리빌
- 재생 정책: 페이지를 연 뒤 요소별 최초 노출 시 한 번
- 스타일 기준: 실제 구현은 Tailwind CSS 사용
- 주요 제약: 반복 모션, 글자별 애니메이션, 강한 패럴랙스 제외
- 설계 문서: `docs/superpowers/specs/2026-07-15-homepage-scroll-motion-design.md`
- 독립 검토 반영: reduced-motion 최종 상태 보장, 원자적 오류 복구, 핵심 CTA 즉시 표시
- 2차 검토 반영: 숨김 선택자를 `prefers-reduced-motion: no-preference` 안으로 이동
- 모션 예산: 페이지 전체 8개, 요소별 완료 시간 760ms 이하
- 성능 중단 기준: 대표 사진 모션이 LCP를 100ms 넘게 악화시키면 제거
- 다음 단계: 사용자 설계 문서 검토 후 구현 계획 작성
- 사용자 설계 문서 승인 완료
- 구현 계획: `docs/superpowers/plans/2026-07-15-homepage-scroll-motion-sample.md`
- 실행 방식: 현재 세션 일괄 실행, `.worktrees/homepage-motion-sample` 격리 작업공간 사용

## 2026-07-15 · 홈페이지 스크롤 모션 샘플 구현

- 기반 구성: Vite 8, TypeScript, Tailwind CSS v4 로컬 빌드 (`5b86b97`)
- 모션 상태 모델: 최초 1회 리빌과 `IntersectionObserver` 폴백 (`7865f87`)
- 접근성·복구 보강: reduced-motion, 포커스, 해시, 회전, BFCache, 초기화 예외 (`0f8c7ef`)
- 홈페이지 구현: 추천 조합 디자인, 3대 전문업무, 4개 언어 표시, 8개 모션 대상 (`ece8a90`)
- 브라우저 회귀 검사: 반응형·오류 복구·무자바스크립트·성능 예산 (`2705dc2`)
- 최종 자동 검사: Vitest 13/13, Playwright 14/14, 운영 빌드 성공
- 렌더 산출물: 데스크톱 PNG 479,665바이트, 모바일 PNG 171,526바이트, 스크롤 WebM 937,096바이트
- 시각 확인: 1440px 데스크톱과 390px 모바일에서 텍스트·CTA·대표 사진 크롭·업무 카드 배치 확인
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체하고 AVIF·WebP·JPEG 파생 파일 생성
- 단일 파일 전달본: `.superpowers/brainstorm/renders/wisdom-homepage-motion-sample.html` (138,668바이트, 외부 자산 의존성 없음)

## 2026-07-15 · 시네마틱 모션 강화 데모

- 모션 대상 확장: 8개에서 12개로 확대 (`b593628`)
- 최종 자동 검사: Vitest 16/16, Playwright 16/16, TypeScript·Vite 운영 빌드 성공
- 독립 실행 검사: `file://`에서 12개 대상 리빌, 390px 가로 넘침 없음, 페이지 오류 없음
- 최종 산출물: 데스크톱 PNG 489,338바이트, 모바일 PNG 171,522바이트, 스크롤 WebM 1,997,846바이트, 단일 HTML 144,046바이트
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체

## 2026-07-15 · 동적 C1 독립 HTML 전달

- 동적 C1 최종값: 18개 대상, 500ms 지속시간, 64px 이동, 60ms 시차, 모바일 동일 강도
- 선행 구현 커밋: Task 1 `e204a44`, Task 2 `a224b45`
- 최종 자동 검사: Vitest 17/17, Playwright 16/16 통과
- 독립 실행 검사: `file://`에서 18개 대상 리빌, `scrollWidth: 390`, `clientWidth: 390`, `pageErrors: []`
- 독립 HTML: `.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html` (142,717바이트)
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체

## 2026-07-15 · 동적 C1 독립 HTML 최종 재검증

- 최종 자동 검사: Vitest 20/20, Playwright 32/32, TypeScript·Vite 운영 빌드 성공
- 사전 상태 검사: Observer를 애플리케이션 시작 전에 정지하고 18개 대상의 `data-revealed="false"`, opacity 0.08, blur 2px, 좌우 64px, 500ms, 0/60/120ms를 전수 확인
- 최종 상태 검사: 18개 대상의 `data-revealed="true"`, opacity 1, filter/translate 해제를 전수 확인
- 전환 중 가로 넘침: 최대 620ms 뒤 프레임 여유를 포함해 650ms를 한 번 기다렸고, 64개 `requestAnimationFrame` 표본 모두 `scrollWidth: 390`, `clientWidth: 390`
- 리소스·런타임 검사: 실제 DOM·CSSOM 리소스와 메인 문서 외 요청을 검사했으며 console/page/request 실패 및 외부 요청 0건
- 독립 HTML: 142,838바이트, SHA-256 `D6F7DCD60409FF965C4CB40823F767F90B47A06527D3BF1A4EF835E3724BE5DF`; 작업트리와 메인 프로젝트 복사본 일치
- 시네마틱 보존: 캡처 명령을 실행하지 않았고 데스크톱 PNG `22D76E30…E8A3`, 모바일 PNG `03B96A79…4117`, 스크롤 WebM `B8F55A77…E7175` 해시 유지
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체

## 2026-07-15 · 운영 포털 Task 1 기반 구성

- 작업 브랜치: `feat/production-portal`; 기준 커밋 `ea54b6b`
- 워크스페이스: Node.js 24, npm 12, `apps/*`, `packages/*`
- 공용 패키지: `packages/shared`의 계약, 상담 검증, 환경 파서, 디자인 토큰
- 테스트 우선 구현: 계약 7개, 상담 7개, 환경 6개, 디자인 토큰 2개
- 보안 기본값: 운영 비밀값 3종 필수, 운영 인메모리 DB 금지, 이메일 `receipt-only`
- 플랫폼 안내: Windows `npm.cmd`, macOS `npm`
- 범위 보존: `prototypes/homepage-motion` 수정 없음
- 재검토 보완: 공개 동의 schema/type 계약, dotted 전화번호 정규화 회귀 테스트
- 환경 계약: `PII_ENCRYPTION_KEY`; 3개 운영 비밀값별 누락·약한 값·test-only 값 거부
- 루트 오케스트레이션: `packages/*` → `apps/*`, 소비 명령 전 `@wisdom/shared` 빌드
- clean checkout 증거: `packages/shared/dist` 삭제 후 `npm.cmd run verify` 통과 (Node test 3/3, Vitest 31/31)

## 2026-07-16 · 운영 상세 Task 3 상담 접수 제어 서비스

- 기준 HEAD: `321d487`; 기존 루트 테스트 Node 4/4, shared 31/31, site 22/22 통과 후 시작
- 의존성: Hono 4.12.30, `@hono/node-server` 2.0.9, Drizzle ORM 0.45.2, `better-sqlite3` 12.11.1 고정
- 플랫폼 확인: Node.js 24.18.0에서 `better-sqlite3` 로드 및 SQLite 3.53.2 쿼리 성공
- 스키마: 상담·동의문/이벤트·멱등성·남용 버킷·알림 아웃박스/설정·관리자/세션·글/리비전·작업·릴리스·감사 테이블과 필수 인덱스 구성
- 보안: 버전형 AES-256-GCM, 엄격한 봉투 파서, 독립 `CONTROL_HMAC_SECRET`, HKDF 목적 분리, 전화/이메일 HMAC 블라인드 인덱스 적용
- API: 동의문 GET, JSON 상담 POST, live/ready; no-store/request ID, 원본 허용 목록, 정확한 32KiB 스트림 제한, 오류 계약 적용
- 원자성: 두 파일 연결 중복 제출, 재시작 replay, 만료 키 교체, 동의문 변경·토큰 만료 후 기존 replay, 중간 장애 전체 rollback 검증
- 남용 방지: honeypot, 2초 최소 작성, 2시간 배타 만료, IP 5/10분·20/일, 연락처 3/10분·10/일, 신뢰 프록시 체인 검증
- 보존기간: 일반 12개월·마케팅 24개월, dry-run 무쓰기, 정확 경계, 아웃박스 취소, 멱등 재실행, 장애 rollback 검증
- 현재 집중 검증: control typecheck 통과, Vitest 10파일 35/35 통과

## 2026-07-16 · 운영 상세 Task 4 관리자·알림·철회

- 기준 HEAD `25dc828`; append-only v2로 MFA/복구/pre-auth/throttle, 알림 lease/attempt, 철회 capability 저장 구조를 추가했다.
- 관리자 인증은 Argon2id 고정 파라미터, SHA-256 TOTP, 1회용 복구 코드, 5분 pre-auth, 30분 idle/8시간 absolute 세션을 사용한다.
- 별도 admin host SSR 화면과 상담 상태 CAS를 구현하고 모든 POST에 strict Origin·CSRF·16KiB 폼 상한·중복 필드 거부를 적용했다.
- SMTP receipt-only/full-inquiry와 loopback HMAC Hermes를 구현하고 2분 lease, 5회 시도, 1/5/15/60분 backoff, at-least-once 의미를 고정했다.
- 관리자 화면에서 SMTP TLS 접속 정보와 Keychain reference만 설정하며 비밀번호 원문은 UI·DB·감사·로그에서 배제한다.
- SMTP는 공개 DNS FQDN·465/implicit TLS만 허용하고, 매 발송의 DNS 전체 응답에서 사설·loopback·link-local·문서용·multicast·ULA 주소를 차단한 뒤 검증된 IP에 고정 연결하고 원 FQDN으로 TLS 인증한다.
- test 알림과 receipt-only는 PII zero-decrypt이며, 설정 오류는 채널별로 격리하고 purge·retention·withdrawal을 외부 I/O 직전에 재검사한다.
- 마케팅 철회는 DB에 capability hash만 저장하고 raw token을 깨끗한 4언어 확인 URL로 교환한 뒤 POST에서 동의 이벤트·pending 취소·감사를 원자 처리한다.
- 로컬 관리자 CLI는 stdin-only 비밀번호와 Windows ACL/POSIX 0600 owner-only 등록 파일을 사용하고 reset/교체 시 세션·pre-auth를 무효화한다.
- 전체 검증: 루트 Node 5/5, shared 33/33, control 183/183, site 22/22, 64페이지 빌드, Playwright 60/60 통과.

## 2026-07-16 · 프로덕션 상세 Task 5 글·번역·발행

- loopback HMAC Hermes 초안 접수와 idempotency, immutable revision, Markdown 안전성 검증, 관리자 review/reject/translate/locale 승인 workflow를 구현했다.
- Codex CLI 번역은 관리자의 명시 요청에만 직렬 실행되며 고정 prompt/model, structured output, two-pass 검수, timeout, read-only/no-shell, 상담 PII 차단을 적용했다.
- 승인된 글과 활성 동의문 8개를 하나의 immutable public snapshot으로 생성하고, temporary build와 exact manifest 검증 후 `public-current`를 원자 전환하도록 했다.
- build·검증·pointer 전환 실패 시 기존 공개본을 유지하고, 보존된 검증 release로 rollback·reconcile할 수 있게 했다. 글이 없는 정책 변경도 policy-only release로 처리한다.
- 발행 성공 뒤에만 IndexNow outbox를 만들고 실패·재시도·소유권 키 부재를 다른 서비스에서 격리했다.

## 2026-07-16 · 프로덕션 상세 Task 6 검색·AI 발견성

- 한국어 canonical과 영어·간체·번체 경로에 self-canonical, 상호 `hreflang`, `x-default`, 고유 title/description을 생성했다.
- 화면에 표시한 사실과 일치하는 `ProfessionalService`, `Person`, `Service`, `Article`, `BreadcrumbList` JSON-LD를 구현했다. 근거 없는 후기·평점·Attorney·성과 보장 표현은 생성하지 않는다.
- sitemap, RSS, robots, Google/Naver 소유권 확인과 IndexNow 표면을 public release에 포함하고 exact MIME·경로·noindex 정책을 검증하도록 했다.
- 출처·검수자·날짜와 완성된 답변 구성을 publication quality gate로 사용하고, 관리자·API·token 표면은 검색 색인에서 제외했다.

## 2026-07-16 · 프로덕션 상세 Task 7 Mac mini 무도커 운영

- Caddy·Cloudflare Tunnel·launchd·newsyslog 템플릿과 Keychain bootstrap/import, preflight, deploy, rollback, stale lock quarantine을 구현했다.
- application release와 public content release를 별도 pointer/manifest로 관리한다. application manifest v2는 workspace·Ops runtime·production dependency·native addon의 exact inventory와 안전한 내부 symlink만 허용한다.
- SQLite online backup을 age로 암호화한 뒤 재복호화·hash·integrity·schema를 검사하고 검증본 24 hourly/14 daily를 보존하도록 했다. restore는 explicit target·destroy confirmation·기존 DB quarantine·readiness rollback을 요구한다.
- local monitor는 5분마다 backup freshness·disk·launchd·loopback ready·안전한 queue 집계를 확인한다. 독립 HMAC의 loopback Hermes handoff, child DB hard timeout, 반복 incident cooldown과 경로/symlink 방어를 추가했다.
- 실제 운영 절차는 `ops/runbooks/deployment.md`, `ops/runbooks/recovery.md`, `ops/runbooks/incidents.md`에 분리했다.

## 2026-07-16 · 프로덕션 상세 Task 8 릴리스 후보와 인수인계

- `docs/operations/release-candidate.md`에 기능별 구현 추적과 실제 공개 전 필수 외부 입력, 실기기·브라우저 점검, 운영 전환 순서를 정리했다.
- 보안·개인정보, UX·접근성, 아키텍처·복구, SEO·AI·i18n, 콘텐츠·법적 표현, 운영·릴리스 관점의 두 차례 병렬 비판 검토와 whole-branch review에서 재현 가능한 지적을 구현에 반영했다.
- `README.md`에 최종 시스템 구성과 콘텐츠·발행·Mac 운영 개요를 추가하고 설치 절차를 lockfile 기반 `npm ci`로 통일했다.
- `docs/00-document-map.md`를 추가해 개발·동의·검색·배포·복구·장애 문서와 코드 영역을 한 곳에서 찾게 했다.
- 구현 코드가 준비된 상태와 실제 외부 공개 상태를 분리했다. 도메인·Cloudflare credential·Kakao URL·SMTP·Hermes/Telegram·owner MFA·승인 정책 문구·보유 범위·전문 직함·검색 소유권·실제 Mac 훈련·외부 uptime은 운영자가 완료해야 하는 launch gate다.
- broad whole-branch review에서 공개 동의 authority를 매 요청 전체 해시하던 비용과 보안 스캐너가 철회 GET을 먼저 소비할 수 있는 문제를 재현했다. `1f249ac`에서 immutable verified cache·cheap identity key·rate limit과 scanner-safe 반복 GET·one-shot POST로 수정했고, 최종 재리뷰는 Critical 0·Important 0이다.
- clean install `npm.cmd ci` 뒤 `npm.cmd run verify`를 496.9초 동안 실행했다. root 9/9, shared 70/70, control 415/415, site 98/98, Ops 203 통과·Windows fixture 6 skip·0 fail, 68페이지 빌드, Chromium·Firefox·WebKit 108/108 통과다.
- 실제 로컬 브라우저에서 320·390·768·1440, 4개 언어, 모바일 메뉴, 서비스·상담·개인정보·철회, 18개·500ms C1, canonical/hreflang과 console error 0을 확인했다. `git diff -- prototypes`도 비어 있다.
- 실제 공개 배포 완료를 뜻하지 않는다. Mac mini의 외부 입력·실기기·복구·경보 게이트는 `docs/operations/release-candidate.md`에서 계속 미완료로 관리한다.
