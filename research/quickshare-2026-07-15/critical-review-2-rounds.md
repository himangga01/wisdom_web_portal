# 기존 조사자료 2회 비판 검토 및 최종 수용안

- 검토 기준일: 2026-07-15 (Asia/Seoul)
- 검토 방식: 서로 다른 관점의 서브에이전트 3명 × 2회, 각 회차 후 메인 세션 재검증
- 검토 대상:
  - `source/구글 네이버 ChatGPT Gemini 검색에 노출되는 설득형 홈페이지 구축 전략.pdf`
  - `source/구글 네이버 ChatGPT Gemini 검색에 노출되는 설득형 홈페이지 구축 전략.docx`
- 목적: 조사자료를 그대로 채택하지 않고, `wisdom-web-portal`의 실제 요구에 맞는 설계 기준만 선별한다.

## 최종 결론

원 조사자료는 Google·Naver·ChatGPT·Gemini 검색 노출을 함께 생각하게 하는 출발점으로는 유용하다. 그러나 단순 정보 제공, 상담 접수, 블로그·카카오 연결, 로컬 PC 운영이라는 현재 요구에 바로 적용할 제작 명세는 아니다.

최종적으로 다음 원칙을 수용한다.

1. 검색 및 AI 노출은 보장 상품이 아니다. 크롤링 가능성, 색인 가능성, 도움이 되는 고유 콘텐츠, 확인 가능한 신뢰 근거, 기술 안정성의 누적 결과로 설명한다.
2. 업종·고객·핵심 제안·실제 증거·운영 방식이 정해지기 전에는 메뉴, 프레임워크, CMS, 상담 저장소를 확정하지 않는다.
3. 로컬 PC 공개 원본 요구를 기본 제약으로 존중한다. 다만 단일 PC·전원·회선은 고가용성이 아니며, 허용 중단시간과 문의 손실 허용도를 먼저 정한다.
4. 검색·AI 제어는 봇 이름을 나열하는 대신 목적별 제어 행렬로 관리한다.
5. 상담 접수는 클릭이나 브라우저 제출이 아니라 시스템 원장에 기록된 시점부터 별도 상태로 추적한다.
6. 개인정보 준수는 템플릿 문구로 완료되지 않는다. 실제 처리자, 법적 근거, 항목, 보유기간, 수탁자와 저장 국가가 확정되기 전에는 실데이터 폼을 공개하지 않는다.
7. IA와 홈 섹션은 고정 템플릿이 아니라 보유한 콘텐츠와 증거에 따라 켜는 조건부 모듈로 둔다.

## 검토 방법

### 1차 병렬 검토

서로 독립적인 세 관점을 사용했다.

- 증거·출처 감사: 인용의 적합성, 최신 공식 문서, 과장된 인과관계
- 아키텍처·운영 감사: 로컬 PC, 외부 공개, 장애, 상담 전달 신뢰성, 유지보수
- 고객설득·UX·개인정보 감사: 정보구조, 카카오 전환, 상담 폼, 접근성, 분석

메인 세션은 서브에이전트 의견을 그대로 채택하지 않고 원본 텍스트, 공식 문서, 장애 시나리오와 다시 대조했다.

### 2차 병렬 검토

1차 반영안을 다시 세 관점에서 공격했다.

- 검색·AI 정책 정합성: 제어 수단의 범위, 기본값, 상속, 상호작용, 측정 한계
- 장애 스트레스 테스트: 정전, 절전, 재부팅, 회선, Tunnel, 디스크, 메일, 미러, 복원
- MVP·고객가치 적대 검토: 고정 IA, 과잉 기능, 허위 증거, CTA, 준법 과장

이후 메인 세션이 다시 공식 문서 및 논리적 장애 모델로 검증하여 수용·부분수용·기각했다.

## 1차 결과와 메인 판단

### 수용

- PDF와 DOCX는 서술 내용이 실질적으로 같지만 레이아웃·도표·인용 구조는 다르다.
- 두 파일의 유사도를 단일한 `97.4%`로 표현하지 않는다. 정규화 방식에 따라 약 93.0%~97.9%로 달라졌기 때문이다.
- 원 보고서의 Next.js + Payload/Strapi + Meilisearch 기본안은 현재 소규모 요구에 비해 근거 없이 무겁다.
- `카카오`, `개인정보`, 구체적인 `상담 접수`, 로컬 PC 운영·복구가 원 보고서에서 충분히 다뤄지지 않았다.
- Google의 `data-nosnippet`, Search Console의 Search generative AI control, Naver의 Yeti·IndexNow를 별도로 검토해야 한다.
- 구조화 데이터, Naver 채널, 외부 언급을 AI 인용이나 검색 순위의 직접 보장 수단처럼 설명하지 않는다.
- ChatGPT referral/UTM, Search Console, Naver Search Advisor로 관찰 가능한 것은 전체 노출·학습·추천이 아니라 일부 결과다.
- 개인정보 최소수집, 보유·파기, 위탁·국외이전, 접근통제와 상담 전달 실패 처리가 필요하다.
- 카카오 공식 채널 경로와 대체 연락 수단을 두며, 클릭을 상담 완료로 집계하지 않는다.
- 자동화 접근성 검사만으로 WCAG 준수라고 표현하지 않는다.

### 부분수용

- Astro는 좋은 정적 사이트 후보지만 아직 확정하지 않는다. Next static export도 후보이며 편집자와 운영 역량을 먼저 확인한다.
- 상담 큐·DB라는 특정 구현을 무조건 강제하지 않는다. 대신 성공 응답 전에 내구성 있는 접수 증거가 있어야 한다.
- Cloudflare Tunnel은 인바운드 포트를 열지 않는 유력 후보지만, 모든 상황에서 직접 reverse proxy보다 우월하다고 단정하지 않는다.
- 관리형 호스팅이나 미러는 로컬 요구를 임의로 대체하지 않고 사용자 동의가 있을 때만 검토한다.

### 기각

- “Next.js는 전부 부적합하다.”
- “WordPress는 항상 낡았거나 부적합하다.”
- “모든 상담 폼은 무조건 동의 체크박스가 필요하다.”
- “모든 소규모 폼은 반드시 복잡한 큐와 별도 DB가 필요하다.”
- “원 조사자료 전체가 무가치하다.”

## 2차 결과와 메인 판단

### 추가 수용

- 검색·AI 제어를 목적 × 표면 × 범위 × 기본값 × 검증법의 행렬로 관리한다.
- `robots.txt`로 크롤링을 차단하면 HTML 안의 `noindex`·`nosnippet`을 읽지 못할 수 있으므로 차단과 메타태그를 무심코 병용하지 않는다.
- Google Search AI, Gemini Apps, Vertex AI grounding, Google user-triggered agents를 서로 다른 표면으로 본다.
- OpenAI의 OAI-SearchBot, GPTBot, ChatGPT-User를 검색·학습·사용자 요청 접근으로 분리한다.
- 공식 크롤러 문서는 매우 자주 바뀌므로 설계 동결 시점, 출시 직전, 운영 중에 다시 확인한다.
- 상담 상태를 `제출 시도 → 시스템 접수 → 알림 전달 → 담당자 확인 → 적격 상담`으로 나눈다.
- 상담 성공 보장의 장애 범위를 프로세스 재시작, 디스크 고장, PC 장애, 외부 제공자 장애 중 어디까지인지 명시한다.
- 정적 미러만 살아 있고 상담 API가 죽는 “가짜 가용성”을 금지한다.
- 미러가 필요하면 동일 정본 URL, 동일 산출물, 동일 canonical/robots/sitemap을 사용하고 공개 중복 URL을 만들지 않는다.
- 로컬 공개 서버는 일상용 PC와 같은 OS에 무방비로 두지 않고 전용 장비 또는 격리된 전용 VM을 기본 조건으로 둔다.
- 6개 메뉴와 긴 홈 섹션 순서를 확정하지 않는다. 한 고객군·한 문제·한 제안·한 주 CTA부터 정한다.
- 사례·후기·전문가·FAQ는 실제 증거와 질문이 있을 때만 만든다.
- 분석에 직접 식별자를 넣지 않더라도 IP, 쿠키, 기기 식별자, 공급자 로그 때문에 “개인정보가 전혀 없다”고 표현하지 않는다.

### 부분수용

- 로컬 SQLite + 재시도 + provider ID + 접수번호는 현재 범위의 합리적인 최소 후보지만, 외부 durable intake가 더 단순할 수도 있다. 개인정보 외부처리 허용 여부와 손실 허용도를 먼저 정한다.
- Turnstile은 유용한 스팸 방어 후보지만 제품명 자체를 필수로 하지 않는다. 어떤 방식을 쓰든 서버 검증, rate limit, 중복 방지가 필요하다.
- 관리형 WordPress는 엄격한 로컬 공개 원본의 기본 후보가 아니라, 외부 호스팅을 허용할 때의 명시적 대안으로만 둔다.
- CTA는 카카오·폼·전화·이메일을 같은 무게로 나열하지 않는다. 하나를 주 CTA로 정하고 운영 가능한 대체 수단을 최소 하나 둔다.

### 추가 기각

- Cloudflare Tunnel이 PC·전원·회선 장애까지 해결한다는 주장
- 별도 공개 도메인에 상시 색인 가능한 미러를 운영하는 안
- HTTP `200/202` 또는 이메일 발송 요청만으로 상담 접수 성공을 선언하는 안
- Google-Extended를 Google Search 노출·순위 제어로 설명하는 안
- ChatGPT-User를 robots.txt로 확실히 통제할 수 있다는 주장
- GSC 생성형 AI 보고서로 Gemini Apps, AI 학습, 답변 grounding 전체를 측정할 수 있다는 주장
- Yeti·IndexNow가 Naver AI 인용을 보장한다는 주장
- 카카오 SDK, CRM, CMS, 복잡한 AI 대시보드를 MVP 필수 기능으로 지정하는 안

## 최종 설계 기준

### 1. 먼저 확정할 사업 정보

- 업종과 적용 규제
- 최우선 고객군과 실제 의사결정자
- 해결할 문제 하나와 핵심 제안 하나
- 가격 공개 여부와 금지해야 할 주장
- 공개 가능한 자격, 실적, 사례, 수치, 후기 및 사용 권한
- 주 상담 CTA, 담당자, 영업시간과 실제 응답 기준

이 정보가 없으면 페이지 구조와 카피는 가설로만 작성한다.

### 2. 조건부 IA와 MVP

증거와 콘텐츠가 적다면 다음 단일 페이지로 시작할 수 있다.

1. 누구의 어떤 문제를 해결하는지
2. 제공 범위와 하지 않는 범위
3. 진행 절차와 예상 산출물
4. 검증 가능한 신뢰 근거
5. 주 상담 CTA와 대체 연락 수단
6. 개인정보 처리방침

서비스·사례·인사이트·회사/전문가·FAQ는 실제 콘텐츠가 생길 때 분리한다. Naver 블로그는 요청된 바로가기 채널로 연결할 수 있으나, 자체 사이트의 원문을 무분별하게 복제하지 않는다.

### 3. 기술 스택 결정 게이트

- 기술 편집자 1명, 낮은 발행 빈도: Git/Markdown 기반 정적 사이트 우선 검토
- 비기술 편집자, 빈번한 발행·승인 흐름: CMS 필요성 검토
- 엄격한 로컬 공개 원본: Astro 정적 또는 Next static export 우선 비교
- 로컬 self-hosted WordPress: 비기술 편집 가치가 운영·패치 부담보다 클 때만 검토
- managed WordPress: 외부 공개 원본을 허용할 때만 검토
- 상시 Node, ISR, Payload, Strapi, Meilisearch: 동적 기능, 다수 편집자, 자체 검색 요구가 확인될 때만 추가

### 4. 로컬 PC 공개 운영

최소 조건은 다음과 같다.

- 전용 상시 장비 또는 격리된 전용 VM
- 절전·최대절전 해제, 유선 연결, 전원 복구 후 자동 부팅
- 정적 서버와 외부 공개 연결의 OS 서비스 등록 및 자동 재시작
- 라우터 인바운드 포트를 열지 않는 방식을 우선 검토
- 외부 상태 모니터, 장애 알림 수신자, 디스크 여유와 로그 회전
- 버전별 빌드 산출물, 원자적 전환, 이전 버전 롤백
- 소스·설정·자격증명·상담 원장의 백업과 실제 복원 시험
- 공개 콘텐츠에 로그인용 Access나 무차별 JS challenge를 걸지 않음
- 봇 접근 정책 변경 후 Googlebot, Yeti, OAI-SearchBot 경로 재검사

Cloudflare Tunnel은 로컬 앱을 공개 hostname으로 연결할 수 있지만, 한 PC의 전원·디스크·회선 장애를 제거하지 않는다. 호스트 장애를 견디려면 별도 호스트의 replica가 필요하다. [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/), [Tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)

### 5. 상담 접수 상태와 최소 신뢰성

상태는 다음처럼 분리한다.

- `submission_attempted`: 브라우저가 제출을 시도함
- `received`: 시스템 원장에 접수 레코드가 생성됨
- `notification_accepted`: 알림 제공자가 메시지를 접수함
- `notification_delivered` 또는 `notification_failed`: 전달 결과가 확인됨
- `operator_acknowledged`: 담당자가 확인함
- `qualified`: 실제 상담 대상으로 판정됨

MVP 최소 기준:

- 서버 측 필드 검증과 최소수집
- origin/CSRF 정책, rate limit, 서버 검증형 스팸 방어
- 제출별 idempotency key와 같은 키의 중복 처리
- 한 곳의 명확한 시스템 원장과 접수 ID
- 성공 화면은 원장 기록이 확인된 뒤 표시
- 알림 실패 재시도, 최종 실패 경보, 운영자 대조
- 로그에서 상담본문·전화·이메일 등 직접 식별자 제거
- 보유기간 만료 시 자동 파기
- 백업 복원, timeout 후 재제출, 429/5xx, PC·Tunnel 중단 시험

단일 로컬 디스크가 고장난 뒤에도 성공 접수의 유실을 0건으로 요구하면, 다른 실패영역의 두 번째 durable 기록이 필요하다. 외부 처리를 금지한다면 마지막 백업 이후 손실 가능성과 RPO를 명시적으로 수용해야 한다.

### 6. 개인정보 및 분석

실서비스 폼 공개 전 다음을 확정한다.

- 개인정보처리자와 실제 처리의 법적 근거
- 필수·선택 항목, 목적, 보유기간, 파기 방식
- 동의가 근거라면 고지 내용과 거부 시 불이익
- 메일·폼·CDN·분석 제공자의 처리위탁, 저장 지역, 하위처리자
- 국외 조회·처리위탁·보관 여부
- 관리자 접근권한, 비밀값 보관, 사고 대응 책임자

개인정보보호위원회는 국외 제3자의 조회, 처리위탁, 보관도 국외이전 범주에 포함될 수 있다고 설명한다. [개인정보보호위원회 국외이전 제도](https://www.pipc.go.kr/np/default/page.do?mCode=D060040010)

분석에는 이름, 전화, 이메일, 문의본문, 카카오 식별자, 접수번호를 보내지 않는다. 다만 IP·쿠키·기기 식별자와 공급자 자동 로그까지 포함해 별도로 평가하며, 이를 단순히 “PII 없는 분석”이라고 부르지 않는다.

### 7. 검색·AI 제어 행렬

| 목적 | 제어 수단 | 범위와 주의점 | 검증 |
|---|---|---|---|
| Google Search 전체에서 페이지 제외 | `noindex` | Googlebot이 태그/헤더를 읽을 수 있어야 함. robots.txt로 동시에 막지 않음 | URL Inspection, 재크롤 후 색인 상태 |
| Google Search 생성형 AI 표면에서 사이트/속성 제외 | Search Console Search generative AI control | 일부 소유자 대상 롤아웃, 기본 Include. AI Overviews·AI Mode·Discover genAI에 영향, 일반 Search·AI 학습에는 영향 없음 | 속성/상속 상태 캡처, 전용 보고서, 변경 후 지연 반영 확인 |
| Google Search snippet·AI direct input 제한 | `nosnippet`, `max-snippet` | 페이지 단위. 모든 Search 표면의 preview에 영향 | 렌더링 HTML과 실제 Search 결과 |
| 특정 본문만 snippet에서 제외 | `data-nosnippet` | DOM 일부에만 적용. 내부 structured data는 별도로 사용될 수 있음 | 렌더링 HTML, Rich Results Test |
| Gemini Apps·Vertex 모델 학습 및 일부 grounding 제어 | `Google-Extended` | 별도 HTTP UA가 아닌 robots.txt product token. Google Search 포함·순위 제어가 아님 | robots 배포 확인, 문서 버전 기록 |
| Google 사용자 요청 agent 접근 | `Google-Agent` 등 | 사용자 요청 fetch는 robots.txt를 일반적으로 무시할 수 있음. 민감정보는 인증/인가로 보호 | 인증 없는 URL 노출 점검, 요청 검증 |
| ChatGPT 검색 결과 후보 | `OAI-SearchBot` | 허용은 검색 노출 보장이 아님. 차단해도 navigational link가 남을 수 있음 | robots, 공개 IP/WAF, 외부 200 응답 |
| OpenAI 모델 학습 정책 | `GPTBot` | OAI-SearchBot과 독립된 정책 | robots와 공식 문서 재확인 |
| ChatGPT 사용자 요청 fetch | `ChatGPT-User` | 자동 검색 크롤러가 아니며 robots.txt가 적용되지 않을 수 있음 | 민감정보 인증/인가, Search 지표로 사용 금지 |
| Naver 웹 발견·갱신 | Yeti 허용, sitemap/RSS, IndexNow | IndexNow는 변경 통지이며 색인 또는 AI 인용을 보장하지 않음 | Search Advisor 수집/색인 단계 확인 |
| 관리자·비공개 콘텐츠 보호 | 인증·인가 | robots는 접근통제가 아님 | 권한 없는 실제 요청 테스트 |

Google은 robots meta/X-Robots-Tag를 읽으려면 크롤러 접근이 허용돼야 한다고 명시하며, `nosnippet`과 `max-snippet`은 AI Overviews/AI Mode의 direct input에도 영향을 준다. [Google robots meta 문서](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)

Search Console의 생성형 AI 제어는 별도 속성 단위 기능이고 기본값은 Include다. 현재 일부 웹사이트 소유자에게 순차 제공된다. [Search generative AI control](https://support.google.com/webmasters/answer/16908024)

Google-Extended는 별도 HTTP user-agent가 아니며 Gemini Apps·Vertex AI API for Gemini 모델 학습과 일부 grounding을 제어하지만 Google Search 포함이나 순위 신호에는 영향이 없다. [Google common crawlers](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers)

OpenAI는 OAI-SearchBot, GPTBot, ChatGPT-User의 역할과 robots 적용 범위를 서로 다르게 설명한다. [OpenAI crawler documentation](https://developers.openai.com/api/docs/bots)

Naver는 IndexNow가 변경을 빨리 알리는 역할을 하지만 색인을 보장하지 않는다고 명시한다. [Naver IndexNow](https://searchadvisor.naver.com/guide/indexnow-about)

### 8. 측정 데이터 사전

처음부터 하나의 “AI visibility score”로 합치지 않는다.

| 지표 | 의미 | 의미하지 않는 것 |
|---|---|---|
| Google Search genAI link impressions | 지원되는 생성형 Search 표면에서 링크가 노출된 횟수 | Gemini Apps 노출, 학습, 링크 없는 grounding 전체 |
| 일반 GSC Web 데이터 | 일반 Search 성과에 포함된 집계 | 생성형 Search의 완전한 별도 성과 |
| `utm_source=chatgpt.com` 세션 | 사용자가 ChatGPT 링크를 실제 클릭한 방문 | 답변 안 언급, 인용 횟수, 학습 여부 |
| Naver Search Advisor 노출·클릭 | Naver 웹 검색 관찰값 | AI 브리핑·AI탭 인용 보장 |
| bot crawl 로그 | 크롤러가 URL을 요청했다는 사실 | 색인, 순위, 인용, 학습의 증거 |
| `cta_click` | 상담 행동 의도 | 접수 성공 |
| `received` | 서버 원장에 접수됨 | 담당자 확인, 적격 리드, 계약 |

현재 Google 생성형 AI 성과 보고서는 일부 속성에만 제공되고, 지원 표면의 링크 impression과 page/country/date/device 중심이다. 일반 Web 합계와 더해 이중 집계하지 않는다. [GSC Generative AI performance report](https://support.google.com/webmasters/answer/16984139)

### 9. 카카오·블로그·접근성

- 카카오는 MVP에서 공식 채널 링크를 먼저 검토하고, SDK는 필요한 기능이 있을 때만 사용한다.
- 카카오 클릭은 `kakao_click` 같은 상호작용이며 상담 완료가 아니다.
- 카카오 로그아웃·앱 부재·데스크톱 환경을 위해 폼 또는 전화 중 운영 가능한 대체 수단을 둔다.
- 블로그는 바로가기 요구를 충족하되, 자체 사이트와 동일 본문을 무분별하게 복제하지 않는다.
- 출시 전 키보드 전 과정, 가시적 포커스, label/오류 메시지, 200% 확대·리플로, 대비, 모바일 터치 영역, 고정 CTA 가림을 확인한다.
- 최소 한 스크린리더 조합으로 핵심 상담 흐름을 점검하되 이를 WCAG 인증이라고 표현하지 않는다.

## 출시 전 결정 게이트

### Gate A — “로컬”의 의미

- 소스가 로컬에 있어야 하는가?
- 공개 원본 서버가 로컬 PC여야 하는가?
- 상담 개인정보도 로컬에만 있어야 하는가?
- CDN 캐시와 외부 장애용 정적 복제본을 허용하는가?

### Gate B — 가용성

- 한 달 최대 허용 중단시간은 얼마인가?
- 한 번의 장애를 몇 시간 안에 복구해야 하는가?
- 정전·회선 장애 중 사이트 중단을 허용하는가?
- 높은 가용성이 필요하면 외부 미러 또는 독립 실패영역을 허용하는가?

### Gate C — 상담 손실

- 성공 화면 뒤 문의 손실을 몇 건까지 허용하는가?
- 디스크 고장까지 포함해 0건 손실을 요구하는가?
- 외부 메일·폼 제공자의 개인정보 처리를 허용하는가?
- 담당자는 이메일만 확인하는가, 상태 목록이 필요한가?

### Gate D — 콘텐츠 운영

- 편집자는 누구이며 월 몇 회 발행하는가?
- 승인·예약·버전복원 기능이 필요한가?
- 공개 가능한 사례와 증빙은 무엇인가?
- Naver 블로그를 지속 운영할 담당자가 있는가?

## 운영 중 재검증

검색·AI 크롤러 문서는 시점 민감하다. Google user-triggered fetchers와 common crawlers 문서는 검토 기준일 직전인 2026-07-13~14에도 갱신됐다.

다음을 필수 운영 항목으로 둔다.

- 설계 동결 시점, 출시 직전, 이후 월 1회 공식 문서 재확인
- URL, 문서 최종 수정일, 조회일을 기록
- user-agent 버전 문자열을 방화벽 규칙에 고정하지 않음
- robots 변경 후 회귀 테스트
- WAF/CDN 규칙 변경 후 검색봇 외부 접근 테스트
- Search Console·Naver Search Advisor의 수집/색인 오류 정기 확인
- 전원, 회선, `cloudflared`, 웹서버, 메일 API, 백업 복원 장애훈련

## 문서 상태

이 문서는 조사자료를 비판적으로 선별한 설계 기준이며 아직 최종 제작 명세가 아니다. 위 결정 게이트의 사용자 답변을 받은 뒤 실제 IA, 기술 스택, 개인정보 흐름, 배포 구조를 확정한다.
