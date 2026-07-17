# 관리자 자동 백업 제어 및 Mac mini 설치 가이드 설계

작성일: 2026-07-17

상태: 사용자 설계 승인 후 명세 검토 대기

대상 저장소: `wisdom-web-portal`

## 1. 목적

이 변경은 두 가지 결과물을 함께 완성한다.

1. 관리자가 웹 관리자 화면에서 **정기 자동 백업만** 활성화하거나 비활성화할 수 있게 한다.
2. 기존 Gemma/Hermes를 실행하는 Mac mini 로그인 계정을 기준으로, 현재 구현을 실제 장비에 설치하고 검증하는 상세 운영 가이드를 작성한다.

가이드는 명령어만 나열하지 않는다. 설치 전에 사용자가 발급받아야 할 계정과 값, 운영자가 결정할 값, Mac에서 생성할 비밀, 검증 방법과 분실 대응을 구분해 제공한다.

## 2. 확정된 사용자 요구

- 백업 OFF는 자동 예약 백업만 중단한다.
- 터미널에서 실행하는 수동 백업과 기존 백업 복원은 OFF 상태에서도 허용한다.
- OFF는 기존 `.age`/`.json` 백업 쌍을 삭제하지 않는다.
- 이미 시작된 백업은 강제 종료하지 않고 완료할 수 있다.
- 다시 ON으로 전환하면 Mac이 깨어 있고 해당 로그인 세션과 LaunchAgent가 정상인 조건에서 60초 이내에 자동 백업 한 번을 시작한다.
- 이후 실제 백업 생성 주기는 기존과 같이 시간당 한 번이다.
- 관리자 화면에서 상태, 변경자, 변경 시각, 마지막 실행 결과와 마지막 검증 성공 시각을 확인할 수 있어야 한다.
- Mac mini 배포는 현재 Gemma/Hermes를 실행하는 로그인 계정을 그대로 사용한다.
- 설치 가이드는 외부 계정·발급값·결정값·로컬 생성 비밀을 빠짐없이 정리해야 한다.

## 3. 고려한 제어 방식

### 3.1 DB 설정과 경량 dispatcher — 채택

SQLite의 singleton 설정 행을 정책의 진실 원천으로 사용한다. 관리자 변경과 감사 이벤트를 한 트랜잭션으로 저장한다. `launchd` 작업은 항상 로드된 상태를 유지하며, 비밀을 읽기 전에 dispatcher가 정책과 실행 시점을 확인한다.

장점:

- 관리자 화면, 실행 정책, 감사 이벤트가 일관된다.
- optimistic concurrency를 적용할 수 있다.
- 웹 애플리케이션이 `launchctl bootout/bootstrap` 권한을 가질 필요가 없다.
- OFF 상태에서 Keychain의 `age` identity를 불필요하게 읽지 않는다.

### 3.2 보호된 JSON 파일을 정책 원천으로 사용 — 미채택

DB 복원과 분리되는 장점이 있지만 파일 갱신과 DB 감사 이벤트를 원자적으로 커밋할 수 없다. 파일과 관리자 화면이 어긋났을 때 별도 reconciliation이 필요하다.

### 3.3 관리자 요청에서 `launchctl` 직접 제어 — 미채택

실행 중 작업 중단, 웹 프로세스 권한 확대, 재부팅·plist 재설치 후 상태 drift, macOS 전용 테스트 부담 때문에 사용하지 않는다.

## 4. 데이터 모델

현재 스키마 v6 다음에 rollback 비호환 v7 migration을 추가한다.

```sql
CREATE TABLE backup_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  automatic_enabled INTEGER NOT NULL CHECK (automatic_enabled IN (0, 1)),
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  updated_by_admin_id TEXT REFERENCES admins(id)
);

INSERT INTO backup_settings (
  singleton,
  automatic_enabled,
  row_version,
  updated_at_ms,
  updated_by_admin_id
) VALUES (1, 1, 1, 0, NULL);
```

정책 기본값은 ON이다. 설정 행 누락, 값 손상, DB 조회 오류는 조용히 ON 또는 OFF로 추정하지 않고 `BACKUP_CONTROL_INVALID`로 실패시켜 운영 경보를 만든다.

마지막 실행 상태는 정책과 분리된 owner-only 관측 파일에 기록한다.

```text
DATA_ROOT/backup-run-state.json
```

허용 필드 예시:

```json
{
  "formatVersion": 1,
  "runId": "UUID",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "outcome": "verified",
  "controlRevision": 4,
  "lastVerifiedAt": "ISO-8601",
  "lastVerifiedArtifact": "hourly-YYYYMMDDTHHMMSSZ.age",
  "errorCode": null
}
```

허용 outcome은 `running`, `verified`, `not-due`, `admin-disabled`, `failed`로 제한한다. `not-due`나 `admin-disabled`를 기록할 때는 이전에 검증된 `lastVerifiedAt`과 basename만 안전하게 이어받는다. `errorCode`는 고정된 allowlist 값 또는 `null`만 허용한다. 파일은 4 KiB 이하, mode `0600`, 실제 파일·실제 상위 디렉터리만 허용하며 임시 sibling과 atomic rename으로 교체한다. 오류 메시지, 절대경로, Keychain 값, 상담정보는 넣지 않는다. 이 파일은 관측용이며 백업 무결성 증거로 사용하지 않는다. 백업 무결성의 진실 원천은 기존 verified `.age`/`.json` 쌍이다.

## 5. 관리자 화면과 보안

관리자 내비게이션에 `Backups`를 추가하고 다음 경로를 제공한다.

- `GET /admin/backups`
- `POST /admin/backups`

기존 관리자 보안 계약을 그대로 적용한다.

- 비밀번호와 TOTP 또는 복구코드를 통과한 관리자 세션
- 정확한 `ADMIN_ORIGIN`
- CSRF 토큰
- POST 전용 상태 변경
- `rowVersion` optimistic concurrency
- 입력 길이와 허용값 고정

화면에는 다음만 표시한다.

- 자동 백업 ON/OFF
- 마지막 정책 변경자와 변경 시각
- 마지막 자동 실행 결과
- 마지막 verified backup 시각과 경과 시간
- OFF 상태의 명확한 위험 경고
- 기존 백업이 삭제되지 않는다는 안내
- 수동 백업·복원은 계속 가능하다는 안내
- 진행 중인 백업 한 건은 완료될 수 있다는 안내
- OFF 동안 RPO 60분 목표가 적용되지 않는다는 안내

`age` 개인키, PII 키, Keychain 값, 전체 경로, 상담정보는 표시하지 않는다.

OFF 요청에는 정확한 확인 체크박스 또는 고정 확인 문자열을 요구한다. ON 요청은 별도 위험 확인 없이 허용한다. 오래 열린 화면에서 이전 `rowVersion`으로 제출하면 `409 Conflict`를 반환하고 새로고침을 요구한다.

설정 변경과 감사 이벤트는 하나의 `BEGIN IMMEDIATE` 트랜잭션으로 처리한다. 감사 이벤트 예시는 다음과 같다.

- `automatic_backup.disabled`
- `automatic_backup.enabled`

감사 metadata에는 이전/새 상태와 row version만 저장한다. 감사 이벤트 기록이 실패하면 설정 변경도 롤백한다.

## 6. 자동 실행 흐름

백업 LaunchAgent는 계속 로드한다. 실행 주기는 경량 dispatcher 기준 60초로 변경하되 실제 암호화 백업은 다음 조건 중 하나일 때만 수행한다.

- verified hourly backup이 없다.
- 마지막 verified hourly backup 후 60분 이상 지났다.
- 설정이 OFF에서 ON으로 바뀐 시각 이후 verified backup이 없다.

dispatcher 흐름:

1. DB의 `backup_settings`를 읽는다.
2. OFF이면 Keychain에 접근하지 않고 `admin-disabled` 상태를 기록한 뒤 exit 0 한다.
3. ON이지만 아직 실행 시점이 아니면 `not-due`로 exit 0 한다.
4. 실행 시점이면 기존 고정 인자로 `keychain-exec.mjs`를 호출한다.
5. `backup.mjs --automatic`이 maintenance lock을 획득한다.
6. lock 안에서 정책을 다시 읽는다.
7. 여전히 ON이면 기존 온라인 SQLite snapshot, age 암호화, 즉시 복호화 검증, status 게시, retention을 수행한다.
8. 결과를 관측 파일에 원자적으로 기록한다.

1차 확인과 2차 확인 사이 OFF로 바뀌면 snapshot을 시작하지 않는다. 2차 확인을 통과한 뒤 OFF로 바뀌면 현재 백업은 끝까지 완료한다. 이 계약을 관리자 경고문과 가이드에 기록한다.

수동 백업 명령은 `--automatic`을 사용하지 않으며 관리자 OFF를 우회해 정상 실행한다. 수동 백업도 기존 Keychain wrapper와 정확한 고정 인자를 사용해야 한다.

## 7. 모니터링과 알림

모니터는 백업 설정을 읽어 다음을 구분한다.

- ON + 최신 verified backup: 정상
- ON 전환 후 첫 백업 대기: 최대 10분의 resume grace
- ON + 90분 이상 verified backup 없음: `BACKUP_VERIFIED_PAIR_STALE`
- OFF: `BACKUP_ADMIN_DISABLED`
- 설정 손상·조회 실패: `BACKUP_CONTROL_INVALID`

OFF는 healthy로 위장하지 않는다. 다음 monitor 실행에서 Hermes/Telegram 운영 경고를 한 번 전송한다. 실패 fingerprint가 `BACKUP_ADMIN_DISABLED`만 포함하고 변하지 않는 동안에는 시간 경과만으로 동일 경고를 다시 전송하지 않는다. 새로운 실제 장애가 추가되어 fingerprint가 바뀌면 즉시 알린다. ON 전환 후 10분 이내에는 첫 실행을 기다리고, 그 안에 verified backup이 없으면 정상적인 백업 실패로 경고한다. 첫 성공이 확인되면 OFF incident 상태를 정리한다.

OFF 상태에서도 디스크, control readiness, launchd 서비스, notification/content/indexing backlog, retention overdue 검사는 계속한다.

## 8. 복원과 정책 보존

복원은 백업 당시의 ON/OFF 상태를 무조건 되살리지 않는다. 현재 운영자의 선택을 정책으로 간주한다.

- 현재 target DB에서 유효한 설정을 읽을 수 있으면 staged DB에 그 상태를 주입한다.
- 주입 사실을 system audit로 남긴다.
- 현재 DB가 없거나 손상되어 상태를 읽을 수 없으면 apply 복원에 `--automatic-backup-after-restore enabled|disabled`를 명시하도록 요구한다.
- dry-run은 사용할 상태와 추가 입력 필요 여부를 출력한다.
- 복원 실패와 rollback은 기존 안전 계약을 유지한다.

복원 후 ON이면 자동 dispatcher가 60초 이내 새 verified backup을 생성하도록 시도한다. OFF이면 기존 백업 파일을 변경하지 않는다.

## 9. age와 전체 복구 경계

`age`는 파일 암호화 도구이며 다음 키 쌍을 사용한다.

- `age1...`: 공개 recipient. 백업 암호화에 사용한다.
- `AGE-SECRET-KEY-1...`: 비공개 identity. 백업 복호화에 사용한다.

identity는 macOS Keychain에만 저장하고 관리자 화면, 환경파일, 명령 인자, Git, 로그에 기록하지 않는다. 그러나 age identity만으로 전체 업무 복구가 완료되지는 않는다.

상담 PII는 DB 내부에서 별도 `PII_ENCRYPTION_KEY`로 암호화된다. 전체 복구에는 최소 다음이 필요하다.

1. 암호화된 `.age`와 verified `.json` 쌍
2. age identity
3. `PII_ENCRYPTION_KEY`
4. 소스 코드와 non-secret 운영 설정
5. 기능 연속성이 필요하면 session/control/withdrawal/Hermes/monitor/SMTP/Codex/IndexNow 관련 비밀

현재 로컬 backup root는 같은 Mac SSD에 있으므로 SSD 고장·분실 보호가 아니다. 가이드는 암호화된 artifact의 외장 또는 offsite 복제 필요성을 명시하고, 자동 offsite 복제가 아직 구현되지 않았음을 숨기지 않는다. 전체 Keychain 비밀의 오프라인 recovery bundle도 현재 구현되지 않았으므로 공개 전 운영 차단 항목으로 표시한다.

## 10. Mac mini 설치 가이드 결과물

신규 문서:

```text
docs/operations/mac-mini-setup.md
```

가이드는 기존 Gemma/Hermes 로그인 계정을 사용한다. 실제 계정명을 하드코딩하지 않고 다음을 계산한다.

```sh
export PORTAL_USER="$(id -un)"
export PORTAL_UID="$(id -u)"
```

현재 Keychain account 검증은 ASCII `[A-Za-z0-9._-]`만 허용하므로 실제 short username이 이 형식이 아니면 설치를 중단시키고 별도 Keychain account 값을 결정하도록 안내한다.

가이드의 각 절차는 다음 네 요소를 포함한다.

1. 실행 명령
2. 기대 결과
3. 실패 시 중단 조건
4. 비밀 노출 금지 또는 rollback 주의사항

## 11. 사전 발급·결정·생성 값 인벤토리

가이드 맨 앞에 아래 열을 가진 준비표를 제공한다.

| 열 | 의미 |
|---|---|
| 필수 여부 | 필수, 조건부 필수, 선택 |
| 구분 | 외부 발급, 운영자 결정, Mac 로컬 생성 |
| 항목 | 계정 또는 값 이름 |
| 발급처/생성 위치 | 공식 서비스 또는 Mac 명령 |
| 허용 형식 | hostname, URL, token, Keychain ref 등 |
| 민감도 | 공개, 내부, 비밀, 복구 전용 |
| 저장 위치 | runtime.env, Keychain, Cloudflare credential file, 오프라인 보관 등 |
| 검증 | 명령 또는 관리 콘솔 확인 방법 |
| 갱신/분실 영향 | 회전 가능 여부와 분실 시 영향 |

### 11.1 장비·macOS

- 현재 Gemma/Hermes 로그인 macOS short username
- UID와 HOME
- Apple Silicon arm64 여부
- FileVault 활성화 상태
- FileVault 복구 수단과 현장 cold-boot 대응자
- 원격접속 방식과 재부팅 후 현장 로그인 가능 여부
- 안정적인 유선 네트워크와 전원/UPS 여부

Apple ID나 FileVault recovery key의 실제 값은 문서나 저장소에 쓰지 않는다.

### 11.2 도메인·DNS·Cloudflare

- 도메인 등록기관 계정
- 실제 apex domain
- canonical public host, 기본 권장 `www.<domain>`
- 분리된 admin host, 기본 권장 `admin.<domain>`
- Cloudflare 계정과 zone 소유권
- Cloudflare Tunnel ID
- owner-only Tunnel credential JSON 파일 경로
- apex/public/admin hostname의 Tunnel DNS 연결
- 최종 fallback 404 ingress 확인

Cloudflare API token은 CLI 자동화가 실제로 필요할 때만 조건부로 요구한다. token을 사용할 경우 최소 권한과 Keychain 또는 owner-only secret storage를 명시한다. 공유기 inbound port forwarding은 요구하지 않는다.

### 11.3 Google·Naver·IndexNow

- Google 계정
- Search Console Domain Property
- Google DNS TXT verification 값
- Naver 계정
- Naver Search Advisor site 등록
- Naver meta token 또는 verification filename 중 정확히 하나
- Mac에서 생성하는 IndexNow key
- IndexNow Keychain service name과 public key URL

검증 token은 공개 방식과 비밀 방식을 구분한다. Google DNS TXT는 빌드 검증에 필요한 동안만 임시 환경값으로 제공할 수 있지만 HTML, sitemap, RSS, 로그, persistent runtime 설정, Git에는 출력하지 않는다.

### 11.4 외부 링크와 채널

- 공식 Naver Blog URL
- 공식 Naver Map URL
- Kakao Channel 또는 Kakao 상담의 최종 HTTPS URL
- 전화, 팩스, 대표 이메일, 주소
- 언어별 CTA 문구 승인

Kakao는 단순 바로가기 URL만 사용하는 경우 개발자 API key가 필요하지 않음을 구분한다. 향후 API 연동을 추가할 때만 별도 Kakao Developers 계정을 요구한다.

### 11.5 SMTP·Hermes·Telegram

- SMTP 제공자 계정
- SMTP host
- port 465와 implicit TLS 지원 여부
- SMTP username/password 또는 app password
- `From` 주소
- 상담 접수 수신자 `To` 주소
- SMTP credential Keychain service name
- 기존 Hermes endpoint와 실제 포트
- Portal/Hermes 일반 HMAC 공유 방식
- Portal/Hermes monitor HMAC 공유 방식
- Hermes가 사용하는 Telegram Bot 계정/token/chat ID 또는 대상 채널

Portal은 Telegram bot token이나 chat ID를 직접 저장하지 않고 Hermes가 이를 보유한다는 경계를 명확히 쓴다. Portal에는 loopback Hermes endpoint와 두 개의 독립 HMAC만 필요하다.

### 11.6 Codex 번역·콘텐츠 작업

- Codex CLI 설치 경로
- 인증 방식
- API credential이 필요한 경우 Keychain service name
- 사용할 model identifier
- 전용 `CODEX_HOME`과 temp root
- 요청 timeout
- 번역과 검수 작업 시 기존 Gemma 자원 경합을 피할 운영 시간대

API key 또는 로그인 credential은 runtime.env나 Git에 쓰지 않는다. 가이드는 저장소가 현재 로컬 Gemma를 직접 호출하지 않고 Codex 작업 경로를 사용한다는 사실도 명시한다.

### 11.7 관리자·법적 콘텐츠

- 최초 owner username
- 강한 owner password
- TOTP 등록 장치
- 일회성 recovery codes의 오프라인 보관 위치
- 한국어·영어·중국어 간체·중국어 번체 개인정보 동의문
- 같은 4개 언어의 선택 마케팅 동의문
- 문서 version, effective time, 승인자
- 개인정보 12개월·마케팅 24개월 보존 계약 확인

password, TOTP secret, recovery code는 가이드 예시나 Git에 쓰지 않는다.

### 11.8 Mac에서 생성하는 운영 비밀

- admin session secret
- control HMAC
- Hermes HMAC
- monitor 전용 Hermes HMAC
- PII encryption key와 active key ID
- withdrawal token secret
- age identity와 public recipient
- IndexNow key
- SMTP credential reference
- Codex credential reference

각 비밀에 대해 생성 명령, Keychain service name, 사용하는 프로세스, 회전 가능 여부, 분실 영향, 복구 시험을 표로 제공한다. 특히 PII/control/withdrawal 키는 migration 없이 무심코 회전하지 않도록 경고한다.

### 11.9 소스 전달·외부 모니터링

- private Git remote 계정/credential 또는 `git bundle` 전달 방식
- 배포할 commit SHA
- Mac/LAN 밖 external uptime 서비스 계정
- 외부 `/health/live` 확인 URL
- 장애 알림 수신자

Windows의 `node_modules`는 전달하지 않고 Mac에서 다시 `npm ci` 한다.

### 11.10 별도 계정이나 설정이 필요하지 않은 항목

혼동을 막기 위해 다음도 준비표에 명시한다.

- Caddy 자체 계정: 불필요
- `age` 서비스 계정: 불필요하며 키는 Mac에서 생성
- 수동 TLS 인증서 구매·설치: Cloudflare가 외부 TLS를 종료하는 현재 구조에서는 불필요
- 공유기 inbound port forwarding: 불필요하며 설정하지 않음
- Docker 계정과 Docker 설치: 사용하지 않음
- WordPress 계정: 사용하지 않음
- Kakao Developers API key: 단순 상담 바로가기 URL만 사용할 때는 불필요
- Penpot 계정: 디자인 검토용일 뿐 운영 배포에는 불필요

## 12. 설치 가이드 목차

1. 범위, 현재 구현 상태, 공개 차단 항목
2. 전체 시스템 구조
3. 사전 발급·결정·생성 값 인벤토리
4. age·PII·FileVault 암호화 계층
5. 기존 로그인 계정과 표준 경로
6. Gemma/Hermes 포트·자원 공존 점검
7. macOS, FileVault, 전원, 원격 복구 사전 점검
8. Node 24, npm, Git, Caddy, cloudflared, age 1.3.1, Codex CLI 설치
9. Windows에서 Mac으로 소스 전달
10. 디렉터리와 권한 생성
11. Cloudflare Tunnel과 DNS 준비
12. 운영 템플릿 렌더링
13. Keychain 비밀과 recovery 준비
14. 로컬 bootstrap public release
15. launchd 설치와 첫 application release
16. 관리자 owner와 MFA
17. 4개 언어 개인정보·마케팅 동의문
18. 첫 정상 public release
19. Caddy와 Tunnel 외부 공개
20. Hermes, Telegram, SMTP
21. Kakao, Blog, Map
22. Google, Naver, IndexNow
23. 관리자 자동 백업 ON/OFF
24. 최초 backup과 별도 target restore drill
25. 외부 uptime과 운영 모니터링
26. FileVault cold boot·정전·재부팅 시험
27. 이후 deploy, rollback, incident 대응
28. 최종 인수 체크리스트

## 13. 가이드가 숨기지 않을 현재 운영 공백

현재 저장소를 그대로 사용해 공개까지 완전히 재현 가능하다고 주장하지 않는다. 최소 다음 공백을 명시한다.

1. 운영용 template 일괄 render/install CLI가 없다.
2. Tunnel을 끈 bootstrap 상태에서 Secure-cookie 관리자 화면으로 첫 정상 public release를 만드는 문서화된 HTTPS 경로가 없다.
3. `PUBLIC_KAKAO_CHAT_URL`이 publication build 격리 환경까지 전달되지 않는다.
4. 생성된 Hermes/monitor HMAC을 기존 Hermes에 안전하게 provisioning하는 완성된 절차가 없다.
5. tunnel-off bootstrap에서 public Host를 포함해 health를 검사하는 경로가 불명확하다.
6. 전체 운영 비밀의 오프라인 recovery bundle이 없다.
7. 암호화된 백업 artifact의 자동 offsite 복제가 없다.

가이드에서는 각 항목을 `공개 전 구현 필요`, `운영자가 입력 필요`, `현재 수동 검증 가능` 중 하나로 표시한다. 미구현 기능을 존재하는 명령처럼 작성하지 않는다.

## 14. 예상 수정 지점

- `apps/control/src/admin/routes.ts`
- 신규 `apps/control/src/backups/settings.ts`
- `apps/control/src/db/client.ts`
- `apps/control/src/db/schema.ts`
- `apps/control/src/config.ts`
- `apps/control/src/server.ts`
- 신규 `ops/scripts/backup-dispatcher.mjs`
- `ops/scripts/backup.mjs`
- `ops/scripts/restore.mjs`
- `ops/lib/backup.mjs`
- `ops/lib/restore.mjs`
- `ops/lib/system-adapters.mjs`
- `ops/lib/monitoring.mjs`
- `ops/scripts/monitor-db-check.mjs`
- `ops/launchd/com.jihye.portal.backup.plist.template`
- `ops/config/runtime.env.template`
- `ops/monitoring/checks.json.template`
- 관련 control/ops 테스트
- `ops/runbooks/deployment.md`
- `ops/runbooks/recovery.md`
- 신규 `docs/operations/mac-mini-setup.md`
- `docs/00-document-map.md`

실제 구현 중 의존성 경계를 더 작게 유지할 수 있으면 파일 수를 줄인다. 앱 코드에서 ops 내부 모듈을 임의 상대경로로 import하지 않고 명시적 adapter 또는 작은 공용 계약을 사용한다.

## 15. 필수 테스트

### 관리자·DB

- 신규 설치와 v6→v7 migration의 기본값 ON
- 인증·Origin·CSRF 없는 접근 거부
- 잘못된 상태·확인문구·row version 거부
- 설정 변경과 audit event 원자적 commit/rollback
- stale row version 409
- 관리자 응답과 로그에 비밀·경로·PII 없음

### dispatcher·backup

- OFF이면 Keychain, checkpoint, online snapshot, age, retention을 호출하지 않음
- OFF에서도 수동 backup 정상 실행
- ON이지만 not due이면 비밀을 읽지 않음
- Mac이 깨어 있고 LaunchAgent가 정상인 조건에서 재활성화 후 60초 이내 한 번 실행
- 이후 60분 전 중복 artifact 없음
- 1차 확인 뒤 OFF이면 2차 확인에서 skip
- 2차 확인 뒤 OFF이면 진행 중 backup 완료
- 상태 파일 권한, 크기, symlink, atomic replace 방어
- 기존 backup pair가 OFF 중 변경되지 않음

### monitor·restore

- disabled와 stale 구분
- OFF 전환 경고 1회와 동일 fingerprint 반복 억제
- OFF 중 다른 장애는 즉시 경고
- ON 전환 후 성공 시 incident 정리
- ON 전환 후 10분 grace 경계와 grace 만료 실패 경고
- restore가 현재 mode를 보존
- 현재 mode를 읽을 수 없으면 apply에 명시적 상태 요구
- readiness rollback과 기존 복구 안전 계약 유지

### 문서

- 모든 명령이 실제 CLI 옵션과 일치
- 모든 template token과 runtime key가 코드와 일치
- 필수 계정/값 표에 발급처·형식·민감도·저장·검증·분실 영향 존재
- 실제 비밀값, placeholder로 오인될 수 있는 작동 token, 사용자 PII 없음
- Mac 경로의 공백을 안전하게 quote
- `age 1.3.1`, Node 24, SQLite 최소 버전 등 preflight 계약과 일치
- 미구현 운영 공백을 실제 기능처럼 안내하지 않음

## 16. 완료 기준

- 관리자가 `/admin/backups`에서 자동 백업을 안전하게 ON/OFF 할 수 있다.
- OFF가 수동 백업·복원을 막지 않는다.
- ON 전환 후 자동 백업이 60초 이내 시작되고 verified pair가 생성된다.
- 설정 변경, 실행 상태, 모니터링, 복원이 서로 모순되지 않는다.
- focused test와 전체 `npm run verify`가 통과한다.
- `docs/operations/mac-mini-setup.md`만 보고 운영자가 필요한 외부 계정·발급값·결정값·로컬 비밀을 준비할 수 있다.
- 가이드는 실제 Mac 설치의 중단 조건과 아직 해결되지 않은 공개 차단 항목을 명확히 구분한다.

## 17. 범위 밖

이번 변경에서 자동 offsite backup provider, 전체 Keychain recovery bundle, Cloudflare 계정 자동 생성, 도메인 구매, 외부 서비스 계정 생성, Kakao API 연동 자체를 구현하지 않는다. 필요한 값과 안전한 준비 절차는 가이드에 기록하되, 외부 계정의 실제 생성·결제·소유권 확인은 운영자가 수행한다.
