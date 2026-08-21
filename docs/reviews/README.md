# 코드 리뷰 기록

이 폴더는 `wisdom-web-portal`에서 수행한 코드 리뷰·UX 점검·적대적 검토의 **발견 사항과 처리 결과**를 원문 기준으로 보존합니다. `work-log.md`가 "무엇을 만들었는가"를 날짜순으로 기록한다면, 이 폴더는 "무엇을 지적받았고 어떻게 처리했는가"를 리뷰 단위로 기록합니다.

- 기록 시점: 2026-07-25
- 기록 범위: 2026-07-16 whole-branch 리뷰 이후 ~ 2026-07-25 포털 중심 전체 리뷰
- 원문 출처: 각 리뷰 수행 세션의 보고 원문(요약·재구성 없이 발견 사항과 근거를 보존)
- 파일·행 번호는 **해당 리뷰 시점 기준**입니다. 이후 수정으로 위치가 바뀐 항목은 각 문서의 처리 결과에 현재 위치를 병기했습니다.

## 심각도 기준

| 등급 | 코드 리뷰 | UX 점검 | 의미 |
|---|---|---|---|
| Critical / High | 🔴 | High | 배포 불가, 데이터 손상·유출, 기능 전면 불능 |
| Important / Medium | 🟠 | Medium | 특정 조건에서 조용히 실패·사용자가 갇힘·운영 관측 불가 |
| Minor / Low | 🟡 | Low | 잠복 결함, 일관성·문서 불일치, 개선 여지 |

## 리뷰 이력

| # | 일자 | 리뷰 | 대상 | 결과 | 해소 커밋 |
|---|---|---|---|---|---|
| 1 | 2026-07-20 | [변경분 코드 리뷰](2026-07-20-change-scope-code-review.md) | `1f249ac`→HEAD 56파일 | Critical 0 · Important 0 · Minor 2 | `ae3f89c` |
| 2 | 2026-07-20 | [전체 코드 리뷰](2026-07-20-full-codebase-review.md) | 전체 약 51,000줄 · 5개 영역 병렬 | Critical 0 · **Important 5** · Minor 약 15 | `ae3f89c` |
| 3 | 2026-07-20 | [UX 점검(공개 포털·관리자)](2026-07-20-ux-audit.md) | 빌드 산출물 68페이지 + 관리자 SSR | 공개 High 3·Med 8·Low 6 / 관리자 **High 6**·Med 8·Low 5 | `b8bb8ac` `03322e1` `2ce3021` `fb2ccb4` |
| 4 | 2026-07-22 | [관리자 2회 적대적 검토](2026-07-22-admin-adversarial-review.md) | 관리자 상담 UI(JSX SSR 이후) | 라운드 1·2 수용 다수 · 테스트 +13 | `19d0b00` |
| 5 | 2026-07-23 | [공개 포털 적대적 검토](2026-07-23-site-adversarial-review.md) | 포털 UX 변경분 | Important 3 · Minor 3 · e2e +9 | `38ff3b2` |
| 6 | 2026-07-25 | [포털 중심 전체 코드 리뷰](2026-07-25-portal-code-review.md) | `8da5cfd` · 운영 소스 약 44,900줄 | **Critical 2** · Important 3 · Minor 6 | `19ef015` `cc91065` `fa82f41` |

### 이 폴더 이전의 리뷰

문서화된 보고 원문이 남아 있지 않고 커밋과 `work-log.md`에만 기록된 이력입니다.

| 일자 | 리뷰 | 결과·해소 |
|---|---|---|
| 2026-07-16 | whole-branch 리뷰(6개 관점 × 2회 병렬 비판 검토 + 최종 재리뷰) | 공개 동의 authority 전량 해시 비용·철회 GET 선소비 문제를 재현·수정(`1f249ac`), **최종 재리뷰 Critical 0 · Important 0** — `work-log.md` 2026-07-16 Task 8 항목 |
| 2026-07-17 | 개인정보 보존·운영 복구 강화 검토 | `37d2d16` |
| 2026-07-17 | 2회차 복원력(resilience) 검토 | `2598f26` |

## 현재 미해소로 남은 항목

수정하지 않기로 **근거를 남기고 판단한** 항목만 모았습니다. 결함으로 판정됐으나 방치된 항목은 없습니다.

| 출처 | 항목 | 미수용 근거 |
|---|---|---|
| 리뷰 6 · M-5 | 비콘 1건당 `ensureDailySalt` 2회 호출 | 현 트래픽 규모에서 이득이 미미한 반면 `analytics/store.ts` 공개 API 변경이 필요해 위험 대비 효용이 낮음 |
| 리뷰 6 · M-6 | 상담 속도 제한이 폼 토큰 검증 **이후** 적용 | 순서를 바꾸면 토큰이 만료된 정상 사용자가 제한 예산을 소모해 오히려 악화. 토큰 발급 경로에 별도 제한이 있어 현 설계가 합리적 |
| 리뷰 4 | 파기 상담의 `preferred_contact`·`marketing_*` **DB 평문 소거** | 마케팅 동의는 합법적 보존 대상일 수 있어 정책 판단 사안이며 CHECK 제약상 마이그레이션 필요. 표시 레이어 은닉으로 갈음 |
| 리뷰 4 | 검색 접근 감사 로그 | 신규 기능 범위 |
| 리뷰 5 | `aria-invalid`/`describedby` 영속 연결, 무JS summary 라벨, 44px 터치 타깃, 날짜 TZ 고정 | 각각 대체 수단 존재(aria-expanded 전달·AA 충족) 또는 의도된 설계 |

## 관련 문서

- [`work-log.md`](../../work-log.md): 날짜순 구현·검증 이력
- [`docs/operations/release-candidate.md`](../operations/release-candidate.md): 공개 전 게이트와 실기기 점검
- [`docs/architecture/first-party-analytics-plan.md`](../architecture/first-party-analytics-plan.md): 리뷰 6이 대상으로 삼은 방문 통계 기능의 설계 근거
- [`research/quickshare-2026-07-15/critical-review-2-rounds.md`](../../research/quickshare-2026-07-15/critical-review-2-rounds.md): 코드가 아닌 **조사자료**에 대한 2회 비판 검토
