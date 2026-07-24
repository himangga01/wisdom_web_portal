# 자체(1st-party) 쿠키리스 방문 통계 — 설계·계획

작성일: 2026-07-24 · 상태: 제안(승인 대기) · 범위: `apps/site`(비콘), `apps/control`(수집·집계·관리자 대시보드), `ops`(설정·백업·잡), 개인정보처리방침 개정

## 1. 배경과 동기

- 현재 서비스에는 사이트 운영 지표가 전무하다: 순 방문자수, 페이지 조회수, 방문 추이, 인기 페이지, 유입 경로를 볼 수 있는 화면이 없다(상담 접수 데이터만 존재).
- Google Analytics는 배제한다. 실측 근거: 공개 사이트 CSP가 `script-src 'self'; connect-src 'self'`(`ops/caddy/Caddyfile.template:19`)로 외부 스크립트·비콘을 차단하며, 도입 시 ①CSP 완화 ②개인정보처리방침의 국외이전 고지(법 제28조의8) ③EEA 방문자(이민·비자 상담 타깃) 대상 GDPR 동의 배너 ④광고차단기로 인한 30~50% 수치 왜곡을 감수해야 한다. 무추적·무배너·자기완결이라는 사이트 설계 원칙과 정면 충돌한다.
- 결정된 방향(2026-07-24): **외부 SaaS·셀프호스트 제품 없이 우리 서비스 안에 직접 구현하되, 신뢰할 수 있는 오픈소스의 검증된 기법을 차용한다.** 본 문서는 3건의 병렬 리서치(OSS 제품 비교 / 프라이버시·법적 근거 / 구현 기법)를 교차 검증해 확정한 계획이다.

## 2. 목표 / 비목표

**목표**
- 관리자 포털 신규 화면 1개(`/admin/analytics`)에서 제공: **순 방문자수 · 페이지 조회수 · 방문 추이 그래프 · 인기 페이지 · 유입 경로(리퍼러) · 로케일 분포 · 기간/단위 설정**(7/30/90일 프리셋 + 커스텀, 일/주/월).
- **쿠키·로컬 식별자 0, 동의 배너 0, CSP 변경 0, 외부 요청 0, 신규 데몬 0.** 기존 스택(Astro 정적 + Caddy + Hono/better-sqlite3 + hono/jsx SSR)만 사용.
- 원본 IP·User-Agent를 어떤 저장소에도 기록하지 않는 **수집 즉시 익명화** 설계. 개인정보처리방침에 필요한 고지를 추가.

**비목표**
- 실시간 접속자, 퍼널/전환 목표, 세션 리플레이, 체류시간·이탈률, UTM 캠페인 관리, 지역(GeoIP)·기기·브라우저 분해, 커스텀 이벤트, 이메일 리포트 — 전부 도입하지 않는다. 대부분 수집 필드를 넓혀 "경로·리퍼러 origin·해시 외 무저장"이라는 프라이버시 단순성을 훼손한다. (CSV 내보내기만 후속 저비용 후보)
- **세션/방문(visit) 추적도 도입하지 않는다.** 요구 지표에 없고, 30분 세션 윈도 관리를 생략하면 수집 모델이 "일 단위 고유 방문자 + 조회수"로 단순해진다.
- 셀프호스트 제품(GoatCounter 등) 운영 — §3.1에서 배제 근거 기술.

## 3. 핵심 결정 (리서치 근거 포함)

### 3.1 전략: 자체 구현 (셀프호스트 비교 결과)

| 제품 | 라이선스 | 스토리지 | 배제 사유 |
|---|---|---|---|
| GoatCounter | EUPL-1.2 (count.js는 ISC) | **SQLite 지원**, Go 단일 바이너리 | 유일한 현실적 셀프호스트 후보. 그러나 별도 로그인·별도(영어 위주) 대시보드·launchd 데몬 +1·백업 표면 +1·관리 화면 무JS 원칙 예외 발생 |
| Umami | MIT | v3부터 PostgreSQL 전용 | PostgreSQL 데몬 필수. 방문자 솔트가 기본 월 단위 회전 — 재식별 윈도가 가장 김 |
| Plausible CE | AGPL-3.0 | PostgreSQL + ClickHouse 필수 | Docker Compose 전제, ClickHouse는 이 규모에 명백한 과설계 |
| Matomo | GPL-3.0 | MySQL/MariaDB 전용 | PHP+MariaDB 데몬, XSS 중심 CVE 이력이 가장 길어 패치 추적 부담 |

자체 구현 시 위 마찰이 전부 소멸하고, 구현 범위는 작다(엔드포인트 1개 + 테이블 5개 + 화면 1개 + 비콘 ~30줄).

**라이선스 원칙**: 기법·알고리즘(해시 구성, 솔트 회전, 스키마 설계)은 저작권 보호 대상이 아니므로 자유롭게 차용한다. 단 **AGPL(Plausible)·EUPL(GoatCounter)·GPL(Matomo) 코드는 한 줄도 복사하지 않는다.** 본 계획의 모든 코드는 자체 작성한다.

### 3.2 방문자 식별: 일 단위 솔트 해시, 해시도 익일 삭제

차용 조합: **해시 스킴은 Plausible**([data-policy](https://plausible.io/data-policy)) + **해시 자체의 단명화는 Fathom**([data](https://usefathom.com/data)) + **롤업 스키마는 GoatCounter v2.6+**.

```
visitor_hash = HMAC-SHA256(daily_salt, ipBucket ‖ "\0" ‖ userAgent)
```

- `daily_salt`: KST 자정 회전하는 CSPRNG 32B. **회전 시 전일 솔트 즉시 삭제** — 날짜 간 연결이 설계상 불가능해지는 프라이버시 보증의 실체.
- `ipBucket`: 해시 입력 전 IP 절단 — IPv4는 마지막 옥텟 제거(CNIL 권고 정합), IPv6는 /64 축약. 기존 `apps/control/src/abuse/client-ip.ts`의 `bucketAddress` 관례 재사용.
- **원본 IP·UA는 어떤 저장소에도 기록하지 않는다**(메모리에서 해시 계산 후 즉시 폐기). `visitor_hash`도 당일 중복 판정에만 쓰고 **익일 프루닝 잡이 삭제**한다(영속 데이터는 익명 집계 카운트뿐).
- 도메인 분리 문자열은 기존 crypto 관례(`wisdom:…:v1\0…`, `apps/control/src/crypto/index.ts`)를 따른다.
- **의미론(명시)**: 솔트가 매일 바뀌므로 주간/월간 "순 방문자"는 일별 고유수의 합(같은 사람이 5일 방문 = 5명)이다. 이는 Plausible과 동일한 업계 수용 의미론이며, 대시보드에 "순 방문자는 일 단위 고유 기준" 각주를 단다.

### 3.3 수집 최소화 (이벤트 스키마)

수집: `path`(쿼리·해시 제거, §3.5 allowlist 검증) · `locale`(경로 접두사에서 서버 파생) · `referrer_origin`(origin만, 자기 origin 제외, ≤128자) · `visitor_hash`(당일 한정). **수집 금지**: 원시 UA 전체·쿼리 포함 리퍼러·화면 해상도 등 핑거프린팅 신호·GeoIP·UTM. JS로 단말 속성을 능동 판독하지 않고 HTTP 요청에 자연히 실리는 것만 사용한다 — 독일 DSK의 "자연 전송 데이터 서버 수신은 ePrivacy 동의 대상 아님" 논리([OH Telemedien](https://www.datenschutzkonferenz-online.de/media/oh/20221205_oh_Telemedien_2021_Version_1_1_Vorlage_104_DSK_final.pdf))에 부합.

### 3.4 저장: 별도 `analytics.db` + 롤업 온리

OLTP DB(상담 PII, `synchronous=FULL`+`secure_delete`)와 분리한 **별도 SQLite 파일**을 쓴다: 내구성 요구 상이(집계는 `synchronous=NORMAL`로 충분), 단일 writer 락 격리(무인증 외부 유발 쓰기가 상담 트랜잭션과 경합 금지), 백업·보존 격리. `config.ts`에 `analyticsDatabasePath`(env `ANALYTICS_DATABASE_PATH`, 기본 `dirname(databasePath)/analytics.db`) 추가.

**원시 이벤트 행을 저장하지 않는다**(GoatCounter v2.6+ 방식). 히트 1건 = 트랜잭션 1개로 롤업 UPSERT만:

```sql
CREATE TABLE analytics_daily_salt (
  day  TEXT PRIMARY KEY,                  -- 'YYYY-MM-DD' (Asia/Seoul)
  salt BLOB NOT NULL CHECK (length(salt) = 32)
) WITHOUT ROWID;

CREATE TABLE analytics_visitor_days (     -- 당일 dedup 전용, 익일 삭제
  day TEXT NOT NULL,
  visitor_hash BLOB NOT NULL CHECK (length(visitor_hash) = 32),
  PRIMARY KEY (day, visitor_hash)
) WITHOUT ROWID;

CREATE TABLE analytics_site_days (        -- 영속(25개월)
  day TEXT PRIMARY KEY,
  views INTEGER NOT NULL CHECK (views >= 0),
  visitors INTEGER NOT NULL CHECK (visitors >= 0)
) WITHOUT ROWID;

CREATE TABLE analytics_page_days (        -- 영속(25개월)
  day TEXT NOT NULL, path TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  views INTEGER NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, path, locale)
) WITHOUT ROWID;

CREATE TABLE analytics_referrer_days (    -- 영속(25개월), '' = direct
  day TEXT NOT NULL, referrer_origin TEXT NOT NULL,
  views INTEGER NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, referrer_origin)
) WITHOUT ROWID;
```

- 순방문자 증분: `INSERT OR IGNORE INTO analytics_visitor_days` 후 `changes === 1`일 때만 `site_days.visitors + 1` → 근사 없이 정확한 일일 distinct.
- 증분 관용구는 기존 `abuse_buckets`의 `INSERT … ON CONFLICT DO UPDATE SET n = n + 1`(`apps/control/src/abuse/rate-limit.ts`)과 동일.
- PRAGMA: `journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000`.
- 용량: 최악 50k pv/월 기준 2년 10MB 미만(일 활성 조합 ≤60 가정). 쓰기 부하 평균 0.02 tx/s — 무부하.
- **보존**: 롤업 25개월(CNIL 집계 벤치마크) 후 일일 잡이 삭제. `analytics_visitor_days`·전일 솔트는 매일 삭제.

### 3.5 수집 엔드포인트: `POST /api/v1/pageview`

Caddy가 이미 `/api/v1/*`를 컨트롤 앱으로 프록시하고(`Caddyfile.template:34,55-58`), 관리자 오리진에서는 `/api/*`가 차단된다(`:114`) — 라우팅 변경 불필요.

- **응답은 무조건 `204 No Content`** — 봇/검증 실패/레이트리밋 드롭이어도 204(스팸 도구에 신호를 주지 않는 Plausible식 자세). 상세 원인은 응답에 노출하지 않는다.
- **Origin 강제**: 기존 `/api/v1/consultations`의 `enforceOrigin`+`allowedOrigins` 검사 재사용. CORS 헤더 없음(교차 출처 사용 없음).
- **경로 allowlist**: 로케일 접두사 분리(`routes.ts`의 `localePrefixes` 규칙) 후 ① `CONTENT_ROUTES` 16종 멤버십(컨트롤 쪽 사본 `config.ts`의 `PUBLIC_CONTENT_ROUTES` 재사용) ② `/insights/:slug`는 `^[a-z0-9]+(?:-[a-z0-9]+)*$` ≤96자(`article_locale_heads.slug` CHECK와 동일). 불합격은 조용히 드롭. 404 페이지는 집계하지 않는다.
- **본문 상한 1KiB**(`readBodyWithLimit` 패턴 재사용), Content-Type `application/json` 강제.
- **리퍼러**: `new URL()` 파싱 실패 시 빈 값, 성공 시 origin만, 자기 origin은 direct 처리.
- **레이트리밋**: `abuse_buckets` UPSERT 윈도 버킷 + `bucketAddress` 재사용 — IP 버킷당 10분 60회/일 1,000회. 초과 시에도 204 드롭.
- **봇 필터**: ① UA 부재 드롭 ② 경량 정규식(`bot|crawler|spider|headless|preview|fetch|monitor` 급) ③ `Sec-Purpose`/`Purpose: prefetch` 헤더 드롭 ④ 클라이언트 `navigator.webdriver` 검사. `isbot` npm(MIT, Umami 채택) 도입은 정크가 실제 관측될 때의 업그레이드 경로로 보류 — 리포의 무의존성 성향(제로 의존성 hono/jsx 선택 이력)에 맞춘 결정. 데이터센터 IP DB·리퍼러 스팸 블록리스트는 YAGNI.
- **거부 신호 존중**: 요청에 `Sec-GPC: 1` 또는 `DNT: 1`이면 드롭. 법적 의무는 아니나(§3.7) CNIL 면제 요건의 "거부 수단 제공"을 쿠키 없이 충족하는 수단.

### 3.6 비콘 클라이언트: `apps/site/src/lib/analytics-beacon.ts` (~30줄)

- `BaseLayout.astro:83-91`의 기존 번들 스크립트 블록에 `initializeAnalyticsBeacon()` 추가 — Astro가 `/_astro/*.js` 자기 오리진 번들로 방출하므로 **CSP `script-src 'self'` 불변**.
- 전송: `fetch(endpoint, {method:"POST", keepalive:true, credentials:"omit"})` — 2026년 전 브라우저 지원(Firefox 133+), `sendBeacon`은 API 단위로 광고차단기에 차단되는 사례가 있어 배제([Clicky 전환 사례](https://clicky.com/blog/js-fetch-vs-sendbeacon)). 페이로드는 `{p: pathname, r: document.referrer}` 최소.
- 발화 시점: **페이지 로드 시 1회**(모듈 스코프 플래그로 중복 방지). `document.prerendering`이면 `prerenderingchange` 후 전송. **bfcache 복원**(`pageshow`의 `persisted === true`)은 실제 재열람이므로 추가 1회 카운트.
- 옵트아웃: `localStorage.getItem("wisdom_ignore") === "true"`면 미전송 + GoatCounter식 URL 해시 토글(`#analytics-toggle`)로 운영자가 기기별 1회 설정. 공개 호스트가 아니면(로컬 개발) 미전송. 관리자 작업은 별도 호스트라 애초에 집계에 섞이지 않는다.

### 3.7 법적 근거와 개인정보처리방침 개정 (리서치 확정 사항)

- **한국**: 쿠키 배너 의무 없음. 개보위 맞춤형 광고 가이드라인(2024-01)은 광고 목적 한정 — 순수 통계엔 비적용. 법적 근거는 ① 수집 즉시 익명처리(법 제58조의2 → PIPA 적용 제외)를 주위적으로, ② 당일 해시를 가명정보로 보는 보수적 해석에는 통계 목적 가명처리(제28조의2), ③ 순간적 IP 처리는 정당한 이익(제15조①6호)을 예비적으로 구성.
- **처리방침 기재는 동의 불요와 무관하게 필요**(법 제30조① + 시행령 제31조①의 자동수집장치 항목). 추가 문안(기존 동의문 발행 워크플로 `docs/operations/consent-publication.md`로 신규 버전 발행):
  1. 자동 수집 항목·수단: "본 웹사이트는 쿠키를 사용하지 않으며, 접속 시 전송되는 IP 주소·브라우저 정보를 통계 목적으로 순간 처리한 뒤 즉시 익명화(일 단위 무작위 값과 결합한 일방향 해시)하며 원본을 저장하지 않습니다."
  2. 목적: 웹사이트 이용 통계 작성·서비스 개선 / 3. 보유 기간: 해시 24시간, 익명 통계 25개월 / 4. 거부 방법: 브라우저 GPC·DNT 신호 존중 명시.
- **EU 방어선**: CNIL 측정도구 면제 요건([Sheet n°16](https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications) — 자사 단독·교차대조 금지·IP 절단·고지·거부 수단·25개월) 실질 충족 + DSK 서버 수신 논리 + CJEU *EDPS v SRB*(C-413/23 P, 2025-09)의 상대적 재식별 기준.
- **전문가 검토 플래그(미해결 쟁점)**: ① EDPB Guidelines 2/2023의 광의 해석(JS 트래커 자체가 5(3) "단말 접근"인지 — DSK와 불일치) ② 솔트 생존 중(당일) 해시의 가명정보성 ③ GDPR 역외적용 여부(EU 소재자 타깃팅 사실관계) ④ 한국 IP 판례 분열로 인한 제15조①6호 의존 안정성. → 운영 개시 전 법률 자문 확인 권장.

### 3.8 관리자 대시보드: `GET /admin/analytics` (hono/jsx SSR, 무JS)

- 조회 화면이므로 GET 쿼리스트링 폼(PRG는 변경 작업 전용이라는 기존 관례 유지): `?range=7d|30d|90d` 프리셋 링크 + `?from&to` 커스텀(`type=date`, 서버 클램프 ≤400일), `?g=day|week|month`(기본 자동: ≤31일→일, ≤120일→주, 초과→월), `?metric=views|visitors`.
- 구성: 합계 스탯(총 조회수·총 순방문자·일평균) → **추이 라인 차트(서버 생성 인라인 SVG)** → 인기 페이지 표(상위 20, 경로+로케일) → 리퍼러 origin 표(direct 포함) → 로케일 분포.
- SVG 차트는 의존성 없이 직접 작성(~150줄, `charts.tsx`): hono/jsx는 SVG 케밥 속성(`stroke-width` 등)을 그대로 방출하므로 헬퍼 불요. y축은 1·2·5×10ⁿ nice-tick, x축은 KST 일/주(월요일 시작)/월 버킷 + 한국어 라벨. 접근성: `role="img"` + `<title>`/`<desc>` + `<details><summary>표로 보기</summary><table>…`  폴백, 데이터포인트 `<title>`로 무JS 네이티브 툴팁.
- 헤더 내비게이션에 "통계" 항목 추가, 라벨은 `labels.ts` 관례.

## 4. 단계별 계획

| 단계 | 내용 | 검증 |
|---|---|---|
| **0. 저장 계층** | `analyticsDatabasePath` 설정, `analytics.db` 마이그레이션(테이블 5종), 솔트 매니저(KST 회전·전일 삭제), 히트 기록 함수(`recordPageview`), 프루닝(솔트·visitor_days·25개월 롤업) | 유닛: 해시 회전 경계(자정 전후 다른 해시), distinct 증분 정확성, 프루닝, UPSERT 동시성 |
| **1. 수집 엔드포인트** | `POST /api/v1/pageview` — Origin·Content-Type·1KiB·allowlist·리퍼러 정규화·레이트리밋·봇 필터·GPC/DNT 드롭, 전 케이스 204 | HTTP 테스트: 유효 적재/무효 경로 드롭/봇 UA 드롭/GPC 드롭/한도 초과 드롭(모두 204 + DB 상태 단언), 상담 API 무회귀 |
| **2. 사이트 비콘** | `analytics-beacon.ts` + BaseLayout 배선(prerender 대기·pageshow persisted·옵트아웃·호스트 가드) | 유닛(모듈), e2e: 페이지 로드 시 요청 발사·CSP 위반 0·옵트아웃 시 미발사·bfcache 재카운트, 기존 123개 무회귀 |
| **3. 대시보드** | `/admin/analytics` 화면 + `charts.tsx` SVG + 내비 항목 | 유닛: SVG 스냅샷·nice-tick·주/월 버킷 경계, HTTP: 시드 후 기간/단위/지표 파라미터별 렌더 단언, 접근성 폴백 표 |
| **4. 운영·법무 마감** | 프루닝 잡을 기존 워커 인터벌에 편입, `ops` 백업 정책 결정(analytics.db는 제외 또는 저빈도), runbook 갱신, **개인정보처리방침 신규 버전 발행**(§3.7 문안, 4로케일) | ops 스팟 테스트, 처리방침 발행 워크플로 수동 확인, 최종 전체 검증(컨트롤·사이트·e2e 전량) |

의존성: 0→1→2는 순차, 3은 1 완료 후 병행 가능, 4는 마지막. 각 단계 커밋 분리.

## 5. 리스크·열린 질문

- **법률 자문 확인 4건**(§3.7 플래그) — 구현과 병행 가능하나 운영 개시 전 확인 권장.
- 주간/월간 순방문자가 일별 합산이라는 의미론은 **정확한 월간 UV가 아니다** — 화면 각주로 명시(업계 표준 트레이드오프, Plausible 동일).
- 테스트·개발 환경 비콘 오염: 호스트 가드 + e2e는 격리 DB 사용으로 차단.
- `analytics.db` 모니터링(`ops/scripts/monitor.mjs`) 포함 여부는 Phase 4에서 결정(권장: 파일 존재·크기 상한 경보만).
- 리서치 미검증 항목: GoatCounter macOS 릴리스 자산(무관 — 자체 구현 확정), Matomo referrer 블록리스트 데이터 라이선스(무관 — 미도입).

## 6. 리서치 출처(요약)

Plausible [data-policy](https://plausible.io/data-policy)·[metrics](https://plausible.io/docs/metrics-definitions)·[Events API](https://plausible.io/docs/events-api) / Fathom [data](https://usefathom.com/data) / GoatCounter [sessions](https://www.goatcounter.com/help/sessions)·[gdpr](https://www.goatcounter.com/help/gdpr)·[pixel](https://www.goatcounter.com/help/pixel) / Umami [sessions](https://docs.umami.is/docs/sessions)·[crypto.ts](https://github.com/umami-software/umami/blob/master/src/lib/crypto.ts) / CNIL [Sheet n°16](https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications) / EDPB [Guidelines 2/2023](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf) / DSK [OH Telemedien](https://www.datenschutzkonferenz-online.de/media/oh/20221205_oh_Telemedien_2021_Version_1_1_Vorlage_104_DSK_final.pdf) / CJEU C-413/23 P(2025-09) / 개인정보보호법 제15·28조의2·30·58조의2, 시행령 제31조(law.go.kr) / 개보위 2024-01 행태정보 정책방안 / MDN·web.dev(fetch keepalive, bfcache) / SQLite [wal](https://sqlite.org/wal.html)
