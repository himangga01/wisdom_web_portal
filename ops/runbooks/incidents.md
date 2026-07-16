# 장애 대응 체크리스트

`TRANSLATION_FAILURE_BACKLOG` means one or more translation jobs reached terminal failed state;
inspect only the bounded error code and job metadata, then retry or replace the job through the
approved workflow. Never copy translation input, consultation data, or credentials into alerts.

각 절차에서 request body, 연락처, capability token, Keychain 값은 출력하지 않는다. 변경 전 active release, DB 상태, 시각, 안전한 오류 코드만 기록한다.

## disk full

서비스 쓰기를 최소화하고 로그/백업의 원인을 구분한다. 검증된 최신 백업은 지우지 않는다. 보존 정책 밖 파일만 승인 후 정리하고 DB integrity와 ready를 재확인한다.

## tunnel outage

로컬 Caddy와 control live를 먼저 확인한 뒤 cloudflared 상태, outbound network, Cloudflare 상태를 확인한다. 사설 ready 상세를 외부 감시에 노출하지 않는다.

## certificate 또는 DNS

Cloudflare DNS hostname, tunnel ingress, 인증서 상태를 확인한다. apex, canonical `www`, admin hostname이 올바르게 분리됐는지 확인한다.

## database corruption

모든 writer를 멈추고 손상 DB와 sidecar를 보존한다. 마지막 verified age 백업으로 dry-run 복구 후 임시 target에서 integrity와 receipt/ciphertext를 확인한다.

## key loss

키를 임의 재생성하여 기존 데이터를 덮지 않는다. Keychain 항목과 오프라인 복구 사본을 확인한다. PII key 또는 age identity가 없으면 영향 범위를 기록하고 전문가 복구 절차로 전환한다.

## notification backlog

실패 수, oldest age, 채널만 확인한다. 수신자나 본문을 로그에 남기지 않는다. 설정/Keychain/SMTP 또는 Hermes loopback 상태를 고친 뒤 제한적으로 requeue한다.

## stalled queue 또는 retention overdue

`NOTIFICATION_QUEUE_STALLED`, `TRANSLATION_QUEUE_STALLED`, `INDEXNOW_QUEUE_STALLED`가 발생하면 15분 기준을 넘긴 집계 수와 worker/lease 상태만 확인한다. `RETENTION_OVERDUE`이면 `com.jihye.portal.retention`의 최근 실행 상태와 purge의 안전한 결과 수치부터 확인한다. 어느 경우에도 상담 본문이나 연락처를 조회·출력하지 말고, 개인정보 보유기간 purge와 WAL 확인 절차에 따라 남은 배치를 처리한다.

## local monitor 또는 Hermes handoff

`monitor.stdout.log`의 bounded JSON에서 실패한 check ID, 안전한 오류 코드, 숫자 값만 확인한다. `HERMES_HANDOFF_FAILED`이면 등록된 loopback Hermes 프로세스 상태와 `com.jihye.portal.monitor-hermes-hmac` Keychain 접근을 각각 확인한다. Hermes에는 metadata와 오류 코드만 전달하며 raw HTTP response, endpoint query, credential, 상담 데이터는 수집하거나 재전송하지 않는다. 복구 뒤 `monitor.mjs --validate-only`, 이어서 `--dry-run`으로 검사하고, 정상 상태에서 handoff가 발생하지 않는지 확인한 다음 launchd job을 한 번 kickstart한다. 이 경로는 Telegram bot이나 목적지를 직접 호출하지 않는다.

Mac 자체·전원·LAN 전체 장애는 로컬 monitor가 전달할 수 없다. Mac/LAN 밖의 external public uptime 경보를 별도 확인하고, 두 경보가 모두 없을 때도 실제 장비 전원과 네트워크를 독립 점검한다.

### Bounded database check

The queue aggregate check runs in a separate Node child process with SQLite opened read-only
and with file existence required. The parent applies a hard timeout and forcibly terminates
the child process; a hung child is reported as `DB_TIMEOUT`. Do not copy raw SQLite errors,
database bytes, paths, or consultation data into a ticket. Confirm the database is a regular
non-symlink file under the configured data root, then investigate lock pressure or corruption
using the database-corruption procedure above.
`DB_TIMEOUT` therefore means the child process exceeded its hard timeout.

### Repeated incident suppression

For an unhealthy run, the monitor derives a deterministic fingerprint from sorted failing
check IDs and safe error codes only. Run IDs, timestamps, metric values, and PII are excluded.
After Hermes accepts an alert, the fingerprint and send time enter a bounded cooldown. The
same unresolved fingerprint inside that cooldown remains unhealthy but sends no duplicate;
a changed fingerprint or an expired cooldown sends again. Failed delivery never marks an
incident as sent. A healthy run clears the state and emits no resolution alert.

The configured `monitor-incident-state.json` is a protected owner-only file below the data
root. It is written by atomic sibling replacement after a successful delivery. Reject a
symlinked file or parent, a canonical-path mismatch, an oversized or malformed state file,
and any path outside the configured data root. Do not manually edit it while the monitor is
running; if recovery is necessary, stop the launchd job, preserve the file for diagnosis,
verify the path, and restart the job.

## rollback

보존된 release ID를 명시하고 manifest/migration compatibility/canary health를 다시 검증한다. 원자적 pointer 전환과 launchd 재시작 후 public/control active health를 확인한다. 실패하면 이전 pointer와 서비스를 복구한다.
