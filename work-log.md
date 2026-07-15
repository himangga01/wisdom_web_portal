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
