# 작업 로그

## 2026-07-15 · 홈페이지 스크롤 모션 설계

- 대상 시안: `.superpowers/brainstorm/mockups/hybrid/h1-recommended-hybrid.html`
- 선택 방향: 차분한 에디토리얼 리빌
- 재생 정책: 페이지를 연 뒤 요소별 최초 노출 시 한 번
- 스타일 기준: 실제 구현은 Tailwind CSS 사용
- 주요 제약: 반복 모션, 글자별 애니메이션, 강한 패럴랙스 제외
- 설계 문서: `docs/superpowers/specs/2026-07-15-homepage-scroll-motion-design.md`
- 독립 검토 반영: reduced-motion 최종 상태 보장, 원자적 오류 복구, 핵심 CTA 즉시 표시
- 2차 검토 반영: 숨김 선택자를 `prefers-reduced-motion: no-preference` 안으로 이동
- 모션 예산: 페이지 전체 8개, 요소별 완료 시간 760ms 이하
- 성능 중단 기준: 대표 사진 모션이 LCP를 100ms 넘게 악화시키면 제거
- 다음 단계: 사용자 설계 문서 검토 후 구현 계획 작성
- 사용자 설계 문서 승인 완료
- 구현 계획: `docs/superpowers/plans/2026-07-15-homepage-scroll-motion-sample.md`
- 실행 방식: 현재 세션 일괄 실행, `.worktrees/homepage-motion-sample` 격리 작업공간 사용

## 2026-07-15 · 홈페이지 스크롤 모션 샘플 구현

- 기반 구성: Vite 8, TypeScript, Tailwind CSS v4 로컬 빌드 (`5b86b97`)
- 모션 상태 모델: 최초 1회 리빌과 `IntersectionObserver` 폴백 (`7865f87`)
- 접근성·복구 보강: reduced-motion, 포커스, 해시, 회전, BFCache, 초기화 예외 (`0f8c7ef`)
- 홈페이지 구현: 추천 조합 디자인, 3대 전문업무, 4개 언어 표시, 8개 모션 대상 (`ece8a90`)
- 브라우저 회귀 검사: 반응형·오류 복구·무자바스크립트·성능 예산 (`2705dc2`)
- 최종 자동 검사: Vitest 13/13, Playwright 14/14, 운영 빌드 성공
- 렌더 산출물: 데스크톱 PNG 479,665바이트, 모바일 PNG 171,526바이트, 스크롤 WebM 937,096바이트
- 시각 확인: 1440px 데스크톱과 390px 모바일에서 텍스트·CTA·대표 사진 크롭·업무 카드 배치 확인
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체하고 AVIF·WebP·JPEG 파생 파일 생성
- 단일 파일 전달본: `.superpowers/brainstorm/renders/wisdom-homepage-motion-sample.html` (138,668바이트, 외부 자산 의존성 없음)

## 2026-07-15 · 시네마틱 모션 강화 데모

- 모션 대상 확장: 8개에서 12개로 확대 (`b593628`)
- 최종 자동 검사: Vitest 16/16, Playwright 16/16, TypeScript·Vite 운영 빌드 성공
- 독립 실행 검사: `file://`에서 12개 대상 리빌, 390px 가로 넘침 없음, 페이지 오류 없음
- 최종 산출물: 데스크톱 PNG 489,338바이트, 모바일 PNG 171,522바이트, 스크롤 WebM 1,997,846바이트, 단일 HTML 144,046바이트
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체

## 2026-07-15 · 동적 C1 독립 HTML 전달

- 동적 C1 최종값: 18개 대상, 500ms 지속시간, 64px 이동, 60ms 시차, 모바일 동일 강도
- 선행 구현 커밋: Task 1 `e204a44`, Task 2 `a224b45`
- 최종 자동 검사: Vitest 17/17, Playwright 16/16 통과
- 독립 실행 검사: `file://`에서 18개 대상 리빌, `scrollWidth: 390`, `clientWidth: 390`, `pageErrors: []`
- 독립 HTML: `.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html` (142,717바이트)
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체

## 2026-07-15 · 동적 C1 독립 HTML 최종 재검증

- 최종 자동 검사: Vitest 20/20, Playwright 32/32, TypeScript·Vite 운영 빌드 성공
- 사전 상태 검사: Observer를 애플리케이션 시작 전에 정지하고 18개 대상의 `data-revealed="false"`, opacity 0.08, blur 2px, 좌우 64px, 500ms, 0/60/120ms를 전수 확인
- 최종 상태 검사: 18개 대상의 `data-revealed="true"`, opacity 1, filter/translate 해제를 전수 확인
- 전환 중 가로 넘침: 최대 620ms 뒤 프레임 여유를 포함해 650ms를 한 번 기다렸고, 64개 `requestAnimationFrame` 표본 모두 `scrollWidth: 390`, `clientWidth: 390`
- 리소스·런타임 검사: 실제 DOM·CSSOM 리소스와 메인 문서 외 요청을 검사했으며 console/page/request 실패 및 외부 요청 0건
- 독립 HTML: 142,838바이트, SHA-256 `D6F7DCD60409FF965C4CB40823F767F90B47A06527D3BF1A4EF835E3724BE5DF`; 작업트리와 메인 프로젝트 복사본 일치
- 시네마틱 보존: 캡처 명령을 실행하지 않았고 데스크톱 PNG `22D76E30…E8A3`, 모바일 PNG `03B96A79…4117`, 스크롤 WebM `B8F55A77…E7175` 해시 유지
- 운영 전 남은 작업: 대표 사진을 고해상도 상반신 원본으로 교체
