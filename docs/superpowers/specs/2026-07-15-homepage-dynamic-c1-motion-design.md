# 홈페이지 C1 역동형 모션 데모 설계

## 1. 결정 사항

- 기준 시안: 기존 지혜행정사사무소 추천 조합 홈페이지
- 모션 방향: C1 빠른 좌우 리빌
- 관찰 대상: 정확히 18개
- 전환 시간: 500ms
- 이동 거리: 좌우 64px
- 카드 간격: 60ms
- 모바일: 데스크톱과 같은 64px·500ms 강도
- 재생 횟수: 각 대상이 화면에 처음 진입할 때 한 번
- 전달 형식: 서버 없이 직접 열 수 있는 단일 HTML

기존 900ms 시네마틱 B안은 새 데모로 덮어쓰지 않는다. C1 데모는 별도 파일로 생성해 이전 결과와 직접 비교할 수 있게 한다.

## 2. 목표와 제외 범위

### 목표

1. 현재 12개 세로 리빌을 18개 좌우 리빌로 바꿔 체감 속도와 화면 활력을 높인다.
2. 기업행정·공공조달·출입국·비자 카드가 각각 독립적으로 빠르게 등장하게 한다.
3. 모바일에서도 데스크톱과 같은 강도를 유지한다.
4. 모션 감소, 무자바스크립트, Observer 오류, 키보드·해시 이동 시 콘텐츠가 숨지 않게 한다.
5. CSS·JavaScript·대표 사진을 포함한 독립 HTML을 생성하고 `file://`에서 검증한다.

### 제외 범위

- 반복 자동 재생
- 글자 단위 애니메이션
- 패럴랙스와 스크롤 고정 장면
- 상담 폼, 관리자 기능, 다국어 번역 기능의 실제 구현
- 운영용 대표 사진 교체

## 3. 18개 모션 대상

그룹 전체를 하나의 대상으로 쓰던 업무·원칙·전문정보 영역을 개별 카드로 분리한다.

| 순서 | 키 | 대상 | 시작 방향 | 그룹 지연 |
|---:|---|---|---|---:|
| 1 | `hero-copy` | 메인 제목·설명·CTA | 왼쪽 | 0ms |
| 2 | `portrait` | 대표행정사 사진 | 오른쪽 | 0ms |
| 3 | `practice-enterprise` | 기업행정 카드 | 왼쪽 | 0ms |
| 4 | `practice-procurement` | 공공조달 카드 | 오른쪽 | 60ms |
| 5 | `practice-visa` | 출입국·비자 카드 | 왼쪽 | 120ms |
| 6 | `navigator-copy` | 업무 찾기 설명 | 왼쪽 | 0ms |
| 7 | `navigator-choices` | 상황 선택 패널 | 오른쪽 | 0ms |
| 8 | `principles-heading` | 업무 원칙 제목 | 왼쪽 | 0ms |
| 9 | `principle-direct` | 대표 1:1 처리 | 오른쪽 | 0ms |
| 10 | `principle-alternative` | 대안 경로 | 왼쪽 | 60ms |
| 11 | `principle-field` | 현장 사실조사 | 오른쪽 | 120ms |
| 12 | `insights-heading` | 전문정보 제목 | 오른쪽 | 0ms |
| 13 | `insight-procurement` | 조달 안내 카드 | 왼쪽 | 0ms |
| 14 | `insight-enterprise` | 기업인증 안내 카드 | 오른쪽 | 60ms |
| 15 | `insight-visa` | 비자 안내 카드 | 왼쪽 | 120ms |
| 16 | `credentials` | 대표행정사 이력 띠 | 오른쪽 | 0ms |
| 17 | `consultation-copy` | 상담 안내 문구 | 왼쪽 | 0ms |
| 18 | `consultation-card` | 사무소 정보 카드 | 오른쪽 | 0ms |

각 대상에는 `data-reveal-direction="left|right"`를 명시한다. 방향은 CSS 클래스 이름에 의존하지 않고 HTML 계약으로 검사한다.

## 4. 모션 토큰과 표현

```css
:root {
  --duration-dynamic: 500ms;
  --distance-dynamic: 64px;
  --stagger-dynamic: 60ms;
  --ease-dynamic: cubic-bezier(0.16, 1, 0.3, 1);
}
```

일반 환경에서만 다음 초기 상태를 사용한다.

- 왼쪽 시작: 개별 변형 속성 `translate: -64px 0`
- 오른쪽 시작: 개별 변형 속성 `translate: 64px 0`
- 초기 투명도: `0.08`
- 초기 흐림: `blur(2px)`
- 최종 상태: `opacity: 1`, `filter: none`, `translate: none`
- 전환: 500ms, `--ease-dynamic`

세로 이동과 큰 사진 확대는 제거한다. 2px 스크롤 진행선과 220ms 카드 호버 반응은 유지한다. 리빌은 개별 `translate` 속성, 호버는 기존 `transform` 속성을 사용해 같은 카드에서 두 효과가 충돌하지 않게 한다.

## 5. 상태 처리와 접근성

기존 `IntersectionObserver` 기반 최초 1회 상태 모델을 그대로 사용한다.

- Observer 준비 성공 후에만 루트에 `motion-enabled`를 추가한다.
- 대상은 `data-revealed="false"`에서 시작해 최초 교차 시 `true`가 되고 다시 되돌아가지 않는다.
- `prefers-reduced-motion: reduce`에서는 첫 프레임부터 최종 상태이며 전환 시간은 0ms다.
- Observer가 없거나 생성 중 예외가 나면 18개 대상 모두 즉시 최종 상태로 복구한다.
- 자바스크립트를 끈 경우 CSS 기본값으로 모든 콘텐츠를 표시한다.
- 포커스 진입과 해시 목적지는 즉시 최종 상태로 전환해 숨은 인터랙션을 만들지 않는다.
- 좌우 이동은 레이아웃 폭을 바꾸지 않으며 320px부터 1440px까지 가로 스크롤이 없어야 한다. 포커스·오류·모션 감소 복구 시 `translate: none`도 강제한다.

## 6. 코드 경계

- `index.html`: 18개 키·방향·그룹 지연 계약
- `src/dynamic-motion.css`: C1 토큰, 좌우 초기 상태, 접근성 폴백, 진행선·호버 보존
- `src/main.ts`: 동적 모션 CSS 로드와 기존 리빌 컨트롤러 시작
- `src/motion/reveal-controller.ts`: 최초 1회 관찰 로직 유지
- `tests/homepage-motion.spec.ts`: 브라우저 동작·반응형·접근성·성능 검사
- `scripts/build-standalone.mjs`: 동적 C1 독립 HTML 생성
- `scripts/verify-standalone.mjs`: `file://` 직접 실행 검사

시네마틱 전용 스타일은 동적 스타일과 동시에 로드하지 않는다. `cinematic-motion.css`를 `dynamic-motion.css`로 교체해 우선순위 충돌을 막는다.

## 7. 단일 HTML 산출물

출력 파일은 다음과 같다.

```text
.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html
```

다음 조건을 만족해야 한다.

- 외부 `/assets` 또는 `/images` 경로가 없다.
- 대표 사진이 JPEG 데이터 URL로 포함된다.
- Chromium이 서버 없이 파일을 직접 연다.
- 18개 대상이 모두 한 번씩 최종 상태가 된다.
- 390px 뷰포트에서 `scrollWidth === clientWidth`다.
- 콘솔 페이지 오류가 없다.

기존 `wisdom-homepage-cinematic-demo.html`은 비교용으로 보존한다.

## 8. 테스트 우선 구현과 승인 기준

1. 정적 계약 테스트를 18개 키·방향 순서로 먼저 변경하고 기존 12개 구현에서 실패를 확인한다.
2. 계산 스타일 테스트를 500ms·64px·60ms와 좌우 초기 상태로 변경하고 기존 900ms 구현에서 실패를 확인한다.
3. HTML·CSS를 최소 변경해 단위 테스트와 Playwright를 통과시킨다.
4. 독립 HTML 검증의 대상 파일명과 예상 개수를 먼저 변경해 실패를 확인한 뒤 빌더를 수정한다.
5. 전체 Vitest, Playwright, TypeScript·Vite 빌드, 독립 HTML 검증을 새로 실행한다.

완료 기준은 다음과 같다.

- 정적 대상 수 정확히 18개
- 모든 키와 방향 중복 없음
- 각 대상 최초 1회 리빌
- 500ms·64px·60ms 계산 스타일 일치
- 320·390·768·1024·1440px 가로 넘침 없음
- 모션 감소·무자바스크립트·Observer 오류·포커스·해시 회귀 없음
- 대표 사진 모션의 LCP 회귀 100ms 이내
- 독립 HTML 10KB 초과 및 `file://` 검증 성공

## 9. 남은 운영 작업

현재 브로슈어 크롭은 데모에만 사용한다. 실제 배포 전 고해상도 상반신 원본으로 교체하고 AVIF·WebP·JPEG 파생 이미지를 생성해야 한다.
