# ChatGPT Sites 기능 기준

기준일: 2026-07-25  
검토 기준: 로컬 Sites 패키지 `0.1.31`, 현재 Sites connector, OpenAI 공식 문서

## 이 문서의 역할

Sites 기능이 바뀌면 마이그레이션 계획의 전제도 달라집니다. 이 문서는 이번
계획이 의존하는 현재 기능과 프로젝트별 선택을 고정합니다.

## 현재 기능과 프로젝트 적용

| 영역 | 현재 Sites 기능 | 이 프로젝트의 적용 |
|---|---|---|
| 앱 구조 | React 기반 Next App Router 호환 vinext/Vite starter와 Worker-compatible ESM runtime | 공개 포털을 capability path로 신규 구현 |
| source | Site별 source repository와 단기 write credential | 검토한 정확한 commit을 credential 비저장 방식으로 push |
| version | source commit SHA와 source archive로 saved version 생성 | 같은 source state의 SHA와 archive만 사용 |
| deployment | 저장된 version만 배포 가능하며 모든 deployment URL은 production | owner-only production 배포와 public 배포를 별도 승인 |
| access | `public`, `workspace_all`, `custom`; owner는 항상 접근 가능 | 최초 owner-only, 최종 승인 후 anonymous public |
| runtime env | production 환경변수 조회·수정, secret 표시, environment revision | 공개 API origin과 canonical origin만 관리; secret은 소스에 넣지 않음 |
| custom domain | domain 추가, DNS record 안내, 상태 갱신·제거 | production 배포 후 도구가 반환한 DNS record만 적용 |
| history | Site version 목록·상세 조회와 이전 version 재배포 | 애플리케이션 rollback에 사용 |
| analytics | SDK 없이 순 방문자·페이지 조회·추이·기간·집계 단위 제공 | Sites가 관리하는 외부 baseline으로만 확인 |
| D1 | 구조화된 영속 상태 | 사용하지 않음 |
| R2 | blob·upload 저장 | 사용하지 않음 |
| SIWC | Sign in with ChatGPT와 workspace identity | 익명 공개 포털이므로 사용하지 않음 |
| Site logs/storage | Site별 운영 리소스 | 상담 PII 저장소로 사용하지 않음 |

## starter와 local source

현재 starter의 주요 특성은 다음과 같습니다.

- React `19.2.6`
- Next `16.2.6` 호환 App Router
- vinext `0.0.50`
- Vite `8.0.13`
- Node `>=22.13`
- `app/`, `worker/index.ts`, `vite.config.ts` 중심 구조
- build 결과의 `dist/server/index.js`가 package archive에 필요

현재 monorepo는 Node `>=24 <25`, npm workspace와 root lockfile을 사용합니다.
Sites initializer는 빈 target과 자체 Git/lockfile을 전제로 하므로
`apps/sites-portal`에서 직접 실행하면 nested Git과 lockfile 경계가
불명확해집니다.

따라서 신규 Sites portal은 승인된 독립 source root에서 초기화합니다. 현재
저장소는 콘텐츠·디자인·계약의 참조 원본과 Control backend로 유지합니다.

## `.openai/hosting.json` 계약

이 파일에는 Sites binding만 둡니다.

```json
{
  "project_id": null,
  "d1": null,
  "r2": null
}
```

- Site 생성 전 `project_id`는 `null`입니다.
- Site 생성 결과의 opaque ID를 변형하지 않고 정확히 기록합니다.
- 현재 포털은 D1과 R2를 사용하지 않으므로 두 binding은 `null`입니다.
- runtime 환경변수와 secret은 이 파일에 넣지 않습니다.
- 파일이 존재하면 Site를 새로 만들기 전에 반드시 먼저 읽습니다.
- 같은 local Site에 Site 생성 작업을 두 번 수행하지 않습니다.

## source, version, deployment의 정확한 경계

```text
local source
  → Site 생성(최초 1회)
  → 단기 source write credential 발급
  → 검토한 exact source commit push
  → 같은 commit으로 build/package
  → exact commit SHA + exact archive로 version 저장
  → 승인된 saved version을 production deploy
  → deployment status가 success일 때 URL 사용
```

- source credential은 파일, shell history, 문서 또는 로그에 저장하지 않습니다.
- saved version은 배포가 아니며 공개 URL을 만들지 않습니다.
- owner-only deployment도 production입니다.
- access 제한은 staging 여부가 아니라 production URL의 접근 권한입니다.
- source push 이후 바뀐 파일이 있으면 기존 SHA/archive로 version을 저장하지
  않고 다시 source state를 맞춥니다.

## access와 인증

접근 정책과 앱 인증은 별개입니다.

- **구축·초기 확인:** owner-only `custom` access
- **최종 공개:** 사용자 승인 후 `public`
- **사용하지 않음:** `workspace_all`, 선택 사용자/그룹 운영, SIWC

공개 포털 방문자는 ChatGPT 로그인을 요구하지 않습니다. 관리자 인증은 기존
Control admin host에 남습니다.

## runtime 환경변수

계획상 필요한 값은 다음과 같습니다.

| 이름 | 공개 여부 | 용도 |
|---|---|---|
| `PUBLIC_SITE_ORIGIN` | 공개값 | canonical, hreflang, structured data 기준 |
| `PUBLIC_CONSULTATION_API_ORIGIN` | 공개값 | 브라우저가 직접 호출할 Control API origin |

두 값은 비밀이 아니지만 환경별 변경을 source와 분리하기 위해 runtime env로
관리합니다. server-render 단계에서 client component에 필요한 값만 전달합니다.
상담 API secret, Control credential 또는 withdrawal token은 Sites env에 넣지
않습니다.

현재 서비스 first-party Analytics를 Sites에서도 이어서 사용할지는 base
migration과 별개의 선택 사항입니다. 공개 전환 후 별도 승인을 받은 경우에만
Sites client flag와 collector origin 계약을 추가합니다.

환경변수 수정은 environment revision을 만들며, 해당 revision은 이후 saved
version을 배포해야 production에 적용됩니다. 로컬 개발값은 `.env`에 두고
이름만 `.env.example`에 기록합니다.

## custom domain

Sites는 custom domain을 지원합니다. 실제 사용 가능 여부는 계정·workspace,
public publishing 정책과 출시 범위에 따라 달라질 수 있습니다.

절차는 다음과 같습니다.

1. 승인된 saved version을 production에 배포합니다.
2. owner-only access를 유지한 상태에서 custom domain 추가 승인을 받습니다.
3. custom domain을 Site에 추가합니다.
4. Sites가 반환한 CNAME/A/검증 record를 DNS에 적용합니다.
5. domain 상태를 갱신해 active를 확인합니다.
6. 별도 승인 후 Site access를 anonymous `public`으로 바꿉니다.
7. canonical과 외부 경로를 확인한 뒤 기존 Astro origin을 rollback 대상으로
   유지합니다.

DNS target을 추측하거나 임의로 만들지 않습니다. 공식 안내상 Enterprise는
출시 시점에 custom domain을 사용할 수 없으며, workspace 관리자가 public
publishing을 제한할 수 있습니다.

## 저장소와 인증 기능을 사용하지 않는 이유

상담 폼은 이름, 전화, 이메일, 회사명과 문의 내용을 다룹니다. 이 데이터의
기존 암호화, 동의 원장, 감사, 보존·삭제와 마케팅 철회 보장을 유지하기 위해
브라우저가 Control API로 직접 전송합니다.

따라서 다음 기능을 현재 migration에 추가하지 않습니다.

- D1에 상담 레코드 저장
- R2에 첨부 또는 상담 데이터 저장
- Sites route handler를 통한 상담 body proxy
- browser storage에 상담 body 저장
- SIWC를 이용한 방문자 계정 생성

## 내장 Analytics

Sites는 배포된 Site의 traffic을 자동 기록하고 다음 값을 ChatGPT web·desktop
Analytics 화면에서 제공합니다.

- 총 순 방문자
- 총 페이지 조회
- 두 지표의 시간 추이
- date range
- granularity

별도 analytics SDK는 필요하지 않습니다. 현재 공식 기준상 Enterprise
workspace 소유 Site에는 Analytics가 제공되지 않으며 CLI·IDE에는 독립
Analytics 화면이 없습니다. 현재 connector에도 analytics 조회 도구가
노출되지 않으므로 자동 수집·export API를 가정하지 않습니다.

인기 페이지, unique visitor 산정 방식, 갱신 주기, 보관기간과 CSV/API export는
현재 공식 가이드에 명시되지 않았습니다. account 화면에서 확인되기 전에는
확정 기능으로 약속하지 않습니다.

자세한 확인·기록 기준은
[`06-sites-analytics-baseline.md`](06-sites-analytics-baseline.md)를
따릅니다.

## 서비스 운영 책임과 제약

- Site 운영자는 Site 내용과 방문자가 제출하는 데이터에 책임이 있습니다.
- 개인정보를 받을 경우 고지, 동의, 권리 행사와 보유·삭제 체계를 유지해야
  합니다.
- 이 Site는 PHI와 결제카드 데이터를 처리하지 않습니다.
- 주민등록번호, 여권번호와 외국인등록번호도 상담 폼에서 받지 않습니다.
- 현재 Sites는 공개 beta 기능이며 지원하지 않는 framework, private network,
  database 또는 background service 패턴이 있을 수 있습니다.
- 공식 안내상 출시 시점에는 Sites의 데이터·추론 residency가 지원되지
  않습니다.

## 공식 기준 문서

- [Creating and managing ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites)
- [Managing ChatGPT Sites for your workspace](https://help.openai.com/en/articles/20001338-managing-chatgpt-sites-for-your-workspace)
- [Understanding responsibilities for your ChatGPT Sites](https://help.openai.com/en/articles/20001337-understanding-responsibilities-for-your-chatgpt-sites)
- [ChatGPT Sites: complying with data protection laws](https://help.openai.com/en/articles/20001340-chatgpt-sites-complying-with-data-protection-laws)
- [ChatGPT Sites Terms](https://openai.com/policies/chatgpt-sites-terms/)
- [ChatGPT Sites Data Processing Addendum](https://openai.com/policies/chatgpt-sites-data-processing-addendum/)
- [ChatGPT Sites developer guide](https://learn.chatgpt.com/docs/sites)

공식 기능이나 connector 계약이 바뀌면 이 문서를 먼저 갱신하고 나머지 계획을
다시 검토합니다.
