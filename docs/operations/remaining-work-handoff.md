# 남은 작업 인수인계

이 문서는 다음 작업자가 현재 구현을 다시 조사하지 않고 이어서 개발·검증할 수 있도록 남은 작업, 중단 조건, 운영자 준비값과 완료 증거를 한곳에 정리한다. 실제 공개 가능 여부는 이 문서 하나가 아니라 [`release-candidate.md`](release-candidate.md)의 체크리스트와 실장비 증거로 판정한다.

## 1. 현재 기준점

| 항목 | 값 |
|---|---|
| 기준일 | 2026-07-17 |
| 저장소 | `https://github.com/himangga01/wisdom_web_portal.git` |
| 작업 브랜치 | `codex/admin-backup-mac-setup` |
| 원격 기준 커밋 | `793b3ce` (`fix: harden production configuration installer`) |
| 초안 PR | `https://github.com/himangga01/wisdom_web_portal/pull/1` |
| Windows 작업 트리 | `C:\Users\루루체\Documents\Codex\2026-07-14\project-wisdom-web-portal\.worktrees\admin-backup-mac-setup` |
| 배포 대상 | Mac mini M4 16GB, Docker 미사용, 기존 Gemma 4·Hermes와 공존 |

현재 브랜치는 위 커밋까지 원격에 push되어 있다. 인수인계 작성 직전 installer/CLI/configuration 집중 테스트는 **55/55 통과**했다. 전체 `npm.cmd run verify`는 `793b3ce` 직전 상태에서 통과했으므로, 최신 hardening 커밋을 포함한 전체 검증은 다시 실행해야 한다.

## 2. 이미 구현된 범위

다음 항목은 새로 만들 필요가 없으며, 변경 시 기존 테스트와 보안 경계를 보존한다.

- Astro·Tailwind 공개 사이트, bronze/sand/ivory 브랜드와 C1 모션
- 한국어·영어·중국어 간체·중국어 번체 4개 언어의 메뉴·본문·SEO 출력
- 서비스 소개, 상담 접수, 필수 개인정보 동의, 선택 마케팅 동의와 비회원 철회 링크
- 관리자 전용 Host·로그인, Argon2id, TOTP·복구 코드, CSRF·세션 보호
- 상담 SQLite 저장, SMTP 알림, Hermes metadata-only 알림 구조
- Codex 기반 번역·검수 흐름과 승인된 글의 정적 publication
- canonical·hreflang·JSON-LD·sitemap·RSS·robots·IndexNow 기반 검색 발견성
- immutable application/public release, preflight, rollback과 보존 정책
- age 암호화 로컬 백업·복구, 관리자 백업 enable/disable, launchd dispatcher와 monitor
- Caddy·cloudflared·launchd·Keychain 운영 템플릿
- 35개 exact-token production values 파일을 사용하는 dry-run-first configuration installer
- user/system scope 분리, 외부 validator, 원자 교체·검증·rollback, 비밀 없는 report

상세 구현 근거는 [`README.md`](../../README.md), [`AGENT.md`](../../AGENT.md), [`work-log.md`](../../work-log.md)와 [`release-candidate.md`](release-candidate.md)를 따른다.

재감사에서 이미 닫힌 항목도 구분한다. `/etc/newsyslog.d`의 macOS physical alias 처리, template inventory·symlink 검사, fatal UTF-8 decode, Bech32 age recipient, IP host 거부, mode drift 검사는 회귀 테스트가 있다. backup dispatcher의 process-group TERM→KILL 정리와 backup policy의 SQLite transaction·rollback도 구현·테스트됐다. 새 재현 증거 없이 이 항목을 미완료로 되돌리지 말고, 아래의 열린 root 실행 경계와 parent TOCTOU부터 처리한다.

## 3. 절대 중단 조건

아래 조건을 해결하거나 명시적으로 승인받기 전에는 외부 공개 완료로 표시하지 않는다.

1. **root Node 실행 금지:** `sudo node "$SOURCE_ROOT/ops/scripts/config-install.mjs"` 형태로 system scope를 적용하지 않는다. 사용자 소유 checkout의 JS/import 교체와 Homebrew Node의 root 실행을 모두 제거하고, 좁은 고정 target만 다루는 최소 root-owned helper 경계를 별도로 만든다.
2. **Secure cookie 약화 금지:** 첫 publication을 만들기 위해 관리자 cookie의 `Secure`를 끄거나 평문 HTTP 예외를 추가하지 않는다.
3. **Tunnel 조기 공개 금지:** 첫 정상 publication, Host-aware health, preflight가 완료되기 전에 cloudflared를 load/start하지 않는다.
4. **HMAC 평문 복사 금지:** 일반 알림 HMAC과 monitor HMAC을 stdout, argv, 로그, 임시 평문 파일로 표시하거나 서로 재사용하지 않는다.
5. **복구 가능성 과장 금지:** all-Keychain offline bundle과 Mac 외부 백업 복제가 없으므로 SSD·Mac 전체 손실 복구가 완료됐다고 표시하지 않는다.
6. **기존 schema v6 우회 금지:** v6 운영 DB는 전용 v6→v7 maintenance migration과 restore drill이 구현되기 전까지 업그레이드하지 않는다. rollback compatibility gate를 제거하거나 SQLite `user_version`을 수동 변경하지 않는다.
7. **실장비 검증 대체 금지:** Windows의 POSIX fixture·mock validator 성공을 macOS ownership, Keychain, launchctl, FileVault, Caddy, cloudflared와 age 실증으로 간주하지 않는다.

## 4. 작업 재개 명령

```powershell
cd C:\Users\루루체\Documents\Codex\2026-07-14\project-wisdom-web-portal\.worktrees\admin-backup-mac-setup
git switch codex/admin-backup-mac-setup
git pull --ff-only
git status --short --branch
node --test ops/tests/config-installer.test.mjs ops/tests/config-install-cli.test.mjs ops/tests/configuration.test.mjs
```

예상 시작 상태는 clean worktree, `HEAD == origin/codex/admin-backup-mac-setup == 793b3ce`, 집중 테스트 55개 통과이다. 다르면 먼저 변경 소유자와 실패 원인을 확인하고 사용자의 기존 변경을 덮어쓰지 않는다.

## 5. 우선순위별 남은 코드 작업

### P0 — RW-01 configuration installer의 root 신뢰 경계 닫기

현재 installer 기능은 구현됐지만, 운영 문서의 system apply 예제가 사용자 쓰기 가능한 checkout의 JavaScript를 `sudo`로 실행할 수 있다. 공개 전에 반드시 수정한다.

- [ ] `SOURCE_ROOT`, `NODE_BINARY`, `APP_ROOT`, `CADDY_BINARY`, `CLOUDFLARED_BINARY` 등 runbook 변수를 첫 사용 전에 정의한다.
- [ ] 현재 `sudo "$NODE_BINARY" "$SOURCE_ROOT/.../config-install.mjs"` 예제를 제거한다. Homebrew Node나 repository JavaScript를 root로 직접 실행하지 않는다.
- [ ] 좁은 고정 target만 다루는 최소 root-owned helper를 설계·구현한다. executable과 전체 실행 의존성은 root 소유·일반 사용자 쓰기 불가여야 하며, 작은 native privileged installer를 우선 검토한다.
- [ ] system scope values도 root만 읽을 수 있는 `0600` snapshot을 사용하고, 사용자 소유 원본을 root 프로세스가 재독하지 않게 한다.
- [ ] 문서 계약 테스트로 `$SOURCE_ROOT` 또는 사용자 소유 checkout에서 root Node 실행 예제가 다시 생기면 실패하게 한다.
- [ ] target parent 교체 TOCTOU를 닫는다. 현재 path 기반 recheck 뒤 `rename` 및 rollback에는 미세 경쟁이 남아 있으므로 directory-FD에 고정된 `openat`/`renameat`/`unlinkat` 계열 경계를 사용한다. 작은 native helper가 현실적인 우선안이다.
- [ ] parent를 rename한 뒤 symlink/junction으로 바꾸는 회귀 테스트에서 attacker directory에 한 바이트도 기록되지 않고 안정된 오류 코드로 실패하는지 확인한다.
- [ ] runbook 순서를 바꿔 실제 public/admin host, Tunnel ID, Cloudflare credential path와 새로 생성한 age recipient를 production values 렌더링 전에 확정한다. example의 유효하지만 배포 불가한 age recipient가 설치되는 것을 막는다.
- [ ] 수정 후 서로 다른 관점의 보안·명세 검토를 한 차례 더 받고 Important/Critical 지적을 재현 테스트와 함께 닫는다.

주요 파일:

- `ops/lib/config-installer.mjs`
- `ops/scripts/config-install.mjs`
- `ops/tests/config-installer.test.mjs`
- `ops/tests/config-install-cli.test.mjs`
- `ops/tests/configuration.test.mjs`
- `ops/runbooks/deployment.md`
- `docs/operations/mac-mini-setup.md`
- `docs/operations/release-candidate.md`

완료 증거:

- 문서에 user checkout에서 `sudo node`를 실행하는 경로가 없음
- root-owned 최소 helper의 provenance·owner·mode와 dependency 경계 확인 기록
- system values snapshot의 owner·`0600` 확인 기록
- parent-swap 실패 주입 테스트와 installer 집중 테스트 통과
- 두 번째 보안 검토의 Critical 0, Important 0

### P0 — RW-02 최신 HEAD 전체 검증과 계획 문서 동기화

- [ ] `npm.cmd run verify`를 `793b3ce` 이후 최종 코드에서 실행한다.
- [ ] placeholder·비밀 패턴 scan 결과를 사람이 확인한다.
- [ ] `git diff --check`를 통과시킨다.
- [ ] [`2026-07-17-production-template-installer.md`](../superpowers/plans/2026-07-17-production-template-installer.md)의 Task 2~6 체크박스를 실제 커밋·검증 상태와 맞춘다. 현재 코드는 구현됐지만 이 계획 문서 표시는 뒤처져 있다.
- [ ] 실행 시간, pass/fail/skip, OS와 commit을 `work-log.md`와 release-candidate 증거에 기록한다.

```powershell
npm.cmd run verify
rg -n "T[B]D|T[O]DO|implement later" ops docs README.md
rg -n "AGE-SECRET-KEY-1[A-Z0-9]+|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|TELEGRAM.*TOKEN=|CODEX_API_KEY=" ops docs README.md
git diff --check
```

scan 명령 자체가 계획 문서에 문자열로 존재할 수 있다. 일치 항목은 자동 무시하지 말고 fixture·예제·실제 비밀 여부를 확인한다.

### P1 — RW-03 Tunnel-off 첫 정상 publication bootstrap

목표는 Tunnel이 완전히 unloaded인 상태에서 Secure cookie와 관리자 Host/origin 검사를 유지하면서 owner가 관리자 UI로 최초 Wisdom release를 만드는 것이다.

- [ ] 로컬 HTTPS 관리자 진입 경로와 인증서 신뢰·Host 매핑 방식을 먼저 승인된 설계로 확정한다.
- [ ] bootstrap 전용 경로가 normal publication authority와 동일한 동의문·콘텐츠·감사 요건을 우회하지 않게 한다.
- [ ] 첫 release 생성 후 normal preflight를 통과한 뒤에만 Tunnel load 단계로 이동한다.
- [ ] HTTP downgrade, `Secure=false`, wildcard origin, Tunnel 조기 시작을 거부하는 자동 테스트를 추가한다.

시작 파일:

- `ops/scripts/seed-public.mjs`
- `ops/lib/public-release.mjs`
- `ops/lib/preflight.mjs`
- `ops/lib/mac-release-adapter.mjs`
- `ops/caddy/Caddyfile.template`
- `apps/control/src/admin/`
- `ops/tests/public-release.test.mjs`
- `ops/tests/security-bootstrap.test.mjs`

완료 증거는 실제 Mac에서 Tunnel off, 올바른 admin Host, HTTPS와 Secure cookie를 확인한 상태로 첫 정상 release 생성 및 다음 preflight 성공 기록이다.

### P1 — RW-04 Tunnel-off Host-aware health probe

현재 host-based Caddy를 올바르게 확인하려면 loopback 주소만 호출해서는 안 된다.

- [ ] probe가 public Host를 명시해 loopback Caddy를 통과하도록 구현한다.
- [ ] 올바른 Host의 기대 status/body만 healthy로 판정한다.
- [ ] Host 누락·오류, 잘못된 body, 예상 밖 status는 실패해야 한다.
- [ ] DNS와 Tunnel 없이 실행 가능해야 하며 cloudflared를 시작하지 않아야 한다.

시작 파일: `ops/lib/preflight.mjs`, `ops/scripts/preflight.mjs`, `ops/lib/mac-release-adapter.mjs`, `ops/caddy/Caddyfile.template`, `ops/tests/security-bootstrap.test.mjs`, `ops/tests/mac-services.test.mjs`.

### P1 — RW-05 Kakao URL publication allowlist

공개 사이트의 runtime 검사는 이미 있지만, 격리된 normal publication build가 `PUBLIC_KAKAO_CHAT_URL`을 승인된 입력으로 전달·봉인하지 않는다.

- [ ] canonical HTTPS Kakao 상담 URL만 허용하는 규칙을 publication input에 추가한다.
- [ ] 허용값을 isolated build environment와 sealed manifest에 포함하고 4개 언어 CTA가 동일 값을 사용하게 한다.
- [ ] 미설정이면 CTA를 숨기고 unsafe scheme, credential 포함 URL, 비승인 host와 모호한 path를 거부한다.
- [ ] Kakao 링크만을 위해 API key나 Kakao Developers 계정을 요구하지 않는다.

시작 파일: `apps/control/src/articles/publication-build.ts`, 해당 test·service/config call site, `apps/site/src/lib/site-config.ts`, `apps/site/src/components/HomePage.astro`, `apps/site/src/components/SiteHeader.astro`.

완료 증거는 허용·미설정·거부 케이스, sealed manifest, 4개 locale build parity 테스트 통과이다.

### P1 — RW-06 Hermes HMAC 안전 provisioning·rotation

Portal Keychain에는 HMAC을 만들 수 있지만 기존 Hermes secret store에 동일한 두 값을 평문 노출 없이 전달하는 절차가 없다.

- [ ] 일반 상담 알림 HMAC과 monitor HMAC의 별도 생성·전달·검증 프로토콜을 구현한다.
- [ ] stdout, argv, shell history, 일반 로그와 평문 파일에 secret이 남지 않게 한다.
- [ ] one-time provisioning 또는 승인된 local secure transport를 사용한다.
- [ ] 양쪽 시스템의 rotation, overlap window, rollback과 폐기 절차를 문서화한다.
- [ ] 일반 상담 알림과 장애 monitor 알림이 서로의 key로는 인증되지 않는 테스트를 추가한다.

시작 파일: `ops/scripts/secret-bootstrap.mjs`, `ops/lib/keychain.mjs`, `apps/control/src/notifications/`, `ops/lib/monitoring.mjs`와 새 provisioning module·tests.

완료 증거는 실제 Hermes로 서명된 상담 알림 1건과 monitor 장애 알림 1건의 E2E 성공, 교차 key 실패, secret 비노출 scan이다.

### P1 — RW-07 all-Keychain offline recovery bundle

현재 age backup만으로는 Mac 전체 손실 후 Keychain 비밀을 되살릴 수 없다.

- [ ] 복구 대상 비밀의 exact inventory와 버전 manifest를 확정한다.
- [ ] PII key, control/session/withdrawal HMAC, 일반·monitor Hermes HMAC, age identity와 필요한 SMTP·Codex·IndexNow reference/credential의 포함·제외 근거를 기록한다.
- [ ] bundle을 Mac 밖의 offline recipient로 암호화하고 plaintext residue가 없게 export/import한다.
- [ ] two-person/offline 접근, rotation, 폐기와 정기 복구 훈련 절차를 구현한다.
- [ ] 별도 깨끗한 Mac에서 wrong identity 거부, integrity 검증, 상담 PII 복호화까지 시험한다.

시작 파일: `ops/lib/keychain.mjs`, 새 recovery export/import scripts·tests, [`mac-mini-setup.md`](mac-mini-setup.md), [`ops/runbooks/recovery.md`](../../ops/runbooks/recovery.md).

### P1 — RW-08 automatic offsite backup replication

현재 검증된 `.age`와 `.json` pair는 같은 Mac에 남으므로 SSD·장비 손실을 막지 못한다. 구현 전 운영자가 S3-compatible object storage, rclone target 등 실제 제공자와 보존 정책을 선택해야 한다.

- [ ] 제공자, 지역, bucket/container, 인증 방식, 비용·보존·삭제 정책을 운영자가 승인한다.
- [ ] locally verified `.age`/`.json` pair만 idempotent하게 복제한다.
- [ ] 원격 size/hash를 확인하고 부분 업로드를 공개 pair로 승격하지 않는다.
- [ ] retry/backoff, retention, 삭제 보호와 복제 지연·실패 monitor를 구현한다.
- [ ] credential은 Keychain에 저장하고 로그·plist·저장소에 넣지 않는다.
- [ ] Mac SSD를 사용하지 않는 별도 복원 시험으로 RPO/RTO를 기록한다.

시작 파일: `ops/lib/backup.mjs`, `ops/lib/backup-control.mjs`, `ops/scripts/backup-dispatcher.mjs`, monitoring module과 새 replication module·tests.

### 조건부 — RW-09 기존 schema v6→v7 maintenance migration

새 빈 DB 또는 이미 schema v7인 설치에는 필요 없다. 기존 v6 운영 DB를 가져올 때만 별도 작업으로 구현한다.

- [ ] verified encrypted backup과 maintenance lock
- [ ] 구 application/public release retirement 승인
- [ ] migration 전후 row·consent·publication·PII integrity 검증
- [ ] 실패 rollback 및 backup restore drill
- [ ] v7-only release 전환 후 RPO/RTO 기록

이 작업이 없으면 기존 v6 설치 업그레이드는 계속 **STOP**이다.

## 6. 운영자가 발급·결정·제공해야 할 값

코드로 대신 만들 수 없는 항목이다. 실제 값은 문서나 Git에 쓰지 말고 [`mac-mini-setup.md`](mac-mini-setup.md)의 저장 위치와 Keychain 경계를 따른다.

- [ ] 실제 apex·`www`·admin domain, registrar 계정과 MFA, DNS 소유권
- [ ] Cloudflare zone, Tunnel ID, owner-only `0600` credential file
- [ ] 실제 Kakao 상담 URL, 공개 전화·이메일, 공식 Naver blog·map URL, 4개 언어 CTA 문구
- [ ] SMTP 계정·MFA·app password, 465 implicit TLS, From/To, `receipt-only` 또는 승인된 `full-inquiry`
- [ ] Hermes loopback endpoint, 일반/monitor HMAC, Hermes 내부 Telegram bot token·chat ID
- [ ] Codex 인증/API billing, binary/model, 격리 `CODEX_HOME`, timeout와 Gemma 비혼잡 실행 시간
- [ ] owner username·display name·password, TOTP와 offline recovery codes
- [ ] 개인정보 필수 동의와 마케팅 선택 동의의 4개 언어 최종본 8개, version·시행 시각·승인자
- [ ] 전체 암호화 상담 envelope의 12개월/24개월 보유 범위에 대한 개인정보 책임자 승인
- [ ] 영어·간체·번체 행정사 전문 직함의 전문가 승인
- [ ] six base secrets, PII key ID, age identity/recipient, SMTP·Codex·IndexNow Keychain reference
- [ ] Google Search Console, Naver Search Advisor 계정·소유권 확인값, IndexNow key
- [ ] 원격접속 MFA, FileVault unlock 담당자, recovery key 보관, UPS, 유선 LAN, 전원 복구 절차
- [ ] Mac/LAN 밖의 uptime 계정과 알림 목적지
- [ ] offsite backup 제공자·지역·인증·보존 정책
- [ ] 원본 vector logo. 대표 사진은 선택 사항이며 승인 전에는 기존 브랜드 illustration을 유지한다.

## 7. Mac mini 실장비 인수 체크리스트

### 설치와 공존

- [ ] `arm64`, FileVault, UPS, 유선 LAN과 volume unlock 절차 확인
- [ ] Gemma 4·Hermes·Portal 포트 충돌과 16GB 메모리·CPU 경합 측정
- [ ] Node 24, npm 12.0.1, age 1.3.1, bundled SQLite 3.51.3 이상과 binary provenance 확인
- [ ] 깨끗한 checkout에서 `npm ci`, Playwright 설치와 `npm run verify`

### configuration installer 실증

- [ ] 실제 `0600` non-symlink values와 root-owned 최소 privileged helper 준비
- [ ] 실제 host·Tunnel ID·credential path·age recipient를 example 값에서 모두 교체한 뒤 values를 렌더링했는지 확인
- [ ] user/system dry-run 모두 성공 후 scope별 apply
- [ ] plist, Caddy, cloudflared, newsyslog 실제 validator 재실행
- [ ] owner·mode·unchanged 재적용·원자 교체 확인
- [ ] 중간 실패와 rollback 실패 주입 기록
- [ ] report가 허용된 필드만 출력하고 Keychain·credential을 읽거나 서비스를 시작하지 않았는지 확인

### 공개 전 기능·보안

- [ ] owner 등록, TOTP 확인, recovery code offline 봉인
- [ ] privacy·marketing × 4 locale 8개 문서 seed·활성화
- [ ] Tunnel off 첫 publication, Host-aware probe, normal preflight, Tunnel load 순서 확인
- [ ] 실제 SMTP receipt와 승인된 경우에만 full-inquiry 범위 확인
- [ ] Hermes 일반/monitor HMAC 분리와 Telegram metadata-only 알림 확인
- [ ] 관리자 Host, noindex, public/admin origin과 cookie 속성 확인

### 백업·감시·장애

- [ ] admin backup enable/disable, 60초 dispatcher, 60분 due gate, OFF 10분 grace 확인
- [ ] OFF 중 manual backup, verified pair, wrong age identity 실패와 별도 target restore
- [ ] RPO/RTO 측정과 offsite-only 복구
- [ ] monitoring `--validate-only`, monitor `--dry-run`
- [ ] 안전한 실패 1회에 Hermes handoff가 정확히 1회 발생하는지 확인
- [ ] Mac/LAN 밖 uptime 경보, cold boot, FileVault 수동 unlock과 전원 차단 훈련

### 검색·실기기

- [ ] 실제 domain의 canonical, hreflang, sitemap, robots, RSS, IndexNow와 MIME/cache 확인
- [ ] Search Console·Naver Search Advisor 소유권·제출 확인
- [ ] Samsung Internet, macOS/iPhone Safari, Kakao/Naver in-app browser와 JavaScript 차단 상태 검수
- [ ] 320·390·768·1440 폭에서 메뉴·언어·동의·상담 완료·외부 링크 확인

각 항목의 정확한 명령과 증거 형식은 [`mac-mini-setup.md`](mac-mini-setup.md)와 [`release-candidate.md`](release-candidate.md)를 사용한다.

## 8. 권장 실행 순서

1. RW-01 root 신뢰 경계와 TOCTOU 결정을 코드·문서·테스트로 닫는다.
2. 두 번째 독립 보안 검토 후 RW-02 전체 검증과 계획 문서 동기화를 끝낸다.
3. RW-03 first publication과 RW-04 Host-aware probe를 한 설계 묶음으로 구현한다.
4. RW-05 Kakao publication allowlist를 구현한다.
5. RW-06 Hermes provisioning을 기존 Hermes 운영자와 함께 E2E 검증한다.
6. RW-07 offline recovery bundle을 먼저 만든 뒤 RW-08 offsite replication 제공자를 확정·구현한다.
7. 운영자 입력값을 보호된 values·Keychain·credential file에 주입한다.
8. Mac 실장비 설치, backup/restore, 장애 주입, cold boot와 실제 브라우저 검수를 수행한다.
9. 모든 공개 게이트의 증거가 모인 뒤에만 Tunnel을 load하고 검색 서비스 등록을 완료한다.

## 9. 완료 후 Git 인계

작업 단위마다 관련 테스트를 먼저 통과시키고 하나의 의도를 가진 commit으로 남긴다. 최종 push 전에는 다음을 실행한다.

```powershell
git status --short --branch
git diff --check
npm.cmd run verify
git push origin codex/admin-backup-mac-setup
git status --short --branch
```

Draft PR 1에 다음 증거를 요약한다.

- 변경한 차단 항목 번호와 위협 모델 결정
- focused test와 full verify 결과
- secret/placeholder scan 결과
- 실제 Mac에서만 가능한 검증의 완료·미완료 구분
- owner·mode·Keychain·launchd·backup/restore·failure-injection 증거 위치
- 여전히 남은 운영자 결정 또는 외부 계정 작업

## 10. 문서 우선순위

충돌할 때는 다음 순서로 현재 상태를 재검증한다.

1. 실행 코드와 자동 테스트
2. [`release-candidate.md`](release-candidate.md)의 공개 게이트와 실제 증거
3. [`mac-mini-setup.md`](mac-mini-setup.md)의 설치·Keychain·복구 중단 조건
4. [`ops/runbooks/deployment.md`](../../ops/runbooks/deployment.md), [`ops/runbooks/recovery.md`](../../ops/runbooks/recovery.md), [`ops/runbooks/incidents.md`](../../ops/runbooks/incidents.md)
5. 승인된 implementation plan과 `work-log.md`

문서에 “구현 완료”라고 적혀 있어도 실제 코드·test·Mac 증거가 없으면 완료로 처리하지 않는다. 반대로 계획 체크박스가 뒤처진 경우 먼저 commit과 test evidence를 확인하고 bookkeeping만 정정한다.
