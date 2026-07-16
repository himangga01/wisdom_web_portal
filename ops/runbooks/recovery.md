# 백업·복구 훈련

## 목표와 한계

- 초기 RPO target은 건강한 hourly backup 기준 60 minutes이다.
- 초기 RTO target은 4 hours이다.
- 두 수치는 timed restore drill로 검증되기 전까지 non-guaranteed 운영 목표이며 서비스 보장이 아니다.

## 백업

1. launchd는 매시간 `backup.mjs --apply`를 실행한다.
2. SQLite online backup과 PASSIVE checkpoint를 사용하며 DB, `-wal`, `-shm` 파일을 raw copy하지 않는다.
3. FileVault 보호 임시 경로의 snapshot을 integrity 검사한 뒤 즉시 age로 암호화한다.
4. 다시 복호화하여 hash, integrity, schema를 검증한 결과만 hourly/daily 상태로 게시한다.
5. 검증된 hourly 24개, daily 14개를 유지하고 마지막 건강 백업이 90분보다 오래되면 경보한다.

## 복구 훈련

1. 복구할 `.age` 파일을 절대 경로로 선택한다. 최신이라는 이유만으로 자동 선택하지 않는다.
2. 기본 dry-run 결과의 target과 단계를 확인한다.
3. control/worker 서비스를 멈춘 뒤 restore를 반드시 `keychain-exec.mjs` 경유로 실행한다. `AGE_IDENTITY=com.jihye.portal.age-identity` 매핑과 shared `runtime.env`를 전달하고, 그 뒤의 절대 Node/restore 명령에 `--apply --target <absolute> --confirm-destroy <same-resolved-absolute>`를 정확히 전달한다. identity를 환경변수로 직접 export하거나 명령 인자에 넣으면 안 되며 restore CLI도 직접 apply를 거부한다. restore adapter는 identity를 age 1.3.1의 `--identity -` 표준입력으로만 넘기고 사용 직후 메모리 버퍼를 덮어쓴다.
4. 도구는 암호 인증, encrypted SHA-256, SQLite integrity, schema compatibility를 검사한다.
5. 기존 DB는 timestamped quarantine으로 보존하고 새 DB를 원자적으로 교체한다. ready 실패 시 이전 DB와 서비스를 복구한다.
6. receipt와 ciphertext가 보존되었는지만 확인한다. 훈련 중 PII를 복호화하거나 출력하지 않는다.
7. 성공 후 quarantine 삭제는 별도 승인 작업으로 수행한다.

애플리케이션 pointer 복구나 rollback을 함께 수행할 때는 대상 release의 `.ops-release.json` format v2를 먼저 검증한다. workspace 전체와 production `node_modules`/native addon의 exact inventory, 파일 size/hash, 내부 상대 symlink가 모두 일치해야 한다. 오래된 format v1 release나 추가·누락·변경 파일, runtime root 밖 symlink가 있는 release는 복구 대상으로 실행하지 않고 새로 검증된 release를 배포한다.

서비스를 중지한 뒤 wrong key, ciphertext hash, integrity 또는 schema 검사가 DB 교체 전에 실패하면 도구는 변경되지 않은 원래 DB를 그대로 두고 기존 서비스를 다시 시작한 뒤 readiness를 확인한다. 이 재시작까지 실패하면 `RESTORE_ORIGINAL_RESTART_FAILED`를 반환하며, 검증 실패와 복구 실패 원인을 모두 내부 cause로 보존하되 오류 메시지에는 secret이나 사설 실행 세부정보를 출력하지 않는다. DB 교체 뒤 실패한 경우에는 기존 timestamped DB quarantine을 되돌리고 서비스를 재확인하는 기존 rollback 절차를 적용한다. rollback 자체도 실패하면 `RESTORE_ROLLBACK_FAILED`로 구분한다.

## stale lock 복구

복구 전에 database maintenance lock이 남아 있으면 삭제하거나 이름을 수동 변경하지 않는다. 먼저 배포 런북의 **배포·DB 잠금의 guarded 복구** 절차에 따라 `recover-lock.mjs --kind database` dry-run을 실행한다. 동일 boot의 살아 있는 process owner는 절대 탈취하지 않으며, owner가 없거나 부분 기록인 lock은 최소 15분 age gate를 통과해야 한다. apply에는 출력과 정확히 같은 절대 lock 경로와 `QUARANTINE_STALE_LOCK` 문구가 모두 필요하다. 결과 quarantine은 backup/restore 작업 기록과 대조가 끝날 때까지 보존한다.

분기마다 별도 임시 디렉터리에서 시간을 재며 전체 drill을 실행하고 실제 RPO/RTO 결과를 기록한다. 실제 `age` 바이너리와 운영 Keychain identity로 verified backup을 일회성 target에 복호화해 SQLite integrity/schema를 확인한 뒤 즉시 안전하게 폐기한다. 같은 artifact에 임시 wrong identity를 사용한 복호화가 인증 실패하는지도 확인하되 secret, PII, 복호화 본문은 출력하지 않는다. age private key 손실 시 암호화 백업은 복구할 수 없으므로 오프라인 복구 사본과 접근 절차도 시험한다.

복구 작업 디렉터리는 작업마다 새로 만든 소유자 전용 디렉터리여야 한다. 그 디렉터리에 이름이 `.identity-`를 포함하는 과거 임시 identity 흔적이 하나라도 있으면 도구가 `AGE_IDENTITY_RESIDUE_DETECTED`로 중지한다. 이때 파일 내용을 열거나 로그로 출력하지 않는다. 복구를 계속하지 말고 디렉터리를 격리하고 age identity 노출 사고로 기록한 뒤, 접근 범위 확인과 Keychain identity 회전 여부를 보안 담당자가 결정한다.

## 개인정보 보유기간 purge와 WAL 확인

1. 동일한 Keychain/runtime 경로를 사용해 purge dry-run에서 대상 건수와 기준 시각을 확인한 뒤 `--apply`를 실행한다. 배치 상한에 도달하면 대상 건수가 0이 될 때까지 반복한다. 로그에는 식별자, 상담 본문, 연락처를 남기지 않는다.
2. apply 성공은 DB transaction COMMIT만을 의미하지 않는다. 구현은 COMMIT 직후 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행하고 결과가 정확히 `busy=0`, `log=0`, `checkpointed=0`인 경우에만 성공을 반환한다.
3. `RETENTION_WAL_CHECKPOINT_BUSY` 또는 `RETENTION_WAL_CHECKPOINT_FAILED`는 즉시 운영 경보다. 개인정보 행의 논리적 삭제는 이미 COMMIT되었을 수 있으므로 이를 되돌리거나 원본을 복구하지 않는다. control/worker와 장기 read transaction을 중지한 뒤 purge apply를 다시 실행한다. 삭제 대상이 0건이어도 checkpoint 검증은 다시 수행된다.
4. 재실행 후 도구 성공 결과와 `PRAGMA wal_checkpoint(TRUNCATE)`의 0/0/0 결과를 확인하고, DB의 `-wal` 파일이 없거나 크기 0인지 확인한다. 운영 DB, WAL, SHM을 raw copy하거나 WAL 파일만 임의 삭제하지 않는다.
