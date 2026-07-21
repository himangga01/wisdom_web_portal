# 후속 수정 계획 (갭 분석 백로그)

작성일: 2026-07-22 · 상태: 제안(검토용) · 근거: 3종 갭 분석 + 코드 실측

이미 해소된 2건(CSP 자기정합 — JSX 마이그레이션 Phase 0, 철회 페이지 관리자 크롬 — Phase 2)은 제외. 각 그룹은 독립 PR로 쪼갤 수 있으며, 관리자 항목 다수는 **DB에 데이터가 이미 있고 표시 계층만 없는** 경우라 신규 저장소 없이 해결된다.

범례: 🟢 순수 코드(바로 가능) · 🟡 결정 필요 · 🔵 운영자 콘텐츠 입력 필요

---

## A. 관리자 — 알림 진실성·가시성 (최우선, 🟢)

**A1. "고객에게 이메일 통지" 라벨 정정** 🟡
- 현재: `screens.tsx:198` 체크박스 라벨 "고객에게 이메일 통지"이나, transactional 이메일 수신자는 항상 운영자(`adapters.ts:158 recipient = options.smtp.to`; 고객 발송은 `purpose === "marketing"`일 때뿐, `:167-181`). 즉 **라벨과 실제 동작 불일치**.
- 결정 포인트: (a) **라벨 정정**(권장·즉시) — "접수 알림 메일 받기(운영자)" 등 실제 수신자를 반영. (b) 고객 접수 확인 메일 실제 발송(신규 기능, 별도 결정). 동작은 설계상 의도된 것이므로 **A1은 (a) 라벨 정정으로 진행**하고 (b)는 별도 제품 결정으로 분리.
- 함께: `:199` Hermes 라벨은 "담당자 Hermes 알림"으로 정확 — 유지.

**A2. 채널 꺼진 알림의 가시성** 🟢
- 현재: 상태 변경 시 선택 채널은 outbox에 삽입되나(`workflow.ts:177-200`), 워커가 채널 비활성 시 `CHANNEL_DISABLED`로 **cancelled** 처리(`worker.ts:179,248`). "발송 실패" 화면은 `state='failed'`만 조회(`routes.ts:1127-1130`)라 cancelled는 영구히 안 보임.
- 수정:
  - 상태 변경 폼에 채널 비활성 경고 표시(알림 설정에서 해당 채널 enabled 여부를 조회해 체크박스 옆에 "현재 비활성" 배지).
  - "발송 실패" 화면 쿼리를 `state IN ('failed','cancelled')`로 확장하고, cancelled는 사유(`last_error_code`)와 함께 별도 톤으로 표기.

**A3. 상담별 알림 이력** 🟢
- 현재: `notification_outbox`(consultation_id, channel, state, sent_at_ms, last_error_code, attempt_count)와 `notification_delivery_attempts`가 있으나 관리자 화면에 조회 쿼리 0건.
- 수정: `consultationDetail()`에 `SELECT channel, state, sent_at_ms, last_error_code, attempt_count FROM notification_outbox WHERE consultation_id = ? ORDER BY created_at_ms` 추가 → `ConsultationDetailProps`에 `notifications` 필드 → 상담 상세에 "알림 이력" 표(채널/상태/발송 시각(KST)/오류). 발송 성공(`sent`)을 여기서 확인 가능해짐(소거법 추론 제거).

---

## B. 관리자 — 정보 노출 (데이터 존재, 표시만, 🟢)

**B1. 상담 상세 누락 필드**
- 현재: `consultationDetail()` SELECT는 이미 `preferred_contact`를 가져오나 뷰에 안 넘김(`routes.ts:393-396`, `screens.tsx:154-163`에 필드 없음). `marketing_accepted`·`retention_expires_at_ms`·`marketing_withdrawn_at_ms`는 SELECT에도 없음(모두 스키마 존재).
- 수정: SELECT에 3개 컬럼 추가 + `ConsultationDetailProps`에 `preferredContact`, `marketingState`(동의/철회/미동의), `retentionExpiresAt`(=`formatSeoulTime`) 추가 → 상세 dl에 "희망 연락 방법 / 마케팅 동의 상태 / 파기 예정일" 3행. (잘못된 채널 연락·마케팅 법적 리스크·후속 상담 계획 공백 해소.)

**B2. 상태 변경 이력** 🟢
- 현재: `changeConsultationStatus`가 `audit_events`에 `{fromStatus,toStatus,rowVersion}` 기록(`workflow.ts:158-174`), 인덱스 `audit_events_target_idx(target_type,target_id,created_at_ms)` 존재하나 조회 화면 없음.
- 수정: 상담 상세에 `SELECT action, metadata_json, created_at_ms FROM audit_events WHERE target_type='consultation' AND target_id=? ORDER BY created_at_ms` → "상태 변경 이력" 표(from→to, 시각). B3(라벨 맵) 재사용.

**B3. enum 값 한국어 라벨 맵** 🟢
- 현재: 상담 상태·글 상태·분야·채널·payload_mode가 화면에 영문 원시 노출(`screens.tsx:26,55,97,137,172,196,359,447` 등). 정본 enum은 `packages/shared/src/contracts.ts`(CONSULTATION_STATUSES/ARTICLE_STATES/...). 부분 라벨은 `channelLabel`(routes.ts)·payload select만 존재.
- 수정: `apps/control/src/admin/ui/labels.ts`에 `statusLabel`/`articleStateLabel`/`categoryLabel`/`channelLabel`/`payloadModeLabel` 맵 신설 → 모든 화면의 raw enum 렌더를 라벨 경유로 교체. 값 속성(`<option value={status}>`)은 원문 유지, 표시 텍스트만 한국어.

---

## C. 관리자 — 안전·효율 (🟢)

**C1. 종결 상태 확인 체크박스**
- 현재: `POST /admin/consultations/:id/status`(`routes.ts:909-938`)에 확인 게이트 없음. closed/spam은 비가역(`ALLOWED_NEXT_STATUSES` `:57-66`).
- 수정: 상태 폼에 선택값이 closed/spam일 때만 확인 체크박스(발행/롤백 패턴 재사용, `screens.tsx:318-321` 스타일) + 핸들러에 서버 검증. 무JS 대비 `required`. (셀렉트 실수로 영구 잠금 방지.)

**C2. 상담 검색 + 상태 필터** 🟢
- 현재: `findConsultationIdsByContact`(service.ts:75-90)는 블라인드 인덱스·스키마 인덱스까지 완비됐으나 **호출자 0**. 목록은 필터 없는 OFFSET 페이지네이션(`routes.ts:876-898`).
- 수정: 상담 목록에 검색 폼(전화/이메일 → `findConsultationIdsByContact`) + 상태 필터(`?status=` → `(status, received_at_ms)` 인덱스 활용). 대시보드 상태 카운트를 `?status=` 링크로 연결(정보주체 열람·삭제 요구, 재문의 대응 가능).

**C3. 인덱스 + 실패 목록 상한** 🟢
- 현재: 목록 `ORDER BY received_at_ms DESC`가 `(status,received_at_ms)` 인덱스로 안 풀림(풀스캔+정렬); `received_at_ms` 단독 인덱스 없음. `/admin/failures`는 LIMIT 없음(`routes.ts:1127-1130`).
- 수정: `consultations(received_at_ms DESC)` 인덱스 추가(마이그레이션); `/admin/failures`에 LIMIT + 페이지네이션(상담 목록 패턴 재사용).

---

## D. 운영 안전 (🟡 결정 포함)

**D1. newsyslog 데몬 kickstart launchd 잡** 🟡
- 현재: 데몬 로그 `$D0` 회전(`newsyslog…:17-26`) 후 `launchctl kickstart -k`가 **문서로만** 존재(`deployment.md:114`). launchd 잡 미구현(`StartCalendarInterval` 템플릿 부재).
- 수정: 신규 `com.jihye.portal.log-kickstart.plist.template`(`StartCalendarInterval` 매일 00:05, 5개 데몬을 `launchctl kickstart -k gui/$(id -u)/<label>`) — `monitor.plist.template`(StartInterval 구조) 모델. 결정: 정확한 실행 시각·데몬 목록. 배포 스크립트·`configuration.test.mjs`에 편입.

**D2. offsite 백업** 🟡 (설계도 미구현 인정)
- 현재: backup root가 동일 SSD(`backup.mjs:45-64`), spec `:204,:415,:502`에서 자동 offsite 미구현 명시. 확장 지점: `applyBackupRetention` 이후(`backup.mjs:317`) 또는 `adapters.storage` 어댑터 슬롯(`:261`).
- 수정: **결정 필요** — 복제 대상/수단(외장 볼륨 rsync / rclone(S3·GDrive 등) / 별도 호스트 scp). 제안: `adapters.storage.replicateOffsite?` 옵셔널 어댑터를 추가해 retention 후 살아남은 검증본을 push(암호화된 `.age`만, 재검증 hash 확인). 실제 provider 설정은 launch gate. **본 계획은 어댑터 seam + 인터페이스만 정의, provider 구현은 결정 후.**

**D3. `/admin/health`에 백업·보존 상태 노출** 🟡 (경계 브리지 필요)
- 현재: health는 DB ready + 큐 카운트만(`screens.tsx:207-219`). 모니터가 백업 신선도·retention 지연·디스크를 계산하나(`monitoring.mjs`) **control이 읽을 상태 파일 없음**(경계 확인: apps/control에 ops 참조 0건).
- 수정: **결정 필요** — 모니터가 매 실행 시 바운드된 상태 JSON(`{backup:{ageMinutes},dailyBackup:{ageHours},retentionOverdue,diskFreePercent,checkedAt}`)을 control이 읽는 경로(예: `{DATA_ROOT}/monitor-status.json`)에 원자적으로 쓰고, `/admin/health`가 있으면 읽어 표로 표시(없으면 생략). 모니터 incidentState 쓰기 패턴 재사용. 스키마·경로 계약을 양쪽 테스트로 고정.

---

## E. 공개 포털 (🟢/🔵)

**E1. privacy/withdraw 시행일 Intl 표기** 🟢 (빠른 수정 — 누락 지점)
- 현재: `PublicPage.astro:180,:200`이 `effectiveAt` 원시 ISO를 그대로 출력(article은 `formatDisplayDate` 적용됨, PublicPage만 누락).
- 수정: `format-date` import 후 `formatDisplayDate(policyDocument.effectiveAt, locale)` 적용(`datetime` 속성은 ISO 유지).

**E2. 모바일 상담 CTA** 🟢
- 현재: `@media(max-width:700px){.header-consultation{display:none}}`(`global.css:1599-1601`), 하단 고정/스티키 CTA 없음(desktop `.content-cta`만 sticky).
- 수정: 모바일 하단 고정 CTA(안전영역 고려) 또는 각 콘텐츠 페이지 말미 상담 유도 블록. 320px 오버플로 회귀 방지(Playwright 게이트) 위해 하단 고정 방식 권장.

**E3. 서버 오류 구분 + 대체 연락처** 🟢
- 현재: 429/503/네트워크 단절이 모두 `statusFailure` 단일 메시지(`form-validation.ts:274,283`), `navigator.onLine` 미사용, 실패 메시지에 전화 없음.
- 수정: 429→"잠시 후"·503→"일시적 점검"·offline(`navigator.onLine`)→"연결 확인" 최소 구분 + 실패 메시지에 전화(`OFFICE.telHref`) 병기. 새 status 키 4언어 추가.

**E4. 콘텐츠·채널·표기** 🔵 (운영자 입력 필요)
- footer 사업자등록번호·운영시간 추가; en/zh 국제 채널(WeChat/WhatsApp/Google Maps); FAQ·요금 안내 페이지 신설; 사무소/인물 사진. → 실제 값·자산은 운영자 제공 필요. **코드 골격(필드·라우트)은 준비 가능, 내용은 launch gate.**

---

## 추천 착수 순서

1. **A(알림 진실성·가시성) + B(정보 노출)** — 최고 위험(고객 응대 누락)·데이터 존재로 즉효, 신규 저장소 없음. B3 라벨 맵은 A/B/C 전반에 재사용.
2. **C(안전·효율)** — C1 확인 게이트, C3 인덱스/상한은 소규모. C2 검색은 중간 규모.
3. **E1·E3** — 포털 소규모 코드. **E2** 모바일 CTA는 오버플로 검증 필요.
4. **D(운영)** — D1은 코드, D2·D3은 설계 결정 선행.
5. **E4** — 운영자 콘텐츠 확정 후.

## 검증 원칙(각 그룹 공통)
- 매 변경: `tsc --noEmit` + `vitest run src/admin`(관리자) / site 테스트 + e2e(포털). 기존 환경 실패 `publication-search-boundary` 1건 제외 green 유지.
- 마이그레이션 추가 시 `isDatabaseReady` fingerprint·계약 테스트 갱신.
- 신규 화면·필드는 컴포넌트 단위 테스트 + admin-http 통합 테스트로 고정.
