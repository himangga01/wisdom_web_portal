# 지혜 웹 포털 전체 코드 리뷰

## 1. 리뷰 정보

| 항목 | 내용 |
|---|---|
| 리뷰 일자 | 2026-07-25 (Asia/Seoul) |
| 기준 브랜치 | `2026-07-21-codex-code-review-fixes` |
| 기준 커밋 | `62c11ce5646dc71e063c8610f798a3d3964d3bca` |
| upstream 상태 | `origin/2026-07-21-codex-code-review-fixes`, ahead/behind `0/0` |
| 리뷰 방식 | 저장소 전체 읽기 전용 정적 검토 |
| 실행하지 않은 항목 | 코드 수정, build, test, lint, E2E, 브라우저, 서비스, 네트워크 |

리뷰 시작 시 작업 트리는 clean 상태였다. 리뷰 도중 별도 작업에서
`docs/gpt-sites-migration` 문서 수정·이동이 발생했으므로, 이 보고서의 코드 판정은
최초 clean 상태의 기준 커밋을 대상으로 한다.

## 2. 검토 범위

추적 파일 362개를 다음 기능 단위로 나누어 검토했다.

| 영역 | 파일 수 | 주요 기능 |
|---|---:|---|
| `apps/site` | 70 | Astro 공개 사이트, 4개 언어, 상담 화면, 검색·발견성 |
| `apps/admin` | 33 | React 관리자 SPA |
| `apps/control` | 106 | Hono API, 상담·동의·철회·관리자·알림·콘텐츠 발행 |
| `packages/shared` | 25 | 공용 계약, 검증 schema, 검색·콘텐츠 규칙 |
| `ops` | 61 | Caddy, Tunnel, launchd, 배포, 백업·복구, 모니터링 |
| `prototypes` | 20 | 홈페이지 모션 참고 구현 |
| `docs` | 23 | 운영 절차와 Sites 마이그레이션 계획 |
| `scripts` | 4 | workspace 검증 orchestration |

테스트·spec 파일은 92개, 운영 코드와 운영 문서 성격의 파일은 약 243개였다.

## 3. 종합 판정

현재 기준 커밋은 정적 검토상 **프로덕션 공개 준비 완료 상태가 아니다.**

- Critical 등급의 무인 인증 우회나 원격 코드 실행 결함은 확인되지 않았다.
- 공개 사이트와 상담 접수의 기본 보안 설계는 전반적으로 견고하다.
- 콘텐츠 발행, 최초 운영 개시, 개인정보 보존기한, 공개 포인터 복구 및 DB
  restore 경로에는 High 등급 결함이 남아 있다.
- 정상 application release가 설치된 뒤 신규 글·정책을 발행하는 build 경로는
  현재 dependency prune 구조와 양립하지 않는다.
- 문서에 기록된 전체 검증은 과거 커밋 기준이며 현재 HEAD의 통과 증거가 아니다.

## 4. 기능별 상태

| 사이트 기능 | 구현 내용 | 판정 |
|---|---|---|
| 다국어 공개 사이트 | 한국어·영어·중국어 간체·번체, 15개 기본 콘텐츠 경로, 게시글 | 기본 기능 양호, 콘텐츠·SEO 결함 존재 |
| 상담·동의 | release 기반 동의문, form token, 멱등성, rate limit, PII 암호화 | 관리자 만료 PII 조회 결함 존재 |
| 마케팅 철회 | 계정 없는 capability, 확인 세션, 보존기한 단축, 발송 취소 | 기능은 동작하나 공개 화면 asset 결함 존재 |
| React 관리자 | MFA, 상담·콘텐츠·발행·알림·상태 화면 | 상태 오표시와 일부 도달 불가능한 설정 존재 |
| 콘텐츠 발행·롤백 | immutable snapshot, build 검증, seal, pointer, reconcile | 현재 운영 발행 차단 및 부분 실패 결함 존재 |
| Mac mini 운영 | Caddy, Tunnel, launchd, Keychain, release, backup/restore | restore race와 bootstrap 운영 경로 문제 |
| Sites 마이그레이션 | 계획 문서 | 프로젝트·코드·배포는 아직 없음 |

## 5. High 등급

### H-01. 정상 배포 후 신규 콘텐츠 발행 build가 실패한다

#### 근거

- `apps/site/astro.config.ts:1-8`은 `@tailwindcss/vite`를 build 시 import한다.
- `apps/site/package.json:20-29`에서 `@tailwindcss/vite`와 `tailwindcss`는
  `devDependencies`이다.
- `ops/lib/mac-release-adapter.mjs:148-157,239`는 application build 이후
  `npm prune --omit=dev --workspaces --include-workspace-root`를 실행한다.
- `apps/control/src/articles/publication-build.ts:219-247`은 이후 현재 application
  release에서 다시 `@wisdom/site` build를 실행한다.

#### 영향

기존 공개 release는 유지되지만 신규 글 발행, 정책 전용 발행 및 첫 정상 Wisdom
release 생성이 실패한다. build 실패는 `failed-publication.log`에만 기록되며
`ops/scripts/monitor-db-check.mjs:124-136`은 이 사전 build 실패를 집계하지 않는다.

#### 권고

publication builder에 필요한 dependency를 production/sealed builder dependency로
유지하고, runtime prune 직후 실제 publication build를 수행하는 배포 gate를
추가한다. build 실패 상태도 DB 또는 monitor가 읽는 bounded 상태로 기록한다.

### H-02. 정상 공개본을 bootstrap 정적본으로 되돌릴 수 있다

#### 근거

- `ops/scripts/seed-public.mjs:48-80`은 정상 Wisdom release 존재 여부를 확인하지
  않고 bootstrap manifest를 만든 뒤 public pointer를 전환한다.
- bootstrap 복귀 금지는 `ops/lib/public-release.mjs:200-236`의
  `verifyPublicCurrent()`에만 있으며 seed CLI는 이를 호출하지 않는다.
- `ops/runbooks/deployment.md:13`은 정상 발행 후 bootstrap으로 돌아갈 수 없다고
  설명한다.

#### 영향

운영자가 `seed-public.mjs --apply`를 재실행하면 Caddy가 즉시 오래된 fixture,
정책 또는 콘텐츠를 서비스할 수 있다.

#### 권고

Wisdom release가 하나라도 존재하면 seed apply를 거부하고, 정상 publication과
동일한 public-release lock 및 Tunnel unloaded 증명을 요구한다.

### H-03. bootstrap에서 첫 정상 발행으로 전환할 지원 경로가 막혀 있다

#### 근거

- `ops/runbooks/deployment.md:12-22`는 정상 발행 전에 Tunnel을 unload하도록 한다.
- 정상 발행은 `apps/control/src/admin/api.ts:897-939`의 관리자 웹 API를 통해서만
  제공된다.
- `apps/control/src/auth/preauth.ts:27-32`와
  `apps/control/src/auth/session.ts:36-42`의 cookie는 항상 `Secure`이다.
- `ops/caddy/Caddyfile.template:1-4,107-124`의 로컬 관리자 listener는 HTTP이며
  `auto_https off`이다.

#### 영향

Tunnel이 꺼진 상태에서는 일반 브라우저가 Secure 관리자 cookie를 유지할 수 없고,
Tunnel은 정상 발행 뒤 시작하도록 되어 있어 최초 publication 절차가 순환 의존에
빠진다.

#### 권고

지원되는 loopback TLS/SSH-forward 관리자 경로 또는 exact confirmation을 요구하는
일회성 first-publication CLI를 제공한다.

### H-04. 공개 pointer와 DB activation이 부분 실패 시 갈라진다

#### 근거

- 발행은 `apps/control/src/articles/publication-release.ts:1413-1418`에서 pointer를
  먼저 전환한 뒤 DB activation을 commit한다.
- rollback도 같은 파일 `1466-1471`에서 동일한 순서를 사용한다.
- reconcile은 `apps/control/src/server.ts:24-35`에서 서버 시작 시에만 호출된다.
- `apps/control/src/admin/api.ts:930-938,999-1008`은 예외를 잡아
  “현재 릴리스는 유지됩니다”라고 응답한다.

#### 영향

pointer 전환 후 DB commit이 실패하면 공개 파일은 바뀌었지만 consent/release
authority는 이전 상태일 수 있다. 프로세스가 계속 실행되므로 startup reconcile도
일어나지 않고 readiness와 상담 API가 503이 될 수 있다.

#### 권고

같은 요청 안에서 activation을 reconcile하거나 안전하게 이전 pointer로 복구한다.
복구를 확정할 수 없으면 프로세스를 fail-closed 종료하고 운영 화면에는 실제
recovery 상태를 표시한다.

### H-05. 보존기한이 지난 상담 PII가 purge 전까지 관리자에게 노출된다

#### 근거

- `apps/control/src/admin/api.ts:570-585`는 상담 상세 조회 시
  `pii_envelope` 존재 여부만 확인하고 복호화한다.
- 같은 query는 `retention_expires_at_ms`와 `purged_at_ms`를 조회하지 않는다.
- `apps/control/src/notifications/worker.ts:159-179`는 외부 전송 직전에 보존기한을
  검사한다.
- 물리 파기는 `apps/control/src/retention/purge.ts:60-74`의 별도 작업이다.

#### 영향

보존기한 도래부터 시간별 purge 실행까지, 또는 purge 실패·지연 기간 동안 관리자가
이미 만료된 PII를 계속 조회할 수 있다. 철회로 보존기한이 단축된 상담도 포함된다.

#### 권고

관리자 상세 API에서도 현재 시각과 `retention_expires_at_ms`를 비교하고 만료되었거나
purge된 경우 복호화하지 않고 `pii: null`을 반환한다.

### H-06. restore 중 retention writer가 DB를 계속 변경할 수 있다

#### 근거

- `ops/lib/mac-services.mjs:16-22`의 기본 stop 대상은 control과 두 worker뿐이다.
- `ops/scripts/restore.mjs:30-34`도 이 기본 adapter를 사용한다.
- `ops/launchd/com.jihye.portal.retention.plist.template:14-20`은 retention purge를
  시작 시와 매시간 실행한다.
- retention purge는 `ops/lib/database-maintenance-lock.mjs:27-49`의
  backup/restore lock을 획득하지 않는다.

#### 영향

restore가 sidecar를 검사한 뒤 retention이 WAL/SHM을 다시 만들거나 이전 DB inode에
기록할 수 있다. purge·audit 유실, restore 실패, quarantine 복구 오류 또는 서비스
장애로 이어질 수 있다.

#### 권고

retention LaunchAgent를 restore의 필수 unload 대상에 포함하고 모든 DB maintenance
writer가 같은 lock에 참여하도록 한다. DB 교체 직전에 writer와 sidecar를 다시
검사한다.

### H-07. rollback은 현재 보존 중인 상담 PII를 다시 검사하지 않는다

#### 근거

- 정상 발행은 `apps/control/src/articles/publication-snapshot.ts:197-203,334-339`에서
  현재 보존 중인 상담 PII와 콘텐츠를 비교한다.
- `apps/control/src/articles/publication-release.ts:1426-1474`의 rollback은 과거
  sealed release만 검증하며 PII key provider를 받지 않는다.

#### 영향

과거 release가 retired된 뒤 새로 들어온 상담 PII와 과거 콘텐츠가 일치하면,
rollback이 그 값을 다시 공개할 수 있다.

#### 권고

rollback 전 현재 PII generation과 대상 release 전체 콘텐츠·slug·route를 재검사하고
pointer 전환 직전 CAS로 다시 확인한다.

### H-08. 장비 분실과 SSD 장애를 감당할 백업 경로가 없다

#### 근거

`docs/superpowers/specs/2026-07-17-admin-backup-control-and-mac-mini-setup-design.md:187-204`
는 암호화 backup이 같은 Mac SSD에 있고 자동 offsite 복제와 전체 Keychain recovery
bundle이 없다고 명시한다.

#### 영향

Mac 또는 SSD를 잃으면 운영 DB와 모든 로컬 backup을 함께 잃을 수 있다.

#### 권고

암호화 artifact의 자동 offsite 복제, 독립 복구 계정, 전체 비밀 recovery bundle 및
실제 장비 분실 restore drill을 공개 전 필수 gate로 둔다.

## 6. Medium 등급

### M-01. release 전환 직후 consent API가 일시적으로 503을 반환한다

`apps/control/src/articles/publication-release.ts:893-915`는 release key가 바뀌면
기존 cache를 지우고 background refresh를 예약한 뒤 현재 요청에는 `undefined`를
반환한다. `apps/control/src/app.ts:310-322,345-403`은 이를 readiness 및 consent
API 503으로 변환한다.

또한 60초마다 최대 256MiB release를 동기 검증하므로 event loop 지연 가능성이 있다.
activation 시 검증된 authority를 원자적으로 전달하고 대형 검증은 request path 밖으로
옮기는 것이 필요하다.

### M-02. 승인 locale head가 65개가 되면 전체 발행이 차단된다

`apps/control/src/articles/publication-release.ts:471-487,1347-1351`은 승인 대상을
모두 선택하지만 `apps/control/src/articles/publication-snapshot.ts:233-240`은
64개를 초과하면 거부한다. 관리자 UI에는 batch 선택이 없어 policy-only 발행까지
막힐 수 있다.

### M-03. 관리자 consent/health가 실제 공개 authority가 아닌 DB 후보를 표시한다

`apps/control/src/admin/api.ts:1187-1198,1242-1249`는
`getActiveConsentBundle()`을 사용하지만 공개 상담 API는 release-backed
`resolveConsentAuthority()`를 사용한다. bundle activate 후 아직 publish하지 않은
상태나 manifest 오류 상태에서 관리자가 잘못된 bundle과 ready 상태를 보게 된다.

### M-04. logout 실패가 성공처럼 보인다

`apps/admin/src/app/session.tsx:105-111`은 logout API가 실패해도 `finally`에서
anonymous 상태로 전환한다. HttpOnly cookie와 서버 session은 남을 수 있으므로
새로고침하면 다시 로그인된 상태가 복구된다.

### M-05. 알림 테스트와 비활성 email 설정이 UI에서 부정확하다

- `apps/admin/src/features/operations/NotificationsPage.tsx:44-49`는 비활성 채널도
  테스트 발송 성공으로 표시한다.
- `apps/control/src/notifications/worker.ts:248-250`은 이를
  `CHANNEL_DISABLED`로 취소한다.
- email이 꺼져 있어도 `NotificationsPage.tsx:67-71`의 SMTP 필드는 항상
  `required`라서 서버가 지원하는 “SMTP 없이 비활성 저장”에 도달할 수 없다.

### M-06. publication 실패 임시 파일이 무제한 누적될 수 있다

`apps/control/src/articles/publication-release.ts:1357-1374`의 build 실패 경로는
`.snapshot-*`, `.home-*`, 일부 `.building-*`를 정리하지 않는다. 반대로 activation
commit 뒤 cleanup 실패는 이미 성공한 발행을 실패 응답으로 바꿀 수 있다.

### M-07. non-default `CONTROL_PORT`에서 readiness 검사가 잘못된다

`ops/lib/mac-release-adapter.mjs:217-220`은 runtime config와 무관한 기본 service
adapter를 만들고, `ops/lib/mac-services.mjs:16-22`는 배포 프로세스 환경 또는
8787을 사용한다. 정상 배포를 잘못 rollback하거나 8787의 다른 서비스로 거짓 성공할
수 있다.

### M-08. Kakao CTA 설정이 publication build에 전달되지 않는다

`apps/site/src/components/HomePage.astro:18`과
`apps/site/src/components/SiteHeader.astro:17`은 `PUBLIC_KAKAO_CHAT_URL`을
사용하지만 `apps/control/src/articles/publication-build.ts:226-242`의 격리 환경은
이를 전달하지 않는다. Control을 통한 새 release에서는 CTA가 빠진다.

### M-09. production origin 검증이 문서보다 약하다

`packages/shared/src/public-origin.ts:7-21`은 일부 placeholder만 거부하므로
사설 IPv4/IPv6, `.local`, single-label host가 통과한다. 통과한 값은 canonical,
hreflang, sitemap, RSS와 IndexNow 전체에 사용된다.

### M-10. 게시글 heading 계약이 상충한다

`packages/shared/src/article-markdown.ts:44-65`는 본문 H1을 허용하고
`apps/site/src/components/PublishedArticle.astro:40,58`은 별도 페이지 H1과 본문
HTML을 함께 렌더링한다. 반면
`apps/site/src/search/quality-gate.ts:167-170`은 평문 H2 정규식만 검사한다.

따라서 다중 H1은 통과하고 `## **강조 제목**` 같은 정상 Markdown H2는 전체 build를
실패시킬 수 있다.

### M-11. 검수자 다국어 표시와 JSON-LD identity가 잘못될 수 있다

`apps/control/src/articles/publication-snapshot.ts:225-228`은 모든 locale의 역할을
영어 `"Administrative content reviewer"`로 고정한다.
`apps/site/src/search/json-ld.ts:107-123`은 실제 승인자가 누구든
`/#representative` ID를 부여한다. 대표자가 아닌 관리자가 승인하면 서로 다른 사람을
하나의 identity로 병합한다.

### M-12. Insights 목록과 검색 갱신 정보가 실제 콘텐츠 변경을 반영하지 않는다

- `apps/site/src/search/surface-registry.ts:18-31`은 `/insights`의 `lastmod`를
  `2026-07-16`으로 고정한다.
- `apps/site/src/content/published-articles.ts:247-259`과 목록 렌더링 경로는 최신
  수정일이 아니라 UUID 기반 manifest 순서를 유지한다.

새 글이 목록 상단에 나타나지 않을 수 있고 sitemap도 변경 시각을 갱신하지 않는다.

### M-13. 상담 validation 및 stale-consent 오류 안내가 불일치한다

- `apps/site/src/components/ConsultationForm.astro:72,103`의 HTML `minlength`는 raw
  문자열을 검사한다.
- `packages/shared/src/consultation.ts:62-74`는 trim 후 길이를 검사한다.
- `apps/site/src/lib/form-validation.ts:254-260`에서 shared parse가 실패하면 어느
  필드인지 표시하지 않고 generic 오류만 보여준다.
- 같은 파일 `269-276,311-313`은 stale consent 재조회 실패 메시지를
  “동의 문서가 변경됨” 메시지로 덮어쓴다.

### M-14. 공개 마케팅 철회 화면의 stylesheet가 제공되지 않는다

`apps/control/src/withdrawal/routes.ts:20-22`는 `/admin/styles.css`를 참조하지만
공개 host는 `/admin*`를 차단하고 관리자 SPA도 manifest 기반 `/admin/assets/*`만
제공한다. 철회 기능은 동작하지만 확인·성공·오류 화면이 항상 무스타일이다.

### M-15. 일반 runtime 시작이 migration compatibility guard를 우회한다

`apps/control/src/runtime.ts:16-22`는 서버·worker·일반 CLI 시작 시
`runMigrations()`를 자동 실행한다. 전용 migration CLI만
`apps/control/src/cli/migrate.ts:11-18`에서 rollback compatibility를 먼저
확인한다. 이전 DB에 새 바이너리를 직접 시작하면 유지보수 절차 없이 rollback 불가능한
schema 변경이 적용될 수 있다.

### M-16. age identity가 child 환경에도 남는다

`ops/lib/runtime-config.mjs:96-110`은 Keychain의 `AGE_IDENTITY`를 restore Node
프로세스 환경에 넣는다. `ops/lib/system-adapters.mjs:80-94`는 identity를 age
stdin으로 전달하지만 spawn 환경을 제한하지 않아 age도 전체 환경을 상속한다.

### M-17. macOS 대소문자 alias로 backup 경로 격리를 우회할 수 있다

`ops/lib/backup.mjs:35-63`과 `ops/lib/restore.mjs:28-36`은 Windows에서만 경로를
소문자로 비교한다. 기본 case-insensitive APFS에서 대소문자만 다른 backup root와
plaintext temp root가 같은 실제 디렉터리를 가리킬 수 있다.

### M-18. 기존 data root의 read 권한을 운영 gate가 확인하지 않는다

표준 신규 설치는 data root를 0700으로 만들지만, 이미 존재하는 0755 디렉터리는
chmod하지 않는다. `apps/control/src/db/client.ts:1215-1219`도 DB/WAL/SHM mode나
umask를 고정하지 않고 launchd plist에 `Umask`가 없다.

`ops/lib/monitor-files.mjs:25-31`의 protected 검사는 group/world write만 금지하고
read는 허용한다. 이관된 traversable data root에서는 다른 로컬 계정이 ciphertext와
운영 metadata를 읽을 수 있어도 gate가 통과한다.

### M-19. 여러 rate-limit 창 위반 시 `Retry-After`가 너무 짧다

`apps/control/src/abuse/rate-limit.ts:69,84-94`는 동시에 위반한 window의 종료
시각 중 `Math.min`을 사용한다. 10분 제한과 일일 제한을 함께 넘으면 10분 뒤 재시도를
안내하지만 일일 제한은 계속 유효하다.

## 7. Low 등급 및 정리 항목

- `apps/site/src/search/feeds.ts:61,70-76`은 다국어 item이 섞인 단일 RSS channel을
  `<language>ko</language>`로 선언한다.
- 상담 성공 뒤 입력값을 편집해도 이전 receipt 성공 상태가 남아 새 내용까지 접수된
  것처럼 보일 수 있다.
- 게시글 title·summary·reviewer schema는 XML 1.0 금지 제어문자를 명시적으로
  제거하지 않으며 RSS escape는 markup 문자만 처리한다.
- slug는 전화번호 형태도 허용하지만 publication PII scan 대상에는 slug·route가
  빠져 있다.
- `README.md:86`의 `PUBLIC_ORIGINS`는 runtime allowlist와 Control 구현에 없으며,
  runtime config에 넣으면 설정 전체가 거부된다.
- React 관리자 API 공용 계약은 TypeScript interface 중심이며 성공 응답 runtime
  schema가 없다. `apps/admin/src/api/client.ts:78`은 성공 body를 cast한다.
- `apps/admin/tests/admin.spec.ts`의 E2E는 실제 Hono Control이 아니라
  `apps/admin/tests/server.mjs` fake server를 사용한다.

## 8. Sites 마이그레이션 검토

기준 커밋에는 `.openai/hosting.json`, Sites project, source push, saved version,
deployment가 없다. Sites 관련 내용은 계획 문서다.

다만 계획된 release 순서는 Sites 정적 정책을 먼저 production deploy한 뒤 Control
consent authority를 활성화한다. 이 순서를 그대로 구현하면 새 정책 화면과 이전
consent API/form token이 동시에 존재하는 split-brain 구간이 생긴다. rollback은
반대 방향의 불일치 구간을 만든다.

구현 전에 다음 중 하나가 필요하다.

- release ID별 dual-bundle API
- old/new bundle 공통 effective time
- 전환 중 임시 access gate
- old/new 양쪽을 제한적으로 검증·수락하는 명시적 protocol
- Sites deployment와 Control authority를 연결하는 release ledger 및 복구 절차

## 9. 잘 구현된 부분

### 공개 사이트

- 4개 언어의 기본 경로와 실제 번역이 존재하는 게시글만 연결하는 hreflang 계약이
  명확하다.
- indexable/noindex/private 표면을 registry로 구분한다.
- Markdown은 raw HTML, image, 비 HTTPS link, 제어문자를 거부한다.
- publication loader가 path containment, symlink, file size, hash, semantic hash,
  exact inventory와 재렌더 결과를 검증한다.

### 상담·개인정보

- form token, exact release 동의문, idempotency, rate limit, consent ledger,
  outbox와 audit를 즉시 transaction 안에서 처리한다.
- 상담 PII는 AES-GCM, consultation-bound AAD, HKDF/HMAC 목적 분리와 blind index를
  사용한다.
- retention과 마케팅 철회 race를 알림 provider 호출 직전에 다시 확인한다.

### 관리자·보안

- Argon2id dummy verification path와 동시 KDF gate가 있다.
- TOTP replay 방지, recovery code 일회성 소비와 durable dual-axis throttle이 있다.
- Secure/HttpOnly/SameSite cookie, exact Origin, CSRF, no-store와 CSP가 적용된다.
- React 출력은 기본 escaping을 사용하고 여러 resource request에서 stale response를
  취소한다.

### 콘텐츠·운영

- Hermes HMAC intake, Codex no-shell 실행, translation review와 PII guard가 계층적으로
  분리돼 있다.
- public release와 application release를 서로 다른 immutable seal과 pointer로
  관리한다.
- release manifest가 exact inventory, hash, size와 symlink containment를 검증한다.
- backup은 SQLite online backup, age 암호화, 재복호화 hash·integrity·schema 검증과
  bounded retention을 제공한다.
- restore는 staged DB, quarantine과 readiness 실패 rollback을 구현한다.

## 10. 현재 검증 증거의 한계

`README.md:46`과 `docs/operations/release-candidate.md:13-20`의 전체 검증 기준은
`273baa0`이다. 이후 `8d96fb4`에서 React 관리자 migration이 추가됐고 현재 HEAD는
`62c11ce`이다.

따라서 문서에 기록된 다음 수치는 현재 코드의 통과 증거로 사용할 수 없다.

- shared·control typecheck
- control 435개 테스트
- site 102개 테스트
- Ops 232개 테스트
- 4개 언어 68페이지 정적 build
- Chromium·Firefox·WebKit E2E 117개

본 리뷰에서도 사용자 지침에 따라 이를 다시 실행하지 않았다.

## 11. 권고 처리 순서

1. H-01 publication dependency와 H-02 bootstrap downgrade를 차단한다.
2. H-04 activation 부분 실패, H-05 만료 PII 조회, H-06 restore-retention race를
   해결한다.
3. H-03 최초 정상 발행 경로와 H-08 offsite recovery를 마련한다.
4. rollback PII 재검사와 관리자 authority 표시를 정리한다.
5. 발행 batch, consent cache, port probe, notification·logout 상태를 수정한다.
6. 공개 콘텐츠 heading·reviewer·Insights·상담 UX와 withdrawal asset을 수정한다.
7. 현재 HEAD 기준 전체 검증과 실제 Mac/Tunnel/backup/restore 증거를 새로 기록한다.

## 12. 리뷰 한계

이 보고서는 코드와 추적 문서의 정적 분석 결과다. 다음 항목은 확인하지 않았다.

- 현재 HEAD의 실제 build/test/lint 통과 여부
- 실제 브라우저의 반응형·색 대비·CSP·native validation
- SQLite 실부하에서의 writer 경합
- macOS launchd, Keychain, APFS ACL과 crash semantics
- 실제 Caddy/cloudflared render, DNS, TLS와 Tunnel ingress
- SMTP, Hermes, Codex, IndexNow 외부 연동
- 실제 backup artifact와 장비 restore drill
- Sites account, project와 deployment 상태
