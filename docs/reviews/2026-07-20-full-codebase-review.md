# 리뷰 2 · 전체 코드 리뷰 (2026-07-20)

| 항목 | 내용 |
|---|---|
| 대상 | 저장소 전체 약 **51,000줄** (control·shared·site·ops 전부) |
| 방식 | 5개 영역으로 분담한 리뷰 에이전트 **병렬 실행** → 후보 결함을 메인 세션에서 실행 경로 추적으로 재검증 |
| 결과 | **Critical 0 · Important 5 · Minor 약 15** |
| 해소 | `ae3f89c` (Important 5 + Minor 다수) |

행 번호는 리뷰 시점 기준입니다.

## 영역 분담

| 영역 | 범위 |
|---|---|
| 1 · control 핵심 도메인 | 암호화(AES-GCM/HKDF/블라인드 인덱스), DB 스키마·마이그레이션, 동의문, 상담 접수, 남용 방지, 보존기간·purge |
| 2 · control 인증·알림·철회 | 관리자 MFA/세션/스로틀, SSR 라우트 CSRF/Origin, SMTP SSRF 방어·알림 lease/재시도, 마케팅 철회 토큰 |
| 3 · 발행 파이프라인 | 글 초안·번역 샌드박스·immutable snapshot·원자 pointer 전환·rollback·IndexNow + 루트 scripts |
| 4 · site + shared | 폼 상태 머신, site↔control API 계약 불일치, JSON-LD/템플릿 XSS, hreflang/robots 정합성 |
| 5 · ops 전체 (11k줄) | 백업/복원/릴리스/모니터링의 경로·symlink·TOCTOU·lock 경합, launchd 템플릿 |

각 에이전트에는 이미 발견된 Minor 2건(리뷰 1)과 알려진 TMPDIR 환경 이슈를 중복 보고하지 말라고 명시했고, 이전 전체 리뷰(Critical 0) 이력을 감안해 깊은 결함 위주로 추적 검증하도록 지시했습니다.

## 🟠 Important 5건 (우선순위 순)

### I-1. 폼 토큰 2시간 만료 후 상담 폼 복구 불가 루프 — site↔control 계약 (영역 4)

방문자가 상담 페이지를 2시간 이상 열어두고 제출하면 서버가 400 `INVALID_SUBMISSION`을 반환하는데, 클라이언트는 409 `CONSENT_VERSION_STALE`일 때만 토큰을 재발급합니다. 그래서 "다시 시도"를 눌러도 같은 만료 토큰으로 영원히 실패하고, 새로고침 외 복구 경로가 없습니다. 서버가 토큰 만료와 honeypot 적발을 같은 코드로 반환해 클라이언트가 선별 복구를 구현할 수도 없는 **계약 설계 공백**입니다. 실사용자가 가장 먼저 겪을 결함.

**처리**: `ae3f89c` — 복구 가능한 409 `FORM_TOKEN_STALE` 도입(클라이언트 재발급 + 쿨다운).

### I-2. IPv6 /64 로테이션 레이트리밋 우회 + 신규 방문자 잠금 DoS — `abuse/rate-limit.ts:34`, `app.ts:321` (영역 1)

IP 버킷 키가 주소 문자열을 그대로 해시하고 IPv6 프리픽스(/64) 집계가 없습니다. IPv6에서는 가입자 한 명이 /64(2^64개 주소)를 통째로 받으므로:

1. 주소를 바꿔가며 요청하면 상담 접수의 per-IP 제한(10분 5회/일 20회)이 무력화됩니다(연락처 버킷만 남음).
2. 더 심각한 쪽 — 동의문 GET의 인메모리 리미터는 subject 4,096개가 차면 **신규 subject에 429**를 반환하는데, 이 엔드포인트가 formToken 발급 경로라 여기가 포화되면 **신규 방문자 전원이 상담 접수 불능**이 됩니다. 단일 IPv6 호스트가 분당 수천 요청으로 맵을 계속 채우면 잠금이 지속됩니다.

XFF 스푸핑 방어 자체는 안전함이 확인됐고, 이 건은 실제 주소 로테이션에 관한 것입니다.

**처리**: `ae3f89c` — IPv6를 /64 프리픽스 단위로 집계.

### I-3. 발행 최종 경로 검사의 symlink 비대칭 — `publication-release.ts:549` (영역 3)

최종 rename 직전 검사가 한쪽은 `realpathSync`(실경로), 다른 쪽은 `resolve`(symlink 미해석)로 비교합니다. macOS에서 `/var`, `/tmp`는 `/private/...`로 가는 symlink이므로, `PUBLIC_RELEASE_ROOT` 조상에 symlink가 하나라도 있으면 **수 분짜리 빌드·검증을 전부 마친 뒤 최종 단계에서 모든 발행이 무조건 실패**합니다. 설정 검증(`validateConfig`)은 이를 미리 잡지 못합니다.

**실측 근거**: 이 코드 그대로 macOS에서 publication-release 테스트 15개가 `PUBLICATION_FINAL_PATH_INVALID`로 실패함을 확인. 포인터 전환 전 실패라 공개 사이트 손상은 없지만(fail-closed), 배포 대상이 macOS(Mac mini)이므로 구성에 따라 발행 기능이 전면 불능이 됩니다.

**처리**: `ae3f89c` — 발행 최종 경로 symlink 정규화.

### I-4. daily 백업 반쯤-웨지 상태가 무경보 — `ops/lib/backup.mjs:300` (영역 5)

daily 페어 불일치가 발생하면 daily 백업 라인이 영구 중단되고 retention이 미실행되어 hourly가 무한 축적되는데, 모니터는 hourly만 보기 때문에 계속 healthy로 보고합니다. **조용한 백업 소멸**.

**처리**: `ae3f89c` — retention 항상 실행 + `daily-backup` 모니터 추가로 관측성 확보.

### I-5. master에서 site 테스트 1건 상시 실패 — `published-articles.test.ts:390` (영역 4)

심링크 방어 테스트가 인벤토리 검사(`UNEXPECTED_FILE`)에 선점되어 기대 오류에 도달하지 못합니다. CI가 항상 적색이고, 실제 심링크 거부 경로가 어떤 테스트로도 커버되지 않게 됩니다(제품 코드 자체는 정상, 테스트 결함). **CI 상시 적색은 실제 회귀를 은폐**합니다.

**처리**: `ae3f89c` — 테스트 스위트 green화 작업군에 포함.

## 🟡 Minor (약 15건 중 발췌)

### 테스트 신뢰성
- ops monitoring 테스트 1건이 도입 시점부터 기대값 오류로 상시 red
- publication 테스트들이 tmpdir realpath 미적용으로 macOS 상시 실패
- → I-5와 묶어 "테스트 스위트를 green으로 만들기" 작업군으로 처리

### 운영
- deploy/rollback health 체크가 셸 `CONTROL_PORT`에 의존 — 포트 비표준 구성 시 정상 배포가 매번 자동 롤백
- newsyslog `GJN` 로테이션이 장수명 데몬 로그를 유실시킴
- retention 경보 기본값 오탐(리뷰 1 기존 발견)

### 방어심층
- SMTP Teredo /32 부분 차단
- darwin 경로 격리의 대소문자 비구분 미처리
- 알림 worker COMMIT 실패 시 promise 고아화(리뷰 1 기존 발견)

### 잠복 결함
- idempotency replay 시 저장된 response_status를 무시하고 201 하드코딩(현재는 201만 저장되어 무해)
- consent `effectiveAt` 포맷 계약 비대칭 — shared 스키마는 허용하는 형식을 클라이언트가 거부(현 생산 경로는 모두 정규화되어 미발현)
- JSON-LD가 검수자를 대표자 `@id` 엔티티에 강제 병합 — 다른 검수자 발행 시 잘못된 사실 진술
- 롤백 시 `in_review` 상태의 신규 리비전 head를 경고 없이 옛 리비전으로 덮어써 재번역 작업 결과가 사실상 유실
- 폼 제출 핸들러에 `if (submitting) return` 재진입 가드 부재(서버 idempotency로 대체로 무해)
- 매니페스트 파일 순서 계약에 locale 민감 `localeCompare` 사용 — control(launchd)과 ops(관리자 셸)의 LANG이 다르면 이론상 검증 실패 가능. 코드포인트 비교 권장
- `purgeExpiredConsultations` dry-run의 dueCount가 batchSize로 절사되어 과소 보고(실운영 CLI 경로는 정확)
- abuse 버킷·idempotency 만료 행 정리가 apply 모드 purge에만 결합 — purge 미실행 시 누적

## 문제없음 확인된 핵심 영역

AES-GCM 봉투/HKDF 목적 분리/블라인드 인덱스, 마이그레이션 v1~v6과 append-only 트리거, 접수 트랜잭션 원자성(fault point 6개 롤백 검증), 관리자 인증 전체(타이밍 균일성·TOTP replay·세션 고정·스로틀), SMTP DNS 리바인딩 방어, 철회 토큰 원자성, Hermes intake의 HMAC/nonce/idempotency, Markdown·JSON-LD XSS 차단, Codex 번역 샌드박스, 발행 원자 전환·reconcile, 백업 검증 체인·restore 안전장치, lock 탈취 방어, keychain 스크립트 인젝션, hreflang/x-default·noindex 정책, retention 월말 클램프 산술 — 전부 추적 검증 통과.

## 총평

보안 핵심 경로(암호화, 인증, CSRF, SSRF 방어, 철회 토큰, 백업/복원 무결성)는 전 영역에서 견고함이 확인됐고, Important 5건은 모두 **"특정 조건에서 서비스가 조용히 멈추거나 사용자가 갇히는" 가용성·운영성 결함**입니다.
