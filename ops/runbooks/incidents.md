# 장애 대응 체크리스트

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

## rollback

보존된 release ID를 명시하고 manifest/migration compatibility/canary health를 다시 검증한다. 원자적 pointer 전환과 launchd 재시작 후 public/control active health를 확인한다. 실패하면 이전 pointer와 서비스를 복구한다.
