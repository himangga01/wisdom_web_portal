# 지혜 웹 포털

지혜행정사사무소 운영 포털의 npm 워크스페이스입니다. 운영 애플리케이션은 `apps/site`, `apps/control`, 공용 계약과 토큰은 `packages/shared`에 둡니다. `prototypes/homepage-motion`은 승인된 시각·모션 참고본이며 운영 워크스페이스와 분리해 동결 상태로 유지합니다.

이 저장소에는 프로덕션 후보 코드와 운영 자동화가 구현되어 있습니다. 그러나 실제 도메인, Cloudflare 자격증명, 승인된 법적 문구와 운영 계정이 아직 주입되지 않은 상태에서는 공개 배포가 완료된 것이 아닙니다. 문서의 시작점은 [`docs/00-document-map.md`](docs/00-document-map.md), 공개 전 체크리스트는 [`docs/operations/release-candidate.md`](docs/operations/release-candidate.md)입니다.

## 시스템 구성

- `apps/site`: Astro 6와 Tailwind CSS 4로 정적 생성하는 공개 사이트입니다. 한국어 `/`를 기준으로 영어 `/en`, 중국어 간체 `/zh-hans`, 중국어 번체 `/zh-hant`를 제공하고, 메뉴·서비스·상담·정책·게시글·메타데이터까지 같은 언어 집합을 사용합니다.
- `apps/control`: `127.0.0.1`에만 바인딩하는 Hono 제어 서비스입니다. 상담 접수, 동의 원장, 계정 없는 마케팅 철회, 별도 관리자 호스트, 알림·번역·발행 작업과 SQLite를 소유합니다.
- `packages/shared`: 공개 경로, 4개 언어, 상담·동의·게시글·환경 설정 계약과 검증 규칙을 공유합니다.
- `ops`: Docker 없이 Mac mini에서 Caddy, Cloudflare Tunnel, launchd, macOS Keychain, 릴리스 포인터, 암호화 백업·복구와 로컬 모니터를 운영하는 템플릿·스크립트·런북입니다.

공개 요청은 Cloudflare Tunnel에서 Caddy로 들어오며, Caddy가 정적 public release와 loopback control API를 분리해 전달합니다. 관리자 호스트는 공개 호스트와 다르고 검색 색인을 차단합니다. 상담 PII는 로컬 SQLite에 암호화해 저장하며 Telegram에는 접수 메타데이터만 보냅니다.

## 요구 환경

- Node.js 24 (`.nvmrc`, `.node-version`)
- npm 12
- Docker 없이 실행 가능한 로컬 환경

## 설치와 검증

Windows PowerShell에서는 실행 정책에 막히는 `npm.ps1` 대신 `npm.cmd`를 사용합니다.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
npm.cmd run verify
```

macOS에서는 일반 `npm` 명령을 사용합니다.

```sh
npm ci
npm run build
npm test
npm run test:e2e
npm run verify
```

루트 명령은 `packages/*`를 `apps/*`보다 먼저 처리하며, 아직 같은 이름의 스크립트가 없는 워크스페이스는 건너뜁니다. `typecheck`, `test`, `test:e2e`는 소비 앱을 실행하기 전에 `@wisdom/shared`를 빌드하므로 `packages/shared/dist`가 없는 새 checkout에서도 동작합니다. `verify`는 타입 검사, 단위 테스트, 빌드, E2E 테스트 순서로 전체 운영 워크스페이스를 확인합니다.

2026-07-21 code commit `273baa0` 기준으로 전체 검증이 통과했습니다. 실제 실행 수치와 과거 기준 기록은 [릴리스 후보 점검표](docs/operations/release-candidate.md)를 따릅니다.

## 환경 설정

`.env.example`을 로컬 `.env`로 복사한 뒤 실제 값을 설정합니다. 애플리케이션은 `.env`를 로드한 다음 `@wisdom/shared`의 `parseEnvironment`에 전달해야 합니다.

- 운영 환경의 `ADMIN_SESSION_SECRET`, `PII_ENCRYPTION_KEY`, `CONTROL_HMAC_SECRET`, `WITHDRAWAL_TOKEN_SECRET`, `HERMES_HMAC_SECRET`은 서로 다른 32바이트 이상의 값이어야 하며 하나라도 없으면 파싱이 실패합니다.
- `PUBLIC_ORIGIN`과 `ADMIN_ORIGIN`은 경로 없는 정확한 원본이어야 합니다. 운영에서는 서로 다른 HTTPS 호스트명을 사용합니다.
- `ADMIN_DUMMY_PASSWORD_HASH`는 실제 계정 비밀번호가 아니라 미등록 계정에도 동일한 Argon2id 비용을 적용하는 공개 dummy 검증값이며 동결된 파라미터를 충족해야 합니다.
- 운영 환경은 인메모리 데이터베이스를 사용할 수 없습니다.
- `NODE_ENV=test`에서만 격리된 인메모리 데이터베이스와 테스트 전용 비밀값을 기본 제공하며 운영에는 재사용되지 않습니다.
- 이메일 본문 모드는 기본적으로 `receipt-only`입니다. `full-inquiry`는 별도 운영 승인 후 명시적으로 설정합니다.
- 실제 비밀값, 상담 요청 본문, 원문 연락처를 Git이나 로그에 남기지 않습니다.

## 공용 패키지

`packages/shared`는 다음 내용을 단일 진입점으로 제공합니다.

- 출시 언어, 상담 분류·상태·연락 방식 계약
- 개인정보·마케팅 동의와 상담 요청 Zod 스키마
- 상담 접수 응답과 API 오류 계약
- 알림 채널·이메일 본문 모드·글 상태 계약
- bronze/sand/ivory 디자인 토큰과 승인된 홈페이지 리빌 수치
- 운영 비밀값을 누락 허용하지 않는 환경 파서

상담 요청은 서버 경계에서 32KiB 원시 본문 제한을 적용하고 PII를 암호화해 저장합니다.

## 로컬 상담 제어 서비스

`apps/control`은 Hono와 SQLite를 사용하는 로컬 전용 상담 접수 서비스입니다. 서버는 항상 `127.0.0.1`에만 바인딩하며 외부 공개는 이후 Caddy와 Cloudflare Tunnel을 통해 구성합니다. SQLite는 WAL, 외래 키, `synchronous=FULL`, 5초 busy timeout, secure delete를 모든 연결에 적용합니다.

운영 환경에서는 기존 비밀값과 함께 다음 설정이 필요합니다.

- `CONTROL_HMAC_SECRET`: 암호화 키와 독립적인 32바이트 이상 HMAC 루트
- `HERMES_HMAC_SECRET`: 다른 모든 키와 독립적인 Hermes 요청 서명 키
- `PUBLIC_ORIGIN`, `ADMIN_ORIGIN`: 예: `https://www.example.com`, `https://admin.example.com`
- `ADMIN_DUMMY_PASSWORD_HASH`: 동결 Argon2id 정책을 만족하는 dummy PHC 문자열
- `HERMES_ENDPOINT`: literal loopback Hermes URL, 기본값 `http://127.0.0.1:8788/notify`
- `PII_ACTIVE_KEY_ID`: 현재 PII 암호화 키 버전 ID
- `PII_PREVIOUS_KEYS_JSON`: 이전 PII 키 ID와 값의 JSON 객체
- `PUBLIC_ORIGINS`: 쉼표로 구분한 HTTPS 원본 허용 목록
- `CONTROL_HOST=127.0.0.1`, `CONTROL_PORT=8787`

`CONTROL_HMAC_SECRET`을 교체하면 기존 폼 토큰, 멱등성 키, 요청 지문 및 블라인드 인덱스가 함께 바뀝니다. HMAC 루트 회전은 Task 7 운영 절차에서 점검·배치 재색인과 함께 수행하며 임의로 즉시 교체하지 않습니다.

Windows PowerShell 운영 명령은 다음과 같습니다. macOS에서는 `npm.cmd` 대신 `npm`을 사용합니다.

```powershell
npm.cmd run db:migrate --workspace @wisdom/control
npm.cmd run consent:seed --workspace @wisdom/control -- --file .\consent-bundle.json
npm.cmd run consent:activate --workspace @wisdom/control -- --bundle bundle-2026-01 --confirm-sha <seed-output-sha>
npm.cmd run retention:purge --workspace @wisdom/control
npm.cmd run retention:purge --workspace @wisdom/control -- --apply --batch-size 100 --max-batches 10
npm.cmd run admin:bootstrap --workspace @wisdom/control -- --username owner --display-name "Primary Owner" --output .\owner-enrollment.json
npm.cmd run admin:password-reset --workspace @wisdom/control -- --username owner
npm.cmd run admin:mfa-replace --workspace @wisdom/control -- --username owner --output .\owner-mfa-replacement.json
npm.cmd run notifications:worker --workspace @wisdom/control
npm.cmd run dev --workspace @wisdom/control
```

`retention:purge --apply`는 한 번에 `batch-size × max-batches`까지만 파기합니다. 남은 만료 건이 있으면 `retention.incomplete`를 출력하고 종료 코드 1을 반환하므로, 운영 알림을 무시하지 말고 다음 실행 전 적체 원인을 확인합니다.

동의 bundle의 `consent:activate`는 다음 발행 후보를 선택하는 단계입니다. 현재 공개
홈페이지와 상담 API는 기존의 검증된 public release를 계속 사용합니다. 활성화 직후
관리자 `/admin/publish/preview`에서 글이 없어도 가능한 policy-only 발행을 완료해야
새 동의문이 8개 정책 화면과 상담 접수에 함께 적용됩니다. 전체 절차는
[`docs/operations/consent-publication.md`](docs/operations/consent-publication.md)를 따릅니다.

동의문 seed 파일은 개인정보·마케팅 문서 각각 4개 언어, 총 8개 문서를 포함해야 합니다. seed는 draft만 만들고 명령 출력의 묶음 SHA-256을 다시 입력해야 활성화됩니다. 보존기간 정리는 기본적으로 dry-run이며 `--apply`가 있을 때만 암호문과 정확검색 인덱스를 제거하고 미발송 아웃박스를 취소합니다.

관리자 CLI 비밀번호는 명령 인자가 아니라 표준 입력 한 줄로만 전달합니다. bootstrap과 MFA 교체가 만드는 등록 JSON은 기존 파일을 덮어쓰지 않으며 POSIX에서는 `0600`, Windows에서는 현재 사용자 SID만 접근 가능한 ACL을 적용합니다. 파일에는 TOTP secret과 10개 복구 코드가 있으므로 인증 앱 등록과 안전한 오프라인 보관을 마친 뒤 일반 공유 폴더에서 제거합니다. CLI는 비밀번호·TOTP·복구 코드를 stdout/stderr에 출력하지 않습니다.

알림 워커는 DB의 활성 채널 설정을 매 주기 다시 읽습니다. SMTP 자격증명은 DB나 `.env`에 넣지 않고 `notification_settings.secret_ref`가 가리키는 macOS Keychain 항목에 `{ "user": "...", "password": "..." }` JSON으로 보관합니다. Hermes에는 literal loopback endpoint와 독립 HMAC 키만 사용하며 Telegram으로는 접수 메타데이터만 전달합니다. 이메일 기본값은 PII를 복호화하지 않는 `receipt-only`; `full-inquiry`는 완전한 TLS SMTP 설정과 관리자 명시 승인 뒤에만 허용됩니다. SMTP 목적지는 공개 DNS FQDN과 465/implicit TLS만 허용하며, 매 발송 시 DNS 전체 응답이 공개 라우팅 주소인지 검사한 뒤 선택한 IP로 연결을 고정하고 TLS SNI는 원래 FQDN으로 유지합니다.

`better-sqlite3@12.11.1`은 Node.js 24에서 사용하는 네이티브 모듈입니다. Windows와 Apple Silicon macOS 사이에서 `node_modules`를 복사하지 말고 대상 장비에서 설치해야 하며, 사전 빌드 파일이 없으면 Windows Build Tools 또는 Xcode Command Line Tools가 필요할 수 있습니다.

## 콘텐츠 작성·번역·발행

- Hermes는 독립 HMAC으로 보호된 loopback 내부 API에 한국어 초안을 등록할 수 있지만 직접 발행할 수 없습니다.
- 관리자가 명시적으로 요청했을 때만 content worker가 Codex CLI를 읽기 전용·no-shell 조건으로 실행해 영어·간체·번체 번역 후보와 검수 결과를 만듭니다. 상담 데이터는 이 경로로 전달하지 않습니다.
- 관리자는 원문과 각 언어 번역을 개별 검토·승인하거나 반려합니다. 승인된 revision과 출처·검수자·날짜·번역 provenance만 발행 후보가 됩니다.
- 발행은 글과 활성 동의문 8개를 하나의 immutable public snapshot으로 봉인하고 임시 디렉터리에서 정적 빌드와 manifest를 검증한 뒤 `public-current` 포인터를 원자적으로 전환합니다. 실패하면 기존 공개본을 유지하며, 검증된 보존 release로 rollback할 수 있습니다.
- canonical, 상호 `hreflang`, `x-default`, JSON-LD, sitemap, RSS, robots와 IndexNow outbox가 구현되어 있습니다. 이는 검색·AI 발견성을 돕는 기술 기반이며 특정 검색 순위나 AI 인용을 보장하지 않습니다.

프로덕션 Site 빌드는 control이 생성한 절대 `WISDOM_PUBLISHED_CONTENT_DIR`를 받아야 합니다. 루트 `npm run build`와 `@wisdom/site`의 `build:fixture`는 테스트·로컬 QA용 fixture 빌드이며 tunnel에 공개할 산출물로 사용하지 않습니다.

## Mac mini 운영

운영 구성은 Docker를 사용하지 않습니다. application release와 public content release는 서로 다른 manifest와 포인터로 관리하며, 모든 서비스는 launchd가 실행합니다. 비밀값은 저장소나 plist가 아니라 Keychain service reference로 주입합니다.

- 배포·rollback·stale lock 복구: [`ops/runbooks/deployment.md`](ops/runbooks/deployment.md)
- age 암호화 hourly 백업과 guarded restore: [`ops/runbooks/recovery.md`](ops/runbooks/recovery.md)
- 장애·알림 backlog·monitor 대응: [`ops/runbooks/incidents.md`](ops/runbooks/incidents.md)
- 동의문 활성화와 policy-only 발행: [`docs/operations/consent-publication.md`](docs/operations/consent-publication.md)
- Google·Naver·AI 발견성 운영: [`docs/operations/search-discovery.md`](docs/operations/search-discovery.md)

로컬 monitor는 5분 주기로 verified backup freshness, 디스크, launchd 서비스, loopback readiness와 안전한 queue 집계만 검사합니다. 상담 본문이나 연락처는 읽지 않으며, 장애 시 알림 worker와 다른 Keychain HMAC으로 loopback Hermes에 오류 코드와 숫자 메트릭만 전달합니다. Mac·전원·LAN 전체 장애는 로컬 monitor가 보고할 수 없으므로 외부 uptime 감시는 별도 필수입니다.

## 공개 전 남은 작업

실제 공개 전에는 도메인·DNS·Cloudflare Tunnel, Kakao URL, SMTP와 수신 메일, Hermes·Telegram 목적지, owner MFA 등록, 승인된 4개 언어 개인정보·마케팅 문구, 영문·중문 직함, 12/24개월 보유 범위, Search Console·Naver Search Advisor·IndexNow, FileVault·UPS·전원 복구, 실제 Mac 백업·복구·장애 주입과 외부 uptime 감시를 운영자가 확정해야 합니다. 전체 목록과 완료 증거 형식은 [`docs/operations/release-candidate.md`](docs/operations/release-candidate.md)를 따릅니다.
