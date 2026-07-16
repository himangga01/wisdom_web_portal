# AGENT 활동 기록

## 2026-07-15

- 추천 하이브리드 홈페이지의 스크롤 모션 요구사항을 정리했다.
- 사용자 선택에 따라 모션은 요소별 최초 노출 시 한 번만 재생하도록 확정했다.
- 에디토리얼 리빌 방향을 제안했고 사용자 승인을 받았다.
- Tailwind CSS, `IntersectionObserver`, 모션 감소 설정을 포함한 설계 문서를 작성했다.
- 독립 UX 검토에서 모션 감소 시 투명도 잔존과 초기화 실패 시 콘텐츠 은닉 위험을 확인했다.
- 루트 상태에 종속된 단방향 모션 상태 모델, 페이지 전체 8개 모션 예산, 수치화된 검증 기준으로 설계를 보완했다.
- Tailwind 공식 문서에서 v4 설치 방식과 기본 브라우저 지원 범위를 확인했다.
- 2차 독립 검토에서 reduced-motion 규칙의 CSS 우선순위 위험을 확인하고, 모든 숨김 규칙을 `no-preference` 미디어쿼리 안으로 제한했다.
- 사용자 문서 승인 후 Tailwind CSS v4 모션 샘플의 테스트 우선 구현 계획을 작성했다.
- `feature/homepage-motion-sample` 격리 작업 브랜치에서 Vite·Tailwind CSS v4 샘플을 구성했다. (`5b86b97`)
- `IntersectionObserver` 기반 최초 1회 리빌 컨트롤러를 테스트 우선으로 구현하고, 포커스·해시·화면 회전·BFCache·런타임 모션 감소·초기화 실패 복구를 보강했다. (`7865f87`, `0f8c7ef`)
- 추천 조합 목업을 기업행정·공공조달·출입국·비자의 동등한 3축, KO·EN·简·繁 표시, 정확히 8개 모션 대상으로 구현했다. (`ece8a90`)
- Chromium에서 반응형 5개 너비, 무자바스크립트, Observer 오류 복구, 키보드 포커스, CLS·LCP 예산을 자동 검증했다. (`2705dc2`)
- 최종 검증 결과는 Vitest 13개와 Playwright 14개 모두 통과, TypeScript·Vite 운영 빌드 성공이다.
- 데스크톱 PNG 479,665바이트, 모바일 PNG 171,526바이트, 스크롤 WebM 937,096바이트를 생성하고 직접 확인했다.
- 남은 시각 자산 작업은 운영 배포 전에 브로슈어 크롭을 고해상도 상반신 원본으로 교체하는 것이다.
- 사용자 요청에 따라 서버 없이 바로 열 수 있도록 CSS·JavaScript·대표 사진을 포함한 138,668바이트 단일 HTML을 추가 생성했다.
- 시네마틱 모션 대상을 8개에서 12개로 확장했다. (`b593628`)
- 최종 검증 결과는 Vitest 16/16, Playwright 16/16, TypeScript·Vite 운영 빌드와 서버 없는 단일 HTML 검증 모두 성공이다.
- 시네마틱 산출물은 데스크톱 PNG 489,338바이트, 모바일 PNG 171,522바이트, 스크롤 WebM 1,997,846바이트, 단일 HTML 144,046바이트다.
- 운영 배포 전 대표 사진은 브로슈어 크롭 대신 고해상도 상반신 원본으로 교체해야 한다.
- 동적 C1 최종값은 18개 대상·500ms·64px·60ms 시차이며 모바일도 같은 강도를 사용한다.
- Task 1 커밋은 `e204a44`, Task 2 커밋은 `a224b45`다.
- 최종 검증 결과는 Vitest 17/17, Playwright 16/16 통과다.
- 동적 C1 독립 HTML은 142,717바이트이며 `file://`에서 18개 대상 리빌, 390px 가로 너비 일치, 페이지 오류 없음으로 검증했다.
- 운영 배포 전 대표 사진은 고해상도 상반신 원본으로 교체해야 한다.
- 최종 재검증 결과는 Vitest 20/20, Playwright 32/32 통과이며 TypeScript·Vite 운영 빌드와 독립 HTML 검증도 성공했다.
- 강화된 검증기는 정지된 Observer 페이지에서 18개 미노출 상태의 opacity·blur·translate·500ms·0/60/120ms를 전수 확인하고, 일반 페이지에서 18개 최종 상태와 64개 프레임의 가로 넘침 없음(`390 === 390`, 최종 대기 650ms)을 확인했다.
- 실제 DOM·CSSOM 리소스와 메인 문서 외 브라우저 요청을 검사했으며 `consoleErrors`, `pageErrors`, `requestFailures`, `externalRequests`는 모두 비어 있었다.
- 동적 C1 독립 HTML은 142,838바이트, SHA-256 `D6F7DCD60409FF965C4CB40823F767F90B47A06527D3BF1A4EF835E3724BE5DF`이며 작업트리와 메인 프로젝트 복사본이 일치한다.
- 캡처를 다시 실행하지 않았고 기존 시네마틱 PNG 2개와 WebM 1개의 SHA-256이 변경 전 기준과 일치함을 확인했다.
- 운영 포털 Task 1에서 Node.js 24·npm 12 기반 루트 워크스페이스와 `packages/shared`를 구성했다.
- 출시 언어 4개, 상담 분류·상태·연락 방식, 알림·글 상태, 접수 응답·API 오류 계약을 Zod와 TypeScript 타입으로 중앙화했다.
- 상담 요청의 필수 개인정보 동의, 조건부 이메일, 문자열·전화번호 정규화와 길이 경계를 테스트 우선으로 구현했다.
- 운영 비밀값 누락과 인메모리 운영 DB를 거부하고 `NODE_ENV=test`에서만 안전한 기본값을 제공하는 환경 파서를 추가했다.
- 승인된 bronze/sand/ivory 색상과 18개·500ms·64px·60ms 홈페이지 리빌 수치를 공용 디자인 토큰으로 고정했다.
- Task 1 재검토에서 공용 동의 스키마·타입 export 누락과 clean checkout 워크스페이스 순서 문제를 확인해 테스트 우선으로 보완했다.
- `privacyConsentSchema`, `marketingConsentSchema`와 추론 타입을 `@wisdom/shared` 공개 진입점에서 제공한다.
- 루트 명령은 `packages/*`를 `apps/*`보다 먼저 처리하고 소비 명령 전에 shared 산출물을 생성하도록 변경했다.
- 운영 PII 키 이름을 `PII_ENCRYPTION_KEY`로 통일하고 3개 운영 비밀값의 누락·약한 값·test-only 값 거부를 매개변수 테스트로 검증했다.

## 2026-07-16

- Task 3에서 `apps/control` Hono·Drizzle·better-sqlite3 워크스페이스를 추가하고 Node.js 24에서 네이티브 모듈을 직접 로드해 확인했다.
- 상담 PII는 AES-256-GCM 버전 봉투로만 저장하고 전화·이메일 정확검색은 독립 HMAC 루트 기반 블라인드 인덱스로 제한했다.
- 4개 언어의 개인정보·마케팅 동의문 8개 묶음을 불변 draft로 seed하고 SHA-256 재확인 후 원자적으로 활성화하도록 구성했다.
- 상담 접수는 단일 `BEGIN IMMEDIATE` 안에서 멱등성, 속도 제한, 상담·동의 이벤트·아웃박스·감사·응답 저장을 함께 처리한다.
- 32KiB 원시 바이트 제한, 2초/2시간 폼 토큰, 10분·일일 제한, 12/24개월 dry-run 우선 보존기간 정리를 테스트로 검증했다.
- 실제 알림 발송과 관리자 UI는 후속 Task 범위로 남기고 테이블과 메타데이터 아웃박스만 준비했다.
- Task 4에서 별도 관리자 호스트의 Argon2id→TOTP/복구 코드 인증, hash-only pre-auth/session, CSRF와 이중 축 로그인 제한을 구현했다.
- 상담 상태 전이·감사·알림 enqueue를 원자적으로 묶고 SMTP/Hermes 알림 워커에 lease, backoff, fencing, 수동 requeue와 PII-safe 결과 로그를 적용했다.
- SMTP 목적지는 공개 FQDN·465/TLS로 제한하고 발송 시점 DNS 전체 검증, 공개 IP pinning, 원 FQDN TLS SNI로 SSRF와 DNS rebinding을 차단했다.
- 마케팅 고객 메일마다 hash-only 철회 capability를 만들고 4개 언어의 깨끗한 확인 화면에서 계정 없이 동의를 철회하도록 구현했다.
- owner bootstrap·비밀번호 재설정·MFA 교체는 로컬 CLI로만 제공하며 비밀번호는 stdin, 등록 정보는 owner-only 파일로만 전달한다.

### 프로덕션 상세 Task 5~8

- Task 5에서 Hermes의 loopback HMAC draft intake, immutable article revision, 관리자 검토·반려·번역 요청·언어별 승인·발행·rollback 흐름을 구현했다. Hermes와 Codex는 초안·번역 후보만 만들 수 있고 자동 발행 권한은 없다.
- Codex 번역 worker는 고정 model·prompt 계약, 구조화 출력, 직렬 작업, timeout, read-only/no-shell 실행, 상담 PII guard를 적용했다. 한국어 원문과 검수 대상은 stdin으로만 넘기며 provenance와 2차 검수 결과를 revision에 남긴다.
- 발행은 승인된 글과 활성 개인정보·마케팅 문서 8개를 같은 immutable snapshot으로 봉인한다. 임시 release 빌드·정확한 file inventory/hash 검증이 성공한 경우에만 `public-current`를 원자 전환하며 실패 시 기존 공개본을 유지한다.
- 정책만 변경할 때도 글 없이 policy-only release를 만들 수 있게 했다. 새 consent bundle의 DB 활성화만으로 공개 페이지나 상담 authority가 바뀌지 않고, 검증된 public release 발행이 완료되어야 함께 전환된다.
- Task 6에서 4개 언어 self-canonical·reciprocal `hreflang`·`x-default`, 고유 title/description, `ProfessionalService`·`Person`·`Service`·`Article`·`BreadcrumbList` JSON-LD, sitemap·RSS·robots와 Google/Naver verification 표면을 추가했다.
- 관리자·API·token 표면은 noindex/disallow하고, 공개 구조화 데이터는 화면에 보이는 사실만 사용한다. 근거 없는 Attorney·평점·후기·성과 보장은 배제했으며 출처·검수자·날짜·답변 완성도 gate를 통과한 콘텐츠만 색인 후보가 된다.
- 발행 성공 뒤에만 IndexNow outbox를 생성하고, Keychain 소유권 키가 없거나 잘못되면 검색 제출만 중지한다. 상담·번역·기존 공개 페이지는 계속 동작한다.
- Task 7에서 Mac mini M4의 Docker 없는 운영을 위해 Caddy·cloudflared·launchd·newsyslog 템플릿, Keychain bootstrap/import, application/public 이중 release, deploy·rollback·preflight와 stale lock quarantine을 구현했다.
- application release manifest v2는 control/site/shared, Ops runtime, production `node_modules`와 native addon의 exact inventory·size·hash·내부 symlink를 봉인한다. public release는 별도의 Wisdom manifest와 pointer를 사용하며 bootstrap manifest를 정상 발행의 fallback으로 쓰지 않는다.
- SQLite 백업은 online backup과 checkpoint 후 age로 암호화하고 재복호화·hash·integrity·schema 검증을 통과한 결과만 24 hourly/14 daily로 유지한다. restore는 명시 target·동일 경로 재확인·서비스 정지·기존 DB quarantine·readiness rollback을 요구한다.
- 5분 주기 로컬 monitor는 verified backup freshness, disk, launchd, loopback ready, 알림·발행·IndexNow queue 집계만 확인한다. 별도 Keychain HMAC으로 loopback Hermes에 안전한 코드와 숫자만 전달하며 child DB timeout, incident fingerprint cooldown, symlink/path swap 방어를 적용했다.
- Task 8에서 요구사항 추적표와 외부 launch-input checklist를 정리하고 보안·개인정보, UX·접근성, 아키텍처·복구, SEO·AI·i18n, 콘텐츠·법적 표현, 운영·릴리스 관점의 병렬 비판 검토 결과를 재현·수정하는 release-candidate hardening을 수행했다.
- 저장소의 구현 완료는 실제 공개 배포 완료를 뜻하지 않는다. 도메인·Cloudflare·Kakao·SMTP·Hermes/Telegram·owner 등록·승인된 정책 문구와 보유 범위·전문 직함·검색 소유권·실제 Mac 훈련·외부 uptime 감시는 `docs/operations/release-candidate.md`의 외부 게이트로 남긴다.
- 최종 whole-branch review의 Important 2건을 `1f249ac`에서 수정했다. 공개 동의 조회는 verified release cache와 저비용 identity key·rate limit로 매 요청 전체 해시를 제거했고, 마케팅 철회는 scanner-safe 반복 GET과 원자적 one-shot POST로 분리했다. 독립 재리뷰는 Critical 0·Important 0이다.
- `master` 병합 후 Windows clean checkout에서 `core.autocrlf`와 workspace 산출물 순서 문제를 발견해 LF 정책과 Control 선행 빌드를 고정했다. 상담 terminal status는 폼·버튼 복구 뒤 공개하고, WebKit 상태 머신 E2E는 reduced-motion 환경에서 포인터 스크롤 변동을 제거했다. 최종 수정 재리뷰도 Critical 0·Important 0·Minor 0이다.
- clean install 이후 최종 검증은 root 11/11, shared 70/70, control 415/415, site 98/98, Ops 203 pass·6 Windows skip·0 fail, 68페이지 빌드, Playwright 108/108 통과다. 관련 WebKit 재시도 시나리오 40/40 반복 통과, 320·390·768·1440과 4개 언어 실제 로컬 브라우저 점검, prototype 무변경도 확인했다.
