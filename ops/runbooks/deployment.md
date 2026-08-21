# macOS 배포 운영 절차

## 운영 경계

- Apple silicon Mac mini, macOS, Node.js 24, SQLite 3.51.3 이상을 전제로 한다. 배포 시 실제 SQLite 버전을 기록하며 예상 버전 3.53.2를 맹신하지 않는다.
- Cloudflare Tunnel은 외부로 나가는 연결만 만들고 Caddy와 control은 `127.0.0.1`에서만 수신한다. 공유기에는 수신 규칙을 추가하지 않는다.
- 공개 호스트와 관리자 호스트는 분리한다. 공개 호스트의 `/api/v1/*`, 철회 기능, `/health/live`, 정확한 `/indexnow-key.txt`만 control로 전달한다. 관리자 호스트에서는 internal/API/철회/health/IndexNow 표면을 차단한다.
- Mac에서 소스 릴리스마다 `npm ci`를 실행한다. Windows에서 만들어진 `node_modules`나 native addon을 복사하지 않는다.

## 최초 설치 순서

1. `ops/config/runtime.env.template`, `ops/monitoring/checks.json.template`, Caddy, cloudflared, launchd 템플릿을 운영값으로 렌더링한다. 렌더 결과는 immutable application release 밖의 `shared` 경로에 두고 소유자만 쓸 수 있게 한다. monitoring 결과는 `shared/monitoring.json`으로 설치하고 group/world 쓰기를 금지한다.
2. 최초 정적 빌드를 만든 뒤 `seed-public.mjs`를 먼저 dry-run하고 `--apply`한다. 이 명령은 public release operation lock을 보유하고 cloudflared LaunchAgent가 완전히 unloaded임을 증명한 상태에서만 별도 `public-releases/<release-id>`에 bootstrap 전용 전체 파일 hash manifest를 만든다. pointer 전환 직전에 `PUBLIC_BOOTSTRAP_DOWNGRADE_FORBIDDEN` 조건을 다시 검사하고 `public-current`를 원자적으로 전환한다. application `current`와 혼용하지 않는다. `.wisdom-release-manifest.json`이 한 번이라도 생성된 public release root에서는 active/retired 여부와 무관하게 bootstrap seed를 다시 실행할 수 없다.
3. bootstrap 단계에서는 cloudflared LaunchAgent를 먼저 `launchctl bootout`하여 완전히 unload한 뒤 `ops/scripts/preflight.mjs --allow-bootstrap-local-staging`으로 verified bootstrap `public-current`, `arm64`, Node 24, Caddy, cloudflared, 정확히 age 1.3.1, `better-sqlite3`, SQLite 버전과 쓰기 가능한 경로를 확인한다. 결과는 `tunnelReady: false`, `tunnelDisabledVerified: true`여야 하며 tunnel을 시작하지 않는다. preflight는 cloudflared가 실행 중이거나 정지됐지만 여전히 loaded인 경우, 또는 launchctl 상태를 확정할 수 없는 경우 모두 실패한다. 이 검사는 서비스를 자동으로 중지하지 않는다. `age --version` 결과가 고정 버전과 다르거나 해석할 수 없으면 배포를 중지한다.
4. `secret-bootstrap.mjs`를 먼저 dry-run하고 `--apply`로 독립된 애플리케이션 비밀을 Keychain에 설치한다. 모니터는 알림 worker의 `HERMES_HMAC_SECRET`을 재사용하지 않고 `MONITOR_HERMES_HMAC_SECRET` → `com.jihye.portal.monitor-hermes-hmac` 항목만 사용한다. 회전은 한 번에 하나만 `--mode rotate --only <ENVIRONMENT>`로 요청하며 PII/control/철회 키는 전용 migration 절차 없이 회전할 수 없다.
5. `age-keygen`으로 운영자가 보관할 age 키를 별도로 만든다. 공개 recipient만 백업 설정에 기록한다. private identity 파일에서 한 줄을 표준입력으로 `secret-import.mjs --account <user> --apply`에 전달하여 `com.jihye.portal.age-identity`에 신규 설치하고, 명령 인자·로그·셸 변수에는 넣지 않는다.
6. content worker용 Codex credential도 표준입력으로 `secret-import.mjs --account <user> --kind codex-api --service <CODEX_KEYCHAIN_SERVICE> --apply`에 신규 설치한다. `runtime.env`에는 API key가 아니라 service reference만 둔다. `CODEX_BINARY`, `GIT_BINARY`, 고정 `CODEX_MODEL`, 서로 다른 non-symlink `CODEX_HOME`/`CODEX_TEMP_ROOT`, bounded `CODEX_TIMEOUT_MS`를 실제 Mac 절대경로로 설정한다. 시작 점검에서 현재 Codex CLI가 `--disable shell_tool`을 지원하지 않으면 worker는 fail-closed로 종료되어야 한다. 번역 원문과 검수 후보는 작업 파일이나 명령행 인자가 아니라 표준입력으로만 전달하며, 실행 인자는 `read-only`, no approval, no web search, no shell inheritance를 고정한다.
7. IndexNow 소유권 키는 8~128자의 영문·숫자·하이픈으로 생성한다. 한 줄을 표준입력으로 `secret-import.mjs --account <user> --kind indexnow-key --service <INDEXNOW_KEYCHAIN_SERVICE> --apply`에 신규 설치한다. `/indexnow-key.txt` 응답과 제출 JSON에는 공개되지만 저장소·프로세스 인자에는 넣지 않는다. Keychain 항목이 없거나 잘못되면 상담 API와 번역 worker는 계속 동작하고 IndexNow 공개·전송만 중지된다. 키를 복구한 뒤 control과 content worker를 재시작하면 보류 outbox가 재개된다.
8. 이메일 알림을 사용할 때 SMTP `{ "user": "...", "password": "..." }` 한 줄 JSON을 표준입력으로 `secret-import.mjs --account <user> --kind smtp-json --service <새-service-name> --apply`에 신규 설치한다. 관리자 설정에는 값이 아니라 `keychain:<service-name>` reference만 저장하며 notification worker plist에는 SMTP password를 넣지 않는다.
9. cloudflared credential 파일은 소유자 읽기 전용으로 설치한다. 템플릿이나 저장소에 토큰/credential 본문을 넣지 않는다.
10. monitor 설정은 먼저 `node ops/scripts/monitor.mjs --config /Users/wisdom/portal/shared/monitoring.json --validate-only`로 구조만 검증한다. 필요한 서비스와 첫 verified backup이 준비되면 같은 절대 경로에 `--dry-run`을 사용해 실제 사설 검사를 수행하되 Hermes 전송은 억제한다. 출력에는 check ID, 안전한 오류 코드, 숫자 메트릭만 있는지 확인한다.
11. launchd plist를 `plutil -lint`로 확인하고 사용자 LaunchAgents로 설치한다. `com.jihye.portal.monitor`는 5분마다 Keychain wrapper를 통해 독립 monitor HMAC 하나만 읽는다. `com.jihye.portal.retention`은 시작 시와 매시간 같은 보호된 runtime/Keychain 경로에서 `purge.js --apply --batch-size 1000 --max-batches 10`을 실행한다. 두 job을 각각 `launchctl print`와 `launchctl kickstart -k`로 첫 실행 및 exit status까지 확인한다. bootstrap public release 동안에는 tunnel agent를 시작하지 않는다. application과 정상 Wisdom public release를 게시한 뒤 `preflight.mjs`에 `--monitor-config /Users/wisdom/portal/shared/monitoring.json`을 포함한 플래그 없는 외부 preflight가 `monitoringConfigValidated: true`, `tunnelReady: true`를 반환해야만 tunnel을 `launchctl bootstrap`한다. 그 후 Caddy, tunnel, control, worker, monitor 상태와 공개 live 응답을 확인한다.

bootstrap에서 첫 Wisdom public release로 전환할 때는 Tunnel을 계속 unloaded 상태로 유지한 채 `ops/scripts/first-publication.mjs`를 사용한다. 기본 실행은 명령 계획만 출력하고, `--plan`은 public release operation lock과 cloudflared unloaded 증명을 확보한 뒤 bootstrap release ID·관리자 ID·동의 bundle·승인 문서 head를 묶은 확인 fingerprint를 출력한다. `--apply --confirm-first-publication <동일 fingerprint>`만 게시를 수행하며, 완료 후 `public-current`가 Wisdom manifest를 가리키는지 확인한다. 이미 release 이력이 있거나 bootstrap이 바뀐 경우 재실행은 실패한다. 이 전환이 끝난 뒤에만 플래그 없는 외부 preflight와 Tunnel 시작 절차로 진행한다.

관리자 React 번들은 application release에 포함한다. 전환 전 `apps/admin/dist/admin/index.html`, `apps/admin/dist/admin/manifest.json`과 manifest가 참조하는 해시 포함 JS/CSS가 release manifest에 포함되었는지 확인한다. `/admin`과 `/admin/api/*`는 `no-store`, 해시 파일명인 `/admin/assets/*`만 immutable cache인지 확인하고 로그인·MFA·상담 목록 조회까지 점검한다.

Applied monitoring has an additional fail-closed preflight. In apply mode, the independent
Keychain HMAC secret must be present and at least 32 bytes before any local checks, incident
state reads, or Hermes requests begin. A missing, short, or malformed secret stops the run
with a sanitized monitor error. `--validate-only` and `--dry-run` never read that secret and
never send or mutate incident state.

Routine five-minute backup freshness checks trust the protected verified status written by
the successful backup job and revalidate the stable artifact size and filesystem identity.
They do not repeatedly read a large encrypted artifact. Full SHA-256 verification remains a
mandatory restore gate before decryption and database replacement.

이후 application 배포는 `deploy.mjs`의 dry-run을 확인한 다음 `--apply`한다. apply에는 `--monitor-config`로 release 밖의 보호된 monitoring JSON 절대경로를 전달한다. 새 release에서 Mac native dependency 설치, build, migration을 실행한 뒤 `npm prune --omit=dev --workspaces --include-workspace-root --ignore-scripts`로 실행용 의존성만 남긴다. 운영 CLI와 worker는 `tsx`가 아니라 빌드된 `dist/*.js`를 실행한다. canary live/ready와 manifest 검증을 모두 통과해야 pointer를 전환한다. 전환 후 launchd와 active health가 실패하면 이전 pointer와 서비스를 복구한다. public 정적 산출물은 동일 release ID를 사용해도 별도 public release/pointer 계약으로 게시한다.

server와 worker runtime은 시작하면서 migration을 실행하지 않는다. 현재 schema fingerprint가 아니면 `DATABASE_MIGRATION_REQUIRED`로 종료하며, 배포의 명시적 `db:migrate --require-rollback-compatible` 단계만 schema를 변경한다. launchd 재시작 뒤 readiness URL은 셸 환경이 아니라 보호된 runtime config의 `CONTROL_HOST=127.0.0.1`과 `CONTROL_PORT`로 생성한다.

앱 배포 내부 preflight만 `--allow-bootstrap-local-staging`을 사용한다. 이 경우 검증된 bootstrap public release를 허용하지만 결과는 반드시 `tunnelReady: false`, `tunnelDisabledVerified: true`이며 Cloudflare Tunnel LaunchAgent는 unloaded 상태여야 한다. Mac 배포 어댑터는 preflight JSON을 직접 파싱하고 이 증명이 빠지거나 모순되면 배포를 중단한다. 정상 Wisdom 발행과 승인된 동의 snapshot을 게시한 뒤, tunnel을 시작하기 직전에 `preflight.mjs`를 이 플래그 없이 다시 실행하여 `tunnelReady: true`를 확인한다. 플래그 없는 외부 공개 preflight는 bootstrap을 거부한다.

## application pointer와 릴리스 복구 경계

- 기존 `current`는 `releases`의 직접 자식인 `<UTC timestamp>-<git hash>` 형식 디렉터리를 가리키는 symlink여야 한다. 대상의 `.ops-release.json` format v2는 control/site/shared workspace 전체, Ops runtime, production `node_modules`와 native addon을 exact inventory로 봉인한다. 파일 size/hash와 내부 상대 symlink를 정렬된 canonical JSON으로 기록하며, 추가·누락·변경 파일과 runtime root 밖으로 탈출하는 symlink를 모두 거부한다. 파일 수·개별/전체 byte·symlink 수·manifest 크기 상한을 넘는 release도 거부한다. 이 manifest가 다시 검증되어야만 배포·rollback·실패 복구에서 실행한다.
- `current`가 release root 밖, 중첩 디렉터리, 잘못된 release ID, symlink 대상 또는 변조된 manifest를 가리키면 운영자가 임의로 pointer를 보존하거나 실행하지 않는다. 원인을 조사하고 검증된 보존 release로 명시적 복구한다.
- pointer 전환 직전과 실패 복구 직전에도 destination/previous manifest를 다시 검사한다. 검증 실패 시 서비스 재시작이나 pointer 복구를 추측해서 계속하지 않는다.

## 배포·DB 잠금의 guarded 복구

정전이나 강제 종료 뒤 lock이 남아도 배포·rollback·backup·restore는 자동 탈취하지 않는다. `owner.json` v2의 host, boot ID, PID, process start identity를 확인한다. 같은 boot의 살아 있는 동일 process instance와 다른 host 소유자는 복구할 수 없다. PID가 재사용되었거나 프로세스가 종료되었거나 이전 boot 소유자임이 증명된 경우만 후보가 된다. owner가 없거나 부분 기록이면 lock 디렉터리가 최소 15분 이상 지난 뒤에만 후보가 된다.

먼저 dry-run한다. 아래 경로는 실제 Mac의 정규화된 절대 경로로 바꾸며 `..`, trailing separator, case alias를 쓰지 않는다.

```sh
node ops/scripts/recover-lock.mjs \
  --kind release \
  --release-root /Users/wisdom/portal/releases \
  --lock /Users/wisdom/portal/releases/.release-operation-lock

node ops/scripts/recover-lock.mjs \
  --kind database \
  --database /Users/wisdom/portal-data/portal.sqlite \
  --lock /Users/wisdom/portal-data/.portal.sqlite.maintenance-lock
```

출력의 `lockPath`, `ownerStatus`, `staleReason`, `observedAgeMs`를 운영 기록에 남긴다. 현재 실행 중 작업이 없음을 별도로 확인한 다음 같은 명령에 아래 세 인자를 추가한다.

```text
--apply --confirm-lock <출력과 정확히 같은 절대 lockPath> --confirm-action QUARANTINE_STALE_LOCK
```

도구는 lock을 삭제하지 않고 timestamp/UUID가 붙은 sibling quarantine으로 원자 이동한다. quarantine의 `owner.json`은 사고 조사와 작업 대조가 끝날 때까지 보존한다. 경로 또는 owner fingerprint가 검사 중 바뀌면 중지하고 처음부터 다시 dry-run한다.

## rollback 비호환 migration

일반 `db:migrate`와 `deploy.mjs`는 항상 rollback compatibility gate를 적용한다. 과거의 `--allow-incompatible-maintenance` 우회는 없으며 다시 추가하거나 직접 호출하지 않는다.

향후 비호환 schema 변경은 별도 maintenance release와 별도 검토를 거친 구현으로만 수행한다. 최소 ceremony는 다음과 같다: (1) control/worker와 tunnel 중지, (2) 방금 생성해 hash·복호화·integrity·schema를 검증한 fresh backup 확보, (3) DB maintenance lock 획득, (4) 새 schema와 호환되지 않는 rollback release를 명시적으로 식별하고 retirement 승인 기록, (5) 전용 migration 실행, (6) 새 release canary/readiness와 데이터 검증, (7) 서비스 재시작 및 외부 preflight. 이 절차의 일부만 자동화하는 임시 flag나 일반 배포 우회는 금지한다.

## 공개 콘텐츠와 동의 문서 사전 확인

1. 공개 빌드 전에 관리자에서 동일 bundle ID의 개인정보·마케팅 문서가 `ko`, `en`, `zh-Hans`, `zh-Hant` 모두 활성 상태인지 확인한다. 하나라도 없거나 version·hash·시행일·보존기간 역할이 맞지 않으면 snapshot 생성은 중단되어야 한다.
2. 상담 API의 개인정보 12개월·마케팅 24개월 metadata와 공개 `/privacy`·`/marketing/withdraw`의 `data-consent-sha256`, 보존기간, 본문을 대조한다. 공개 본문은 Markdown을 HTML로 실행하지 않고 escaped text로 보여야 한다.
3. 선택 마케팅 동의 시 24개월 보존 대상은 이름·회사·연락처·상담 내용을 포함한 암호화된 전체 상담 envelope다. 대표행정사와 개인정보 운영 책임자가 이 범위와 4개 언어 문구를 서면 승인하기 전에는 tunnel을 열지 않는다.
4. 영문 상호 `JIHYE Administrative Attorney`와 영어·간체·번체의 전문 직함은 대표행정사 및 관련 광고·표시 기준 검토자의 승인을 기록한다. Codex 번역 결과만으로 승인 처리하지 않는다.
5. 마케팅 철회는 확인 이메일의 hash 저장된 1회 링크로만 mutation한다. 전화·이메일은 링크 사용 지원 수단이며, 상담원이 별도 검증 절차 없이 전화·메일 요청만으로 철회를 완료했다고 안내하지 않는다.

정상 public 발행의 authoritative seal은 `.wisdom-release-manifest.json`이다. canonical pretty JSON+LF, snapshot manifest SHA-256, lexical strict 파일 목록, 각 파일의 size/SHA-256, exact inventory를 매번 재검증한다. `.ops-public-release.json`은 최초 bootstrap에만 허용되며 Wisdom seal과 혼용하거나 정상 발행 이후 fallback으로 사용할 수 없다.

검색엔진 운영 파일도 verified public release에 포함한다. 배포 후 `/sitemap.xml`은 `Content-Type: application/xml; charset=utf-8`, `/rss.xml`은 `application/rss+xml; charset=utf-8`인지 확인한다. Naver 소유권 확인 raw 파일은 Site와 동일하게 루트의 `naver` + 24~128자리 ASCII 영숫자·밑줄·하이픈 + `.html` 형식만 허용하며 Caddy가 `X-Robots-Tag: noindex, nofollow`를 붙인다. 더 넓은 `/naver*` matcher나 임의 파일명을 허용하지 말고, 파일 변경 시 새 public manifest와 pointer로 게시한다.

## Consent release authority

`consent:activate` only selects the next complete database bundle. The currently sealed
release remains authoritative for both the public policy pages and consultation intake
until an administrator completes the verified publish action. Policy-only publication is
valid when there are no eligible article heads. Follow
[`docs/operations/consent-publication.md`](../../docs/operations/consent-publication.md)
and do not start or expose the tunnel while consent readiness is unavailable.

Production Site builds must receive an absolute Control-generated
`WISDOM_PUBLISHED_CONTENT_DIR`. `build:fixture` is test/local-QA only and must never be
used for the tunneled public release.

## FileVault와 전원

FileVault has a pre-login limit: after a cold boot, the user must unlock the volume before user LaunchAgents and Keychain-backed services can run. `autorestart` cannot bypass that user unlock. 원격 무인 복구 계획에 이 제한을 반영한다.

- UPS와 wired Ethernet을 권장하고 실제 정전 시 graceful shutdown과 복귀를 시험한다.
- power 설정은 스크립트가 자동 변경하지 않는다. 먼저 `pmset -g custom`으로 inspect하고 결과를 저장한다.
- 전원 연결 시 system sleep 비활성, 정전 후 재시작, 지원되는 Wake-on-LAN을 검토할 수 있다. 예: `sudo pmset -c sleep 0 autorestart 1 womp 1`.
- 모든 `pmset` 변경은 기존 값을 기록한 뒤 한 항목씩 적용·검증하며 reversible하게 원래 값으로 되돌릴 수 있어야 한다.

## 로그와 감시

- Caddy access log는 비활성 상태를 유지한다. 애플리케이션 로그는 allowlist된 이벤트만 기록하고 PII, capability token, request body, secret을 기록하지 않는다.
- `newsyslog/wisdom-portal.conf.template`를 운영 사용자/`staff`, glob `G`, 압축 `J`, 불필요한 syslogd signal 방지 `N`으로 렌더링하여 파일당 10 MiB, 10개로 제한한다. 강제 rotation 시험 뒤 launchd 프로세스가 새 파일 descriptor에 계속 쓰는지 확인하고, 그렇지 않으면 maintenance `kickstart -k`로 writer를 재시작한다. 회전본 소유권/권한과 실제 크기 상한을 감시한다.
- 로컬 monitor는 verified age backup pair의 hash·freshness, disk free, Caddy/tunnel/control/worker launchd 상태, loopback `/health/ready`, 실패 backlog, 15분 이상 지연된 notification/translation/IndexNow 작업, 보유기간이 지난 미파기 상담의 집계 숫자만 확인한다. 읽기 전용 helper는 본문·연락처·request body를 선택하거나 출력하지 않는다. unhealthy이면 독립 HMAC으로 등록된 loopback Hermes endpoint에 metadata와 오류 코드만 전달하고 Telegram에 직접 연결하지 않는다.
- 외부 감시는 Mac/LAN 밖에서 공개 live URL과 예상 본문을 확인한다. 로컬 monitor가 Mac·전원·LAN 전체 장애를 스스로 보고할 수 없으므로 외부 계정과 외부 알림 목적지를 반드시 별도로 운영한다.
