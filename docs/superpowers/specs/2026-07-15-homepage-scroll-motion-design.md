# 홈페이지 스크롤 모션 설계

- 상태: 모션 방향 승인, 구현 전 사용자 문서 검토 단계
- 대상: 추천 하이브리드 홈페이지 시안
- 작성일: 2026-07-15

## 1. 목표

지혜행정사사무소 홈페이지의 차분하고 신뢰감 있는 인상을 유지하면서 방문자의 시선을 다음 콘텐츠로 자연스럽게 안내한다. 모션은 정보 이해를 돕는 보조 수단으로만 사용하며 시선을 빼앗는 장식이 되지 않게 한다.

성공 기준은 다음과 같다.

- 텍스트와 사진이 화면에 들어올 때 부드럽게 나타난다.
- 각 요소의 스크롤 모션은 페이지를 연 뒤 최초 노출 시 한 번만 재생한다.
- 페이지 전체 모션 대상을 8개로 제한한다.
- 제목, 주 상담 버튼, 업무 선택 버튼, 연락처와 같은 핵심 기능은 즉시 표시한다.
- 데스크톱과 모바일 모두에서 레이아웃 이동과 가로 넘침이 없다.
- 모션 감소 설정을 사용하는 방문자는 첫 프레임부터 애니메이션 없이 콘텐츠를 본다.
- 자바스크립트가 실패하거나 지원되지 않아도 콘텐츠가 숨겨진 채 남지 않는다.
- 검색엔진과 AI 검색 크롤러가 본문을 별도 실행 없이 읽을 수 있다.

## 2. 선택한 방향

세 가지 접근법 중 `에디토리얼 리빌`을 적용한다.

- 비상호작용 텍스트: 아래에서 원래 위치로 이동하며 페이드인
- 대표 사진: 약한 투명도 전환과 미세 축소
- 링크·버튼을 포함한 콘텐츠 그룹: 투명하게 숨기지 않고 위치만 미세하게 이동
- 재생 횟수: 페이지를 연 뒤 요소별 한 번
- 모바일: 순차 지연 없이 그룹 단위로 재생

다음 효과는 사용하지 않는다.

- 글자 단위 분해 애니메이션
- 강한 좌우 이동, 회전, 바운스
- 무한 반복 및 자동으로 흐르는 문구
- 배경과 콘텐츠가 크게 엇갈리는 패럴랙스
- 레이아웃을 다시 계산하게 하는 `top`, `left`, `height` 기반 애니메이션

## 3. 모션 예산과 토큰

페이지 전체에서 모션 대상은 정확히 8개, 한 섹션에서는 최대 2개로 제한한다. 카드 안의 제목·본문·버튼을 각각 움직이지 않고 하나의 그룹으로 취급한다.

| 토큰 | 값 | 용도 |
|---|---:|---|
| `duration-fast` | 400ms | 첫 화면 대표 사진 |
| `duration-base` | 600ms | 텍스트와 콘텐츠 그룹 |
| `distance-desktop` | 16px | 데스크톱 텍스트 이동 |
| `distance-mobile` | 10px | 모바일 텍스트 이동 |
| `media-scale` | 1.015 → 1 | 대표 사진의 미세한 깊이감 |
| `stagger-desktop` | 80ms | 데스크톱 동일 그룹 안의 카드 |
| `stagger-mobile` | 0ms | 모바일 카드 지연 제거 |
| `delay-max` | 160ms | 지연 상한 |
| `ease-editorial` | `cubic-bezier(0.22, 1, 0.36, 1)` | 빠르게 반응하고 부드럽게 정지 |

모든 구역은 이 토큰명만 참조한다. 지연을 포함한 한 요소의 완료 시간은 760ms 이하여야 한다.

## 4. 구역별 적용 대상

### 4.1 즉시 표시 대상

다음 요소에는 스크롤 리빌을 적용하지 않는다.

- 헤더, 메뉴, 언어 변경
- 첫 화면 핵심 제목과 설명
- `상담 요청서 작성`을 포함한 모든 링크와 버튼
- 업무 찾기의 질문과 선택 버튼
- 대표 자격 표시줄과 연락처 패널
- 개인정보·법적 고지와 푸터

### 4.2 모션 대상 8개

1. **대표 사진**: `duration-fast`, 지연 없음, 투명도 0.55에서 1, `media-scale` 적용
2. **세 전문영역 그룹**: `duration-base`, 위치 이동만 적용하고 세 링크는 항상 보이게 유지
3. **업무 찾기 안내 패널의 비상호작용 문구**: `duration-base` 페이드업
4. **업무 원칙 섹션 제목**: `duration-base` 페이드업
5. **업무 원칙 카드 그룹**: `duration-base`, 위치 이동만 적용
6. **전문정보 섹션 제목**: `duration-base` 페이드업
7. **전문정보 카드 그룹**: `duration-base`, 위치 이동만 적용
8. **상담 섹션 제목과 설명**: `duration-base` 페이드업, 연락처와 버튼은 즉시 표시

데스크톱 카드 그룹 내부에서는 `stagger-desktop`을 사용하되 총 지연은 `delay-max`를 넘지 않는다. 모바일에서는 모든 카드를 동시에 표시한다.

## 5. Tailwind CSS 구현 원칙

실제 홈페이지와 모션 샘플은 Tailwind CSS v4 계열을 사용하며 정확한 설치 버전은 `package-lock.json`에 고정한다. Play CDN은 시제품과 운영본 모두에서 사용하지 않는다. 빌드 도구가 Vite라면 공식 `@tailwindcss/vite` 플러그인을 사용하고, 다른 프레임워크가 선택되면 해당 공식 통합 방식을 따른다.

기본 스타일은 항상 콘텐츠가 보이는 최종 상태다. 초기 숨김 상태는 루트의 `.motion-enabled` 아래에서만 유효하게 한다.

```css
@import "tailwindcss";

@layer utilities {
  .reveal,
  .reveal-media,
  .reveal-group {
    opacity: 1;
    transform: none;
    transition-property: opacity, transform;
    transition-duration: var(--reveal-duration);
    transition-delay: var(--reveal-delay, 0ms);
    transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  }

  @media (prefers-reduced-motion: no-preference) {
    .motion-enabled .reveal[data-revealed="false"] {
      opacity: 0;
      transform: translateY(var(--reveal-distance));
    }

    .motion-enabled .reveal-media[data-revealed="false"] {
      opacity: 0.55;
      transform: scale(1.015);
    }

    .motion-enabled .reveal-group[data-revealed="false"] {
      opacity: 1;
      transform: translateY(var(--reveal-distance));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .reveal,
    .reveal-media,
    .reveal-group {
      opacity: 1;
      transform: none;
      transition-duration: 0ms;
      transition-delay: 0ms;
    }
  }
}
```

상태 표현은 `@layer utilities` 안의 의미 기반 `.reveal`, `.reveal-media`, `.reveal-group`과 정적인 `data-revealed` 속성으로 통일한다. `.reveal-group`은 링크나 버튼을 포함할 수 있으므로 투명도를 낮추지 않는다. 런타임에서 Tailwind 클래스 문자열을 조합하지 않는다. 순차 지연은 `--reveal-delay` CSS 변수를 사용하고 0~160ms 범위로 제한한다.

모든 숨김 규칙은 `@media (prefers-reduced-motion: no-preference)` 안에서만 활성화한다. 모션 감소 상태에는 `opacity: 1`, `transform: none`, `transition-duration: 0ms`를 모두 명시한다. 단순히 `transition-none`만 적용해 초기 투명도가 남는 구현을 금지한다.

Tailwind CSS v4의 공식 지원 기준에 맞춰 Safari 16.4+, Chrome·Edge 111+, Firefox 128+를 기본 브라우저 범위로 한다. iOS Safari와 네이버·카카오 인앱 브라우저 최신판은 별도 실기기 스모크 테스트 대상이다.

## 6. 단방향 상태 모델과 데이터 흐름

상태는 다음 세 가지다.

1. `dormant`: 루트 클래스 없음. 모든 콘텐츠가 보인다.
2. `waiting`: `.motion-enabled`가 있고 `data-revealed="false"`다.
3. `revealed`: `data-revealed="true"`다. 이후 다시 `false`로 돌아가지 않는다.

불변조건은 **루트에 `.motion-enabled`가 없으면 하위 속성값과 관계없이 모든 콘텐츠가 보인다**이다.

스크롤 감지는 단일 `IntersectionObserver`를 사용하며 설정값은 `rootMargin: "0px 0px -12% 0px"`, `threshold: 0.01`로 고정한다.

초기화 순서는 다음과 같다.

1. `matchMedia('(prefers-reduced-motion: reduce)')`를 가장 먼저 확인한다.
2. 모션 감소 상태이면 모든 대상을 `revealed`로 설정하고 Observer를 만들지 않는다.
3. `IntersectionObserver` 지원 여부를 확인한다. 미지원이면 `dormant` 상태를 유지한다.
4. 대상 수집과 Observer 생성을 완료한다.
5. 초기 기준선을 이미 지난 대상은 `revealed`로 기록한다.
6. 오류 복구와 설정 변경 이벤트를 연결한 뒤 마지막 단계에서만 `.motion-enabled`를 추가한다.
7. 대상이 기준선에 도달하면 먼저 `data-revealed="true"`를 기록한 다음 `unobserve`한다.

초기화 전체를 `try/catch`로 감싼다. 실패하면 루트 클래스를 제거하고 모든 대상을 `revealed`로 바꾸며 Observer를 `disconnect`한다.

페이지를 새로 열거나 새로고침하면 모션은 다시 재생한다. 같은 페이지에서 위아래로 이동하거나 BFCache로 복귀하면 이미 표시된 요소를 다시 숨기지 않는다. 해시 링크로 이동할 때는 대상 섹션을 이동 전에 `revealed`로 전환한다. 화면 회전과 빠른 스크롤 후에는 기준선을 지난 대상을 즉시 최종 상태로 고정한다.

모션 감소 설정이 실행 중 켜지면 Observer를 해제하고 모든 대상을 즉시 표시한다. 같은 페이지에서 설정이 다시 꺼져도 이미 표시된 요소를 숨기지 않는다.

## 7. 접근성, SEO, 성능

- 링크·버튼 또는 그 조상은 `opacity: 0` 상태로 만들지 않는다.
- 키보드 `focusin`이 모션 대상 안에서 발생하면 해당 대상을 포커스 표시 전에 즉시 `revealed`로 전환한다.
- 애니메이션 때문에 키보드 포커스나 문서 읽기 순서가 달라지지 않는다.
- 제목과 본문은 HTML에 처음부터 존재하며 자바스크립트로 늦게 생성하지 않는다.
- 크롤러가 스타일이나 스크립트를 실행하지 않아도 동일한 정보를 읽을 수 있다.
- 애니메이션 속성은 합성이 가능한 `opacity`와 `transform`으로 제한한다.
- 대표 사진에는 고정 `width`·`height` 또는 `aspect-ratio`를 지정한다.
- 사진 래퍼는 `overflow-hidden`, 사진은 중앙 `transform-origin`을 사용한다.
- `will-change`는 애니메이션 직전에 추가하고 `transitionend` 또는 1초 제한시간 후 제거한다.
- 첫 화면 H1과 주 상담 버튼은 첫 페인트부터 표시한다.
- 대표 사진의 모션 때문에 모바일 LCP 목표가 깨지면 대표 사진 모션을 제거한다.

## 8. 오류 처리

- 자바스크립트 비활성화: 루트 클래스가 없으므로 콘텐츠를 기본 표시한다.
- Observer 미지원: 모션을 활성화하지 않고 모든 요소를 표시한다.
- 초기화 중 예외: 루트 제거, 모든 대상 표시, Observer 해제를 한 번에 수행한다.
- 이미지 로드 실패: 대체 텍스트와 배경색을 유지하고 빈 레이아웃으로 무너지지 않게 한다.
- 빠른 스크롤: 이미 기준선을 통과한 요소를 최종 표시 상태로 고정한다.
- 해시 직접 진입: 대상 섹션을 먼저 표시한 뒤 이동한다.
- BFCache 복귀와 화면 회전: `revealed` 상태를 보존하고 새로 기준선을 지난 대상만 표시한다.
- 실행 중 모션 감소 전환: 남은 애니메이션을 취소하고 모든 대상을 표시한다.

## 9. 샘플 시안 범위

기존 추천 하이브리드 시안은 무모션 비교본으로 보존하고 별도의 Tailwind 기반 모션 샘플을 만든다.

샘플 제공물은 다음과 같다.

- 브라우저에서 직접 스크롤할 수 있는 Tailwind v4 빌드 샘플
- 데스크톱 1440px 초기 화면 캡처
- 모바일 390px 초기 화면 및 스크롤 후 캡처
- 모션을 확인할 수 있는 짧은 스크롤 녹화
- 일회 재생과 오류 복구를 확인하는 자동화 상태 검사 결과
- 모션 감소 설정 검증 결과

## 10. 검증 기준

### 10.1 자동 검사

- 320, 390, 768, 1024, 1440px에서 `document.scrollWidth === document.documentElement.clientWidth`
- 동일 요소의 `waiting → revealed` 전환 횟수가 정확히 1회
- 지연을 포함한 모션 완료 시간이 760ms 이하
- 자바스크립트 차단, Observer 미지원, 초기화 강제 예외에서 모든 대상의 계산된 `opacity`가 1
- 모션 감소 설정에서 첫 프레임부터 `opacity: 1`, `transform: none`, `transition-duration: 0s`
- 프로덕션 빌드 CSS에 `.reveal`, `.reveal-media`, `.reveal-group`, `data-revealed` 상태 규칙이 포함됨
- 모션 실행 전후 요소의 레이아웃 박스 크기가 동일함

### 10.2 성능 목표

- 배포 환경 모바일 75번째 백분위 LCP 2.5초 이하
- CLS 0.1 이하
- 대표 사진 모션을 켠 결과가 끈 기준보다 LCP를 100ms 넘게 악화시키면 사진 모션 제거
- 모션 실행 중 긴 작업 50ms 초과가 발생하지 않음

### 10.3 수동 시나리오

- 페이지 진입 → 표시 → 화면 밖 이동 → 재진입 시 재생 1회 유지
- 첫 로드부터 모션 감소, 실행 중 모션 감소 전환
- 페이지 최상단에서 최하단까지 즉시 스크롤한 뒤 역방향 탐색
- 해시 링크 직접 진입, 뒤로가기 BFCache 복귀, 모바일 화면 회전
- 스크롤하지 않고 Tab만 반복해 보이지 않는 포커스가 없는지 확인
- 느린 이미지·웹폰트 조건에서 CLS와 가로 넘침 측정
- 한국어·영어·중국어에서 콘텐츠 길이가 늘어도 모션 순서와 레이아웃 유지
- iOS Safari, Chromium 계열, 네이버·카카오 인앱 브라우저 최신판 스모크 테스트

## 11. 범위 밖 항목

- 페이지 전환 애니메이션
- 강한 패럴랙스 및 WebGL 효과
- Lottie·GSAP·Framer Motion 도입
- 블로그 글 내부의 별도 모션 편집기
- 관리자 페이지 모션 디자인

## 12. 참고 자료

- Tailwind CSS 공식 설치 문서: <https://tailwindcss.com/docs/installation/using-postcss>
- Tailwind CSS v4 업그레이드 및 브라우저 지원: <https://tailwindcss.com/docs/upgrade-guide>
