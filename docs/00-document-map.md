# 지혜 웹 포털 문서 지도

이 문서는 저장소 문서의 시작점입니다. 현재 저장소는 프로덕션 후보 코드와 운영 자동화를 포함하지만, 실제 도메인과 운영 자격증명이 주입되고 공개 전 게이트가 닫히기 전까지는 외부 배포 완료 상태가 아닙니다.

## 처음 읽을 문서

1. [`README.md`](../README.md): 시스템 구성, 설치·검증, 주요 기능과 Mac mini 운영 개요
2. [`docs/operations/mac-mini-setup.md`](operations/mac-mini-setup.md): Mac mini M4 계정·발급값·비밀 인벤토리, 설치 순서, 공개 차단 항목, backup/restore와 cold-boot 인수
3. [`docs/superpowers/plans/2026-07-15-production-portal.md`](superpowers/plans/2026-07-15-production-portal.md): Task 1~8의 승인된 구현 범위와 전역 제약
4. [`docs/operations/release-candidate.md`](operations/release-candidate.md): 구현 추적표, 실제 공개 전 필수 입력과 실기기 점검
5. [`AGENT.md`](../AGENT.md): 구현 결정과 작업 단위별 기술 기록
6. [`work-log.md`](../work-log.md): 날짜순 작업·검증 이력

## 운영 런북

| 상황 | 문서 | 핵심 내용 |
|---|---|---|
| 최초 Mac 실장비 준비·인수 | [`docs/operations/mac-mini-setup.md`](operations/mac-mini-setup.md) | 외부 계정·운영 결정·로컬 비밀, FileVault/age/PII 경계, 정확한 명령과 중단 조건, 8개 공개 차단 항목 |
| 최초 설치·배포·rollback | [`ops/runbooks/deployment.md`](../ops/runbooks/deployment.md) | no-Docker Mac, Caddy/cloudflared/launchd, Keychain, application·public release 포인터, preflight와 guarded lock 복구 |
| 동의문 변경·발행 | [`docs/operations/consent-publication.md`](operations/consent-publication.md) | 4개 언어 개인정보·마케팅 8문서, bundle 활성화, policy-only 발행, release authority와 rollback |
| 검색 등록·발견성 | [`docs/operations/search-discovery.md`](operations/search-discovery.md) | canonical/hreflang, JSON-LD, sitemap/RSS/robots, Google·Naver 소유권 확인, IndexNow |
| 백업·복구 훈련 | [`ops/runbooks/recovery.md`](../ops/runbooks/recovery.md) | SQLite online backup, age 암호화, 24 hourly/14 daily, guarded restore, RPO/RTO 측정 |
| 장애 대응 | [`ops/runbooks/incidents.md`](../ops/runbooks/incidents.md) | disk/tunnel/DNS/DB/key/queue/monitor 장애, 안전한 진단 정보, rollback |

## 코드 영역

| 영역 | 위치 | 책임 |
|---|---|---|
| 공개 홈페이지 | [`apps/site`](../apps/site) | Astro 정적 페이지, 4개 언어, Tailwind UI, 상담 폼, 정책·게시글, SEO·AI 발견성 출력 |
| 제어·관리 서비스 | [`apps/control`](../apps/control) | 상담·동의·철회, 관리자 MFA, SMTP/Hermes 알림, AI 글 workflow, release와 IndexNow |
| 공용 계약 | [`packages/shared`](../packages/shared) | locale, 상담·동의·게시글, 환경과 공개 URL의 타입·검증 규칙 |
| Mac 운영 자동화 | [`ops`](../ops) | 템플릿, 배포·rollback, Keychain, 백업·restore, lock, monitoring과 테스트 |
| 승인된 모션 참고본 | [`prototypes/homepage-motion`](../prototypes/homepage-motion) | C1 18개·500ms 시각 참고본; 운영 코드와 분리된 동결 prototype |

## 운영 기준의 우선순위

- 데이터·보안 동작의 기준은 실행 코드와 테스트이며, 운영 순서는 해당 runbook을 따릅니다.
- 공개 콘텐츠와 상담 동의의 authority는 현재 검증된 public release입니다. DB에서 새 bundle을 활성화한 것만으로 공개 정책이 바뀌지 않습니다.
- application release와 public content release는 별도 포인터와 manifest를 사용합니다. 둘을 서로의 대체물로 취급하지 않습니다.
- `build:fixture`는 로컬 QA와 자동 테스트 전용입니다. 실제 공개 빌드는 control이 생성한 절대 published-content 디렉터리를 사용합니다.
- 기능이 저장소에 구현된 것과 실제 Mac mini에서 서비스가 공개된 것은 다른 상태입니다. 공개 여부는 release-candidate 체크리스트와 실제 운영 증거로 판단합니다.

## 외부 공개를 위해 반드시 별도로 준비할 것

도메인·DNS·Cloudflare credential, Kakao 상담 URL, SMTP와 수신 메일, Hermes·Telegram 등록, owner MFA, 승인된 개인정보·마케팅 문구와 보유 범위, 영문·중문 직함, 검색 서비스 소유권 확인값, 실제 Mac의 FileVault·UPS·전원·Keychain·launchd·백업/복구 훈련, 외부 uptime 감시는 저장소가 자동으로 결정하거나 생성할 수 없습니다. 누락 없이 [`release-candidate.md`](operations/release-candidate.md)에 완료 증거를 남깁니다.
