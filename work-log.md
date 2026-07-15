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
