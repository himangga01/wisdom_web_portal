# 프로덕션 릴리스 후보 점검표

이 문서는 코드 완성과 실제 공개 개시를 구분한다. 저장소의 기능·테스트가 통과해도 아래 외부 입력과 실제 Mac mini 점검이 끝나기 전에는 공개 운영으로 전환하지 않는다.

## 상태 판정 원칙

- 아래 추적표의 **구현 완료**는 저장소에 기능·자동 검증·운영 절차가 존재한다는 뜻이다. 실제 도메인에서 서비스가 실행 중이라는 뜻이 아니다.
- 실제 공개 준비 완료는 이 문서의 외부 입력 게이트, 대상 Mac의 preflight·backup/restore·failure injection, 실제 브라우저 점검과 외부 uptime 경보가 모두 증거와 함께 확인된 상태다.
- Windows에서 통과한 Ops 테스트는 스크립트 계약의 증거지만 macOS Keychain, launchctl, FileVault unlock, 실제 `age`·Caddy·cloudflared 실행을 대신하지 않는다. macOS 전용 항목은 대상 장비에서 다시 수행한다.
- 최종 clean install 검증 수치와 검증 기준 code commit은 아래 실제 실행 증거를 사용한다. 과거 중간 수치나 예상값으로 대체하지 않는다.
- 검색·AI 발견성 구현은 크롤러가 이해할 수 있는 기술 기반을 제공할 뿐, Google·Naver 순위나 ChatGPT·Gemini 인용을 보장하지 않는다.

## 현재 검증 상태

- 2026-07-21 현재 작업 트리에서 `npm run verify`가 exit 0으로 통과했다.
- typecheck: shared·control TypeScript 통과, Astro 60개 파일 0 error·0 warning·0 hint.
- 테스트: root orchestration 11/11, shared 70/70, control 435/435, site 102/102, Ops 232/232.
- 정적 빌드: fixture publication snapshot으로 4개 언어 68페이지 생성.
- 브라우저 E2E: Chromium·Firefox·WebKit 합계 117/117 통과.
- 검증 기준 code commit: `273baa0` (`fix: address full code review findings`).

## 2026-07-16 과거 검증 기록

아래 결과는 `ebbeb22` (`fix: stabilize consultation retry readiness`) 기준의 과거 기록이며 현재 수정본의 릴리스 근거가 아니다.

- 검증 기준 code commit: `ebbeb22`.
- clean install: `npm.cmd ci` 성공, lockfile 기준 447개 패키지 설치.
- 전체 관문: `npm.cmd run verify` exit 0, 총 322.9초.
- typecheck: shared·control TypeScript 통과, Astro 60개 파일 0 error·0 warning·0 hint.
- 테스트: root orchestration 11/11, shared 70/70, control 415/415, site 98/98.
- Ops: 203 통과, 0 실패, Windows에서 symlink/POSIX 권한 fixture 6개만 platform skip.
- 정적 빌드: fixture publication snapshot으로 4개 언어 68페이지 생성.
- 브라우저 E2E: Chromium·Firefox·WebKit 합계 108/108 통과. 접근성, no-JavaScript, reduced motion, 320·390·768·1440 overflow, 상담·동의, SEO와 게시 글을 포함한다.
- WebKit 상담 재시도·동의 갱신 상태 머신은 trace로 smooth-scroll pointer 변동을 분리한 뒤 reduced-motion 환경에서 40/40 반복 통과했다. terminal status가 폼·버튼 복구 뒤 공개되는 순서도 회귀 검증한다.
- 수동 로컬 브라우저: 320·390·768·1440 홈, 모바일 메뉴, 서비스·상담·개인정보·철회 화면, `ko`·`en`·`zh-Hans`·`zh-Hant` 전환, 18개·500ms C1, canonical·5개 hreflang, console error 0을 확인했다. 실제 Samsung Internet·Safari·Kakao/Naver 앱은 아래 공개 전 게이트로 유지한다.
- 동결 prototype: `git diff -- prototypes` 출력 없음.
- 전체 브랜치와 최종 수정 재리뷰: Critical 0, Important 0. 대형 release의 주기 검증을 별도 worker로 옮기는 최적화와 shutdown 시 verifier interval 명시 정리만 Minor 후속 권고다.
- `npm audit --omit=dev`: Critical 0, High 0, Moderate 0, Low 2. 두 항목은 Windows에서 Astro/esbuild 개발 서버를 실행할 때의 low advisory 한 계보이며, 운영 구조는 Mac의 빌드 결과를 Caddy가 정적으로 제공하고 개발 서버를 외부에 공개하지 않는다. Astro 7 major 전환은 호환성 검증과 함께 별도 유지보수 항목으로 관리한다.

## 요구사항 추적표

| 영역 | 구현 근거 | 검증 관문 | 상태 |
|---|---|---|---|
| 4개 언어 공개 사이트 | `apps/site`, locale별 정적 경로와 실제 언어 전환 | Site unit/type/build, 3-browser E2E | 구현 완료 |
| bronze/sand/ivory 디자인과 C1 모션 | 공용 토큰, 18개·500ms·64px·60ms, reduced-motion/no-JS 폴백 | 320/390/768/1440 overflow와 모션 브라우저 검사 | 구현 완료 |
| 상담 접수와 동의 | 로컬 SQLite, 필수 개인정보 동의, 선택 마케팅 동의, 계정 없는 1회 링크 철회 | API·트랜잭션·멱등성·보존기간·정책 snapshot parity 테스트 | 구현 완료 |
| 관리자 포털 | 별도 호스트, Argon2id, TOTP/복구 코드, CSRF, 감사 이벤트 | 인증·세션·상태전이·host routing 테스트 | 구현 완료 |
| Telegram·이메일 알림 | Hermes metadata-only, SMTP `receipt-only` 기본, 관리자 선택 | lease/fencing/backoff와 PII 비노출 테스트 | 구현 완료 |
| Hermes 글 작성과 Codex 번역 | HMAC draft intake, 명시적 번역, shell tool 비활성 Codex CLI 3회 검수, locale별 승인 | 스키마·stdin 입력·no-shell 실행·PII guard·작업 복구 테스트 | 구현 완료 |
| 정적 발행과 롤백 | 승인 글과 활성 8개 동의 문서를 함께 봉인한 snapshot/build, 원자 pointer 전환, active+retired 2개 보존 | 정책 body/hash/보존기간 parity·장애 주입·reconcile·rollback·retention 테스트 | 구현 완료 |
| Google·Naver·AI 발견성 | canonical/hreflang/x-default, JSON-LD, sitemap/RSS/robots, IndexNow | DOM·feed·crawler·3-browser 검사 | 구현 완료 |
| Mac mini 무도커 운영 | Caddy, Cloudflare Tunnel, launchd, Keychain, release scripts | 운영 구성·dry-run·release 테스트 | 구현 완료 |
| 백업과 복구 | 시간별 age 암호화 SQLite online backup, 24 hourly/14 daily | 실제 SQLite fake-age backup/guarded restore drill | 구현 완료 |
| 로컬 운영 감시 | 5분 launchd runner, backup/disk/services/ready/queue 집계, 독립 HMAC Hermes handoff | fixture failure 1회 handoff·healthy 0회, config/preflight 테스트 | 구현 완료 |

## 공개 전 필수 입력 게이트

다음 항목은 코드 기본값으로 추측하거나 자동 생성해 공개하지 않는다.

- [ ] 실제 apex·`www`·관리자 도메인과 DNS 소유권
- [ ] Cloudflare Tunnel ID와 소유자 전용 credential 파일
- [ ] 실제 Kakao 상담 URL; 미설정 상태에서는 Kakao CTA를 공개하지 않음
- [ ] 원본 벡터 로고. 대표 사진은 선택 입력이며, 제공·공개 승인을 받기 전에는 현재의 bronze/sand/ivory 브랜드 일러스트를 유지한다. 사진을 사용할 때만 고해상도 원본과 AVIF/WebP/JPEG 파생본을 준비한다.
- [ ] SMTP 계정과 Keychain service reference, 수신자 메일 주소, `receipt-only`/`full-inquiry` 운영 선택
- [ ] Hermes loopback endpoint와 독립 HMAC 키, Telegram 목적지의 Hermes 측 등록
- [ ] owner 관리자 로컬 등록, TOTP 스캔, 복구 코드 오프라인 보관
- [ ] 행정사 및 개인정보 운영 책임자가 검토한 개인정보 수집·이용 동의문과 선택 마케팅 동의문 4개 언어 최종본을 seed·활성화하고, 공개 `/privacy`·`/marketing/withdraw`의 version/hash/시행일/보존기간이 상담 API 문서와 일치하는지 확인
- [ ] 선택 마케팅 미동의 상담의 암호화된 전체 상담 envelope 12개월, 선택 마케팅 동의 상담의 암호화된 전체 상담 envelope 24개월 보존을 확인. 특히 마케팅 24개월은 연락처만이 아니라 이름·회사·연락처·상담 내용이 들어 있는 전체 envelope 범위이므로 대표행정사와 개인정보 운영 책임자의 명시적 승인을 기록
- [ ] 사용자 제공 영문 상호 `JIHYE Administrative Attorney`와 영어·간체·번체의 행정사 전문 직함 표현을 대표행정사 및 관련 광고·표시 기준 검토자가 승인하고 기록
- [ ] IndexNow ownership key와 Keychain service reference
- [ ] Google Search Console·Naver Search Advisor 소유권 확인 값과 실제 제출
- [ ] FileVault 재부팅 후 사람의 volume unlock 절차, UPS·유선 LAN·전원 복구 시험
- [ ] 실제 외부 네트워크의 공개 live 감시와 운영 알림 목적지
- [ ] 실제 Mac mini에서 monitoring config `--validate-only`와 monitor `--dry-run`을 실행하고, backup·disk·launchd·ready·queue가 healthy인지 기록
- [ ] 실제 Mac mini에서 안전한 실패를 한 번 주입해 loopback Hermes handoff가 정확히 1회 도착하고 body에 metadata/error code 외 값이 없는지 확인한 뒤 원복
- [ ] Mac/LAN 밖의 외부 uptime 계정과 알림 목적지는 로컬 monitor와 별도로 구성하고, Mac 전원 차단 드릴에서 외부 경보가 도착하는지 확인

## 화면 크기와 실제 브라우저 점검

자동 검사는 Chromium·WebKit·Firefox에서 320, 390, 768, 1440px을 사용한다. 출시 당일에는 다음 실제 기기 점검을 추가한다.

1. Samsung Internet에서 홈·서비스·상담·게시 글을 열고 메뉴, 언어 변경, 키보드, 체크박스, 접수 완료와 가로 넘침을 확인한다.
2. macOS/iPhone Safari에서 동일 경로와 focus ring, reduced motion, 뒤로 가기/BFCache 복구를 확인한다.
3. KakaoTalk·Naver 앱 내 브라우저에서 외부 링크 복귀, 전화/메일/지도 링크, 상담 입력 키보드와 완료 화면을 확인한다.
4. JavaScript를 차단한 상태에서 핵심 정보·내비게이션·게시 글이 보이고, 상담은 거짓 성공을 표시하지 않는지 확인한다.
5. 실제 도메인에서 `/robots.txt`, `/sitemap.xml`, `/rss.xml`, `/indexnow-key.txt`의 status·MIME·cache·noindex 정책을 확인한다.

실제 Samsung Internet·Safari·Kakao/Naver 앱 점검은 Windows CI로 대체할 수 없으므로 공개 전 수동 게이트로 유지한다.

## 운영 전환 순서

1. `ops/runbooks/deployment.md`의 Keychain·runtime·public seed·preflight 순서를 따른다.
2. `PUBLIC_ORIGIN`을 실제 `www` HTTPS 원본으로 지정해 정적 빌드한다.
3. 활성 동의 bundle이 정확히 privacy+marketing × 4개 언어의 8개 문서인지 확인하고, public content manifest가 `consent-bundle.json` SHA-256을 봉인했는지 검증한다.
4. application release와 public content release의 pointer를 혼용하지 않는다.
5. 외부 tunnel을 시작하기 전에 `public-current` 전체 manifest와 readiness를 검증한다.
6. 공개 후 Search Console/Search Advisor 등록, sitemap 제출, IndexNow 응답을 확인한다.
7. 백업을 한 번 생성한 뒤 별도 test target에 복원하고 RPO/RTO 측정값을 기록한다.
