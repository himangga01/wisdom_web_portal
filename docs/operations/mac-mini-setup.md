# Mac mini M4 설치·운영·복구 가이드

이 문서는 기존 Gemma 4와 Hermes가 동작하는 **같은 Mac mini M4(16 GB)의 로그인 계정**에 지혜 웹 포털을 Docker 없이 설치하기 위한 운영자 진입점이다. 저장소의 실행 코드와 테스트가 동작 계약의 기준이며, 긴급 대응은 [배포 런북](../../ops/runbooks/deployment.md), [복구 런북](../../ops/runbooks/recovery.md), [장애 런북](../../ops/runbooks/incidents.md)을 함께 따른다.

현재 저장소에는 프로덕션 후보 코드가 있지만 아래 8개 공개 차단 항목 중 미해결 항목이 있다. 따라서 이 문서는 로컬 검증과 준비 절차를 제공할 뿐, 미구현 절차를 완료된 설치기로 가장하지 않는다. 외부 계정 생성·결제·소유권 확인은 운영자가 각 공식 서비스에서 직접 수행한다.

## 1. 사전 발급·결정·생성 값 인벤토리

실제 비밀값은 이 표에 쓰지 않는다. `값 형식·예`에는 공개 값 또는 **형식**만 적는다. 각 행의 분실 영향과 오류 영향을 확인한 뒤 준비 완료로 표시한다.

| 필수 여부 | 구분 | 항목 | 발급처/생성 위치 | 값 형식·예 | 민감도 | 저장 위치 | 검증 방법 | 갱신·분실 영향 |
|---|---|---|---|---|---|---|---|---|
| 필수 | Mac 로컬 생성 | macOS 로그인 short username | 기존 Gemma/Hermes 로그인 세션의 `id -un` | 제한 ASCII 1~128자 | 내부·운영자 결정 | macOS 계정, `PORTAL_USER` | `id -un`; Keychain account 정규식 검사 | 형식 오류면 모든 Keychain wrapper 중단 |
| 필수 | Mac 로컬 생성 | UID와 HOME | `id -u`, macOS 계정 | 숫자 UID, 절대 HOME | 내부 | `PORTAL_UID`, `$HOME` | `id -u`; `dscl . -read /Users/"$PORTAL_USER" NFSHomeDirectory` | 잘못된 LaunchAgent domain·경로 사용 |
| 필수 | 운영자 결정 | 원격접속 방식 | 기존 Mac 운영자 | 승인된 원격관리 경로·MFA | 비밀 계정·내부 | 원격관리 계정/운영 기록 | LAN 밖 접속과 재부팅 전후 시험 | 침해 또는 장애 시 원격 진단 불가; FileVault pre-login은 별도 |
| 필수 | 운영자 결정 | FileVault unlock 담당자와 복구 수단 | macOS 설정과 기관 복구 정책 | 현장 담당자·봉인된 복구 위치 | 복구 전용 비밀 | Mac 밖의 승인된 오프라인 보관 | cold boot 후 수동 unlock 시험 | 로그인 전 볼륨·Keychain·LaunchAgent 접근 불가 |
| 필수 | 운영자 결정 | cold-boot 현장 접근 계획 | 사무소 운영 책임자 | 담당자, 연락망, 목표 도착시간 | 내부 | 운영 연락망 | 전원 완전 종료 후 현장 로그인 훈련 | 원격만으로 FileVault pre-login 통과 불가 |
| 필수 | 운영자 결정 | 유선 LAN | 라우터·스위치 운영자 | 고정된 Ethernet 연결 | 내부 | 네트워크 운영표 | 케이블 분리/복구와 외부 health 시험 | Tunnel과 모든 외부 접속 중단 |
| 필수 | 운영자 결정 | UPS와 전원 설정 | UPS 운영자, macOS `pmset` | 장비 식별, 기존/승인 설정 | 내부 | 자산대장·운영 기록 | UPS self-test, `pmset -g custom` | 정전 중 데이터 손상·장시간 중단 위험 |
| 필수 | 외부 발급 | 도메인 등록기관 계정 | 선택한 registrar | 계정과 MFA | 비밀 | 공급자 vault·MFA 장치 | registrar console 로그인 | 도메인 갱신·소유권 복구 불가 |
| 필수 | 운영자 결정 | apex·public·admin host | 도메인/DNS 운영자 | apex, `www.` host, 분리된 `admin.` host | 공개 | DNS, 보호된 non-secret 설정 | DNS 조회와 외부 HTTPS 요청 | canonical·로그인·검색 소유권 불일치 |
| 필수 | 외부 발급 | Cloudflare 계정과 zone | Cloudflare | zone 소유 계정·MFA | 비밀 | Cloudflare 계정 | dashboard에서 zone 소유권 확인 | DNS·Tunnel 운영 불가 |
| 필수 | 외부 발급 | Cloudflare Tunnel ID | Cloudflare Tunnel | UUID | 내부 | cloudflared 설정 | dashboard와 설정의 ID 대조 | Tunnel 시작 또는 라우팅 실패 |
| 필수 | 외부 발급 | Cloudflare Tunnel credential | Cloudflare | owner-only JSON 파일 | 비밀 | `~/.cloudflared/`의 `0600` 실제 파일 | 내용 출력 없이 파일 유형·권한 확인 | Tunnel 인증 불가; 유출 시 즉시 폐기·재발급 |
| 필수 | 운영자 결정 | Tunnel DNS·ingress | Cloudflare DNS | apex/public/admin 연결, 마지막 404 | 공개·내부 | Cloudflare zone과 cloudflared 설정 | 세 host 외부 응답과 unknown-host 404 | 잘못된 host 노출·공개 실패 |
| 조건부 필수 | 외부 발급 | 조건부 Cloudflare API token | Cloudflare | 최소 zone 권한 token | 비밀·조건부 | 승인된 비밀 저장소 | 권한 범위와 만료 확인 | 자동화만 실패; 현재 수동 console 운영에는 불필요 |
| 필수 | 외부 발급 | Google 계정 | Google | Search Console 소유 계정·MFA | 비밀 | Google 계정 | 로그인·복구 연락처 확인 | 소유권·색인 진단 불가 |
| 필수 | 외부 발급 | Google Search Console Domain Property | Google Search Console | apex domain property | 공개·내부 | Search Console | property 상태 확인 | 전체 subdomain 소유권 진단 불가 |
| 필수 | 외부 발급 | Google DNS TXT verification | Google Search Console | DNS TXT 문자열 | 공개 검증값 | DNS zone; Git·runtime에는 두지 않음 | Search Console의 Verify | 소유권 확인 실패 |
| 필수 | 외부 발급 | Naver 계정 | Naver | Naver Search Advisor 운영 계정 | 비밀 | Naver 계정·MFA | 로그인·복구 수단 확인 | Naver 수집·색인 진단 불가 |
| 필수 | 운영자 결정 | Naver Search Advisor site와 검증 방식 | Naver Search Advisor | public origin + HTML 파일 **또는** meta 중 정확히 하나 | 공개 검증값 | 검증된 public release 또는 빌드 시 일시 입력 | Search Advisor 소유권 확인 | 두 방식 동시 설정 또는 형식 오류면 빌드·검증 실패 |
| 필수 | Mac 로컬 생성 | IndexNow ownership key | Mac의 암호학적 난수 + `secret-import.mjs` | 영문·숫자·하이픈 8~128자 | 게시 전 내부, 게시 후 공개 | Keychain service `com.jihye.portal.indexnow` | `/indexnow-key.txt`와 제출 결과 | 갱신 통지만 실패; 색인 자체를 보장하지 않음 |
| 필수 | 운영자 결정 | 공식 Naver Blog URL | 지혜행정사사무소 | `https://m.blog.naver.com/wisdom_jhk` | 공개 | 승인된 콘텐츠 설정 | 외부 브라우저 200/redirect 확인 | 잘못된 브랜드 채널로 이탈 |
| 필수 | 운영자 결정 | 공식 Naver Map URL | 지혜행정사사무소 | `https://naver.me/GprFCirq` | 공개 | 승인된 콘텐츠 설정 | 모바일·데스크톱 열기 | 잘못된 사무소 위치 안내 |
| 필수 | 운영자 결정 | Kakao 상담 URL | 공식 Kakao 채널/상담 | 최종 HTTPS URL | 공개 | 승인된 콘텐츠 설정 | 로그인/비로그인·앱 유무 시험 | CTA 실패; 현재 publication allowlist 차단 항목도 확인 |
| 필수 | 운영자 결정 | 사무소 공개 연락처 | 사무소 승인 | 전화·팩스·메일·주소 | 공개 | 4개 언어 콘텐츠 | 실제 발신·수신·지도 대조 | 고객 오접수·표시 오류 |
| 필수 | 운영자 결정 | 4개 언어 CTA 문구 | 대표행정사 승인 | `ko`, `en`, `zh-Hans`, `zh-Hant` | 공개 | 승인된 콘텐츠 | 언어별 사람 검수 | 오역·과장 표현 위험 |
| 필수 | 외부 발급 | SMTP 계정 | 메일 제공자 | 계정·MFA | 비밀 | 제공자 계정 | 로그인과 app password 관리 확인 | 메일 알림 발송 불가 |
| 필수 | 외부 발급 | SMTP host·port·TLS | 메일 제공자 | 공개 FQDN, **465**, implicit TLS | 공개·내부 | 관리자 알림 설정 | 테스트 알림과 TLS 연결 | 다른 port/TLS mode는 설정 거부 |
| 필수 | 운영자 결정 | SMTP From·To | 사무소 | 승인된 발신/상담 수신 mailbox | 공개·내부 | 관리자 알림 설정 | 실제 receipt 수신 | 발신 정책 실패·상담 메일 누락 |
| 필수 | 외부 발급 | SMTP app password | 메일 제공자 | `smtp-json` 한 줄 입력에 포함되는 credential | 비밀 | 별도 Keychain service; DB에는 `keychain:` 참조만 | 값 출력 없이 Keychain item 존재와 테스트 알림 | 이메일 channel 실패; 유출 시 공급자에서 폐기 |
| 필수 | 운영자 결정 | 이메일 본문 모드 | 개인정보 운영 책임자 | 기본 `receipt-only`; 승인 시 `full-inquiry` | 내부 | 관리자 `/admin/notifications` | 테스트 메일의 본문 범위 확인 | 과도한 PII 이메일 전송 위험 |
| 필수 | 운영자 결정 | Hermes endpoint·port | 기존 Hermes 운영자 | literal loopback, 기본 `127.0.0.1:8788` | 내부 | `runtime.env`, monitoring JSON | loopback process/port 확인 | Telegram handoff·monitor 경고 실패 |
| 필수 | Mac 로컬 생성 | Portal/Hermes 일반 HMAC | `secret-bootstrap.mjs` | service `com.jihye.portal.hermes-hmac` | 비밀 | Portal Keychain + Hermes의 독립 secret store | 원문 출력 없이 end-to-end 테스트 | 상담 알림 인증 실패; provisioning 절차는 현재 차단 항목 |
| 필수 | Mac 로컬 생성 | Portal/Hermes monitor HMAC | `secret-bootstrap.mjs` | service `com.jihye.portal.monitor-hermes-hmac` | 비밀 | Portal Keychain + Hermes의 별도 secret store | 장애 모의 handoff | 일반 HMAC과 재사용하면 격리 계약 위반 |
| 필수 | 외부 발급 | Telegram bot token·chat ID | Telegram/BotFather와 Hermes 운영자 | Hermes 전용 credential·대상 | 비밀 | **Hermes 안에만** 보관 | Hermes 자체 test message | Portal에 넣으면 보안 경계 위반; 분실 시 Telegram 알림 불가 |
| 필수 | 외부 발급 | Codex CLI 인증·OpenAI API credential·billing | OpenAI/Codex 운영 계정 | 로그인 또는 printable credential 중 택1 | 비밀 | Codex 전용 Keychain service와 공급자 계정 | `codex --version`, 비용 한도, 요청 승인 시험 | 승인된 사용자 요청형 AI 번역·2회 검수와 콘텐츠 자동화에 필수; 분실 시 작업 실패 또는 비용 통제 불가 |
| 필수 | 운영자 결정 | Codex binary·model | 콘텐츠 운영자 | 절대 binary 경로, 안전한 model identifier | 내부 | `runtime.env` | worker의 version probe와 승인된 테스트 job | 잘못된 모델·경로면 작업 claim 전 실패 |
| 필수 | 운영자 결정 | Codex 격리 경로·timeout·운영 시간 | 콘텐츠/Gemma 운영자 | 별도 `CODEX_HOME`, temp root, 120초; Gemma 비혼잡 시간 | 내부 | `runtime.env`·운영 일정 | 경로 분리·timeout·메모리 관찰 | 기존 Gemma/Hermes와 16 GB 자원 경합 |
| 필수 | 운영자 결정 | 최초 owner username·display name | 대표 운영자 | 관리자 식별자·표시명 | 내부 | 관리자 DB | owner login | 잘못된 책임자·감사 귀속 |
| 필수 | 운영자 결정 | owner password | 대표 운영자 | 강한 한 줄 password | 비밀 | 사람의 password manager; CLI stdin만 | 첫 로그인 | 분실 시 승인된 reset 절차 필요 |
| 필수 | Mac 로컬 생성 | TOTP enrollment | `admin:bootstrap` 또는 `admin:mfa-replace` | TOTP URI/secret | 비밀 | 인증 앱 + 일시적 `0600` enrollment 파일 | 두 번째 장치 없이 로그인 시험 | 분실 시 recovery code 필요 |
| 필수 | Mac 로컬 생성 | recovery code 10개 | 관리자 CLI | 일회성 recovery code | 복구 전용 비밀 | Mac 밖의 봉인된 오프라인 보관 | 한 코드 사용 후 나머지 수량 대조 | 모두 분실 시 MFA replace 운영 필요 |
| 필수 | 운영자 결정 | 개인정보 동의문 4개 | 법률·개인정보 책임자 | `ko`, `en`, `zh-Hans`, `zh-Hant` | 공개 | consent bundle + sealed public release | 4 locale hash/version/effective time 대조 | 상담 공개·접수 게이트 실패 |
| 필수 | 운영자 결정 | 선택 마케팅 동의문 4개 | 법률·개인정보 책임자 | `ko`, `en`, `zh-Hans`, `zh-Hant` | 공개 | consent bundle + sealed public release | 4 locale hash/version/effective time 대조 | 선택 동의·철회 문구 불일치 |
| 필수 | 운영자 결정 | 동의문 version·시행시각·승인자·보유기간 | 개인정보 책임자 | privacy 12개월, marketing 24개월 계약 | 공개·내부 | bundle 승인 기록 | API metadata와 8개 정책 화면 대조 | 파기·동의 증거 불일치 |
| 필수 | Mac 로컬 생성 | admin session secret | `secret-bootstrap.mjs` | `com.jihye.portal.admin-session` | 비밀 | macOS Keychain | item 존재만 확인 | 분실/회전 시 세션 무효화·로그인 영향 |
| 필수 | 운영자 결정 | `ADMIN_DUMMY_PASSWORD_HASH` | 승인된 Argon2id dummy 생성 절차 | 실제 계정과 무관한 공개 PHC 문자열 | 공개·내부 설정 | 보호된 `runtime.env` | 동결 Argon2id 정책과 config parse | 누락/형식 오류면 production control 시작 실패 |
| 필수 | Mac 로컬 생성 | control HMAC | `secret-bootstrap.mjs` | `com.jihye.portal.control-hmac` | 비밀·migration 민감 | macOS Keychain | 기능 회귀·전용 migration | 무심코 회전하면 token/index 계약 파손 |
| 필수 | Mac 로컬 생성 | PII encryption key와 active key ID | `secret-bootstrap.mjs`; 운영자 ID 결정 | `com.jihye.portal.pii-key`, 기본 `pii-v1` | 비밀·복구 필수 | Keychain + non-secret key ID | 암호화 round trip·복원 drill | 분실 시 상담 PII 복호화 불가 |
| 필수 | Mac 로컬 생성 | withdrawal token secret | `secret-bootstrap.mjs` | `com.jihye.portal.withdrawal-token` | 비밀·migration 민감 | macOS Keychain | 철회 링크 회귀 시험 | 기존 capability token 무효화 |
| 필수 | Mac 로컬 생성 | age identity·recipient | age 1.3.1 `age-keygen`, `secret-import.mjs` | identity `AGE-SECRET-KEY-1...`; recipient `age1...` | identity 복구 전용 비밀, recipient 공개 | identity Keychain + 검증된 오프라인 사본; recipient non-secret 설정 | 암호화·복호화와 wrong-identity 실패 | identity 분실 시 모든 age backup 복구 불가 |
| 필수 | Mac 로컬 생성 | IndexNow/SMTP/Codex Keychain references | 운영자가 service 이름 결정 | 제한된 service name | 내부 | `runtime.env` 또는 관리자 설정에는 참조만 | 참조 대상 item 존재 확인 | 참조 오타면 해당 integration만 실패 |
| 필수 | 운영자 결정 | GitHub 공개/비공개·전달 방식 | 소스 소유자 | HTTPS remote 또는 검증된 `git bundle` | 내부 | Git remote·운영 기록 | remote URL, bundle verify | 소스 재구축·복구 불가 |
| 조건부 필수 | 외부 발급 | 조건부 GitHub 계정·credential | GitHub 조직/소유자 | private remote용 최소 권한 credential | 비밀·조건부 | Git credential manager 또는 승인 vault | read-only clone·회수 시험 | public remote면 생략하고 private remote면 필수; 분실 시 소스 갱신·재설치 불가, 유출 시 저장소 위험 |
| 필수 | 운영자 결정 | 저장소 URL과 배포 commit SHA | 소스 소유자 | `https://github.com/himangga01/wisdom_web_portal.git`, 40자 SHA | 공개·내부 | Git과 변경관리 기록 | `git rev-parse HEAD`, clean status | 재현 불가·승인되지 않은 코드 배포 |
| 필수 | 외부 발급 | 외부 uptime 계정·알림 대상 | Mac/LAN 밖의 공급자 | public live URL, 수신자 | 내부·비밀 계정 | 외부 서비스 | Mac 전원/LAN 차단 drill | 로컬 전체 장애를 아무도 통지하지 못함 |

### 운영 비밀·reference lifecycle

아래 표는 값 자체가 아니라 service/reference와 수명주기를 기록한다. 회전 가능이라고 적힌 값도 검증된 절차와 rollback 없이 즉시 교체하지 않는다.

| 비밀·reference | Keychain service 또는 저장 위치 | 사용 프로세스 | 회전 가능 여부 | 분실 영향 | 복구 시험 |
|---|---|---|---|---|---|
| admin session secret | `com.jihye.portal.admin-session` | control·관리자 CLI | 가능; 모든 관리자 session 무효화를 승인한 뒤 교체 | 로그인 session 검증·발급 불가 | owner password+TOTP 재로그인과 기존 session 철회 확인 |
| control HMAC | `com.jihye.portal.control-hmac` | control·notification/content worker | **전용 migration 없이 회전 금지** | form token·멱등성 key·fingerprint·blind index 계약 파손 | migration rehearsal 뒤 기존/신규 token과 index 회귀 시험 |
| Hermes HMAC | `com.jihye.portal.hermes-hmac` + Hermes 독립 secret store | control·notification worker·Hermes | Portal/Hermes 동시 교체와 overlap 절차가 생긴 뒤 가능 | 상담 알림 서명 검증 실패 | metadata-only 상담 end-to-end handoff; 현재 provisioning blocker 확인 |
| monitor HMAC | `com.jihye.portal.monitor-hermes-hmac` + Hermes 별도 secret store | monitor·Hermes | 일반 HMAC과 분리해 동시 교체할 때만 가능 | 장애 알림 handoff 실패 | 독립 monitor incident 모의 전송과 일반 HMAC 비호환 확인 |
| PII encryption key | `com.jihye.portal.pii-key`; active ID는 `runtime.env` | control·retention·관리자 CLI | versioned 재암호화 migration과 이전 key 보존 없이 회전 금지 | 기존 상담 PII 복호화 불가 | 암복호화 round trip과 검증된 backup의 별도-target PII 복구 시험 |
| withdrawal token secret | `com.jihye.portal.withdrawal-token` | control | 기존 capability 처리 계획 없이 회전 금지 | 발급된 마케팅 철회 URL 무효화 | 회전 rehearsal에서 구/신규 철회 link 정책과 audit 확인 |
| age identity | `com.jihye.portal.age-identity` + 봉인된 오프라인 사본 | backup·restore Keychain wrapper | 신규 backup용 교체 가능; 이전 identity는 해당 backup 만료까지 보존 | 해당 identity로 암호화한 모든 backup 복구 불가 | correct-identity restore와 wrong-identity 거부를 함께 시험 |
| age recipient | 보호된 `runtime.env`의 공개 `age1...` reference | backup dispatcher·backup | 대응 identity 사본을 먼저 검증한 뒤 신규 backup부터 변경 | 잘못된 reference면 새 backup 검증 실패 | recipient↔identity 파생값 일치와 새 encrypted pair restore |
| IndexNow key/reference | `com.jihye.portal.indexnow`; 관리 설정에는 Keychain reference | site·content worker | 가능; sealed public key 파일과 제출 설정을 함께 교체 | URL 갱신 통지 실패 | `/indexnow-key.txt` 일치, no-store/noindex, outbox 성공 확인 |
| SMTP credential/reference | 별도 SMTP Keychain service; DB에는 `keychain:` reference | notification worker | 공급자에서 폐기·재발급 후 coordinated update 가능 | 이메일 상담 접수 알림 실패 | 465 implicit TLS와 receipt/full-inquiry test delivery 확인 |
| Codex credential/reference | Codex 전용 Keychain service·공급자 로그인 | content worker가 실행하는 격리 Codex child | 공급자 폐기·재로그인/재발급으로 가능 | 번역·검수 job 실패 또는 계정 비용 통제 상실 | 격리 `CODEX_HOME`에서 승인 model의 non-PII test job과 billing limit 확인 |

### 외부·운영자 credential lifecycle

인벤토리에서 `비밀`, `복구 전용 비밀`, `비밀 계정`으로 분류했지만 Portal Keychain이 직접 소유하지 않는 나머지 항목은 아래 표로 관리한다. 실제 password·token·recovery code·MFA seed는 기록하지 않고 소유자, consumer, 회전·폐기 순서와 복구 시험의 증거만 변경관리 기록에 남긴다.

| 외부·운영자 비밀·계정 | 저장 위치·소유자 | 사용자·consumer | 회전·폐기 | 분실 영향 | 복구 시험 |
|---|---|---|---|---|---|
| 원격접속 계정·MFA | 승인 password manager와 운영자 MFA 장치; Mac 운영 책임자 소유 | 승인된 원격 운영자와 macOS 원격관리 경로 | 대체 운영자 접속을 먼저 검증하고 password·MFA를 교체한 뒤 기존 session·장치를 폐기 | 침해 시 Mac 전체 운영 경계 노출; 분실 시 원격 진단 불가 | LAN 밖 새 session, 이전 session revoke, 재부팅 후 접속을 시험하며 FileVault pre-login은 별도 시험 |
| FileVault 복구 수단 | Mac 밖 봉인된 오프라인 보관; 지정 unlock 담당자와 사무소 책임자 공동 통제 | 현장 unlock 담당자와 macOS FileVault 복구 절차 | 새 복구 수단을 생성·봉인·검증한 뒤에만 이전 수단을 폐기하고 담당자 변경 기록을 갱신 | cold boot 후 volume·Keychain·LaunchAgent에 접근할 수 없어 전체 서비스 복구 불가 | 승인 maintenance에서 cold boot와 현장 unlock을 수행하고 보관 위치·담당자 연락망을 함께 대조 |
| 도메인 등록기관 계정·MFA | 공급자 account vault와 독립 MFA·recovery 수단; 도메인 소유 책임자 | registrar console의 갱신·소유권·nameserver 운영자 | recovery 연락처를 먼저 검증하고 password·MFA를 교체한 뒤 이전 session과 장치를 revoke | 갱신 실패·도메인 상실·DNS 위임 복구 불가 | 새 MFA 로그인, recovery 절차, 자동갱신·결제수단·만료일 확인 |
| Cloudflare 계정·MFA | Cloudflare account vault와 별도 MFA·recovery code; DNS/Tunnel 책임자 | Cloudflare dashboard의 zone·DNS·Tunnel 운영자 | 최소 두 복구 경로를 확보한 뒤 password·MFA 교체, 기존 session·장치 revoke | DNS·Tunnel 변경과 계정 복구 불가; 침해 시 외부 라우팅 탈취 | 새 로그인, zone 소유권, 세 host DNS·Tunnel 상태, account recovery를 값 노출 없이 확인 |
| Cloudflare Tunnel credential | `~/.cloudflared/`의 owner-only `0600` JSON; Tunnel 운영자 | 로컬 `cloudflared` LaunchAgent만 사용 | 새 credential로 loopback origin 연결을 검증한 뒤 기존 credential을 Cloudflare에서 revoke하고 로컬 파일을 안전 교체 | 분실 시 Tunnel 시작 불가; 유출 시 승인되지 않은 connector 위험 | 이전 credential revoke 확인 후 새 credential로 apex·public·admin과 unknown-host 404를 외부 시험 |
| Cloudflare API token | 승인된 외부 secret vault; DNS 자동화 책임자, 수동 console 운영에서는 미발급 | 명시적으로 승인된 Cloudflare 자동화만 사용하며 Portal runtime은 사용하지 않음 | 최소 zone scope·만료가 있는 새 token을 검증한 뒤 기존 token revoke | 조건부 자동화만 실패; 유출 시 허용 scope의 DNS·Tunnel 변경 위험 | staging 또는 read-only 검증 후 허용 action과 거부 action, revoke된 token 실패를 확인 |
| Google 계정·MFA | Google account vault와 독립 MFA·recovery 수단; 검색 운영 책임자 | Search Console Domain Property 운영자 | recovery 연락처를 먼저 검증하고 password·MFA·session을 순차 교체·폐기 | Domain Property 소유권·색인 진단과 복구 불가 | 새 MFA 로그인, property 접근, DNS 소유권 상태, account recovery 경로 확인 |
| Naver 계정·MFA | Naver account vault와 독립 MFA·recovery 수단; 검색 운영 책임자 | Naver Search Advisor site 운영자 | recovery 수단 확인 후 password·MFA 교체, 이전 session revoke | Naver 소유권 확인·수집 요청·색인 진단 불가 | 새 로그인, site 소유권, sitemap·robots 수집 상태와 recovery 경로 확인 |
| SMTP 제공자 계정·MFA | 메일 공급자 account vault와 MFA; 사무소 메일 책임자 | app password 발급·폐기와 발신 정책을 관리하는 사람만 사용 | 새 provider password·MFA와 app password를 검증한 뒤 기존 app password·session 폐기 | 새 SMTP credential 발급·메일 channel 복구 불가 | 공급자 새 로그인과 recovery 확인 후 Keychain reference를 통한 465 implicit-TLS test delivery 수행 |
| Telegram bot token·chat ID | Hermes 전용 secret store; Hermes 운영 책임자, Portal 저장 금지 | 기존 Hermes의 상담·monitor 알림 connector만 사용 | BotFather에서 새 token을 발급하고 대상 chat을 검증한 뒤 Hermes를 전환하고 이전 token revoke | 상담·장애 Telegram 알림 실패; 유출 시 bot 위조·오용 위험 | Hermes 자체 test message와 서명된 Portal handoff를 확인하고 revoke된 token의 전송 실패를 확인 |
| owner password | 대표 운영자의 password manager; CLI·shell history·파일 저장 금지 | owner와 control 관리자 인증, reset wrapper의 stdin만 사용 | 승인된 reset에서 새 password를 stdin으로 설정하고 TOTP 로그인을 확인한 뒤 이전 값 폐기 | 관리자 로그인·승인 작업 불가; 유출 시 관리자 권한 탈취 | reset 절차 후 새 password+TOTP 로그인, 기존 session revoke, audit 귀속 확인 |
| owner TOTP | 대표 운영자의 인증 앱; 임시 `0600` enrollment 파일은 검증 직후 삭제 | owner와 control의 두 번째 인증 factor | 유효 recovery code로 MFA replace를 승인하고 새 TOTP·새 로그인을 확인한 뒤 이전 seed와 임시 파일 폐기 | password만으로 로그인할 수 없고 recovery code가 없으면 MFA replace 운영 필요 | 새 TOTP와 offline recovery code로 각각 로그인한 뒤 이전 TOTP 거부와 임시 파일 부재 확인 |
| owner recovery codes | Mac 밖 봉인된 오프라인 보관; 대표 운영자와 지정 비상 책임자 공동 통제 | owner의 일회성 복구 로그인과 MFA replace 승인 | 새 code 세트를 발급·오프라인 봉인·수량 대조한 뒤 기존 미사용 code 전부 무효화 | TOTP 장치까지 분실하면 관리자 복구 경로 상실 | maintenance에서 한 code를 사용하고 재사용 거부·잔여 수량·새 세트 보관 증거를 확인 |
| GitHub private credential | OS credential manager 또는 승인 vault; 저장소 소유 책임자 | private remote를 읽는 운영자 `git` client만 사용하며 public remote에는 미발급 | 최소 read scope의 새 credential로 clone을 검증한 뒤 기존 credential·session revoke | private 소스 갱신·재설치 불가; 유출 시 저장소 기밀성과 공급망 위험 | 깨끗한 경로의 read-only clone·commit SHA 대조 후 revoke된 credential 실패 확인 |
| external uptime account/MFA | Mac·LAN 밖 공급자 account vault와 독립 MFA; 외부 감시 책임자 | 외부 probe·maintenance window·알림 대상 관리 운영자 | 새 password·MFA·수신 대상을 검증한 뒤 기존 session·장치·불필요 destination 폐기 | Mac 전체·LAN·Tunnel 장애가 탐지·통지되지 않음 | Mac 전원 또는 LAN 차단 drill에서 외부 경보 수신·복구 알림·account recovery를 확인 |

### 비밀 저장 금지 위치

비밀은 Git, `.env.example`, runtime template, plist, shell history, 명령 인자, 스크린샷, Telegram, 이 가이드, 일반 공유 폴더에 저장하지 않는다. 출력 검증은 service 이름·action·exit code만 사용하고 값 자체를 표시하지 않는다. Keychain 값을 출력하는 option을 운영자 명령에 사용하지 않는다.

## 2. 암호화 계층과 완전 복구 경계

다음 네 값은 역할이 서로 다르다.

```text
age1...                public recipient used to encrypt backup files
AGE-SECRET-KEY-1...    private identity required to decrypt backup files
PII_ENCRYPTION_KEY     separate key required to decrypt consultation fields inside SQLite
FileVault              protects the Mac storage at rest before login
```

- `age1...` recipient는 공개 가능하며 `.age` 파일을 만드는 데 쓴다. 이것만으로 복호화할 수 없다.
- `AGE-SECRET-KEY-1...` identity는 비공개 개인키다. Keychain과 검증된 오프라인 복구 사본 밖에 두지 않는다.
- `PII_ENCRYPTION_KEY`는 SQLite 안의 상담 필드 암호화 키다. age identity가 있어도 이 키가 없으면 복원된 DB의 상담 PII를 읽을 수 없다.
- FileVault는 로그인 전 Mac SSD 전체의 at-rest 보호다. 로그인 후 애플리케이션 암호화나 offsite backup을 대신하지 않는다.

완전 복구에는 (1) 같은 basename의 검증된 `.age`/`.json` 쌍, (2) age identity, (3) `PII_ENCRYPTION_KEY`, (4) 나머지 application 비밀, (5) 소스와 non-secret 운영 설정, (6) cold boot 후 FileVault를 unlock하고 로그인할 운영자가 모두 필요하다. `.json`의 크기·SHA-256과 실제 `.age`를 restore가 다시 확인해야 하며 관측용 `backup-run-state.json`은 무결성 증거가 아니다.

현재 로컬 backup root는 같은 Mac SSD에 있으므로 SSD 고장·분실을 견디지 못한다. **all-Keychain offline recovery bundle**과 **automatic offsite backup replication**은 아직 구현되지 않은 공개 차단 항목이다. 존재하지 않는 export/replication 명령을 실행하지 말고 공개 전에 별도 구현·검토·복원 시험을 완료한다.

## 3. 공개 차단 항목 8개

| 번호 | 정확한 차단 항목 | 상태 | 공개 전에 필요한 증거 |
|---|---|---|---|
| 1 | production template render/install CLI | **구현 완료·Mac 실장비 검증 필요** | 실제 Mac에서 보호된 입력, user/system 분리 설치, ownership·원자 교체·rollback과 설치 후 validator를 검증한 통합 시험 |
| 2 | first normal publication bootstrap | **공개 전 구현 필요** | Tunnel off 상태에서 Secure-cookie 관리자 UI를 안전하게 이용해 첫 Wisdom release를 만드는 HTTPS 경로 |
| 3 | Kakao URL publication allowlist | **공개 전 구현 필요** | 승인된 Kakao HTTPS URL이 격리된 publication build에 전달되고 manifest/페이지에서 검증되는 테스트 |
| 4 | Hermes HMAC provisioning | **공개 전 구현 필요** | 일반 HMAC과 monitor HMAC을 서로 섞지 않고 기존 Hermes에 전달·회전·검증하는 절차 |
| 5 | tunnel-off Host-aware health probe | **공개 전 구현 필요** | host-based Caddy가 bootstrap 중 public Host를 포함해 health를 검사하는 안전한 probe |
| 6 | all-Keychain offline recovery bundle | **공개 전 구현 필요** | 필요한 모든 비밀의 암호화 offline bundle, 접근 통제, 정기 복구 시험 |
| 7 | automatic offsite backup replication | **공개 전 구현 필요** | verified encrypted pair의 Mac 밖 자동 복제, 보존·삭제·복원 검증 |
| 8 | stale PUBLIC_ORIGINS README mismatch | **현재 수동 검증 가능** — 이 변경에서 `PUBLIC_ORIGIN`으로 정정 | README·template·runtime parser가 singular key 하나로 일치하는 문서 계약 테스트 |

차단 항목을 해결하지 않은 상태에서 Tunnel을 열거나 실상담을 받지 않는다. Cloudflare·Google·Naver·SMTP·OpenAI·외부 uptime 계정 생성, 결제와 소유권 확인은 저장소가 대신하지 않는 운영자 입력 작업이다.

### 3.1 기존 schema v6 설치의 추가 배포 중단 조건

위 8개는 모든 공개 설치에 적용되는 차단 항목이다. 다음 조건은 **이미 schema v6 DB를 운영 중인 설치에만 추가로 적용되는 배포 차단 항목**이며, 신규 설치와 구분한다. 신규 빈 DB(`user_version = 0`)는 rollback compatibility gate를 통과해 schema v7까지 생성할 수 있고, 이미 정확한 schema v7인 DB도 정상 배포 대상이다.

기존 schema v6 DB에는 일반 `deploy.mjs --apply`를 실행하지 않는다. 배포기가 강제하는 rollback compatibility gate가 `DATABASE_MIGRATION_ROLLBACK_INCOMPATIBLE`로 중단하는 것이 현재의 의도된 안전 동작이다. schema v7을 모르는 보존 release로 rollback하면 DB를 안전하게 사용할 수 없으므로, 이 중단을 배포 실패로 오인해 우회해서는 안 된다.

전용 v6→v7 maintenance migration은 현재 구현되어 있지 않다. 별도 변경으로 정지 범위, 방금 검증한 암호화 backup, maintenance lock, 구 release retirement 승인, 전환 후 데이터 검증과 복구 drill을 구현·검토·실장비 시험하기 전까지 기존 v6 설치의 업그레이드는 **STOP** 상태다. `--require-rollback-compatible`를 제거하거나 우회 flag를 추가하지 말고, SQLite `user_version`을 수동 수정하지 않는다. 상세한 필수 절차는 [`ops/runbooks/deployment.md`의 rollback 비호환 migration](../../ops/runbooks/deployment.md#rollback-비호환-migration)을 따른다.

## 4. 필요하지 않은 계정·설정

- Docker 계정·설치: 불필요. 이 운영안은 Docker를 사용하지 않는다.
- WordPress 계정: 불필요. 공개 사이트는 Astro 정적 산출물이다.
- Caddy 계정: 불필요. 로컬 binary와 설정 파일만 사용한다.
- age 서비스 계정: 불필요. 키 쌍은 Mac에서 생성한다.
- 공유기 inbound port forwarding: 불필요. 설정하지 않는다.
- 수동 TLS 인증서: 불필요. 현재 구조에서는 외부 TLS를 Cloudflare가 종료한다.
- Kakao Developers API: 단순 링크에는 불필요. 향후 SDK/API 기능을 추가할 때만 별도 검토한다.
- Penpot 운영 runtime 접근: 불필요. Penpot은 디자인 검토 도구이며 운영 서비스 의존성이 아니다.

## 5. Mac 계정과 표준 경로

Mac의 기존 Gemma/Hermes 로그인 세션에서 실행한다. username을 문서에 하드코딩하지 않는다.

이 문서의 `sh` 블록은 **같은 전용 shell 세션에서 위에서 아래 순서로** 실행한다. 의도된 nonzero를 검사하는 wrong-identity·monitor 절차가 있으므로 전역 `set -e`에 의존하지 않는다. 대신 fail-fast 계약으로 필수 predicate·mutation·dry-run·apply마다 `|| exit 1` 또는 명시적 `if` 분기를 둔다. 어느 블록이든 중단 조건이 생기면 다음 블록을 붙여넣지 말고 원인을 고친 뒤 해당 검증부터 다시 실행한다.

```sh
umask 077 || exit 1
PORTAL_USER="$(id -un)" || exit 1
PORTAL_UID="$(id -u)" || exit 1
export PORTAL_USER PORTAL_UID
export SOURCE_ROOT="$HOME/src/wisdom-web-portal"
export APP_ROOT="$HOME/portal"
export RELEASE_ROOT="$APP_ROOT/releases"
export CURRENT_RELEASE="$APP_ROOT/current"
export PUBLIC_RELEASE_ROOT="$APP_ROOT/public-releases"
export PUBLIC_CURRENT_RELEASE="$APP_ROOT/public-current"
export DATA_ROOT="$HOME/Library/Application Support/WisdomPortal"
export LOG_ROOT="$HOME/Library/Logs/WisdomPortal"
export BACKUP_ROOT="$HOME/Backups/WisdomPortal"
export BACKUP_TEMP_ROOT="$HOME/Library/Caches/WisdomPortalBackup"

printf 'user=%s uid=%s home=%s\n' "$PORTAL_USER" "$PORTAL_UID" "$HOME" || exit 1
if ! printf '%s' "$PORTAL_USER" | /usr/bin/grep -Eq '^[A-Za-z0-9._-]{1,128}$'; then
  printf 'STOP: Keychain account 형식 불일치\n' >&2
  exit 1
fi
```

기대 결과: 실제 short username, UID, HOME이 한 줄로 나오고 정규식 검사가 0으로 끝난다. 중단 조건: username이 제한 ASCII가 아니거나 UID/HOME이 예상 로그인 계정과 다르면 별도 제한 ASCII Keychain account 설계를 검토하기 전 설치하지 않는다. username을 억지로 변경하면 기존 Gemma/Hermes와 FileVault 접근이 깨질 수 있다.

## 6. 하드웨어·FileVault·전원·공존 사전 점검

### 6.1 장비와 복구 가능성

```sh
ARCHITECTURE="$(uname -m)" || exit 1
test "$ARCHITECTURE" = "arm64" || exit 1
sw_vers || exit 1
FILEVAULT_STATUS="$(fdesetup status)" || exit 1
printf '%s\n' "$FILEVAULT_STATUS" || exit 1
printf '%s\n' "$FILEVAULT_STATUS" | /usr/bin/grep -Fq 'FileVault is On' || exit 1
pmset -g custom || exit 1
xcode-select -p || exit 1
df -h "$HOME" || exit 1
sysctl -n hw.memsize || exit 1
unset ARCHITECTURE FILEVAULT_STATUS
```

기대 결과:

- `uname -m`은 정확히 `arm64`다.
- `fdesetup status`는 FileVault가 켜졌음을 보여준다.
- Xcode Command Line Tools 경로와 충분한 여유 공간이 있다.
- `pmset` 결과는 **변경 전에** 운영 기록에 보관한다.

다음 중 하나라도 해당하면 중단한다: Intel architecture, FileVault 복구 수단 부재, cold boot 후 현장 unlock 담당자 부재, 운영 release·backup·Codex 임시 작업을 감당할 여유 공간 부재. FileVault recovery key나 Apple ID credential은 화면 캡처·Git·이 문서에 남기지 않는다.

전원 설정은 저장소가 자동 변경하지 않는다. 기존 값을 기록하고 운영 승인과 복구 절차가 있을 때만 한 항목씩 적용한다. 아래는 기존 배포 런북의 **검토 가능한 예**이며 장비 지원 여부와 원래 값 복원 방법을 먼저 확인해야 한다.

```sh
pmset -g custom || exit 1
sudo pmset -c sleep 0 autorestart 1 womp 1 || exit 1
pmset -g custom || exit 1
```

기대 결과: AC power profile의 승인 항목만 바뀐다. 중단 조건: UPS 동작·정전 후 FileVault 수동 unlock·원래 설정 복원까지 시험하지 못하면 무인 복구 가능하다고 기록하지 않는다. `autorestart`는 FileVault pre-login unlock을 우회하지 못한다.

### 6.2 Gemma/Hermes와 포트 충돌

먼저 기존 프로세스와 실제 포트를 기록한다.

```sh
/usr/bin/test -x /bin/ps || exit 1
/usr/bin/test -x /usr/sbin/lsof || exit 1
PROCESS_SNAPSHOT="$(ps -axo pid=,ppid=,%cpu=,%mem=,comm=)" || exit 1
printf '%s\n' "$PROCESS_SNAPSHOT" | /usr/bin/awk 'tolower($5) ~ /(gemma|hermes)/ { print }' || exit 1
unset PROCESS_SNAPSHOT
for port in 8787 8788 8080 2019 18787; do
  printf '\n--- TCP %s ---\n' "$port"
  if PORT_LISTENERS="$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>&1)"; then
    printf '%s\n' "$PORT_LISTENERS" || exit 1
  else
    LSOF_STATUS=$?
    test "$LSOF_STATUS" = "1" || exit 1
  fi
done
unset PORT_LISTENERS LSOF_STATUS
```

포트 계약은 control `8787`, Hermes 기본 loopback `8788`, Caddy `8080`, Caddy admin `2019`, 배포 canary `18787`이다. 기대 결과: 기존 Hermes가 승인된 `8788`을 쓰는 경우를 제외하고 Portal이 사용할 포트가 비어 있거나 소유 프로세스가 명확하다. 중단 조건: 알려지지 않은 listener, 외부 interface에 바인딩된 Hermes, Gemma와 canary 포트 충돌, 또는 16 GB 메모리에서 동시 Codex/Gemma 부하 기준이 없으면 먼저 포트·작업 시간대를 다시 결정한다. 기존 프로세스를 임의 종료하지 않는다.

## 7. 소프트웨어 버전과 설치 출처

필수 계약은 Node.js major 24 (`>=24 <25`), npm `12.0.1`, Apple Silicon용 Caddy, cloudflared, **age 정확히 1.3.1**, `better-sqlite3`가 보고하는 SQLite **3.51.3 이상**, Git, Codex CLI다. Caddy/cloudflared/Codex의 특정 최신 버전을 이 문서가 임의로 고정하지는 않지만 설치 당시 버전과 출처를 기록한다.

운영자가 공식 배포처에서 Apple Silicon artifact를 받아 설치하고, 공급자가 게시한 checksum/signature를 별도로 대조한다. 특히 package manager가 현재 제공하는 age 버전을 가정하지 말고 1.3.1 artifact와 공식 checksum을 고정한다. 다운로드 파일 검증 형식은 다음과 같으며 기대 SHA-256은 공식 release 기록에서 가져온다.

```sh
if [ -z "${DOWNLOAD_ARTIFACT_PATH:-}" ] || [ -z "${EXPECTED_ARTIFACT_SHA256:-}" ]; then
  printf 'STOP: artifact path와 승인 SHA-256이 필요함\n' >&2
  exit 1
fi
test -f "$DOWNLOAD_ARTIFACT_PATH" || exit 1
test ! -L "$DOWNLOAD_ARTIFACT_PATH" || exit 1
ACTUAL_ARTIFACT_SHA256="$(shasum -a 256 "$DOWNLOAD_ARTIFACT_PATH" | /usr/bin/awk '{print $1}')" || exit 1
test "$ACTUAL_ARTIFACT_SHA256" = "$EXPECTED_ARTIFACT_SHA256" || exit 1
printf '%s  %s\n' "$ACTUAL_ARTIFACT_SHA256" "$DOWNLOAD_ARTIFACT_PATH" || exit 1
unset ACTUAL_ARTIFACT_SHA256
```

기대 결과: 출력 hash가 별도 채널에서 확인한 공식 hash와 정확히 같다. 불일치, 출처 불명, Rosetta용 binary면 설치를 중단한다. 이 저장소에는 installer나 공급자 checksum 자체가 포함되어 있지 않다.

설치 후 절대 경로와 버전을 확인한다.

```sh
NODE_BINARY="$(command -v node)" || exit 1
NPM_BINARY="$(command -v npm)" || exit 1
CADDY_BINARY="$(command -v caddy)" || exit 1
CLOUDFLARED_BINARY="$(command -v cloudflared)" || exit 1
AGE_BINARY="$(command -v age)" || exit 1
AGE_KEYGEN_BINARY="$(command -v age-keygen)" || exit 1
CODEX_BINARY="$(command -v codex)" || exit 1
GIT_BINARY="$(command -v git)" || exit 1
export NODE_BINARY NPM_BINARY CADDY_BINARY CLOUDFLARED_BINARY
export AGE_BINARY AGE_KEYGEN_BINARY CODEX_BINARY GIT_BINARY

"$NODE_BINARY" --version || exit 1
"$NPM_BINARY" --version || exit 1
"$CADDY_BINARY" version || exit 1
"$CLOUDFLARED_BINARY" --version || exit 1
"$AGE_BINARY" --version || exit 1
"$CODEX_BINARY" --version || exit 1
"$GIT_BINARY" --version || exit 1

test "$("$NODE_BINARY" -p 'process.versions.node.split(".")[0]')" = "24" || exit 1
test "$("$NPM_BINARY" --version)" = "12.0.1" || exit 1
"$AGE_BINARY" --version 2>&1 | /usr/bin/grep -Eq '(^|[[:space:]])(age[[:space:]]+)?v?1\.3\.1($|[[:space:]])' || exit 1
```

기대 결과: 모든 binary가 절대 경로로 해석되고 세 계약 검사가 0이다. 중단 조건: Node/npm/age가 다르거나 어느 binary가 없으면 source 설치로 진행하지 않는다. system `sqlite3` 버전과 배포에서 쓰는 SQLite는 다를 수 있다. 최종 SQLite 판정은 `npm ci` 후 `preflight.mjs`가 로드한 `better-sqlite3` engine을 기준으로 한다.

## 8. 소스 전달과 저장소 QA

### 8.1 GitHub clone 또는 검증된 bundle 중 하나 선택

GitHub 접근이 허용되면 다음을 사용한다.

```sh
mkdir -p "$HOME/src" || exit 1
git clone https://github.com/himangga01/wisdom_web_portal.git "$SOURCE_ROOT" || exit 1
cd "$SOURCE_ROOT" || exit 1
git remote -v || exit 1
git rev-parse HEAD || exit 1
GIT_STATUS="$(git status --porcelain)" || exit 1
test -z "$GIT_STATUS" || exit 1
unset GIT_STATUS
```

기대 결과: 승인된 GitHub remote와 배포할 40자 commit SHA가 보이고 `git status --porcelain`은 비어 있다. 중단 조건: clone·remote 조회 실패, 예상하지 않은 remote, dirty tree, 승인 SHA 불일치. 이 경로를 쓰면 아래 bundle 경로는 실행하지 않는다.

망 분리나 private 전달이면 먼저 별도 매체의 bundle을 검증하고 clone한다.

```sh
if [ -z "${VERIFIED_BUNDLE_PATH:-}" ]; then
  printf 'STOP: verified bundle 절대 경로가 필요함\n' >&2
  exit 1
fi
test -f "$VERIFIED_BUNDLE_PATH" || exit 1
test ! -L "$VERIFIED_BUNDLE_PATH" || exit 1
git bundle verify "$VERIFIED_BUNDLE_PATH" || exit 1
git clone "$VERIFIED_BUNDLE_PATH" "$SOURCE_ROOT" || exit 1
cd "$SOURCE_ROOT" || exit 1
git rev-parse HEAD || exit 1
GIT_STATUS="$(git status --porcelain)" || exit 1
test -z "$GIT_STATUS" || exit 1
unset GIT_STATUS
```

기대 결과: 승인된 remote/전달 출처, 배포할 40자 commit SHA, 빈 `git status --porcelain` 출력이다. 중단 조건: bundle verify 실패, 예상하지 않은 remote, dirty tree, 승인 SHA 불일치. Windows에서 만든 `node_modules`, native addon, build 산출물을 Mac으로 복사하지 않는다.

### 8.2 Mac에서 의존성과 브라우저를 새로 설치

```sh
cd "$SOURCE_ROOT" || exit 1
npm ci || exit 1
npm exec playwright install || exit 1
npm run verify || exit 1
GIT_STATUS="$(git status --porcelain)" || exit 1
test -z "$GIT_STATUS" || exit 1
unset GIT_STATUS
```

기대 결과: lockfile 그대로 설치되고 `npm run verify`가 typecheck, unit/Ops test, build, E2E를 모두 통과하며 Git 상태가 깨끗하다. 하나라도 실패하면 중단하고 최초 실패를 조사한다. `npm run verify`의 root Site build는 fixture 기반 QA이며 **정상 production publication이나 Tunnel 공개를 만들지 않는다**.

## 9. 디렉터리와 권한

`current`와 `public-current`는 배포 도구가 관리할 symlink이므로 디렉터리로 만들지 않는다.

```sh
umask 077 || exit 1
mkdir -p \
  "$APP_ROOT" \
  "$APP_ROOT/shared" \
  "$RELEASE_ROOT" \
  "$PUBLIC_RELEASE_ROOT" \
  "$DATA_ROOT" \
  "$LOG_ROOT" \
  "$BACKUP_ROOT" \
  "$BACKUP_TEMP_ROOT" \
  "$HOME/Library/LaunchAgents" || exit 1

chmod 700 \
  "$APP_ROOT" \
  "$APP_ROOT/shared" \
  "$RELEASE_ROOT" \
  "$PUBLIC_RELEASE_ROOT" \
  "$DATA_ROOT" \
  "$LOG_ROOT" \
  "$BACKUP_ROOT" \
  "$BACKUP_TEMP_ROOT" || exit 1

for directory in \
  "$APP_ROOT" "$APP_ROOT/shared" "$RELEASE_ROOT" "$PUBLIC_RELEASE_ROOT" \
  "$DATA_ROOT" "$LOG_ROOT" "$BACKUP_ROOT" "$BACKUP_TEMP_ROOT"; do
  test -d "$directory" && test ! -L "$directory" || exit 1
  test "$(stat -f '%Lp' "$directory")" = "700" || exit 1
done
```

기대 결과: 모든 경로가 실제 디렉터리이고 mode `0700`이다. symlink, group/world 쓰기, release/data/public root 중첩이 있으면 중단한다.

### 9.1 production template render/install CLI

설치기는 구현됐지만 대상 Mac의 ownership·원자 교체·rollback 통합 시험은 아직 공개 게이트다. template을 수작업 치환하지 않는다. 먼저 example을 **비밀이 아닌** 운영 reference와 공개 값으로 채운다. 이 JSON에는 application secret, SMTP password, Telegram token, Cloudflare credential 본문, Codex credential, age identity를 넣지 않는다. 정확한 35개 token 외의 key는 설치기가 거부한다.

보호된 values 파일을 실제 일반 파일 mode `0600`으로 준비한다. 기존 파일을 덮어쓰기보다 승인된 편집 절차로 새 파일을 만든 뒤 권한과 symlink 여부를 확인한다.

```sh
export CONFIG_VALUES="$HOME/.config/jihye-portal/production-values.json"
case "$CONFIG_VALUES" in /*) ;; *) exit 1 ;; esac
umask 077
mkdir -p "$(dirname "$CONFIG_VALUES")" || exit 1
chmod 700 "$(dirname "$CONFIG_VALUES")" || exit 1
cp "$SOURCE_ROOT/ops/config/production-values.example.json" "$CONFIG_VALUES" || exit 1
chmod 600 "$CONFIG_VALUES" || exit 1

# 승인된 non-secret 운영값으로 편집한 뒤 실행한다.
test -f "$CONFIG_VALUES" && test ! -L "$CONFIG_VALUES" || exit 1
test "$(stat -f '%Lp' "$CONFIG_VALUES")" = "600" || exit 1
```

입력 파일이 64 KiB를 넘거나 group/world 권한이 하나라도 열렸거나 symlink이면 중단한다. 편집을 마친 뒤 user와 system 두 scope를 **모두 dry-run**한다. dry-run에는 `sudo`를 사용하지 않는다.

```sh
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/config-install.mjs" \
  --values "$CONFIG_VALUES" \
  --scope user || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/config-install.mjs" \
  --values "$CONFIG_VALUES" \
  --scope system || exit 1
```

각 성공 출력은 `schemaVersion`, `scope`, `applied: false`, `artifacts`만 있는 JSON이다. 각 artifact에는 `id`, `sha256`, `changed`만 있어야 한다. token 값, 렌더 본문, 절대 target 경로, child stdout/stderr가 보이면 중단한다. dry-run도 private staging에서 runtime·monitoring parse와 plist·Caddy·cloudflared 또는 newsyslog validator를 모두 실행하지만 target은 변경하지 않는다.

두 dry-run이 모두 성공한 뒤 기존 로그인 계정으로 user scope만 적용한다. 두 confirmation은 values에서 검증된 경로와 정확히 같아야 한다.

```sh
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/config-install.mjs" \
  --values "$CONFIG_VALUES" \
  --scope user \
  --apply \
  --confirm-app-root "$APP_ROOT" \
  --confirm-user-home "$HOME" || exit 1
```

system scope는 별도 명령으로만 root 적용한다. 이 명령은 user 파일을 다시 쓰지 않고 newsyslog 파일 하나만 설치해야 한다.

```sh
sudo "$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/config-install.mjs" \
  --values "$CONFIG_VALUES" \
  --scope system \
  --apply \
  --confirm-system-target /etc/newsyslog.d/wisdom-portal.conf || exit 1
```

apply 성공 출력은 같은 sanitized 형식의 `applied: true`이고, 설치기는 먼저 모든 파일을 렌더링·검증한 뒤 sibling temporary file, `fsync`, mode 설정, atomic rename으로 게시한다. 나중 artifact의 게시가 실패하면 앞선 변경을 복구한다. user scope는 12개 파일을 mode `0600`, system scope는 `/etc/newsyslog.d/wisdom-portal.conf` 하나를 mode `0644`로 설치한다.

설치된 실제 target을 다시 검증한다.

```sh
plutil -lint "$HOME/Library/LaunchAgents"/com.jihye.portal.*.plist || exit 1
"$CADDY_BINARY" validate \
  --config "$APP_ROOT/shared/Caddyfile" \
  --adapter caddyfile || exit 1
"$CLOUDFLARED_BINARY" \
  --config "$APP_ROOT/shared/cloudflared.yml" \
  tunnel ingress validate || exit 1
sudo /usr/sbin/newsyslog -n \
  -f /etc/newsyslog.d/wisdom-portal.conf || exit 1
stat -f '%Sp %Su %N' \
  "$APP_ROOT/shared/runtime.env" \
  "$APP_ROOT/shared/monitoring.json" \
  "$APP_ROOT/shared/Caddyfile" \
  "$APP_ROOT/shared/cloudflared.yml" \
  "$HOME/Library/LaunchAgents"/com.jihye.portal.*.plist \
  /etc/newsyslog.d/wisdom-portal.conf || exit 1
```

기대 결과: plist·Caddy·cloudflared·newsyslog 검증 성공, user 파일은 현재 로그인 계정 소유의 `0600`, system 파일은 root 소유의 `0644`다. 설치기는 Keychain, Cloudflare credential 파일, application secret을 읽지 않으며 `launchctl`을 호출하거나 서비스를 시작·재시작하지 않는다. 특히 cloudflared는 정상 Wisdom publication과 이후 preflight가 끝날 때까지 unloaded 상태를 유지한다.

차단 항목 1을 최종 종료하려면 대상 Mac에서 정상 설치뿐 아니라 잘못된 owner/mode·symlink 거부, 두 번째 apply의 unchanged 판정, 중간 publication 실패의 원본 복구, rollback 실패의 별도 sanitized code, 설치 후 digest/mode 재검증을 기록한다. 이 실장비 증거가 없으면 구현 완료 상태를 공개 준비 완료로 올리지 않는다.

## 10. 도메인·Cloudflare Tunnel 준비

registrar에서 apex domain의 소유권·자동 갱신·MFA·복구 연락처를 먼저 확인한다. 운영자가 다음 non-secret 값을 확정한다.

```sh
if [ -z "${APEX_HOST:-}" ] || [ -z "${PUBLIC_HOST:-}" ] || \
  [ -z "${ADMIN_HOST:-}" ] || [ -z "${TUNNEL_ID:-}" ]; then
  printf 'STOP: APEX_HOST, PUBLIC_HOST, ADMIN_HOST, TUNNEL_ID가 모두 필요함\n' >&2
  exit 1
fi
export APEX_HOST PUBLIC_HOST ADMIN_HOST TUNNEL_ID
export PUBLIC_ORIGIN="https://$PUBLIC_HOST"
export ADMIN_ORIGIN="https://$ADMIN_HOST"
export CLOUDFLARED_CREDENTIALS_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
```

기대 결과: 네 host/Tunnel 변수와 두 origin이 값 본문을 출력하지 않고 현재 shell에 설정된다. 중단 조건: public/admin이 같은 hostname, origin에 path·query·trailing slash가 있음, Tunnel UUID나 credential 경로가 승인값과 다름. `PUBLIC_ORIGIN`은 구현된 singular key다. 실제 값은 shell history가 아닌 보호된 운영 입력으로 설정한다.

Cloudflare에서 apex/public/admin DNS를 같은 Tunnel ingress로 연결하고 설정의 마지막 ingress를 404로 둔다. credential JSON은 다음 조건만 확인하고 내용을 출력하지 않는다.

```sh
test -f "$CLOUDFLARED_CREDENTIALS_FILE" || exit 1
test ! -L "$CLOUDFLARED_CREDENTIALS_FILE" || exit 1
chmod 600 "$CLOUDFLARED_CREDENTIALS_FILE" || exit 1
test "$(stat -f '%Lp' "$CLOUDFLARED_CREDENTIALS_FILE")" = "600" || exit 1
```

기대 결과: owner-only 실제 파일이다. symlink, group/world 접근, zone/Tunnel ID 불일치면 중단한다. Cloudflare credential 본문이나 API token을 template에 넣지 않는다. 공유기 inbound rule과 수동 인증서를 만들지 않는다. Cloudflare Tunnel은 Mac 전원·SSD·LAN 장애를 해결하지 않는다.

## 11. Keychain 비밀과 recovery 준비

### 11.1 저장소가 생성하는 6개 base secret

`secret-bootstrap.mjs`는 아래 6개 32-byte 값을 생성한다. age identity, IndexNow key, SMTP credential, Codex credential은 이 명령의 대상이 아니다.

```sh
cd "$SOURCE_ROOT" || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-bootstrap.mjs" --account "$PORTAL_USER" || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-bootstrap.mjs" --account "$PORTAL_USER" --apply || exit 1
```

기대 결과: 첫 명령은 `dryRun: true`, 두 번째는 `dryRun: false`이고 두 출력 모두 action·environment·service 이름만 포함한다.

```text
ADMIN_SESSION_SECRET          com.jihye.portal.admin-session
CONTROL_HMAC_SECRET           com.jihye.portal.control-hmac
HERMES_HMAC_SECRET            com.jihye.portal.hermes-hmac
MONITOR_HERMES_HMAC_SECRET    com.jihye.portal.monitor-hermes-hmac
PII_ENCRYPTION_KEY            com.jihye.portal.pii-key
WITHDRAWAL_TOKEN_SECRET       com.jihye.portal.withdrawal-token
```

중단 조건: 기존 item 충돌, `INVALID_KEYCHAIN_ACCOUNT`, Keychain 잠김, 일부만 생성된 상태. bootstrap을 반복하거나 `-U`로 덮지 않는다. `CONTROL_HMAC_SECRET`, `HERMES_HMAC_SECRET`, `PII_ENCRYPTION_KEY`, `WITHDRAWAL_TOKEN_SECRET`은 전용 migration 없이 회전할 수 없다. `secret-bootstrap.mjs --mode rotate`도 정확히 하나의 `--only`가 필요하며 migration-sensitive key는 거부한다.

값을 출력하지 않고 존재만 확인한다.

```sh
for service in \
  com.jihye.portal.admin-session \
  com.jihye.portal.control-hmac \
  com.jihye.portal.hermes-hmac \
  com.jihye.portal.monitor-hermes-hmac \
  com.jihye.portal.pii-key \
  com.jihye.portal.withdrawal-token; do
  /usr/bin/security find-generic-password -a "$PORTAL_USER" -s "$service" >/dev/null 2>&1 || exit 1
done
```

기대 결과: 출력 없이 exit 0. 어느 item이든 없으면 control/worker를 시작하지 않는다.

### 11.2 age identity와 public recipient

age 1.3.1의 identity를 owner-only FileVault 임시 경로에 만들고, public recipient를 파생한다.

```sh
umask 077 || exit 1
AGE_STAGING_DIR="$(mktemp -d "$BACKUP_TEMP_ROOT/age-keygen.XXXXXX")" || exit 1
export AGE_STAGING_DIR
export AGE_KEYGEN_OUTPUT="$AGE_STAGING_DIR/generated-identity.txt"
export AGE_IDENTITY_STAGING="$AGE_STAGING_DIR/identity-line.txt"
chmod 700 "$AGE_STAGING_DIR" || exit 1
"$AGE_KEYGEN_BINARY" -o "$AGE_KEYGEN_OUTPUT" || exit 1
/usr/bin/grep '^AGE-SECRET-KEY-1' "$AGE_KEYGEN_OUTPUT" > "$AGE_IDENTITY_STAGING" || exit 1
test "$(wc -l < "$AGE_IDENTITY_STAGING" | tr -d ' ')" = "1" || exit 1
AGE_RECIPIENT="$("$AGE_KEYGEN_BINARY" -y "$AGE_IDENTITY_STAGING")" || exit 1
export AGE_RECIPIENT
printf '%s\n' "$AGE_RECIPIENT" || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind age-identity || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind age-identity --apply < "$AGE_IDENTITY_STAGING" || exit 1
```

기대 결과: recipient는 `age1...`, dry-run/apply 출력은 `import-age-identity`와 service 이름만 포함한다. Keychain item 존재와 암복호화 drill을 확인하고, identity의 승인된 오프라인 복구 사본을 별도 매체에서 실제로 읽을 수 있는지 시험한 뒤 staging 파일을 제거한다.

```sh
/usr/bin/security find-generic-password \
  -a "$PORTAL_USER" -s com.jihye.portal.age-identity >/dev/null 2>&1 || exit 1

export AGE_PROBE_PLAIN="$AGE_STAGING_DIR/probe.txt"
export AGE_PROBE_ENCRYPTED="$AGE_STAGING_DIR/probe.age"
export AGE_PROBE_RESTORED="$AGE_STAGING_DIR/probe.restored"
printf 'WisdomPortal age recovery probe\n' > "$AGE_PROBE_PLAIN" || exit 1
"$AGE_BINARY" --encrypt --recipient "$AGE_RECIPIENT" \
  --output "$AGE_PROBE_ENCRYPTED" "$AGE_PROBE_PLAIN" || exit 1
"$AGE_BINARY" --decrypt --identity "$AGE_IDENTITY_STAGING" \
  --output "$AGE_PROBE_RESTORED" "$AGE_PROBE_ENCRYPTED" || exit 1
cmp -s "$AGE_PROBE_PLAIN" "$AGE_PROBE_RESTORED" || exit 1

if [ -z "${AGE_OFFLINE_IDENTITY_FILE:-}" ]; then
  printf 'STOP: 검증할 offline age identity 절대 경로가 필요함\n' >&2
  exit 1
fi
test -f "$AGE_OFFLINE_IDENTITY_FILE" || exit 1
test ! -L "$AGE_OFFLINE_IDENTITY_FILE" || exit 1
test "$(stat -f '%Lp' "$AGE_OFFLINE_IDENTITY_FILE")" = "600" || exit 1
OFFLINE_AGE_RECIPIENT="$("$AGE_KEYGEN_BINARY" -y "$AGE_OFFLINE_IDENTITY_FILE")" || exit 1
test "$OFFLINE_AGE_RECIPIENT" = "$AGE_RECIPIENT" || exit 1

rm -f "$AGE_PROBE_PLAIN" "$AGE_PROBE_ENCRYPTED" "$AGE_PROBE_RESTORED" || exit 1
rm -f "$AGE_IDENTITY_STAGING" "$AGE_KEYGEN_OUTPUT" || exit 1
rmdir "$AGE_STAGING_DIR" || exit 1
unset AGE_IDENTITY_STAGING AGE_KEYGEN_OUTPUT AGE_STAGING_DIR
unset AGE_PROBE_PLAIN AGE_PROBE_ENCRYPTED AGE_PROBE_RESTORED OFFLINE_AGE_RECIPIENT
```

기대 결과: Keychain import, 암복호화 drill, 오프라인 사본 검증을 마친 뒤 Mac의 plaintext staging 파일과 빈 디렉터리만 사라진다. 중단 조건: identity 형식 오류, recipient가 하나의 `age1...` line이 아님, offline 사본 검증 전 staging 삭제. SSD의 파일 삭제를 전체 Keychain recovery bundle로 간주하지 않는다.

### 11.3 IndexNow key

```sh
umask 077 || exit 1
export INDEXNOW_KEYCHAIN_SERVICE=com.jihye.portal.indexnow
INDEXNOW_INPUT="$(mktemp "$BACKUP_TEMP_ROOT/indexnow.XXXXXX")" || exit 1
export INDEXNOW_INPUT
/usr/bin/openssl rand -hex 32 > "$INDEXNOW_INPUT" || exit 1
test -f "$INDEXNOW_INPUT" || exit 1
test ! -L "$INDEXNOW_INPUT" || exit 1
test "$(stat -f '%Lp' "$INDEXNOW_INPUT")" = "600" || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind indexnow-key \
  --service "$INDEXNOW_KEYCHAIN_SERVICE" || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind indexnow-key \
  --service "$INDEXNOW_KEYCHAIN_SERVICE" --apply < "$INDEXNOW_INPUT" || exit 1

/usr/bin/security find-generic-password \
  -a "$PORTAL_USER" -s "$INDEXNOW_KEYCHAIN_SERVICE" >/dev/null 2>&1 || exit 1
rm -f "$INDEXNOW_INPUT" || exit 1
unset INDEXNOW_INPUT
```

기대 결과: metadata-only import 성공과 item 존재. key는 `/indexnow-key.txt`에서 공개되지만 Git·process argv·지속 runtime 파일에는 두지 않는다. import 실패 또는 public key URL과 service mismatch면 IndexNow 전송을 중단한다.

### 11.4 SMTP와 Codex credential

공급자에서 발급한 credential은 non-echo 방식으로 만든 owner-only 임시 입력 파일에 넣는다. Codex 입력은 한 줄 printable credential, SMTP 입력은 `user`와 `password` 두 key만 가진 한 줄 JSON이어야 한다. 실제 값을 command line이나 history에 넣지 않는다.

```sh
export CODEX_KEYCHAIN_SERVICE=com.jihye.portal.codex-api
export SMTP_KEYCHAIN_SERVICE=com.jihye.portal.smtp
export CODEX_CREDENTIAL_INPUT="$BACKUP_TEMP_ROOT/codex-credential.input"
export SMTP_CREDENTIAL_INPUT="$BACKUP_TEMP_ROOT/smtp-credential.input"

test -f "$CODEX_CREDENTIAL_INPUT" || exit 1
test ! -L "$CODEX_CREDENTIAL_INPUT" || exit 1
test -f "$SMTP_CREDENTIAL_INPUT" || exit 1
test ! -L "$SMTP_CREDENTIAL_INPUT" || exit 1
chmod 600 "$CODEX_CREDENTIAL_INPUT" "$SMTP_CREDENTIAL_INPUT" || exit 1
test "$(stat -f '%Lp' "$CODEX_CREDENTIAL_INPUT")" = "600" || exit 1
test "$(stat -f '%Lp' "$SMTP_CREDENTIAL_INPUT")" = "600" || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind codex-api --service "$CODEX_KEYCHAIN_SERVICE" || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind codex-api --service "$CODEX_KEYCHAIN_SERVICE" \
  --apply < "$CODEX_CREDENTIAL_INPUT" || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind smtp-json --service "$SMTP_KEYCHAIN_SERVICE" || exit 1
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/secret-import.mjs" \
  --account "$PORTAL_USER" --kind smtp-json --service "$SMTP_KEYCHAIN_SERVICE" \
  --apply < "$SMTP_CREDENTIAL_INPUT" || exit 1

for service in "$CODEX_KEYCHAIN_SERVICE" "$SMTP_KEYCHAIN_SERVICE"; do
  /usr/bin/security find-generic-password -a "$PORTAL_USER" -s "$service" >/dev/null 2>&1 || exit 1
done
rm -f "$CODEX_CREDENTIAL_INPUT" "$SMTP_CREDENTIAL_INPUT" || exit 1
unset CODEX_CREDENTIAL_INPUT SMTP_CREDENTIAL_INPUT
```

기대 결과: import action/service만 출력되고 두 item이 존재한다. 중단 조건: credential 파일이 symlink/공유 가능, Codex billing·한도 미승인, SMTP가 public FQDN + 465 implicit TLS를 지원하지 않음. SMTP 관리자 설정에는 값이 아니라 `keychain:com.jihye.portal.smtp` reference만 저장한다.

### 11.5 Hermes와 Telegram 경계

Portal은 Telegram bot token·chat ID를 저장하거나 Telegram을 직접 호출하지 않는다. Portal에는 loopback Hermes endpoint와 서로 독립인 일반/monitor HMAC만 필요하다. 그러나 **Hermes HMAC provisioning — 공개 전 구현 필요**다. 현재 script는 Portal Keychain에 값을 생성하지만 값을 출력하지 않으며 기존 Hermes에 동일 비밀을 안전하게 설치하는 완성 절차가 없다. 이 절차와 end-to-end signature test가 생기기 전 Hermes/Telegram channel과 monitor apply를 활성화하지 않는다. 값을 화면에 출력해 복사하는 임시 우회는 금지한다.

## 12. 로컬 bootstrap public release

이 단계는 Tunnel이 unloaded인 로컬 rehearsal이다. fixture build는 프로덕션 콘텐츠가 아니며 외부에 노출하지 않는다.

```sh
validate_launchctl_missing_service() {
  missing_file=$1
  missing_label=$2
  if [ ! -f "$missing_file" ] || [ -L "$missing_file" ] || [ -z "$missing_label" ]; then
    return 1
  fi
  LC_ALL=C /usr/bin/awk -v label="$missing_label" -v uid="$PORTAL_UID" '
    BEGIN {
      expected = "Could not find service \"" label "\" in domain for user gui: " uid
      optional_prefix = "Bad request."
    }
    {
      current = $0
      sub(/\r$/, "", current)
      observed[NR] = current
    }
    END {
      if (NR == 1 && observed[1] == expected) exit 0
      if (NR == 2 && observed[1] == optional_prefix && observed[2] == expected) exit 0
      exit 1
    }
  ' "$missing_file" || return 1
}

launchctl print "gui/$PORTAL_UID" >/dev/null 2>&1 || exit 1
export CLOUDFLARED_PROBE_ERROR="$BACKUP_TEMP_ROOT/cloudflared-launchctl.stderr"
test ! -e "$CLOUDFLARED_PROBE_ERROR" || exit 1
: > "$CLOUDFLARED_PROBE_ERROR" || exit 1
chmod 600 "$CLOUDFLARED_PROBE_ERROR" || exit 1
if launchctl print "gui/$PORTAL_UID/com.jihye.portal.cloudflared" \
  >/dev/null 2>"$CLOUDFLARED_PROBE_ERROR"; then
  printf 'STOP: bootstrap 동안 Tunnel이 loaded 상태\n' >&2
  exit 1
else
  CLOUDFLARED_PROBE_STATUS=$?
fi
test "$CLOUDFLARED_PROBE_STATUS" -ne 0 || exit 1
test "$(stat -f '%z' "$CLOUDFLARED_PROBE_ERROR")" -le 1024 || exit 1
validate_launchctl_missing_service "$CLOUDFLARED_PROBE_ERROR" 'com.jihye.portal.cloudflared' || exit 1
rm -f "$CLOUDFLARED_PROBE_ERROR" || exit 1
unset CLOUDFLARED_PROBE_ERROR CLOUDFLARED_PROBE_STATUS

cd "$SOURCE_ROOT" || exit 1
npm run build:fixture --workspace @wisdom/site || exit 1
BOOTSTRAP_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)" || exit 1
export BOOTSTRAP_RELEASE_ID

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/seed-public.mjs" \
  --source-dist "$SOURCE_ROOT/apps/site/dist" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" \
  --release-id "$BOOTSTRAP_RELEASE_ID" || exit 1

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/seed-public.mjs" \
  --source-dist "$SOURCE_ROOT/apps/site/dist" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" \
  --release-id "$BOOTSTRAP_RELEASE_ID" --apply || exit 1
```

기대 결과: dry-run은 `dryRun: true`와 네 단계 plan, apply는 `verified: true`와 `seed-public-current`를 반환한다. 중단 조건: Tunnel loaded, release ID/path/symlink/manifest 오류, destination 재사용. bootstrap `.ops-public-release.json`은 정상 Wisdom release의 authority가 아니다.

보호된 monitoring 설정이 준비되면 local staging preflight를 실행한다.

```sh
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/preflight.mjs" \
  --monitor-config "$APP_ROOT/shared/monitoring.json" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --data-root "$DATA_ROOT" \
  --caddy "$CADDY_BINARY" \
  --cloudflared "$CLOUDFLARED_BINARY" \
  --age "$AGE_BINARY" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" \
  --allow-bootstrap-local-staging || exit 1
```

기대 결과: `ok: true`, `ageVersion: "1.3.1"`, SQLite 3.51.3 이상, `monitoringConfigValidated: true`, `tunnelReady: false`, `tunnelDisabledVerified: true`. 다른 결과나 sanitized `Preflight failed` code가 나오면 중단한다. 이 flag는 bootstrap staging에만 쓰며 외부 공개 승인이 아니다.

## 13. application deploy와 launchd

### 13.1 deploy dry-run과 apply

승인 commit에서 새 release ID를 만든다. canary `18787`이 비어 있어야 한다.

```sh
cd "$SOURCE_ROOT" || exit 1
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)" || exit 1
export RELEASE_ID

"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/deploy.mjs" \
  --source "$SOURCE_ROOT" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --release-id "$RELEASE_ID" \
  --canary-port 18787 || exit 1
```

기대 결과: JSON dry-run plan이며 파일·서비스·DB를 변경하지 않는다. path/release ID/canary 검증 실패면 apply하지 않는다.

아래 apply는 9.1의 production installer를 실행해 보호된 runtime/monitoring 파일을 설치·검증하고, 나머지 관련 차단 항목과 bootstrap public pointer가 검증된 뒤에만 실행한다.

```sh
"$NODE_BINARY" "$SOURCE_ROOT/ops/scripts/deploy.mjs" \
  --source "$SOURCE_ROOT" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --release-id "$RELEASE_ID" \
  --canary-port 18787 \
  --node "$NODE_BINARY" \
  --npm "$NPM_BINARY" \
  --runtime-config "$APP_ROOT/shared/runtime.env" \
  --monitor-config "$APP_ROOT/shared/monitoring.json" \
  --data-root "$DATA_ROOT" \
  --caddy "$CADDY_BINARY" \
  --cloudflared "$CLOUDFLARED_BINARY" \
  --age "$AGE_BINARY" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" \
  --public-live-url "https://$PUBLIC_HOST/health/live" \
  --account "$PORTAL_USER" \
  --apply || exit 1
```

기대 결과: native install/build/schema gate/canary/manifest/pointer/service 검증을 모두 통과한 deploy JSON. 어느 단계든 실패하면 중단하고 자동 pointer/service 복구 결과를 확인한다. release 디렉터리를 수동 수정하거나 current symlink를 수동 교체하지 않는다.

검증된 보존 release로 rollback할 때도 먼저 dry-run한다. **rollback dry-run은 인자·경로·계획의 문법적 검증일 뿐** retained release의 실제 manifest·migration 호환성·canary 성공을 증명하지 않는다. apply가 이 검사를 pointer switch 전에 다시 수행하며 하나라도 실패하면 pointer를 바꾸지 않아야 한다.

```sh
if [ -z "${RETAINED_RELEASE_ID:-}" ]; then
  printf 'STOP: verified retained release ID가 필요함\n' >&2
  exit 1
fi
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/rollback.mjs" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --release-id "$RETAINED_RELEASE_ID" \
  --canary-port 18787 || exit 1
```

기대 결과: rollback dry-run은 syntactic plan만 출력하고 pointer를 바꾸지 않는다. 중단 조건: 인자·경로·release ID plan 오류. 실제 retained release·manifest·migration·canary 판정은 다음 apply에서 pointer switch **전에** 수행된다.

```sh
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/rollback.mjs" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --release-id "$RETAINED_RELEASE_ID" \
  --canary-port 18787 \
  --node "$NODE_BINARY" \
  --npm "$NPM_BINARY" \
  --runtime-config "$APP_ROOT/shared/runtime.env" \
  --monitor-config "$APP_ROOT/shared/monitoring.json" \
  --data-root "$DATA_ROOT" \
  --caddy "$CADDY_BINARY" \
  --cloudflared "$CLOUDFLARED_BINARY" \
  --age "$AGE_BINARY" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" \
  --public-live-url "https://$PUBLIC_HOST/health/live" \
  --account "$PORTAL_USER" \
  --apply || exit 1
```

기대 결과: verified retained release로 원자 전환하고 service/readiness를 통과한다. 실패 시 기존 pointer 복구까지 확인하며 수동 symlink 교체나 incompatible migration 우회를 하지 않는다.

### 13.2 launchd 설치 이후의 검사 명령

다음 lifecycle 명령은 **9.1의 installer가 실제 plist를 설치하고 설치 후 validator가 통과한 이후**에만 사용한다. installer 자체는 `launchctl`을 호출하지 않는다. bootstrap 중 cloudflared는 loaded하면 안 된다.

```sh
plutil -lint "$HOME/Library/LaunchAgents"/com.jihye.portal.*.plist || exit 1

for label in \
  com.jihye.portal.caddy \
  com.jihye.portal.control \
  com.jihye.portal.notification-worker \
  com.jihye.portal.content-worker \
  com.jihye.portal.backup \
  com.jihye.portal.retention \
  com.jihye.portal.monitor; do
  launchctl print "gui/$PORTAL_UID/$label" || exit 1
done

launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.control" || exit 1
launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.monitor" || exit 1
```

기대 결과: plist `OK`, 각 label의 program·last exit status·절대 경로가 승인값과 일치한다. missing label, 반복 crash, nonzero exit status면 Tunnel을 시작하지 않는다. 설치/재설치의 실제 lifecycle은 다음 형식이지만 검증된 installer가 ownership과 원자 설치를 책임져야 한다.

```sh
launchctl print "gui/$PORTAL_UID/com.jihye.portal.control" >/dev/null 2>&1 || exit 1
launchctl bootout "gui/$PORTAL_UID/com.jihye.portal.control" || exit 1
launchctl bootstrap "gui/$PORTAL_UID" "$HOME/Library/LaunchAgents/com.jihye.portal.control.plist" || exit 1
launchctl print "gui/$PORTAL_UID/com.jihye.portal.control" || exit 1
```

기대 결과: 승인된 plist의 control service가 한 번 등록되고 `launchctl print`에 승인된 program 경로와 정상 상태가 보인다. 중단 조건: service가 loaded되지 않았는데 `bootout` 실행, bootstrap 실패, 반복 crash, 승인되지 않은 program 경로. `bootout`은 service가 실제 loaded인지 먼저 확인하고 maintenance window에서만 수행한다. 이 한 label 예를 전체 installer로 오해하지 않는다.

## 14. 최초 owner와 MFA

저장소의 npm aliases는 `admin:bootstrap`, `admin:password-reset`, `admin:mfa-replace`이지만, production에서는 비밀을 `.env`에 쓰지 않고 `keychain-exec.mjs`가 보호된 runtime과 5개 application secret을 주입한 뒤 빌드된 CLI를 실행한다.

먼저 owner 식별자와 output 위치를 결정하고, output 파일이 없는지 확인한다.

```sh
if [ -z "${OWNER_USERNAME:-}" ] || [ -z "${OWNER_DISPLAY_NAME:-}" ]; then
  printf 'STOP: owner username과 display name이 필요함\n' >&2
  exit 1
fi
export OWNER_ENROLLMENT="$BACKUP_TEMP_ROOT/owner-enrollment.json"
test ! -e "$OWNER_ENROLLMENT" || exit 1

SAVED_STTY="$(stty -g)" || exit 1
stty -echo || exit 1
if ! IFS= read -r OWNER_PASSWORD; then
  stty "$SAVED_STTY" || exit 1
  unset SAVED_STTY OWNER_PASSWORD
  exit 1
fi
stty "$SAVED_STTY" || exit 1
unset SAVED_STTY
printf '\n' || exit 1
if [ -z "$OWNER_PASSWORD" ]; then
  unset OWNER_PASSWORD
  exit 1
fi
printf '%s\n' "$OWNER_PASSWORD" | \
  "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
    --account "$PORTAL_USER" \
    --config "$APP_ROOT/shared/runtime.env" \
    --secret ADMIN_SESSION_SECRET=com.jihye.portal.admin-session \
    --secret CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac \
    --secret HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac \
    --secret PII_ENCRYPTION_KEY=com.jihye.portal.pii-key \
    --secret WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token \
    -- "$NODE_BINARY" "$CURRENT_RELEASE/apps/control/dist/admin/cli.js" \
      bootstrap \
      --username "$OWNER_USERNAME" \
      --display-name "$OWNER_DISPLAY_NAME" \
      --output "$OWNER_ENROLLMENT" || { unset OWNER_PASSWORD; exit 1; }
unset OWNER_PASSWORD

test -f "$OWNER_ENROLLMENT" || exit 1
test ! -L "$OWNER_ENROLLMENT" || exit 1
test "$(stat -f '%Lp' "$OWNER_ENROLLMENT")" = "600" || exit 1
```

기대 결과: stdout은 `admin.cli.succeeded`와 command만 포함하고 enrollment 파일은 `0600` 실제 파일이다. stderr의 generic failure, 기존 output, password stdin 오류, Keychain/runtime 실패면 중단한다. enrollment 내용을 터미널에 출력하지 않는다.

인증 앱에 TOTP를 등록하고 새 브라우저에서 password+TOTP 로그인을 시험한다. 10개 recovery code는 Mac 밖의 봉인된 보관소로 옮기고 접근 권한을 시험한 뒤 일반 파일을 제거한다.

```sh
if [ "${OWNER_ENROLLMENT_VERIFIED:-}" != "yes" ]; then
  printf 'STOP: TOTP·offline recovery code·새 로그인을 모두 검증한 뒤 OWNER_ENROLLMENT_VERIFIED=yes로 승인함\n' >&2
  exit 1
fi
rm -f "$OWNER_ENROLLMENT" || exit 1
unset OWNER_ENROLLMENT
unset OWNER_ENROLLMENT_VERIFIED
```

기대 결과: 오프라인 보관과 새 로그인을 검증한 뒤 Mac의 일시 enrollment 파일만 사라진다. 중단 조건: TOTP 등록, recovery code 오프라인 보관, 새 로그인 중 하나라도 검증되지 않았으면 삭제하지 않는다.

MFA 장치 교체는 로그인 가능한 별도 승인 경로를 확보한 maintenance window에서만 수행한다.

```sh
export OWNER_MFA_REPLACEMENT="$BACKUP_TEMP_ROOT/owner-mfa-replacement.json"
test ! -e "$OWNER_MFA_REPLACEMENT" || exit 1
test -n "${OWNER_USERNAME:-}" || exit 1

"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret ADMIN_SESSION_SECRET=com.jihye.portal.admin-session \
  --secret CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac \
  --secret HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac \
  --secret PII_ENCRYPTION_KEY=com.jihye.portal.pii-key \
  --secret WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/apps/control/dist/admin/cli.js" \
    mfa-replace --username "$OWNER_USERNAME" --output "$OWNER_MFA_REPLACEMENT" || exit 1
test -f "$OWNER_MFA_REPLACEMENT" || exit 1
test ! -L "$OWNER_MFA_REPLACEMENT" || exit 1
test "$(stat -f '%Lp' "$OWNER_MFA_REPLACEMENT")" = "600" || exit 1
```

기대 결과: generic success와 새 `0600` enrollment 파일, 기존 session 전부 철회. 새 TOTP 등록, 새 recovery code의 Mac 밖 오프라인 복사와 실제 읽기, password+새 TOTP 로그인을 모두 검증한 뒤에만 다음 cleanup을 승인한다. 중단 조건: 세 검증 중 하나라도 실패했거나 기존 장치를 먼저 폐기하려는 경우.

```sh
if [ "${OWNER_MFA_REPLACEMENT_VERIFIED:-}" != "yes" ]; then
  printf 'STOP: 새 TOTP·offline recovery code·새 로그인 검증이 필요함\n' >&2
  exit 1
fi
rm -f "$OWNER_MFA_REPLACEMENT" || exit 1
unset OWNER_MFA_REPLACEMENT
unset OWNER_MFA_REPLACEMENT_VERIFIED
```

기대 결과: 검증을 마친 뒤 plaintext replacement enrollment 파일과 shell 경로가 사라진다. 중단 조건: 오프라인 사본·새 로그인 증거가 없으면 삭제하지 않는다. password reset은 같은 wrapper의 child를 `password-reset --username "$OWNER_USERNAME"`으로 실행하고 새 password 한 줄을 stdin으로만 넣는다.

## 15. 4개 언어 동의문 8개와 활성화

bundle에는 개인정보 문서와 선택 마케팅 문서가 각각 `ko`, `en`, `zh-Hans`, `zh-Hant`로 있어야 한다. 각 문서의 version, effective time, 본문 hash, 승인자와 보유기간 계약을 사람이 확인한다. Codex 번역 결과만으로 법적 승인하지 않는다.

```sh
if [ -z "${CONSENT_BUNDLE_FILE:-}" ] || [ -z "${CONSENT_BUNDLE_ID:-}" ]; then
  printf 'STOP: approved consent bundle file과 ID가 필요함\n' >&2
  exit 1
fi
test -f "$CONSENT_BUNDLE_FILE" && test ! -L "$CONSENT_BUNDLE_FILE" || exit 1

"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret ADMIN_SESSION_SECRET=com.jihye.portal.admin-session \
  --secret CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac \
  --secret HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac \
  --secret PII_ENCRYPTION_KEY=com.jihye.portal.pii-key \
  --secret WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/apps/control/dist/cli/consent-seed.js" \
    --file "$CONSENT_BUNDLE_FILE" || exit 1
```

기대 결과: `consent.seeded`, 정확히 8개 insert 대상, bundle ID와 64자리 lowercase `confirmSha`. 중단 조건: locale/type 누락, 중복, 승인값 불일치. 출력 SHA를 운영 기록에서 대조한 뒤 환경으로 전달한다.

```sh
if [ -z "${CONSENT_CONFIRM_SHA:-}" ] || [ -z "${CONSENT_BUNDLE_ID:-}" ]; then
  printf 'STOP: exact seed SHA-256와 bundle ID가 필요함\n' >&2
  exit 1
fi

"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret ADMIN_SESSION_SECRET=com.jihye.portal.admin-session \
  --secret CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac \
  --secret HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac \
  --secret PII_ENCRYPTION_KEY=com.jihye.portal.pii-key \
  --secret WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/apps/control/dist/cli/consent-activate.js" \
    --bundle "$CONSENT_BUNDLE_ID" --confirm-sha "$CONSENT_CONFIRM_SHA" || exit 1
```

기대 결과: `consent.activated`, `publicAuthority: "pending-publication"`, next action `/admin/publish/preview`. activation만으로 공개 정책이나 상담 authority가 바뀌지 않는다. SHA mismatch 또는 8문서 readiness 실패면 중단한다.

## 16. 첫 정상 publication과 Tunnel 공개

정상 publication은 CLI가 없다. MFA 인증된 관리자 브라우저에서 `GET /admin/publish/preview`를 검토하고 CSRF와 정확한 확인값을 포함한 `POST /admin/publish`를 실행하는 UI-only 작업이다. 성공은 303 후 verified immutable Wisdom public release와 원자적 `public-current` 전환이다. 실패 시 기존 pointer가 유지되어야 한다.

현재는 **first normal publication bootstrap — 공개 전 구현 필요**다. Tunnel을 끈 bootstrap에서 관리자 cookie는 Secure인데 문서화된 안전한 local HTTPS 경로가 없다. Secure cookie를 약화하거나 HTTP로 우회하지 않는다. 또한 **Kakao URL publication allowlist — 공개 전 구현 필요**이므로 Kakao URL이 격리 build와 sealed release에 포함된다는 테스트 전에는 CTA 완성으로 승인하지 않는다.

두 차단 항목을 구현한 뒤에만 policy-only 또는 승인 글을 관리자 UI에서 publication한다. 그 다음 bootstrap flag 없이 같은 preflight를 실행한다.

```sh
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/preflight.mjs" \
  --monitor-config "$APP_ROOT/shared/monitoring.json" \
  --release-root "$RELEASE_ROOT" \
  --current "$CURRENT_RELEASE" \
  --data-root "$DATA_ROOT" \
  --caddy "$CADDY_BINARY" \
  --cloudflared "$CLOUDFLARED_BINARY" \
  --age "$AGE_BINARY" \
  --public-release-root "$PUBLIC_RELEASE_ROOT" \
  --public-current "$PUBLIC_CURRENT_RELEASE" || exit 1
```

기대 결과: verified Wisdom manifest·index·8문서 consent bundle과 `tunnelReady: true`, `monitoringConfigValidated: true`. bootstrap format, `tunnelReady: false`, 또는 error code면 Tunnel을 시작하지 않는다.

**tunnel-off Host-aware health probe — 공개 전 구현 필요**도 해결되어야 한다. host 기반 Caddy에 Host 없는 loopback probe를 성공으로 가장하지 않는다. 모든 게이트가 닫힌 뒤 검증된 cloudflared plist를 시작한다.

```sh
launchctl bootstrap \
  "gui/$PORTAL_UID" \
  "$HOME/Library/LaunchAgents/com.jihye.portal.cloudflared.plist" || exit 1
launchctl print "gui/$PORTAL_UID/com.jihye.portal.cloudflared" || exit 1
```

기대 결과: 승인 binary/config로 running, 반복 restart·nonzero exit 없음. 중단 조건: preflight gate 미통과, credential/DNS/ingress mismatch, 외부 unknown host가 404가 아님.

## 17. SMTP·Hermes·Telegram과 공식 링크

MFA 관리자 UI `GET /admin/notifications`에서 설정한다.

1. 이메일은 public SMTP FQDN, port `465`, `implicit-tls`, 승인 From/To, `keychain:com.jihye.portal.smtp` 참조를 입력한다.
2. 기본 `receipt-only`는 상담 본문 PII를 복호화하지 않는다. `full-inquiry`는 개인정보 책임자의 명시 승인과 실제 수신함 보안 검토 뒤 체크한다.
3. `/admin/notifications/test`에서 email test를 queue하고 실제 mailbox 수신과 outbox 성공을 확인한다.
4. Hermes channel은 HMAC provisioning blocker 해결 후에만 켠다. test는 Telegram에 접수 ID·시간·안전한 분류 같은 metadata만 전달하고 이름·전화·이메일·상담 본문이 없어야 한다.

기대 결과: 관리자 화면은 secret 값을 표시하지 않고 configured 여부만 표시하며, email/Hermes 각각 test delivery가 완료된다. 중단 조건: SMTP TLS/DNS pinning 오류, `full-inquiry` 미승인, Telegram에 PII, Portal에 bot token/chat ID 저장, 일반/monitor HMAC 재사용.

공식 Blog·Map·Kakao URL은 모바일 앱 설치/미설치와 데스크톱에서 확인한다. Kakao 클릭은 상담 접수 완료가 아니며 폼·전화 같은 대체 경로가 항상 있어야 한다.

## 18. Google·Naver·IndexNow·검색 표면

### 18.1 공개 파일과 canonical 점검

```sh
curl -fsSI "$PUBLIC_ORIGIN/" || exit 1
curl -fsSI "$PUBLIC_ORIGIN/sitemap.xml" || exit 1
curl -fsSI "$PUBLIC_ORIGIN/rss.xml" || exit 1
curl -fsS "$PUBLIC_ORIGIN/robots.txt" || exit 1
curl -fsSI "$PUBLIC_ORIGIN/indexnow-key.txt" || exit 1
```

기대 결과: public home 200, sitemap `application/xml`, RSS `application/rss+xml`, robots가 공개 페이지를 허용하면서 admin을 authority로 사용하지 않음, IndexNow key endpoint 200 + `no-store`/`noindex`. 중단 조건: canonical host redirect loop, bootstrap/fixture 콘텐츠, secret/PII 노출, sitemap·hreflang·locale 누락.

### 18.2 소유권과 제출

- Google Search Console에는 apex **Domain Property**를 만들고 공급자가 준 DNS TXT를 Cloudflare DNS에 추가해 Verify한다. TXT를 HTML, sitemap, RSS, log, persistent runtime, Git에 쓰지 않는다.
- Naver Search Advisor에는 canonical public site를 등록한다. `NAVER_SITE_VERIFICATION_FILE` 또는 `NAVER_SITE_VERIFICATION_META` 중 정확히 하나만 선택해 새 sealed public release로 게시한다. 파일 방식은 `naver` + 24~128자리 ASCII 영숫자·밑줄·하이픈 + `.html` 형식만 허용한다. 두 값 동시·0개인 상태에서 소유권 완료로 기록하지 않는다.
- IndexNow Keychain key와 `https://$PUBLIC_HOST/indexnow-key.txt`를 대조하고 publication 후 outbox 성공을 확인한다. IndexNow는 갱신 통지이며 Naver 색인, 검색 순위, ChatGPT·Gemini 인용을 보장하지 않는다.
- Search Console·Naver Search Advisor에서 sitemap을 제출하고 수집/색인 오류를 운영 기록에 남긴다. Google·Naver·AI 노출은 크롤링·색인·콘텐츠·신뢰·기술 안정성의 결과이며 보장 상품으로 표현하지 않는다.

기대 결과: 두 서비스의 소유권, sitemap 수집, 공개 URL 검사 증거가 있다. 중단 조건: verification 값을 Git에 넣음, Naver 두 방식 동시 설정, 검색 순위·AI 인용을 보장한다고 광고함.

## 19. 관리자 자동 백업 ON/OFF

자동 백업 정책의 진실 원천은 schema v7 SQLite singleton이다. CLI로 정책을 바꾸거나 LaunchAgent를 unload하지 않는다. MFA 관리자 UI `GET /admin/backups`와 CSRF 보호된 `POST /admin/backups`만 사용한다.

### OFF

- 정확한 위험 확인과 현재 `rowVersion`이 필요하다. stale 화면은 `409 Conflict`이므로 새로고침한다.
- 기존 `.age`/`.json` pair와 restore 기능은 그대로 둔다.
- **정기 자동 backup 생성과 backup artifact retention만** 중단한다. 상담 보유기간 purge LaunchAgent는 계속 동작한다.
- 수동 backup은 가능하다.
- 60-minute RPO 목표는 OFF 동안 무효다.
- 2차 policy check를 이미 통과해 시작된 한 건은 강제 종료하지 않고 완료될 수 있다.
- dispatcher가 OFF를 먼저 보면 Keychain, verified-pair scan, SQLite snapshot, age, backup retention을 호출하지 않는다.

다음 monitor는 `BACKUP_ADMIN_DISABLED`를 unhealthy로 1회 Hermes/Telegram에 알린다. 동일 disabled-only fingerprint는 시간 경과와 무관하게 반복 전송하지 않는다. 디스크·control readiness·launchd·queue/failure backlog·상담 retention 검사는 OFF 중에도 계속하고, 새 실제 장애가 추가되면 fingerprint가 바뀌어 즉시 다시 알린다.

### ON

ON에는 위험 확인문구가 없지만 현재 `rowVersion`은 필요하다. Mac이 깨어 있고 로그인 세션과 `com.jihye.portal.backup` LaunchAgent가 정상이라는 조건에서 secret-free dispatcher의 다음 60-second scheduling opportunity에 한 번 시작하는지 관찰한다. launchd는 hard real-time scheduler가 아니므로 “60초 보장”이 아니라 이상 탐지 기준으로 사용한다.

```sh
launchctl print "gui/$PORTAL_UID/com.jihye.portal.backup" || exit 1
```

기대 결과: StartInterval/ThrottleInterval 60, 최신 run의 sanitized 상태가 관리자 화면에서 `running` 뒤 `verified`, 그리고 그 뒤 60분 전에는 중복 artifact가 없다. 60초가 지나도 start 관측이 없으면 LaunchAgent·정책 revision·로그의 안전한 error code를 확인하고 공개 운영을 중단한다.

OFF→ON 후 post-transition verified pair가 없으면 monitor는 정확히 10분 미만 동안 `BACKUP_RESUME_GRACE`로 exit 0, 알림 없음이다. grace는 기존 disabled incident를 읽거나 지우지 않는다. 정확히 10분에 pair가 없으면 정상 backup failure가 되며, post-transition verified 성공이 확인된 뒤에만 이전 incident가 정리된다.

## 20. 수동 암호화 backup

수동 backup은 `--automatic`을 **넣지 않는다**. 먼저 secret-free dry-run을 확인한다.

```sh
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/backup.mjs" \
  --source "$DATA_ROOT/portal.sqlite" \
  --root "$BACKUP_ROOT" \
  --temp-root "$BACKUP_TEMP_ROOT" \
  --age "$AGE_BINARY" \
  --recipient "$AGE_RECIPIENT" || exit 1
```

기대 결과: `dryRun: true`, `automatic: false`, hourly 24/daily 14 retention plan. path·recipient 오류 또는 예상하지 않은 source/root면 apply하지 않는다.

실행은 age identity를 argv나 일반 환경에 직접 넣지 않고 Keychain wrapper를 사용한다.

```sh
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret AGE_IDENTITY=com.jihye.portal.age-identity \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/backup.mjs" \
    --source "$DATA_ROOT/portal.sqlite" \
    --root "$BACKUP_ROOT" \
    --temp-root "$BACKUP_TEMP_ROOT" \
    --age "$AGE_BINARY" \
    --recipient "$AGE_RECIPIENT" \
    --apply || exit 1
```

기대 결과: `dryRun: false`, `verified: true`, artifact **basename**, 64자리 encrypted SHA-256, byte size만 출력한다. `Backup failed` code, DB maintenance lock, SQLite integrity/schema, encrypt/decrypt/hash, status publication, retention 오류면 실패로 기록하고 pair를 복구 근거로 사용하지 않는다. 관리자 automatic OFF여도 이 수동 명령은 정상 동작해야 한다.

생성된 pair의 basename·두 파일 mode·stable size를 확인하고, restore가 status의 full SHA-256/size를 다시 검증하게 한다.

```sh
if [ -z "${BACKUP_ARTIFACT:-}" ]; then
  printf 'STOP: verified hourly .age 절대 경로가 필요함\n' >&2
  exit 1
fi
export BACKUP_STATUS="${BACKUP_ARTIFACT%.age}.json"
test -f "$BACKUP_ARTIFACT" || exit 1
test ! -L "$BACKUP_ARTIFACT" || exit 1
test -f "$BACKUP_STATUS" || exit 1
test ! -L "$BACKUP_STATUS" || exit 1
test "$(stat -f '%Lp' "$BACKUP_ARTIFACT")" = "600" || exit 1
test "$(stat -f '%Lp' "$BACKUP_STATUS")" = "600" || exit 1
stat -f '%Lp %z %N' "$BACKUP_ARTIFACT" "$BACKUP_STATUS" || exit 1
shasum -a 256 "$BACKUP_ARTIFACT" || exit 1
```

기대 결과: 두 파일은 direct backup-root child, mode `0600`, `.json`의 `encryptedBytes`/`encryptedSha256`와 실제 artifact가 일치한다. 수동 `shasum` 출력만으로 restore 검증을 생략하지 않는다.

## 21. guarded restore와 별도 target drill

### 21.1 정책 규칙

- readable current target DB가 있으면 그 ON/OFF가 오래된 backup 안의 값보다 항상 우선한다. flag를 생략하거나, 넣는다면 현재 값과 같아야 한다. 충돌은 복호화·quarantine 전에 `RESTORE_BACKUP_POLICY_CONFLICT`로 중단한다.
- target DB가 없거나 손상되어 정책을 읽을 수 없으면 apply에 정확히 `--automatic-backup-after-restore enabled` 또는 `--automatic-backup-after-restore disabled`가 필수다. 생략은 `RESTORE_BACKUP_POLICY_REQUIRED`다.
- dry-run은 SQLite와 Keychain을 열지 않고 `automaticBackupPolicy: "preserve-current"`, `explicitFallback`, `inputRequiredIfCurrentUnreadable: true`를 보여준다.
- staged DB에는 retention 이후, 최종 integrity/schema 검사 전에 선택 정책과 system audit을 같은 transaction으로 기록한다.

### 21.2 missing target에 대한 격리 drill

운영 DB를 덮지 않는 새 target을 선택한다. 이 target은 정책을 읽을 수 없으므로 여기서는 의도적으로 `disabled` fallback을 사용한다. 다만 이 도구에는 no-service drill mode가 없다. **별도 target restore도 운영 control·notification-worker·content-worker를 중단한 뒤 다시 시작하고 production readiness를 검사**하므로 실제 outage를 만든다. 승인된 maintenance window와 현장/원격 복구 담당자를 확보하고 외부 uptime maintenance를 설정한다. 설정하지 않으면 external uptime이 의도된 중단을 실제 장애로 알릴 수 있다.

새 로그인 또는 새 shell 세션에서 수행한다면 5절의 표준 경로·환경 변수 블록을 먼저 다시 실행하고 모든 값·권한 사전검증을 통과해야 한다. 아래 apply 블록은 12절에서 만든 shell 함수에 의존하지 않도록 missing-service validator를 자체 정의한다.

```sh
export RESTORE_DRILL_ROOT="$DATA_ROOT/restore-drill"
export RESTORE_DRILL_TARGET="$RESTORE_DRILL_ROOT/portal.sqlite"
mkdir -p "$RESTORE_DRILL_ROOT" || exit 1
chmod 700 "$RESTORE_DRILL_ROOT" || exit 1
test -d "$RESTORE_DRILL_ROOT" || exit 1
test ! -L "$RESTORE_DRILL_ROOT" || exit 1
test "$(stat -f '%Lp' "$RESTORE_DRILL_ROOT")" = "700" || exit 1
test ! -e "$RESTORE_DRILL_TARGET" || exit 1

date -u '+restore-drill-start %Y-%m-%dT%H:%M:%SZ' || exit 1
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/restore.mjs" \
  --backup-root "$BACKUP_ROOT" \
  --backup "$BACKUP_ARTIFACT" \
  --target "$RESTORE_DRILL_TARGET" \
  --temp-root "$BACKUP_TEMP_ROOT" \
  --age "$AGE_BINARY" \
  --automatic-backup-after-restore disabled || exit 1
```

기대 결과: dry-run policy가 `preserve-current`, explicit fallback `disabled`, input-required rule과 bounded steps를 표시한다. backup이 direct child가 아니거나 target/temp/path가 unsafe하면 중단한다.

apply는 exact resolved target confirmation과 Keychain marker가 모두 필요하다. dry-run 성공을 확인한 뒤 maintenance 시작을 기록하고, live service 세 개를 정확히 bootout한 다음 모두 stopped/unloaded임을 증명한다. restore library는 내부 service-stop 단계에 진입한 뒤의 성공·실패 경로에서는 세 production service를 복구하지만, 그보다 이른 inspection 실패까지 책임지지는 않는다. 따라서 다음 operator-shell recovery trap을 **첫 bootout 전에** arm하고, restore 성공·세 service running·production readiness HTTP 200을 모두 확인한 뒤에만 disarm한다. 임의의 별도 service나 no-service 우회를 만들지 않는다.

```sh
validate_launchctl_missing_service() {
  missing_file=$1
  missing_label=$2
  if [ ! -f "$missing_file" ] || [ -L "$missing_file" ] || [ -z "$missing_label" ]; then
    return 1
  fi
  LC_ALL=C /usr/bin/awk -v label="$missing_label" -v uid="$PORTAL_UID" '
    BEGIN {
      expected = "Could not find service \"" label "\" in domain for user gui: " uid
      optional_prefix = "Bad request."
    }
    {
      current = $0
      sub(/\r$/, "", current)
      observed[NR] = current
    }
    END {
      if (NR == 1 && observed[1] == expected) exit 0
      if (NR == 2 && observed[1] == optional_prefix && observed[2] == expected) exit 0
      exit 1
    }
  ' "$missing_file" || return 1
}

launchctl print "gui/$PORTAL_UID" >/dev/null 2>&1 || exit 1

restore_production_services() {
  if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.control" >/dev/null 2>&1; then
    if ! launchctl bootstrap "gui/$PORTAL_UID" \
      "$HOME/Library/LaunchAgents/com.jihye.portal.control.plist" >/dev/null 2>&1; then return 1; fi
    if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.control" >/dev/null 2>&1; then return 1; fi
  fi
  if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.notification-worker" >/dev/null 2>&1; then
    if ! launchctl bootstrap "gui/$PORTAL_UID" \
      "$HOME/Library/LaunchAgents/com.jihye.portal.notification-worker.plist" >/dev/null 2>&1; then return 1; fi
    if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.notification-worker" >/dev/null 2>&1; then return 1; fi
  fi
  if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.content-worker" >/dev/null 2>&1; then
    if ! launchctl bootstrap "gui/$PORTAL_UID" \
      "$HOME/Library/LaunchAgents/com.jihye.portal.content-worker.plist" >/dev/null 2>&1; then return 1; fi
    if ! launchctl kickstart -k "gui/$PORTAL_UID/com.jihye.portal.content-worker" >/dev/null 2>&1; then return 1; fi
  fi
  launchctl print "gui/$PORTAL_UID/com.jihye.portal.control" | \
    /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || return 1
  launchctl print "gui/$PORTAL_UID/com.jihye.portal.notification-worker" | \
    /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || return 1
  launchctl print "gui/$PORTAL_UID/com.jihye.portal.content-worker" | \
    /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || return 1
  curl -fsS "http://127.0.0.1:8787/health/ready" >/dev/null || return 1
}

restore_recovery_handler() {
  RESTORE_EXIT_STATUS=$?
  if ! trap - EXIT HUP INT TERM; then
    return 1
  fi
  if [ "${RESTORE_RECOVERY_ARMED:-no}" = "yes" ]; then
    if ! restore_production_services; then
      printf 'STOP: restore 조기 종료 후 production service/readiness 복구 실패\n' >&2
      exit 1
    fi
  fi
  exit "$RESTORE_EXIT_STATUS"
}

trap 'restore_recovery_handler' EXIT HUP INT TERM || exit 1
RESTORE_RECOVERY_ARMED=yes

launchctl bootout "gui/$PORTAL_UID/com.jihye.portal.control" || exit 1
launchctl bootout "gui/$PORTAL_UID/com.jihye.portal.notification-worker" || exit 1
launchctl bootout "gui/$PORTAL_UID/com.jihye.portal.content-worker" || exit 1

export RESTORE_CONTROL_PROBE="$BACKUP_TEMP_ROOT/restore-control-launchctl.stderr"
test ! -e "$RESTORE_CONTROL_PROBE" || exit 1
: > "$RESTORE_CONTROL_PROBE" || exit 1
chmod 600 "$RESTORE_CONTROL_PROBE" || exit 1
if launchctl print "gui/$PORTAL_UID/com.jihye.portal.control" \
  >/dev/null 2>"$RESTORE_CONTROL_PROBE"; then
  printf 'STOP: control service가 아직 loaded 상태\n' >&2
  exit 1
else
  RESTORE_CONTROL_PROBE_STATUS=$?
fi
test "$RESTORE_CONTROL_PROBE_STATUS" -ne 0 || exit 1
test "$(stat -f '%z' "$RESTORE_CONTROL_PROBE")" -le 1024 || exit 1
validate_launchctl_missing_service "$RESTORE_CONTROL_PROBE" 'com.jihye.portal.control' || exit 1
rm -f "$RESTORE_CONTROL_PROBE" || exit 1
unset RESTORE_CONTROL_PROBE RESTORE_CONTROL_PROBE_STATUS

export RESTORE_NOTIFICATION_PROBE="$BACKUP_TEMP_ROOT/restore-notification-launchctl.stderr"
test ! -e "$RESTORE_NOTIFICATION_PROBE" || exit 1
: > "$RESTORE_NOTIFICATION_PROBE" || exit 1
chmod 600 "$RESTORE_NOTIFICATION_PROBE" || exit 1
if launchctl print "gui/$PORTAL_UID/com.jihye.portal.notification-worker" \
  >/dev/null 2>"$RESTORE_NOTIFICATION_PROBE"; then
  printf 'STOP: notification-worker service가 아직 loaded 상태\n' >&2
  exit 1
else
  RESTORE_NOTIFICATION_PROBE_STATUS=$?
fi
test "$RESTORE_NOTIFICATION_PROBE_STATUS" -ne 0 || exit 1
test "$(stat -f '%z' "$RESTORE_NOTIFICATION_PROBE")" -le 1024 || exit 1
validate_launchctl_missing_service "$RESTORE_NOTIFICATION_PROBE" 'com.jihye.portal.notification-worker' || exit 1
rm -f "$RESTORE_NOTIFICATION_PROBE" || exit 1
unset RESTORE_NOTIFICATION_PROBE RESTORE_NOTIFICATION_PROBE_STATUS

export RESTORE_CONTENT_PROBE="$BACKUP_TEMP_ROOT/restore-content-launchctl.stderr"
test ! -e "$RESTORE_CONTENT_PROBE" || exit 1
: > "$RESTORE_CONTENT_PROBE" || exit 1
chmod 600 "$RESTORE_CONTENT_PROBE" || exit 1
if launchctl print "gui/$PORTAL_UID/com.jihye.portal.content-worker" \
  >/dev/null 2>"$RESTORE_CONTENT_PROBE"; then
  printf 'STOP: content-worker service가 아직 loaded 상태\n' >&2
  exit 1
else
  RESTORE_CONTENT_PROBE_STATUS=$?
fi
test "$RESTORE_CONTENT_PROBE_STATUS" -ne 0 || exit 1
test "$(stat -f '%z' "$RESTORE_CONTENT_PROBE")" -le 1024 || exit 1
validate_launchctl_missing_service "$RESTORE_CONTENT_PROBE" 'com.jihye.portal.content-worker' || exit 1
rm -f "$RESTORE_CONTENT_PROBE" || exit 1
unset RESTORE_CONTENT_PROBE RESTORE_CONTENT_PROBE_STATUS

"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret AGE_IDENTITY=com.jihye.portal.age-identity \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/restore.mjs" \
    --backup-root "$BACKUP_ROOT" \
    --backup "$BACKUP_ARTIFACT" \
    --target "$RESTORE_DRILL_TARGET" \
    --temp-root "$BACKUP_TEMP_ROOT" \
    --age "$AGE_BINARY" \
    --automatic-backup-after-restore disabled \
    --apply \
    --confirm-destroy "$RESTORE_DRILL_TARGET" || exit 1

launchctl print "gui/$PORTAL_UID/com.jihye.portal.control" | /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || exit 1
launchctl print "gui/$PORTAL_UID/com.jihye.portal.notification-worker" | /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || exit 1
launchctl print "gui/$PORTAL_UID/com.jihye.portal.content-worker" | /usr/bin/grep -Eq 'state[[:space:]]*=[[:space:]]*running' || exit 1
curl -fsS "http://127.0.0.1:8787/health/ready" >/dev/null || exit 1
RESTORE_RECOVERY_ARMED=no
trap - EXIT HUP INT TERM || exit 1
export CORRECT_IDENTITY_RESTORE_VERIFIED=yes
date -u '+restore-drill-finish %Y-%m-%dT%H:%M:%SZ' || exit 1
```

기대 결과: `restored: true`, bounded `retentionPurgedCount`, `automaticBackupAfterRestore: false`, `automaticBackupPolicySource: "explicit"`. 도구가 encrypted hash/size, age authentication, SQLite integrity/schema, retention, staged policy audit와 **운영 production readiness**를 모두 확인한다. 이어지는 세 `launchctl print`가 모두 `running`, local ready가 HTTP 200이어야 trap을 disarm하고 correct-identity restore 통과로 기록한다. PII나 복호화 본문을 출력해 검증하지 않는다.

`restore apply`는 세 운영 서비스의 재기동과 production readiness의 HTTP 200 확인까지 완료되어야 성공이다. `launchctl print`의 실패를 서비스 부재로 인정하는 경우도 위 helper가 stderr 전체를 CR 제거 후 정확히 한 줄, 또는 첫 줄이 정확히 `Bad request.`인 두 줄로 검증할 때뿐이다. label·UID 불일치, 추가 줄, 추가 문구가 있으면 임의 오류로 간주하고 즉시 중단한다.

실패 시 원래 운영 target이 untouched인지, service restart/rollback 결과의 안전한 code를 확인한다. `RESTORE_ORIGINAL_RESTART_FAILED` 또는 `RESTORE_ROLLBACK_FAILED`면 즉시 장애 런북으로 전환한다. drill의 RPO는 artifact created time과 시작 시각 차이, RTO는 위 두 UTC timestamp 차이로 기록한다. 60-minute RPO와 4-hour RTO는 실측 전 non-guaranteed 목표다.

### 21.3 wrong identity negative test

운영 identity를 바꾸지 않고 FileVault 임시 경로에 새 wrong identity를 생성해 같은 encrypted artifact의 복호화가 실패하는지 확인한다. 바로 앞 correct-identity restore가 통과하고 production service/readiness가 복구된 동일한 verified pair에만 수행한다. pinned age 1.3.1에서 유효하지만 recipient가 다른 identity, nonzero 종료, `no identity matched any of the recipients` 오류 class, bounded protected stderr, plaintext output 부재를 **함께** 요구한다. 이 조합이므로 단순 missing binary·깨진 artifact·권한 오류를 성공적인 negative test로 오인하지 않는다.

```sh
test -x "$AGE_BINARY" || exit 1
test -x "$AGE_KEYGEN_BINARY" || exit 1
test "${CORRECT_IDENTITY_RESTORE_VERIFIED:-}" = "yes" || exit 1
test -f "$BACKUP_ARTIFACT" || exit 1
test ! -L "$BACKUP_ARTIFACT" || exit 1
test -f "$BACKUP_STATUS" || exit 1
test ! -L "$BACKUP_STATUS" || exit 1
test "$(stat -f '%Lp' "$BACKUP_ARTIFACT")" = "600" || exit 1
test "$(stat -f '%Lp' "$BACKUP_STATUS")" = "600" || exit 1
test "$(dirname "$BACKUP_ARTIFACT")" = "$BACKUP_ROOT" || exit 1
test "$BACKUP_STATUS" = "${BACKUP_ARTIFACT%.age}.json" || exit 1

WRONG_STAGING_DIR="$(mktemp -d "$BACKUP_TEMP_ROOT/wrong-age.XXXXXX")" || exit 1
export WRONG_STAGING_DIR
export WRONG_KEYGEN_OUTPUT="$WRONG_STAGING_DIR/generated-identity.txt"
export WRONG_IDENTITY_FILE="$WRONG_STAGING_DIR/identity.txt"
export WRONG_OUTPUT="$WRONG_STAGING_DIR/output.sqlite"
export WRONG_STDERR="$WRONG_STAGING_DIR/decrypt.stderr"
chmod 700 "$WRONG_STAGING_DIR" || exit 1
test -w "$WRONG_STAGING_DIR" || exit 1
test ! -e "$WRONG_OUTPUT" || exit 1
test ! -e "$WRONG_STDERR" || exit 1

"$AGE_KEYGEN_BINARY" -o "$WRONG_KEYGEN_OUTPUT" || exit 1
/usr/bin/grep '^AGE-SECRET-KEY-1' "$WRONG_KEYGEN_OUTPUT" > "$WRONG_IDENTITY_FILE" || exit 1
test "$(wc -l < "$WRONG_IDENTITY_FILE" | tr -d ' ')" = "1" || exit 1
WRONG_RECIPIENT="$("$AGE_KEYGEN_BINARY" -y "$WRONG_IDENTITY_FILE")" || exit 1
test "$WRONG_RECIPIENT" != "$AGE_RECIPIENT" || exit 1
: > "$WRONG_STDERR" || exit 1
chmod 600 "$WRONG_STDERR" || exit 1

if "$AGE_BINARY" --decrypt \
  --identity "$WRONG_IDENTITY_FILE" \
  --output "$WRONG_OUTPUT" \
  "$BACKUP_ARTIFACT" 2> "$WRONG_STDERR"; then
  printf 'STOP: wrong identity가 성공함\n' >&2
  exit 1
else
  WRONG_DECRYPT_STATUS=$?
fi

test "$WRONG_DECRYPT_STATUS" -ne 0 || exit 1
test -f "$WRONG_STDERR" || exit 1
test ! -L "$WRONG_STDERR" || exit 1
test "$(stat -f '%Lp' "$WRONG_STDERR")" = "600" || exit 1
WRONG_STDERR_BYTES="$(stat -f '%z' "$WRONG_STDERR")" || exit 1
test "$WRONG_STDERR_BYTES" -gt 0 || exit 1
test "$WRONG_STDERR_BYTES" -le 4096 || exit 1
LC_ALL=C /usr/bin/grep -Fq 'no identity matched any of the recipients' "$WRONG_STDERR" || exit 1
test ! -e "$WRONG_OUTPUT" || exit 1

rm -f "$WRONG_KEYGEN_OUTPUT" "$WRONG_IDENTITY_FILE" "$WRONG_STDERR" "$WRONG_OUTPUT" || exit 1
rmdir "$WRONG_STAGING_DIR" || exit 1
unset WRONG_KEYGEN_OUTPUT WRONG_IDENTITY_FILE WRONG_OUTPUT WRONG_STDERR WRONG_STAGING_DIR
unset WRONG_RECIPIENT WRONG_DECRYPT_STATUS WRONG_STDERR_BYTES
```

기대 결과: age authentication이 nonzero로 실패하고 복호화 DB를 사용하지 않는다. 성공하거나 PII가 출력되면 즉시 보안 사고로 중단한다.

### 21.4 운영 target restore 차이

운영 `$DATA_ROOT/portal.sqlite`가 readable하면 보통 fallback flag를 **생략**하고 exact target을 두 번 전달한다. 현재 정책을 먼저 읽고 보존한다. 복원 결과가 ON이면 restore time으로 설정 시각이 갱신되어 다음 60-second dispatcher opportunity에 새 verified automatic backup이 due가 된다. OFF이면 새 자동 backup을 만들지 않고 기존 pair도 변경하지 않는다. service ready 후 인증된 `/admin/backups`에서 정책과 sanitized observation을 확인하며 DB를 직접 조회해 PII/secret을 출력하지 않는다.

## 22. local monitor와 외부 uptime

보호된 monitoring JSON은 exact `backupResumeGraceMinutes: 10`을 포함해야 한다. 먼저 구조, 그 다음 실제 local check를 secret 없이 실행한다.

```sh
"$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/monitor.mjs" \
  --config "$APP_ROOT/shared/monitoring.json" --validate-only || exit 1

if "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/monitor.mjs" \
  --config "$APP_ROOT/shared/monitoring.json" --dry-run; then
  MONITOR_DRY_STATUS=0
else
  MONITOR_DRY_STATUS=$?
fi
case "$MONITOR_DRY_STATUS" in
  0|2) ;;
  *) exit 1 ;;
esac
unset MONITOR_DRY_STATUS
```

기대 결과: validate는 `valid: true`, 외부 monitor 분리, monitor Keychain service만 출력한다. healthy dry-run은 exit 0; unhealthy dry-run은 exit 2이고 handoff·incident mutation은 없다. check ID, allowlisted code, 숫자 metric 외에 path·PII·request body·secret이 나오면 중단한다.

apply는 독립 monitor HMAC을 Keychain wrapper로 읽은 뒤에만 검사·Hermes handoff를 한다.

```sh
if "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/keychain-exec.mjs" \
  --account "$PORTAL_USER" \
  --config "$APP_ROOT/shared/runtime.env" \
  --secret MONITOR_HERMES_HMAC_SECRET=com.jihye.portal.monitor-hermes-hmac \
  -- "$NODE_BINARY" "$CURRENT_RELEASE/ops/scripts/monitor.mjs" \
    --config "$APP_ROOT/shared/monitoring.json" --apply; then
  MONITOR_APPLY_STATUS=0
else
  MONITOR_APPLY_STATUS=$?
fi
case "$MONITOR_APPLY_STATUS" in
  0|2) ;;
  *) exit 1 ;;
esac
unset MONITOR_APPLY_STATUS
```

기대 결과: healthy exit 0, unhealthy delivered/suppressed exit 2, operational/HMAC/Hermes 오류 exit 3. `BACKUP_CONTROL_INVALID`은 schema v7 설정 손상·읽기 실패·future timestamp 등을 fail-closed로 나타낸다. 보호된 incident file을 수동 수정하지 않는다.

외부 uptime은 반드시 Mac과 같은 LAN 밖의 독립 계정에서 `https://$PUBLIC_HOST/health/live`의 200/`ok`를 검사하고 Mac과 다른 알림 경로를 사용한다. Mac의 local monitor나 같은 공유기의 curl은 정전·Mac 고장·회선 전체 장애를 감지하는 외부 증거가 아니다.

## 23. cold boot·UPS·유선망·외부 인수 시험

승인된 maintenance window와 현장 담당자가 있을 때만 수행한다.

1. external uptime incident가 실제 수신되는지 확인하고 정상 종료한다.
2. 완전 전원 차단 후 다시 켜 FileVault pre-login 화면에서 현장 담당자가 수동 unlock한다.
3. 같은 기존 로그인 계정으로 로그인한 뒤 Keychain prompt와 user LaunchAgent 시작을 확인한다.
4. UPS self-test와 graceful shutdown을 시험하고 원래 전원 설정으로 복구 가능한지 확인한다. SSD 쓰기 중 전원 코드를 임의로 뽑지 않는다.
5. wired Ethernet 분리/복구 때 외부 incident와 Tunnel recovery를 확인한다.

로그인 후 다음을 실행한다.

```sh
FILEVAULT_STATUS="$(fdesetup status)" || exit 1
printf '%s\n' "$FILEVAULT_STATUS" | /usr/bin/grep -Fq 'FileVault is On' || exit 1
unset FILEVAULT_STATUS
pmset -g custom || exit 1
for label in \
  com.jihye.portal.caddy \
  com.jihye.portal.cloudflared \
  com.jihye.portal.control \
  com.jihye.portal.notification-worker \
  com.jihye.portal.content-worker \
  com.jihye.portal.backup \
  com.jihye.portal.retention \
  com.jihye.portal.monitor; do
  launchctl print "gui/$PORTAL_UID/$label" || exit 1
done
```

기대 결과: FileVault enabled, 승인 power profile, 모든 필수 label 정상, Keychain-backed process가 로그인 후 재개한다. pre-login에서 service가 시작되지 않는 것은 정상이며 unlock 없이 무인 복구됐다고 기록하면 안 된다.

Mac/LAN 밖의 장치에서 최종 확인한다.

```sh
curl -fsS "https://$PUBLIC_HOST/health/live" || exit 1
curl -fsSI "https://$PUBLIC_HOST/" || exit 1
curl -fsSI "https://$ADMIN_HOST/admin/login" || exit 1
```

기대 결과: public live `ok`, public canonical 200, admin login reachable over 분리된 HTTPS host. public host에서 `/admin`, `/health/ready`, `/internal`은 노출되지 않고 unknown Host는 404여야 한다. 상담 synthetic 접수 1건이 durable receipt를 만들고 receipt-only SMTP와 metadata-only Hermes가 전달되며 관리자가 확인할 수 있어야 한다.

## 24. 최종 인수 체크리스트

- [ ] 인벤토리의 외부 발급·운영자 결정·Mac 로컬 생성 값을 실제 담당자가 소유하고 검증했다.
- [ ] 비밀이 Git, runtime template, plist, shell history, screenshot, Telegram, guide에 없다.
- [ ] arm64, Node 24, npm 12.0.1, age 1.3.1, bundled SQLite 3.51.3 이상과 binary provenance가 확인됐다.
- [ ] Windows `node_modules`를 복사하지 않았고 Mac에서 `npm ci`, Playwright install, `npm run verify`를 통과했다.
- [ ] production template render/install CLI를 실제 Mac에서 user/system dry-run·분리 apply·ownership·원자 교체·rollback·설치 후 validator까지 시험해 차단 항목 1을 닫았다.
- [ ] 공개 차단 항목 2~7을 실제 구현·검토·Mac 시험으로 닫았다.
- [ ] stale `PUBLIC_ORIGINS` README mismatch는 singular `PUBLIC_ORIGIN`으로 정정되었다.
- [ ] owner password, TOTP, recovery code와 8개 consent 문서가 승인·검증됐다.
- [ ] first normal Wisdom publication, Kakao URL, normal preflight와 Tunnel 공개가 안전한 순서로 완료됐다.
- [ ] SMTP receipt/full-inquiry 승인, Hermes 일반/monitor HMAC 분리, Telegram metadata-only가 확인됐다.
- [ ] Google Search Console, Naver Search Advisor, sitemap/robots/RSS/IndexNow와 canonical 링크가 확인됐다.
- [ ] 자동 OFF/ON, `BACKUP_ADMIN_DISABLED`, 10-minute grace, 60-second dispatcher와 60-minute due gate를 실제로 관찰했다.
- [ ] OFF 중 수동 backup, verified pair, wrong identity 실패, 별도 target restore와 RPO/RTO를 측정했다.
- [ ] all-Keychain offline recovery bundle과 automatic offsite backup replication을 구현하고 Mac 밖 복원에 성공했다.
- [ ] 외부 uptime, FileVault cold boot, UPS, wired-network, 정전/재부팅 drill을 통과했다.

한 항목이라도 미완료면 공개 완료로 표시하지 않는다. 배포·rollback은 [배포 런북](../../ops/runbooks/deployment.md), backup/restore는 [복구 런북](../../ops/runbooks/recovery.md), 장애 code는 [장애 런북](../../ops/runbooks/incidents.md)을 사용한다.
