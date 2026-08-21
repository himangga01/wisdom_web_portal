# 리뷰 5 · 공개 포털 적대적 검토 (2026-07-23, 커밋 2026-07-24)

| 항목 | 내용 |
|---|---|
| 대상 | 공개 포털 UX 변경분(`fb2ccb4` 이후 표면) — 모바일 내비, i18n 전화·날짜, 폼 마감 |
| 방식 | 서로 다른 **5개 관점**(i18n·SEO·접근성/무JS·정확성·반응형)의 서브에이전트 병렬 실행 → 메인 세션 재검증 → 수용 |
| 결과 | **Important 3 · Minor 3** 수용, e2e **+9** (114 → 123) |
| 검증 | 사이트 타입체크 0 에러 · 유닛 101 · e2e **123/123**(Chromium·Firefox·WebKit) |
| 해소 | `38ff3b2` |

## 수용·수정 완료

| 심각도 | 지적 | 처리 |
|---|---|---|
| Important | **모바일 ≤400px에서 브랜드명 ↔ 언어 링크 겹침 회귀**(반응형) — `overflow-x:clip`이 e2e 오버플로 테스트를 통과시켜 놓침 | ≤420px에서 상단 `.language-links` 숨김(햄버거 `.mobile-languages`로 도달성 유지) |
| Important | `/privacy`·`/marketing/withdraw` 동의문서 발효일 **raw ISO 노출**(i18n) | `formatDisplayDate` 적용 |
| Important | **axe 검증 공백**(접근성) — axe 단언이 `/`·`/consultation`·인사이트에만 있고 404는 전무, 모바일 메뉴는 모든 뷰포트가 1280px라 `display:none`으로 스킵됨. 즉 이번에 바뀐 summary aria-label·모바일 내비가 한 번도 감사되지 않음 | 404 axe + 좁은 뷰포트에서 **메뉴 연 상태** axe + 헤더 겹침 기하 검증 테스트 추가 |
| Minor | json-ld `telephone` 하드코딩(SEO·i18n 중복 지적) | `OFFICE`에서 단일 파생 + 가드 테스트 |
| Minor | submit 핸들러가 `disabled` 속성에만 의존(정확성) | 상태 플래그 재검증(방어심층) 추가 |
| Minor | 제출 성공 시 포커스 유실(포커스된 버튼이 disabled되며 body로 이동), 외부 클릭으로 메뉴 닫을 때 포커스 미복귀(Escape는 복귀) | 상태 메시지에 `tabindex=-1` + `.focus()`, summary 포커스 복귀를 Escape와 대칭 처리 |

## 이 라운드의 핵심 성과

반응형 관점 에이전트가 **e2e 그린이 놓친 실제 레이아웃 회귀**를 잡아냈습니다. `overflow-x: clip`이 `scrollWidth` 기반 오버플로 테스트를 통과시키면서 겹침을 마스킹하고 있었습니다. 수정 후 그 사각지대를 메우는 **기하 검증 테스트**(요소 경계 상자 교차 검사)를 추가했고, 이 테스트가 그린이므로 겹침이 실제로 제거됐음이 확인됩니다.

## 보류 — 근거 기록

| 지적 | 보류 근거 |
|---|---|
| `aria-invalid`/`aria-describedby` 영속 연결 | 기존 폼 패턴의 광범위 변경 필요 |
| `phoneLength` 메시지 | `pattern` 제약에 가려짐(둘 다 낭독됨) |
| 무JS 환경의 summary 라벨 고정 | `aria-expanded`로 상태가 전달됨 |
| 404의 데드 `.muted` 클래스 | 무해한 미관 이슈 |
| 44px 터치 타깃 | WCAG AA 기준 24px 충족, 겹침 수정으로 대부분 해소 |
| 날짜 KST ±1일 | 의도된 표기(발효일은 KST 기준) |
