# ChatGPT Sites 공개 포털 마이그레이션

기준일: 2026-07-25  
문서 상태: 현재 서비스와 Sites 책임 분리 v1.5  
로컬 Sites 패키지 기준: `0.1.31`  
대상: 지혜행정사사무소 공개 포털

## 목적

현재 `apps/site`의 공개 포털 디자인, 네 언어 콘텐츠, 실무 안내, 정책 화면과
상담 신청 UI를 ChatGPT Sites에서 다시 구현하기 위한 기준 문서입니다.

다음 운영 기능은 Sites로 옮기지 않습니다.

- 관리자 포털
- 상담·동의·철회 데이터베이스
- 인증·감사·알림·보존 및 삭제 워커
- 콘텐츠 작성·검수·승인 원장
- Mac mini의 Control 운영 환경

## 이번 재검토에서 바로잡은 전제

1. **모든 Sites 배포 URL은 production입니다.**
   owner-only 접근으로 제한한 배포도 staging 또는 private preview가 아닙니다.
2. 배포 전 검토 단계는 로컬 미리보기와 **저장만 된 version**으로 구분합니다.
   saved version 자체는 배포가 아닙니다.
3. Sites lifecycle은 `Site 생성 → source push → version 저장 → production
   deploy` 순서입니다.
4. custom domain, 접근 정책, production runtime 환경변수, 저장된 version
   조회와 재배포가 현재 Sites 기능으로 제공됩니다.
5. 현재 포털은 D1, R2, SIWC를 사용하지 않습니다. 상담 개인정보는 기존
   Control로 직접 전송하고 Control만 저장합니다.
6. Sites starter와 원격 source lifecycle을 보존하기 위해 신규 포털은 현재
   monorepo 하위 workspace가 아니라 **독립 Sites source root**에 구축합니다.
7. `www`를 Sites에 연결하면 현재 Caddy의 같은 host 경로 분기를 사용할 수
   없으므로 API와 마케팅 철회 origin을 분리합니다.
8. Sites 내장 Analytics는 외부 baseline으로 사용합니다. Control과 React
   관리자의 first-party Analytics는 현재 서비스 기능으로 별도
   구현·운영하며 Sites migration의 선행 구현 task로 취급하지 않습니다.

## 문서 읽는 순서

1. [`00-sites-capability-baseline.md`](00-sites-capability-baseline.md)
   - 현재 Sites 기능, 제약과 이 프로젝트에서 사용할 기능을 고정합니다.
2. [`01-migration-scope.md`](01-migration-scope.md)
   - 이관 대상, 비대상, 성공 기준과 승인 경계를 정의합니다.
3. [`02-portal-content-map.md`](02-portal-content-map.md)
   - 페이지, 정보 단위, 다국어 콘텐츠와 상담 폼 계약을 정리합니다.
4. [`03-target-architecture.md`](03-target-architecture.md)
   - Sites, custom domain, Control API와 콘텐츠 공급의 목표 구조를 정의합니다.
5. [`04-implementation-plan.md`](04-implementation-plan.md)
   - 승인 후 수행할 작업을 순서와 결과물 단위로 나눕니다.
6. [`05-decision-and-risk-register.md`](05-decision-and-risk-register.md)
   - 확정 결정, 실행 전 게이트와 위험을 기록합니다.
7. [`06-sites-analytics-baseline.md`](06-sites-analytics-baseline.md)
   - Sites 내장 Analytics에서 확인할 기능과 공개 후 기록 범위를 정의합니다.

현재 서비스의 성과지표 구현은 이 migration 폴더 밖의
[`2026-07-24-first-party-analytics.md`](../superpowers/plans/2026-07-24-first-party-analytics.md)를
따릅니다. 이 문서는 Astro·Control·React 관리자 기능이며 Sites migration과
독립된 승인 단위입니다.

## 현재 결론

- 현재 Astro 포털은 custom-domain 전환과 안정화가 끝날 때까지 운영 및
  rollback 대상으로 유지합니다.
- 신규 Sites 포털은 독립 source root에 병행 구축합니다. 기본 경로 후보는
  `/Users/wisdom/wisdom_project/gpt/wisdom_sites_portal`이며 실제 생성 전에
  사용자 승인을 받습니다.
- Sites는 공개 화면과 상담 폼 UI를 담당합니다.
- Control은 상담 API, 동의문 권위, PII, 마케팅 철회, 관리자 기능과 알림을
  계속 담당합니다.
- 상담 브라우저 요청은 Sites route handler를 거치지 않고 Control의 전용
  public API origin으로 직접 보냅니다.
- 콘텐츠 승인은 계속 Control에서 수행하고, 승인된 immutable public snapshot을
  Sites source version에 포함하는 운영자 주도 release handoff를 사용합니다.
- 현재 서비스의 aggregate page-view 수집과 React 성과 화면은 별도
  현재 서비스 계획에서 구현합니다. Sites migration은 기능을 다시 구현하지
  않고, 공개 전환 시 승인된 collector wire contract만 선택적으로
  재사용합니다.
- Sites 내장 Analytics는 독립된 외부 baseline으로 사용합니다. Sites의 인기
  페이지는 현재 공식 문서와 connector에서 확인되지 않으므로 실제 account의
  제공 여부만 별도로 기록합니다.
- Sites 프로젝트 생성, 코드 구현, 테스트, source push/version 저장,
  owner-only production 배포, public access 전환, custom domain 연결은 서로
  다른 승인 단위입니다.

## 현재 실행 상태

- 이 폴더의 계획 문서만 수정했습니다.
- Sites 프로젝트나 `.openai/hosting.json`은 생성하지 않았습니다.
- Sites access, runtime 환경변수, custom domain과 deployment를 변경하지
  않았습니다.
- Sites Analytics 화면 조회와 baseline 기록을 실행하지 않았습니다.
- 코드 수정, 테스트, 브라우저 검증, 커밋과 푸시는 실행하지 않았습니다.

## 문서 변경 규칙

- Sites 마이그레이션 Markdown만 이 폴더에서 관리합니다. 현재 서비스 기능
  구현계획은 `docs/superpowers/plans`에서 관리합니다.
- 공개 콘텐츠의 사실은 현재 실행 코드와 승인된 production public release를
  기준으로 합니다.
- fixture, placeholder 법률 문구와 예시 게시글을 운영 입력으로 확정하지
  않습니다.
- lifecycle 또는 아키텍처 결정이 바뀌면
  `05-decision-and-risk-register.md`와 관련 문서를 함께 갱신합니다.
