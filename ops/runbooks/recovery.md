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
3. control/worker 서비스를 멈춘 뒤 restore를 반드시 `keychain-exec.mjs` 경유로 실행한다. `AGE_IDENTITY=com.jihye.portal.age-identity` 매핑과 shared `runtime.env`를 전달하고, 그 뒤의 절대 Node/restore 명령에 `--apply --target <absolute> --confirm-destroy <same-resolved-absolute>`를 정확히 전달한다. identity를 환경변수로 직접 export하거나 명령 인자에 넣으면 안 되며 restore CLI도 직접 apply를 거부한다.
4. 도구는 암호 인증, encrypted SHA-256, SQLite integrity, schema compatibility를 검사한다.
5. 기존 DB는 timestamped quarantine으로 보존하고 새 DB를 원자적으로 교체한다. ready 실패 시 이전 DB와 서비스를 복구한다.
6. receipt와 ciphertext가 보존되었는지만 확인한다. 훈련 중 PII를 복호화하거나 출력하지 않는다.
7. 성공 후 quarantine 삭제는 별도 승인 작업으로 수행한다.

분기마다 별도 임시 디렉터리에서 시간을 재며 전체 drill을 실행하고 실제 RPO/RTO 결과를 기록한다. 실제 `age` 바이너리와 운영 Keychain identity로 verified backup을 일회성 target에 복호화해 SQLite integrity/schema를 확인한 뒤 즉시 안전하게 폐기한다. 같은 artifact에 임시 wrong identity를 사용한 복호화가 인증 실패하는지도 확인하되 secret, PII, 복호화 본문은 출력하지 않는다. age private key 손실 시 암호화 백업은 복구할 수 없으므로 오프라인 복구 사본과 접근 절차도 시험한다.
