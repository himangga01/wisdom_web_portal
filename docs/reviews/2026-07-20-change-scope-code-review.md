# 리뷰 1 · 변경분 코드 리뷰 (2026-07-20)

| 항목 | 내용 |
|---|---|
| 대상 | `1f249ac` → HEAD, 커밋 15개 / **56파일 / +3,775줄** (모니터링·백업·보존기간·복구 강화와 검증 스크립트) |
| 범위 근거 | `1f249ac` 시점에 whole-branch 전체 리뷰(2회 병렬 비판 검토 + 최종 재리뷰, Critical 0·Important 0)를 통과했으므로 그 이후 변경분에 집중 |
| 방식 | diff 중심 + 주변 맥락 코드(worker 실행 경로·마이그레이션·purge 로직) 동반 추적, 변경 영역 테스트 실제 실행 |
| 결과 | **Critical 0 · Important 0 · Minor 2** |
| 검증 | control 84/84 · site 19/19 통과. ops 실패 3건은 기준 커밋에서도 동일한 macOS 샌드박스 환경 문제로 회귀 아님 |
| 해소 | `ae3f89c` (리뷰 2의 수정과 함께 반영) |

행 번호는 리뷰 시점 기준입니다.

## 🟡 Minor 2건

### M-1. 알림 worker: COMMIT 실패 시 delivery promise 고아화 — `apps/control/src/notifications/worker.ts:284`

handoff 트랜잭션 안에서 SMTP 발송(`deliveryPromise`)을 시작한 직후 `COMMIT`이 예외를 던지면, 이미 시작된 발송 promise에 아무 핸들러도 붙지 않은 채 `PROVIDER_HANDOFF_ERROR`로 빠져나갑니다. 이후 그 발송이 실패(reject)하면 worker 프로세스에 unhandledRejection 핸들러가 없어 크래시할 수 있고, provider에 이미 전달된 발송이 오류로 기록돼 재시도 시 중복 발송이 됩니다(중복 자체는 at-least-once 설계상 수용 범위).

**판정 근거**: 발생 조건이 좁고(WAL에서 COMMIT 실패는 드묾) launchd가 worker를 재기동하므로 Minor.

**처리**: `ae3f89c`에서 worker promise 관측 추가.

### M-2. retention 경보 기본값 불일치 — `ops/monitoring/checks.json.template:28` + retention plist

purge 작업은 1시간 주기인데 모니터는 5분마다 "만료됐지만 아직 purge 안 된 건수"를 세고 임계값 기본이 0입니다. 즉 보유기간이 만료되고 다음 시간당 purge가 돌기 전까지의 **정상적인 대기 창**이 매번 `RETENTION_OVERDUE` 장애 경보로 올라가 경보 피로를 만듭니다(중복 전송은 incident cooldown이 완화).

**처리**: `ae3f89c`에서 retention 경보에 유예창 도입.

## 참고 — 이번 변경 범위 밖(회귀 아님)

macOS 기본 `TMPDIR`(`/var/folders` 심링크) 환경에서 ops 테스트 일부가 `BACKUP_PATH_UNSAFE`로 실패하는데, 기준 커밋에서도 동일합니다. "clean checkout 검증 이식성" 취지에 맞춰 fixture 경로에 `realpath` 적용을 후속 권고했고, `ae3f89c`에서 반영했습니다.

## 문제없음으로 확인된 영역

백업 유계 retention(TOCTOU 방어 포함), 모니터링 freshness 완화(의도적·복구 시 전체 해시 게이트 유지), 복구 시 retention 강제(fail-closed), v5/v6 마이그레이션과 append-only 트리거, purge/withdrawal의 handoff 보존 로직, 릴리스 rollback 실패 처리, 상담 만료 drain CLI, site의 abort/재시도/터미널 상태 순서 변경, robots·LF 정책·launchd plist, 문서-스크립트 일치 스팟체크 — 모두 정상.
