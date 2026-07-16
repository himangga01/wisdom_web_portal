# macOS 배포 운영 절차

## 운영 경계

- Apple silicon Mac mini, macOS, Node.js 24, SQLite 3.51.3 이상을 전제로 한다. 배포 시 실제 SQLite 버전을 기록하며 예상 버전 3.53.2를 맹신하지 않는다.
- Cloudflare Tunnel은 외부로 나가는 연결만 만들고 Caddy와 control은 `127.0.0.1`에서만 수신한다. 공유기에는 수신 규칙을 추가하지 않는다.
- 공개 호스트와 관리자 호스트는 분리한다. 공개 호스트의 `/api/v1/*`, 철회 기능, `/health/live`, 정확한 `/indexnow-key.txt`만 control로 전달한다. 관리자 호스트에서는 internal/API/철회/health/IndexNow 표면을 차단한다.
- Mac에서 소스 릴리스마다 `npm ci`를 실행한다. Windows에서 만들어진 `node_modules`나 native addon을 복사하지 않는다.

## 최초 설치 순서

1. `ops/config/runtime.env.template`, Caddy, cloudflared, launchd 템플릿을 운영값으로 렌더링한다. 렌더 결과는 immutable application release 밖의 `shared` 경로에 두고 소유자만 쓸 수 있게 한다.
2. 최초 정적 빌드를 만든 뒤 `seed-public.mjs`를 먼저 dry-run하고 `--apply`한다. 이 명령은 별도 `public-releases/<release-id>`에 bootstrap 전용 전체 파일 hash manifest를 만들고 검증한 후 `public-current`를 원자적으로 전환한다. application `current`와 혼용하지 않는다. 정상 발행이 한 번이라도 존재하면 bootstrap release로 되돌아갈 수 없다.
3. 이제 `ops/scripts/preflight.mjs`로 verified `public-current`, `arm64`, Node 24, Caddy, cloudflared, 정확히 age 1.3.1, `better-sqlite3`, SQLite 버전과 쓰기 가능한 경로를 확인한다. `age --version` 결과가 고정 버전과 다르거나 해석할 수 없으면 배포를 중지한다. 이 gate를 통과하기 전에는 tunnel을 시작하지 않는다.
4. `secret-bootstrap.mjs`를 먼저 dry-run하고 `--apply`로 독립된 애플리케이션 비밀을 Keychain에 설치한다. 회전은 한 번에 하나만 `--mode rotate --only <ENVIRONMENT>`로 요청하며 PII/control/철회 키는 전용 migration 절차 없이 회전할 수 없다.
5. `age-keygen`으로 운영자가 보관할 age 키를 별도로 만든다. 공개 recipient만 백업 설정에 기록한다. private identity 파일에서 한 줄을 표준입력으로 `secret-import.mjs --account <user> --apply`에 전달하여 `com.jihye.portal.age-identity`에 신규 설치하고, 명령 인자·로그·셸 변수에는 넣지 않는다.
6. content worker용 Codex credential도 표준입력으로 `secret-import.mjs --account <user> --kind codex-api --service <CODEX_KEYCHAIN_SERVICE> --apply`에 신규 설치한다. `runtime.env`에는 API key가 아니라 service reference만 둔다. `CODEX_BINARY`, `GIT_BINARY`, 고정 `CODEX_MODEL`, 서로 다른 non-symlink `CODEX_HOME`/`CODEX_TEMP_ROOT`, bounded `CODEX_TIMEOUT_MS`를 실제 Mac 절대경로로 설정한다. 시작 점검에서 현재 Codex CLI가 `--disable shell_tool`을 지원하지 않으면 worker는 fail-closed로 종료되어야 한다. 번역 원문과 검수 후보는 작업 파일이나 명령행 인자가 아니라 표준입력으로만 전달하며, 실행 인자는 `read-only`, no approval, no web search, no shell inheritance를 고정한다.
7. IndexNow 소유권 키는 8~128자의 영문·숫자·하이픈으로 생성한다. 한 줄을 표준입력으로 `secret-import.mjs --account <user> --kind indexnow-key --service <INDEXNOW_KEYCHAIN_SERVICE> --apply`에 신규 설치한다. `/indexnow-key.txt` 응답과 제출 JSON에는 공개되지만 저장소·프로세스 인자에는 넣지 않는다. Keychain 항목이 없거나 잘못되면 상담 API와 번역 worker는 계속 동작하고 IndexNow 공개·전송만 중지된다. 키를 복구한 뒤 control과 content worker를 재시작하면 보류 outbox가 재개된다.
8. 이메일 알림을 사용할 때 SMTP `{ "user": "...", "password": "..." }` 한 줄 JSON을 표준입력으로 `secret-import.mjs --account <user> --kind smtp-json --service <새-service-name> --apply`에 신규 설치한다. 관리자 설정에는 값이 아니라 `keychain:<service-name>` reference만 저장하며 notification worker plist에는 SMTP password를 넣지 않는다.
9. cloudflared credential 파일은 소유자 읽기 전용으로 설치한다. 템플릿이나 저장소에 토큰/credential 본문을 넣지 않는다.
10. launchd plist를 `plutil -lint`로 확인하고 사용자 LaunchAgents로 설치한다. `launchctl bootstrap` 후 Caddy, tunnel, control, worker의 상태와 공개 live 응답을 확인한다.

이후 application 배포는 `deploy.mjs`의 dry-run을 확인한 다음 `--apply`한다. 새 release에서 Mac native dependency 설치, build, migration, canary live/ready, manifest 검증을 모두 통과해야 pointer를 전환한다. 전환 후 launchd와 active health가 실패하면 이전 pointer와 서비스를 복구한다. public 정적 산출물은 동일 release ID를 사용해도 별도 public release/pointer 계약으로 게시한다.

정상 public 발행의 authoritative seal은 `.wisdom-release-manifest.json`이다. canonical pretty JSON+LF, snapshot manifest SHA-256, lexical strict 파일 목록, 각 파일의 size/SHA-256, exact inventory를 매번 재검증한다. `.ops-public-release.json`은 최초 bootstrap에만 허용되며 Wisdom seal과 혼용하거나 정상 발행 이후 fallback으로 사용할 수 없다.

검색엔진 운영 파일도 verified public release에 포함한다. 배포 후 `/sitemap.xml`은 `Content-Type: application/xml; charset=utf-8`, `/rss.xml`은 `application/rss+xml; charset=utf-8`인지 확인한다. Naver 소유권 확인 raw 파일은 Site와 동일하게 루트의 `naver` + 24~128자리 ASCII 영숫자·밑줄·하이픈 + `.html` 형식만 허용하며 Caddy가 `X-Robots-Tag: noindex, nofollow`를 붙인다. 더 넓은 `/naver*` matcher나 임의 파일명을 허용하지 말고, 파일 변경 시 새 public manifest와 pointer로 게시한다.

## FileVault와 전원

FileVault has a pre-login limit: after a cold boot, the user must unlock the volume before user LaunchAgents and Keychain-backed services can run. `autorestart` cannot bypass that user unlock. 원격 무인 복구 계획에 이 제한을 반영한다.

- UPS와 wired Ethernet을 권장하고 실제 정전 시 graceful shutdown과 복귀를 시험한다.
- power 설정은 스크립트가 자동 변경하지 않는다. 먼저 `pmset -g custom`으로 inspect하고 결과를 저장한다.
- 전원 연결 시 system sleep 비활성, 정전 후 재시작, 지원되는 Wake-on-LAN을 검토할 수 있다. 예: `sudo pmset -c sleep 0 autorestart 1 womp 1`.
- 모든 `pmset` 변경은 기존 값을 기록한 뒤 한 항목씩 적용·검증하며 reversible하게 원래 값으로 되돌릴 수 있어야 한다.

## 로그와 감시

- Caddy access log는 비활성 상태를 유지한다. 애플리케이션 로그는 allowlist된 이벤트만 기록하고 PII, capability token, request body, secret을 기록하지 않는다.
- `newsyslog/wisdom-portal.conf.template`를 운영 사용자/`staff`, glob `G`, 압축 `J`, 불필요한 syslogd signal 방지 `N`으로 렌더링하여 파일당 10 MiB, 10개로 제한한다. 강제 rotation 시험 뒤 launchd 프로세스가 새 파일 descriptor에 계속 쓰는지 확인하고, 그렇지 않으면 maintenance `kickstart -k`로 writer를 재시작한다. 회전본 소유권/권한과 실제 크기 상한을 감시한다.
- 외부 감시는 Mac/LAN 밖에서 공개 live URL과 예상 본문을 확인한다. backup freshness, disk, tunnel/service, notification failure backlog는 사설 점검으로 분리한다.
