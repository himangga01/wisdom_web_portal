# Sites release-ID 동의 권위 운영

기준일: 2026-07-25  
적용 범위: 공개 전환 이후 Sites version 반복 발행과 rollback

이 절차는 Control의 동의 권위와 외부 Sites 화면에 내장된 release ID가
엇갈리지 않게 합니다. Sites project 생성, source push, version 저장,
deployment, access, custom domain과 DNS 변경을 자동으로 수행하지 않습니다.
그 작업은 각각 별도 승인을 받은 Sites migration 절차에서 실행합니다.

## 계약

- Sites 화면은 자신이 포함한 Control `releaseId`로
  `GET /api/v1/consent-documents?locale=<locale>&releaseId=<releaseId>`를
  요청합니다.
- 응답은 같은 `releaseId`, `bundleId`, 정책 문서와 서명된 `formToken`을
  반환합니다.
- 폼 토큰은 release ID, bundle ID, release manifest SHA-256,
  privacy/marketing version을 함께 서명합니다.
- 상담 제출은 `pending`, `default`, 또는 아직 만료되지 않은 `retiring`
  binding에서만 허용됩니다.
- `releaseId` 없는 기존 요청은 Sites `default` binding을 사용하며, 아직
  binding이 없으면 기존 Control publication/database 권위로 호환됩니다.

DB migration 8의 `sites_release_handoffs`가 현재 상태를 보관하고
`audit_events`가 prepare, deployment 기록, activation, rollback과 abort
이력을 보관합니다. 이 ledger는 두 시스템을 하나의 원자 transaction으로
만들지 않습니다. 상태와 exact identity를 이용해 중단 지점을 판별하고
안전하게 재개하기 위한 근거입니다.

## 상태

| 상태 | 의미 | 폼 허용 |
|---|---|---|
| `pending` | 새 Sites version에 넣을 release를 등록했지만 기본값은 아님 | exact release ID만 허용 |
| `default` | release ID가 없는 요청의 현재 기본 권위 | 허용 |
| `retiring` | 이전/실패 version의 bounded 호환 구간 | `acceptUntilMs` 전까지만 허용 |

동시에 `pending`과 `default`는 각각 최대 한 개만 존재합니다. rollback 호환
구간은 2시간 이상 24시간 이하로 명시해야 합니다.

## 최초 또는 다음 release

모든 ID는 Sites가 반환한 opaque 값을 그대로 사용합니다. ID를 추측하거나
다른 값에서 파생하지 않습니다.

1. 전용 migration 명령으로 schema 8을 적용합니다.
2. verified Control release, published consent bundle, manifest SHA-256,
   Sites source commit과 environment revision을 확정합니다.
3. deployment 전에 pending binding을 등록합니다.

```sh
npm --workspace @wisdom/control run sites-release -- prepare \
  --release-id <control-release-id> \
  --bundle <consent-bundle-id> \
  --manifest-sha <64-lowercase-hex> \
  --source-commit <exact-git-commit> \
  --environment-revision <exact-environment-revision> \
  --expected-state absent
```

4. 별도 승인된 절차로 같은 release ID를 Sites source에 내장하고 exact source
   commit으로 saved version을 만든 뒤 deployment합니다.
5. 실제 deployed 화면의 release identity를 확인한 후 saved version과
   deployment ID를 기록합니다.

```sh
npm --workspace @wisdom/control run sites-release -- record-deployment \
  --release-id <control-release-id> \
  --manifest-sha <64-lowercase-hex> \
  --source-commit <exact-git-commit> \
  --environment-revision <exact-environment-revision> \
  --expected-state pending \
  --saved-version-id <opaque-saved-version-id> \
  --deployment-id <opaque-deployment-id>
```

6. deployed identity가 모두 일치할 때만 기본 권위를 전환합니다.

```sh
npm --workspace @wisdom/control run sites-release -- activate \
  --release-id <control-release-id> \
  --manifest-sha <64-lowercase-hex> \
  --source-commit <exact-git-commit> \
  --environment-revision <exact-environment-revision> \
  --expected-state pending \
  --saved-version-id <opaque-saved-version-id> \
  --deployment-id <opaque-deployment-id> \
  --retiring-window-ms 7200000
```

기존 default는 같은 transaction에서 retiring으로 바뀝니다. 그 뒤에만
ledger identity와 일치하는 IndexNow/RSS/sitemap 후속 절차를 진행합니다.

## rollback

이전 binding이 아직 retiring window 안에 있을 때만 release-ID rollback을
허용합니다.

1. 이전 saved version을 별도 승인으로 재배포합니다.
2. 기존 deployment identity와 새 rollback deployment identity를 모두
   명시해 ledger를 갱신합니다.

```sh
npm --workspace @wisdom/control run sites-release -- record-deployment \
  --release-id <previous-control-release-id> \
  --manifest-sha <previous-manifest-sha> \
  --source-commit <previous-source-commit> \
  --environment-revision <previous-environment-revision> \
  --expected-state retiring \
  --expected-current-saved-version-id <previous-saved-version-id> \
  --expected-current-deployment-id <previous-deployment-id> \
  --saved-version-id <rollback-saved-version-id> \
  --deployment-id <rollback-deployment-id>
```

3. 이전 binding을 default로 되돌립니다.

```sh
npm --workspace @wisdom/control run sites-release -- activate \
  --release-id <previous-control-release-id> \
  --manifest-sha <previous-manifest-sha> \
  --source-commit <previous-source-commit> \
  --environment-revision <previous-environment-revision> \
  --expected-state retiring \
  --saved-version-id <rollback-saved-version-id> \
  --deployment-id <rollback-deployment-id> \
  --retiring-window-ms 7200000
```

실패한 새 default는 retiring으로 바뀝니다. 이전 binding의 window가 이미
끝났다면 이 명령으로 되돌리지 않고 별도 복구 계획과 승인을 받습니다.

## pending abort

아직 활성화하지 않은 pending만 삭제할 수 있습니다. deployment가 이미
기록됐다면 그 exact identity를 함께 확인합니다.

```sh
npm --workspace @wisdom/control run sites-release -- abort \
  --release-id <control-release-id> \
  --manifest-sha <64-lowercase-hex> \
  --source-commit <exact-git-commit> \
  --environment-revision <exact-environment-revision> \
  --expected-state pending \
  --expected-current-saved-version-id <saved-version-id> \
  --expected-current-deployment-id <deployment-id>
```

abort는 handoff row를 제거하지만 immutable audit event는 남깁니다.

## 중단과 재개

- prepare 후 중단: 같은 identity로 deployment를 진행하거나 exact pending을
  abort합니다.
- deployment 기록 후 중단: deployed release identity를 다시 확인한 뒤
  activate하거나 exact deployment identity로 abort합니다.
- activate 후 중단: DB의 default/retiring 상태와 audit event를 기준으로
  후속 알림만 재개합니다.
- identity/state mismatch: 값을 덮어쓰지 말고 Sites와 Control 양쪽 실제
  identity를 다시 확인합니다.
- retiring window 만료: 오래된 form과 release는 409 stale 처리되며 사용자는
  현재 화면에서 정책을 다시 받아야 합니다.

Sites source의 consultation adapter에 release ID를 내장하는 변경, cross-origin
host/CORS, 실제 deployment와 public cutover는 별도 migration 승인이 필요합니다.
