# ChatGPT Sites 의사결정과 위험 등록부

기준일: 2026-07-25  
문서 상태: 현재 서비스와 Sites 책임 분리 v1.6

## 확정 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-001 | Sites 문서는 `docs/gpt-sites-migration`에서 관리 | 운영 문서와 migration 계획 구분 |
| D-002 | Sites source는 current monorepo와 분리한 standalone root 사용 | starter Git/lockfile과 Sites source lifecycle 보존 |
| D-003 | current Astro portal을 cutover와 안정화 기간 동안 유지 | 비교와 host rollback |
| D-004 | 공개 presentation과 form UI만 Sites로 이전 | 요청 범위에 집중 |
| D-005 | Control/SQLite를 상담·동의·철회의 system of record로 유지 | 기존 암호화, 감사, 보존과 철회 보장 |
| D-006 | D1과 R2를 사용하지 않고 binding을 `null`로 유지 | 상담 PII 복제 방지 |
| D-007 | SIWC를 사용하지 않고 최종 access는 anonymous `public` | 공개 포털 성격 유지 |
| D-008 | browser가 Control API를 직접 호출 | Sites runtime/log에 상담 body가 지나가지 않게 함 |
| D-009 | `www`, `api`, `consent`, `admin` origin을 분리 | Sites custom domain과 Control route 경계 양립 |
| D-010 | 초기 migration에서 shared public package를 추출하지 않음 | 기존 production 코드의 불필요한 refactor 방지 |
| D-011 | 승인 snapshot과 provenance를 Sites source에 import | public content identity와 fixture 배제 |
| D-012 | Control publish와 Sites deploy 사이 운영자 주도 release ceremony 사용 | 현재 Sites lifecycle과 콘텐츠 권위 일치 |
| D-013 | 모든 deployment를 production으로 취급 | owner-only URL을 staging으로 오인하지 않음 |
| D-014 | local preview, saved version, owner-only deploy, public access를 구분 | lifecycle과 승인 경계 명확화 |
| D-015 | Site를 local project당 정확히 한 번 생성하고 opaque ID를 그대로 기록 | 중복 project와 binding 손상 방지 |
| D-016 | source commit SHA와 archive를 같은 상태로 version 저장 | 재현성과 rollback identity 보장 |
| D-017 | runtime env와 secret을 `.openai/hosting.json`에 쓰지 않음 | hosting binding과 환경 설정 분리 |
| D-018 | custom domain DNS는 Sites가 반환한 record만 사용 | 잘못된 DNS 추측 방지 |
| D-019 | 기존 `www` withdrawal link가 남아 있으면 cutover 중단 | capability와 철회 권리 보호 |
| D-020 | 테스트·외부 변경·commit·push는 사용자 승인 단위로 실행 | 글로벌 작업 지침 준수 |
| D-021 | Sites 내장 Analytics는 외부 baseline으로 사용 | connector/API 없이도 수동 비교 기준 유지 |
| D-022 | Control first-party Analytics는 현재 서비스 독립 계획으로 관리 | Sites migration의 선행·완료 조건과 분리 |
| D-023 | Base migration에 제3자 analytics package, cookie와 browser visitor ID를 추가하지 않음 | Sites 콘텐츠 이전 범위와 추적 경계 유지 |
| D-024 | Sites 화면과 Control 동의 권위를 release ID로 결합 | old/new/rollback 화면이 자신의 정책과 token을 사용 |
| D-025 | pending/default/retiring 상태와 exact opaque deployment identity를 DB·audit에 기록 | 수동 handoff 중단 시 재개와 rollback 근거 확보 |
| D-026 | release ledger를 cross-system atomic transaction으로 표현하지 않음 | Sites와 SQLite 사이 원자성 오해 방지 |

## 실행 전 결정 gate

### G-001 Sites entitlement와 workspace 정책

확인할 값:

- Sites 사용 가능 여부
- public publishing 허용 여부
- custom domain 제공 여부
- Enterprise 정책 적용 여부
- Sites Analytics 제공 여부
- 실제 account의 인기 페이지 제공 여부

이 gate가 닫히면 scaffold 이후 외부 Site 작업을 진행하지 않습니다.

### G-002 standalone source root

고정 후보는 `/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal`입니다.
새 repository 생성과
initializer 실행은 별도 승인이 필요합니다.

### G-003 production host

후보:

```text
www.jihye-office.kr      -> Sites
api.jihye-office.kr      -> Control public API
consent.jihye-office.kr  -> Control withdrawal
admin.<domain>           -> Control admin
```

실제 host, cloudflared ingress, Caddy와 DNS 변경은 운영 승인 때 확정합니다.

### G-004 release compatibility

cutover 전에 다음을 만족해야 합니다.

- pending snapshot을 Sites에 먼저 배포할 수 있음
- deployed Sites identity 확인 후 Control authority 활성화
- IndexNow가 Sites 배포보다 먼저 실행되지 않음
- Control release와 Sites version/deployment 1:1 ledger

준비 전에는 콘텐츠 발행 freeze가 필요합니다.

### G-005 legacy withdrawal

다음을 운영 DB에서 별도 승인으로 확인합니다.

- 미사용·미만료 `www` capability 수
- 실제 발송 이력
- 신규 `consent` origin 전환 시각
- 진행 중인 confirmation session

유효 link가 있으면 direct `www` cutover를 승인하지 않습니다.

### G-006 개인정보·법률 검토

공개 전 다음 내용을 실제 정책에 반영합니다.

- Sites hosting과 Control로의 직접 전송
- 운영자 역할과 이용자 권리
- 보유·삭제와 문의 경로
- PHI, 결제카드 정보와 민감 식별번호 미수집
- Sites의 현재 데이터·추론 residency 제약

### G-007 검증 범위

후보는 typecheck, unit/build, API/CORS, consultation staging, 핵심 viewport,
접근성, metadata와 rollback입니다. 실행할 범위는 사용자가 승인합니다.

### G-008 public access와 custom domain

- owner-only production deployment
- custom domain 추가와 DNS
- domain active
- anonymous public access

각 항목을 별도 승인으로 처리합니다.

### G-009 안정화 기간

Astro release, legacy route와 DNS rollback target을 언제 제거할지는 cutover 후
별도 결정합니다.

### G-010 Sites 내장 Analytics baseline

- Sites Analytics UI의 실제 account 제공 범위를 확인
- 첫 비교 가능한 기간의 Sites 지표를 외부 baseline으로 기록
- Analytics가 제공되지 않아도 migration 실패로 처리하지 않음
- 공식 지원이 확인되지 않은 API, export와 scraping을 사용하지 않음
- 현재 서비스 성과지표와의 비교·통합을 이 gate에 포함하지 않음

Sites Analytics UI 조회와 baseline 기록은 각각 별도 승인을 받습니다.

## 위험과 대응

| ID | 위험 | 영향 | 대응 | Gate |
|---|---|---|---|---|
| R-001 | Sites public beta/account/region 가용성 제한 | migration 시작 또는 운영 불가 | 첫 task에서 entitlement 확인 | G-001 |
| R-002 | workspace가 public publishing을 금지 | 익명 공개 불가 | admin policy 확인, 차단 시 중단 | G-001 |
| R-003 | Enterprise에서 custom domain 미제공 | 원하는 URL 사용 불가 | 구현 전 제공 여부 확인 | G-001 |
| R-004 | standalone이 아닌 하위 initializer로 nested Git 생성 | source/lockfile 손상 | 승인된 standalone empty root 사용 | G-002 |
| R-005 | monorepo 전체를 Sites source로 push | Control/admin/ops source 불필요 전송 | Sites-only standalone repository | G-002 |
| R-006 | `www`를 Sites에 연결해 기존 path split 소실 | API·withdrawal 단절 | API/consent 전용 host | G-003 |
| R-007 | 현재 Control이 API host를 421로 거부 | 상담 전체 실패 | origin 의미와 host routing 분리 | G-003 |
| R-008 | GET/POST CORS와 OPTIONS 누락 | consent 조회·상담 제출 실패 | exact CORS, preflight, `Vary: Origin` | G-003, G-007 |
| R-009 | wildcard/credentialed CORS | 임의 origin 요청 또는 credential 노출 | exact allowlist, `credentials: "omit"` | G-003 |
| R-010 | proxy header 경계 오류 | rate limit 우회 또는 정상 사용자 차단 | Cloudflare/Caddy trusted proxy 경계 유지 | G-003, G-007 |
| R-011 | 기존 `www` withdrawal link가 cutover 후 끊김 | 마케팅 철회 불가 | capability inventory와 hard gate | G-005 |
| R-012 | token을 Sites redirect로 전달 | URL/log/referrer에 capability 노출 | Sites proxy/redirect 금지 | G-005 |
| R-013 | Control authority가 Sites보다 먼저 활성화 | policy/article version 불일치 | 두 단계 release ceremony | G-004 |
| R-014 | IndexNow가 아직 없는 Sites URL을 먼저 알림 | 검색 오류와 stale URL | Sites deploy 확인 후 activation | G-004 |
| R-015 | 수동 release에서 Sites와 Control identity drift | 정책·동의 증거 불일치 | 1:1 ledger와 content freeze | G-004 |
| R-016 | fixture policy/article import | 잘못된 법률 문서 공개 | realpath/canary/manifest/hash 거부 | G-004, G-007 |
| R-017 | owner-only deployment를 staging으로 오인 | production 변경을 승인 없이 수행 | 모든 deployment를 production으로 표기 | G-008 |
| R-018 | 잘못된 access policy | 의도치 않은 공개 또는 접근 불가 | deploy 전 owner-only 확인, public 별도 승인 | G-008 |
| R-019 | source SHA와 archive 불일치 | 재현 불가 version | exact push 후 같은 commit build/package | G-007 |
| R-020 | 단기 source credential 저장·노출 | repository write 권한 유출 | per-command 사용, 비저장 | G-008 |
| R-021 | runtime secret을 source/hosting file에 기록 | credential 노출 | env 도구 사용, hosting에는 binding만 | G-008 |
| R-022 | environment revision을 배포하지 않음 | old API/canonical 사용 | revision과 deployment identity 기록 | G-008 |
| R-023 | custom-domain DNS record 추측 또는 validation 실패 | domain 장애 | Sites 반환 record 적용 후 status refresh | G-008 |
| R-024 | DNS propagation/cutover 실패 | 공개 포털 장애 | Astro DNS target과 TTL 기록, rollback | G-009 |
| R-025 | 상담 PII가 Sites runtime/storage/log에 기록 | 개인정보 침해 | direct browser→Control, D1/R2/proxy 금지 | G-006 |
| R-026 | visitor가 PHI·카드·식별번호 입력 | 금지 데이터 처리 | 명확한 폼 고지와 첨부 미지원 | G-006 |
| R-027 | 개인정보 처리방침이 실제 Sites 흐름과 다름 | 법률·신뢰 위험 | 공개 전 정책 검토 | G-006 |
| R-028 | Sites 데이터·추론 residency 미지원 | 내부 정책/법률 요구 미충족 | 공개 전 적합성 판단 | G-006 |
| R-029 | unsupported private network/background dependency | Sites build/runtime 실패 | frontend만 이전, Control 외부 HTTPS API 유지 | G-001, G-003 |
| R-030 | 이전 Sites version에도 환경 회귀 존재 | app rollback 불충분 | version rollback과 DNS rollback 이중화 | G-009 |
| R-031 | Sites 전환 후 기존 health monitor가 잘못된 host 감시 | 장애 탐지 실패 | Sites URL과 API health monitor 분리 | G-003 |
| R-032 | sitemap/RSS/robots/ownership route 누락 | 검색 발견성 저하 | Sites machine route에 포함 | G-007 |
| R-033 | generated social card의 한글 텍스트 오류 | 브랜드 품질 저하 | 한 번 생성·검수, unusable일 때 한 번 재생성 | G-007 |
| R-034 | Enterprise 소유 Site에 Analytics 미제공 | 외부 baseline 부재 | 최초 entitlement에서 미제공으로 기록하고 migration 계속 | G-001, G-010 |
| R-035 | Sites 인기 페이지를 확인 없이 지원한다고 약속 | 외부 기능 오해 | 실제 account UI에서 제공 여부 확인 | G-010 |
| R-036 | CLI/connector Analytics API를 가정 | 자동 KPI 수집 구현 실패 | web/desktop UI 기반 수동 review | G-010 |
| R-037 | 제3자 SDK를 중복 추가 | cookie/consent와 데이터 흐름 확대 | Base migration은 Sites 내장 Analytics만 사용 | G-006, G-010 |
| R-038 | traffic 감소를 장애로 단정 | 잘못된 운영 대응 | health monitor의 보조 신호로만 사용 | G-010 |
| R-039 | 이전 Sites 화면이 새 기본 정책을 받아 split-brain 발생 | 동의 증거와 화면 불일치 | embedded release ID, exact consent GET과 signed token | G-004 |
| R-040 | rollback 대상 release 호환 시간이 이미 만료 | 오래된 화면 제출 실패 | bounded retiring window 안에서만 rollback, 만료 시 별도 복구 승인 | G-004 |
| R-041 | ledger 존재를 cross-system 원자성으로 오인 | 중간 상태에서 잘못된 후속 작업 | expected state/identity CLI와 단계별 재개 절차 | G-004 |

## 현재 준비 상태

| 항목 | 상태 |
|---|---|
| 현재 Sites 기능과 공식 정책 재확인 | 완료 |
| Sites 내장 Analytics 기능 검토 | 완료 |
| 공개 route/content/design inventory | 완료 |
| 상담 form/API/withdrawal boundary 검토 | 완료 |
| 기존 migration 문서 전면 수정 | 완료 |
| standalone Sites source | 생성하지 않음 |
| `.openai/hosting.json` | 생성하지 않음 |
| 외부 Site/project | 생성하지 않음 |
| runtime env/access | 변경하지 않음 |
| source push/saved version | 실행하지 않음 |
| owner-only production deployment | 실행하지 않음 |
| public access/custom domain/DNS | 변경하지 않음 |
| Sites Analytics UI/baseline 기록 | 실행하지 않음 |
| current Control release-ID consent protocol | 구현, 승인된 집중 테스트 대기 |
| standalone Sites source 코드 | 실행하지 않음 |
| 테스트·브라우저 검증 | 실행하지 않음 |
| commit·push | 실행하지 않음 |

## 다음 승인 단위

다음 최소 실행 단위는
[`04-implementation-plan.md`](04-implementation-plan.md)의 **Task 0: Sites
entitlement와 workspace 정책 확인**입니다.

그 결과가 충족된 뒤에만 standalone source root 생성 승인을 요청합니다.
