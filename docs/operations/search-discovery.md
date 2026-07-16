# 검색·AI 발견성 운영 가이드

이 문서는 지혜행정사사무소 공개 사이트의 Google, 네이버 및 AI 검색 크롤러 발견성 설정을 운영하는 절차입니다. 메타데이터, 구조화 데이터, 사이트 소유권 확인, 크롤러 허용 및 IndexNow 전송은 검색·인용 후보가 될 가능성을 높이지만 **순위, 색인, 노출 또는 ChatGPT·Gemini의 인용을 보장하지 않습니다.**

## 1. 공개 URL의 단일 기준

운영 빌드에는 `PUBLIC_ORIGIN`을 반드시 설정합니다.

```sh
export PUBLIC_ORIGIN='https://www.example.kr'
```

실제 값은 다음 조건을 모두 충족해야 합니다.

- HTTPS 원본 하나만 사용합니다.
- 사용자명·비밀번호, 경로, 쿼리, 프래그먼트, 포트 및 끝의 `/`를 넣지 않습니다.
- `localhost`, IP 주소, `example.*`, `.test`, `.invalid`, `staging`, `preview`, `dev` 호스트를 운영값으로 사용할 수 없습니다.
- 입력값의 대소문자나 `:443`을 조용히 정규화하지 않습니다. 설정값 자체가 최종 원본과 정확히 같아야 합니다.
- canonical, hreflang, JSON-LD ID, sitemap, RSS 및 IndexNow 대상 URL은 모두 이 원본과 동일한 URL 생성기를 사용합니다.

설정이 없거나 운영 원본이 아니면 빌드가 `PUBLIC_ORIGIN_INVALID`로 중단됩니다. 테스트나 스테이징 원본으로 운영 결과물을 만들지 않습니다.

## 2. 공개 표면 정책

`apps/site/src/search/surface-registry.ts`가 URL 공개 정책의 단일 기준입니다. 경로 문자열을 보고 정책을 추측하지 않습니다.

| 정책 | 대상 | 검색 산출물 |
| --- | --- | --- |
| `indexable` | 홈, 소개, 업무 목록·상세, 진행 절차, 인사이트 목록·승인 글, 오시는 길 | self-canonical, 실제 번역만 포함한 hreflang, JSON-LD, sitemap |
| `noindex` | 상담 신청, 개인정보 처리방침 운영 초안, 마케팅 철회, 404 | self-canonical과 `noindex, follow`; hreflang·sitemap·RSS·IndexNow 제외 |
| `private` | 관리자, API, 내부, 상태 확인, 철회 토큰, 내부 검증 토큰 | 사이트 빌드 대상 아님; 인증·호스트 분리·404와 robots disallow를 함께 적용 |

robots는 접근통제가 아닙니다. 관리자·API·토큰 URL은 별도 호스트, 인증 및 서버 라우팅으로 차단해야 합니다.

## 3. canonical과 다국어 그래프

- 색인 가능한 HTTP 200 페이지마다 절대 self-canonical을 정확히 하나 출력합니다.
- 기본 페이지는 한국어, 영어, 중국어 간체 및 중국어 번체 네 페이지가 동일한 상호 hreflang 집합을 가집니다.
- 글 번역은 slug가 아니라 동일한 `articleId`로 연결합니다. 각 언어 slug는 달라도 됩니다.
- 승인되어 실제 manifest에 존재하는 언어만 글 hreflang과 화면 언어 링크에 포함합니다.
- 같은 글의 한국어 판이 있을 때만 `x-default`를 한국어 canonical로 출력합니다. 한국어가 없으면 `x-default`도 없습니다.
- 누락된 언어 페이지를 생성하거나 다른 언어 본문으로 대체하지 않습니다.

## 4. 구조화 데이터와 콘텐츠 품질

허용하는 최상위 Schema.org 타입은 다음 다섯 가지뿐입니다.

- `ProfessionalService`
- `Person`
- `Service`
- `Article`
- `BreadcrumbList`

`Attorney`, `Review`, `AggregateRating`, 가짜 후기·평점·성공률·순위·보장 문구는 만들지 않습니다. 사무소와 대표의 ID는 각각 `PUBLIC_ORIGIN/#professional-service`, `PUBLIC_ORIGIN/#representative`로 고정합니다. 사무소 `url`은 현재 문서 URL이 아니라 해당 언어의 홈 canonical입니다.

서비스 상세 페이지가 색인되려면 다음 항목이 모두 있어야 합니다.

- 현지화된 title, description 및 H1
- `scope`, `preparation`, `process` 답변 섹션
- 대표행정사 검수자 이름과 직함
- 실제 콘텐츠 개정에 연결된 검수일·최초 공개일·수정일
- 승인 revision ID와 콘텐츠 SHA-256
- 화면에 표시되는 유효한 HTTPS 공식 출처 한 개 이상

승인 글은 정규화 Markdown과 sanitizer 결과, H2 답변 섹션, 검수자, 네 개의 이벤트 일자, revision ID, 실제 semantic SHA-256 및 HTTPS 출처를 모두 통과해야 합니다. Site는 `computePublishedArticleContentSha256`으로 제목·요약·정규화 Markdown·출처·언어를 다시 계산합니다. 문자 수만으로 게시 가능 여부를 판단하지 않습니다.

화면의 H1·요약·검수자·일자·출처와 JSON-LD는 같은 타입 DTO에서 생성됩니다. JSON-LD는 `<`, `>`, `&`와 script 종료 문자열을 이스케이프합니다.

정적 기본 콘텐츠를 수정하면 `surface-registry.ts`의 해당 `lastModified`를 실제 콘텐츠 개정 시각으로 함께 갱신합니다. 빌드 시각을 `lastmod`로 사용하지 않습니다.

## 5. sitemap, RSS 및 robots

운영 결과물은 다음 루트 파일을 제공합니다.

- `/sitemap.xml`: 색인 가능한 self-canonical HTTP 200 URL 집합과 정확히 동일
- `/rss.xml`: 현재 active manifest의 승인 글만 포함
- `/robots.txt`: 절대 sitemap URL과 크롤러별 정책 포함

RSS의 guid와 link는 글 canonical이며, 언어·최초 공개일·수정일 및 sanitizer를 통과한 HTML만 포함합니다. 초안, 개인정보, 관리자·API·토큰·검증 파일은 sitemap과 RSS에 들어가지 않습니다.

robots 허용 그룹은 `Googlebot`, `Yeti`, `OAI-SearchBot`, `Google-Extended`, `ChatGPT-User`, `*`입니다. 각 그룹에 관리자·API·내부·상태 확인·철회·검증 토큰 경로를 반복해서 disallow합니다. `GPTBot`은 전체 차단합니다. `OAI-SearchBot`, `GPTBot`, `ChatGPT-User`는 서로 다른 제어 항목입니다. `nosourceinfo`는 사용하지 않습니다.

정적 Astro preview는 `.xml` 파일을 `text/xml`로 제공할 수 있습니다. 운영 Caddy에서는 sitemap을 `application/xml; charset=utf-8`, RSS를 `application/rss+xml; charset=utf-8`로 제공하는지 확인합니다.

## 6. Google Search Console 소유권 확인

Google은 Domain Property와 DNS TXT 확인을 사용합니다. HTML 메타 토큰과 섞지 않습니다.

```sh
export GOOGLE_SITE_VERIFICATION_DNS='google-site-verification=운영자가_발급받은_값'
```

이 값은 형식 검증과 운영 체크에만 사용하며 HTML, sitemap, RSS, 로그 또는 Git에 출력하지 않습니다.

1. Search Console에서 Domain Property를 생성합니다.
2. 표시된 TXT 레코드를 DNS 공급자에 등록합니다.
3. DNS 전파 후 Search Console에서 확인합니다.
4. 확인 후에도 TXT 레코드를 삭제하지 않습니다.
5. 실제 canonical 원본의 sitemap URL을 제출합니다.

`CHANGE_ME`, `your-token-here` 같은 placeholder는 설정되지 않은 값으로 취급합니다.

## 7. 네이버 Search Advisor 소유권 확인

네이버는 메타 방식과 파일 방식 중 하나만 사용합니다. 두 방식을 동시에 설정하면 빌드가 중단됩니다.

### 메타 방식

```sh
export NAVER_SITE_VERIFICATION_META='운영자가_발급받은_원문_토큰'
```

설정된 경우에만 모든 정적 HTML head에 다음 태그가 생성됩니다.

```html
<meta name="naver-site-verification" content="원문_토큰">
```

### 파일 방식

```sh
export NAVER_SITE_VERIFICATION_FILE='naver발급값.html'
```

빌드는 루트에 정확한 파일 하나를 만들고 본문을 `naver-site-verification: 파일명`으로 고정합니다. 해당 파일은 sitemap, RSS 및 hreflang에 포함하지 않습니다. 정적 파일 응답은 빌드 시 설정한 헤더를 보존하지 않을 수 있으므로 Caddy에서 이 파일 패턴에 `X-Robots-Tag: noindex`를 추가합니다.

실제 토큰과 파일명은 `.env`, fixture, 테스트, 문서 예제, Git 또는 로그에 저장하지 않습니다.

## 8. IndexNow 순서와 재시도

IndexNow 키와 전송은 Control의 durable outbox가 소유합니다. Site는 현재 릴리스의 정렬된 `indexNowUrls`와 안정적인 `releaseSetSha256`만 생성합니다.

1. 승인 manifest로 임시 릴리스 디렉터리를 빌드합니다.
2. canonical·sitemap·RSS·내부 링크·민감정보·초안 canary 검증을 통과합니다.
3. 검증된 릴리스를 원자적으로 `current`에 전환합니다.
4. 전환이 성공한 후에만 같은 호스트의 현재 canonical URL을 outbox에 기록합니다.
5. `(releaseSetSha256, canonical URL)`로 중복 전송을 방지합니다.
6. HTTP 200은 요청 수락, HTTP 202는 키 검증 대기로 기록합니다. 어느 응답도 색인 완료를 뜻하지 않습니다.
7. 실패는 outbox 정책으로 재시도하며 요청 본문, 키 또는 URL 목록을 일반 로그에 남기지 않습니다.

롤백은 이전의 검증된 정적 릴리스 전체를 다시 `current`로 전환합니다. 이전 manifest를 임의로 재생성하지 않으며, canonical·sitemap·RSS·IndexNow URL 집합도 이전 릴리스와 동일해야 합니다.

## 9. 빌드 및 검증 체크리스트

macOS 운영 장비에서 실제 값으로 실행합니다.

```sh
export PUBLIC_ORIGIN='https://실제-공개-도메인'
export WISDOM_PUBLISHED_CONTENT_DIR='/절대경로/immutable-release-content'
npm run build --workspace @wisdom/shared
npm test --workspace @wisdom/site
npm run typecheck --workspace @wisdom/site
npm run build --workspace @wisdom/site
npm run test:e2e --workspace @wisdom/site -- --grep 'search discovery|published insight'
```

배포 전 다음을 모두 확인합니다.

- 모든 색인 가능 HTML에 canonical이 하나이고 요청 페이지의 절대 URL과 같다.
- hreflang에는 self가 있고 모든 sibling이 동일한 상호 집합을 가진다.
- 한국어 sibling이 있을 때만 `x-default`가 한국어 canonical을 가리킨다.
- noindex 및 private URL이 sitemap, RSS, IndexNow 목록에 없다.
- sitemap `<loc>` 집합이 색인 가능한 canonical 집합과 정확히 같다.
- RSS item 수가 active manifest 승인 글 수와 같고 초안·PII·unsafe HTML canary가 없다.
- JSON-LD의 모든 `@id`, `url`, breadcrumb item, citation이 파싱 가능한 절대 HTTPS URL이다.
- Service와 Article JSON-LD의 이름·설명·검수자·일자·출처가 화면 내용과 같다.
- `/robots.txt`가 HTTP 200 `text/plain`이고 각 명시적 allow 그룹에 민감 경로가 반복된다.
- GPTBot은 전체 차단되고 OAI-SearchBot과 ChatGPT-User는 독립 그룹이다.
- Google DNS 값이 HTML·feed·sitemap에 없고 네이버 값은 선택한 한 방식으로만 출력된다.
- Naver raw 파일에 운영 Caddy가 `X-Robots-Tag: noindex`를 붙인다.
- `nosourceinfo`, 가짜 후기·평점·성공률·순위·보장 문구가 없다.

검색엔진 제출 후에는 Search Console과 Search Advisor에서 소유권 상태, sitemap 읽기 결과, 크롤링 오류 및 색인 제외 사유를 각각 확인합니다. 결과를 근거로 콘텐츠와 기술 오류를 개선하되 순위·색인·AI 인용 완료 시점을 약속하지 않습니다.

## 10. 공식 참고 문서

- Google 다국어 페이지: <https://developers.google.com/search/docs/specialty/international/localized-versions>
- Google canonical: <https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls>
- Google 구조화 데이터 정책: <https://developers.google.com/search/docs/appearance/structured-data/sd-policies>
- Google sitemap: <https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap>
- 네이버 Search Advisor: <https://searchadvisor.naver.com/guide/seo-help>
- OpenAI 크롤러: <https://developers.openai.com/api/docs/bots>
- IndexNow 프로토콜: <https://www.indexnow.org/documentation>
