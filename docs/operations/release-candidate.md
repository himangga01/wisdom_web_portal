# 프로덕션 릴리스 후보 점검표

이 문서는 코드 완성과 실제 공개 개시를 구분한다. 저장소의 기능·테스트가 통과해도 아래 외부 입력과 실제 Mac mini 점검이 끝나기 전에는 공개 운영으로 전환하지 않는다.

## 요구사항 추적표

| 영역 | 구현 근거 | 검증 관문 | 상태 |
|---|---|---|---|
| 4개 언어 공개 사이트 | `apps/site`, locale별 정적 경로와 실제 언어 전환 | Site unit/type/build, 3-browser E2E | 구현 완료 |
| bronze/sand/ivory 디자인과 C1 모션 | 공용 토큰, 18개·500ms·64px·60ms, reduced-motion/no-JS 폴백 | 320/390/768/1440 overflow와 모션 브라우저 검사 | 구현 완료 |
| 상담 접수와 동의 | 로컬 SQLite, 필수 개인정보 동의, 선택 마케팅 동의, 계정 없는 철회 | API·트랜잭션·멱등성·보존기간 테스트 | 구현 완료 |
| 관리자 포털 | 별도 호스트, Argon2id, TOTP/복구 코드, CSRF, 감사 이벤트 | 인증·세션·상태전이·host routing 테스트 | 구현 완료 |
| Telegram·이메일 알림 | Hermes metadata-only, SMTP `receipt-only` 기본, 관리자 선택 | lease/fencing/backoff와 PII 비노출 테스트 | 구현 완료 |
| Hermes 글 작성과 Codex 번역 | HMAC draft intake, 명시적 번역, shell tool 비활성 Codex CLI 3회 검수, locale별 승인 | 스키마·stdin 입력·no-shell 실행·PII guard·작업 복구 테스트 | 구현 완료 |
| 정적 발행과 롤백 | 검증된 snapshot/build, 원자 pointer 전환, active+retired 2개 보존 | 장애 주입·reconcile·rollback·retention 테스트 | 구현 완료 |
| Google·Naver·AI 발견성 | canonical/hreflang/x-default, JSON-LD, sitemap/RSS/robots, IndexNow | DOM·feed·crawler·3-browser 검사 | 구현 완료 |
| Mac mini 무도커 운영 | Caddy, Cloudflare Tunnel, launchd, Keychain, release scripts | 운영 구성·dry-run·release 테스트 | 구현 완료 |
| 백업과 복구 | 시간별 age 암호화 SQLite online backup, 24 hourly/14 daily | 실제 SQLite fake-age backup/guarded restore drill | 구현 완료 |

## 공개 전 필수 입력 게이트

다음 항목은 코드 기본값으로 추측하거나 자동 생성해 공개하지 않는다.

- [ ] 실제 apex·`www`·관리자 도메인과 DNS 소유권
- [ ] Cloudflare Tunnel ID와 소유자 전용 credential 파일
- [ ] 실제 Kakao 상담 URL; 미설정 상태에서는 Kakao CTA를 공개하지 않음
- [ ] 원본 벡터 로고와 고해상도 대표 상반신 사진, AVIF/WebP/JPEG 파생본
- [ ] SMTP 계정과 Keychain service reference, 수신자 메일 주소, `receipt-only`/`full-inquiry` 운영 선택
- [ ] Hermes loopback endpoint와 독립 HMAC 키, Telegram 목적지의 Hermes 측 등록
- [ ] owner 관리자 로컬 등록, TOTP 스캔, 복구 코드 오프라인 보관
- [ ] 행정사 검토를 마친 개인정보 처리·수집 이용 동의문과 선택 마케팅 동의문 4개 언어 최종본
- [ ] 개인정보 12개월·마케팅 24개월 보존기간 운영 확인
- [ ] IndexNow ownership key와 Keychain service reference
- [ ] Google Search Console·Naver Search Advisor 소유권 확인 값과 실제 제출
- [ ] FileVault 재부팅 후 사람의 volume unlock 절차, UPS·유선 LAN·전원 복구 시험
- [ ] 실제 외부 네트워크의 공개 live 감시와 운영 알림 목적지

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
3. application release와 public content release의 pointer를 혼용하지 않는다.
4. 외부 tunnel을 시작하기 전에 `public-current` 전체 manifest와 readiness를 검증한다.
5. 공개 후 Search Console/Search Advisor 등록, sitemap 제출, IndexNow 응답을 확인한다.
6. 백업을 한 번 생성한 뒤 별도 test target에 복원하고 RPO/RTO 측정값을 기록한다.
