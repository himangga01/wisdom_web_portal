# Homepage Dynamic C1 Motion Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지혜행정사사무소 홈페이지의 12개·900ms 시네마틱 리빌을 정확히 18개·500ms·좌우 64px C1 리빌로 교체하고, 서버 없이 직접 여는 단일 HTML을 전달한다.

**Architecture:** 기존 `IntersectionObserver` 최초 1회 컨트롤러는 유지하고, HTML의 업무·원칙·전문정보 그룹을 개별 관찰 대상으로 분리한다. 새 `dynamic-motion.css`는 개별 CSS `translate` 속성으로 리빌을 처리하고 기존 카드 `transform` 호버와 합성 충돌을 피한다. Vite 빌드 결과와 대표 사진을 하나의 HTML로 인라인하고 Playwright로 `file://` 직접 실행을 검증한다.

**Tech Stack:** Vite 8, TypeScript 7, Tailwind CSS v4, Vitest 4, Happy DOM, Playwright 1.61, CSS individual transform properties

## Global Constraints

- 모션 대상은 정확히 18개이며 설계 문서의 키 순서를 유지한다.
- 모든 대상은 `data-reveal-direction="left|right"`와 `data-reveal-delay="0|60|120"`를 가진다.
- 전환은 500ms, 좌우 이동은 64px, 카드 스태거는 60ms다.
- 모바일도 500ms·64px로 축소하지 않는다.
- 대상별 모션은 최초 화면 진입 때 한 번만 재생한다.
- 반복 재생, 글자 단위 애니메이션, 패럴랙스는 추가하지 않는다.
- `prefers-reduced-motion`, 무자바스크립트, Observer 오류, 포커스, 해시 이동에서 콘텐츠를 즉시 표시한다.
- 새 출력명은 `.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html`이다.
- 기존 `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html`은 삭제하거나 덮어쓰지 않는다.
- Windows 명령은 `npm.cmd`를 사용한다.

## File Structure

- Modify: `prototypes/homepage-motion/index.html` — 18개 키·방향·지연의 유일한 마크업 계약
- Modify: `prototypes/homepage-motion/src/homepage-contract.test.ts` — 정적 대상 순서·중복·방향·지연 검사
- Modify: `prototypes/homepage-motion/tests/homepage-motion.spec.ts` — 최초 1회, 계산 스타일, 접근성, 반응형, 성능 검사
- Create: `prototypes/homepage-motion/src/dynamic-motion.css` — C1 좌우 리빌과 접근성 폴백
- Delete: `prototypes/homepage-motion/src/cinematic-motion.css` — 충돌하는 B안 스타일 제거
- Modify: `prototypes/homepage-motion/src/main.ts` — 동적 CSS 엔트리 로드
- Modify: `prototypes/homepage-motion/src/artifact-contract.test.ts` — 새 독립 HTML 이름과 18개 검증 계약
- Modify: `prototypes/homepage-motion/scripts/build-standalone.mjs` — C1 독립 HTML 생성
- Modify: `prototypes/homepage-motion/scripts/verify-standalone.mjs` — `file://`에서 18개 리빌 검증
- Modify: `prototypes/homepage-motion/README.md` — 새 데모 파일명과 검증 명령 기록
- Modify: `AGENT.md` — 구현 커밋·검증 결과·파일 크기 기록
- Modify: `work-log.md` — C1 결정과 남은 사진 교체 작업 기록

---

### Task 1: 18개 HTML 모션 계약

**Files:**
- Modify: `prototypes/homepage-motion/src/homepage-contract.test.ts`
- Modify: `prototypes/homepage-motion/tests/homepage-motion.spec.ts`
- Modify: `prototypes/homepage-motion/index.html`

**Interfaces:**
- Consumes: 기존 `[data-reveal]`, `data-reveal-key`, `data-revealed` 컨트롤러 계약
- Produces: `RevealTargetContract = { key: string; direction: "left" | "right"; delay: "0" | "60" | "120" }` 18개와 브라우저 최초 1회 검사 기준

- [ ] **Step 1: 18개 정적 계약 테스트를 먼저 작성한다**

`homepage-contract.test.ts`의 `expectedRevealKeys`를 다음 계약으로 교체한다.

```ts
const expectedRevealTargets = [
  { key: "hero-copy", direction: "left", delay: "0" },
  { key: "portrait", direction: "right", delay: "0" },
  { key: "practice-enterprise", direction: "left", delay: "0" },
  { key: "practice-procurement", direction: "right", delay: "60" },
  { key: "practice-visa", direction: "left", delay: "120" },
  { key: "navigator-copy", direction: "left", delay: "0" },
  { key: "navigator-choices", direction: "right", delay: "0" },
  { key: "principles-heading", direction: "left", delay: "0" },
  { key: "principle-direct", direction: "right", delay: "0" },
  { key: "principle-alternative", direction: "left", delay: "60" },
  { key: "principle-field", direction: "right", delay: "120" },
  { key: "insights-heading", direction: "right", delay: "0" },
  { key: "insight-procurement", direction: "left", delay: "0" },
  { key: "insight-enterprise", direction: "right", delay: "60" },
  { key: "insight-visa", direction: "left", delay: "120" },
  { key: "credentials", direction: "right", delay: "0" },
  { key: "consultation-copy", direction: "left", delay: "0" },
  { key: "consultation-card", direction: "right", delay: "0" },
] as const;
```

첫 테스트를 다음 코드로 바꾼다.

```ts
it("contains the eighteen approved dynamic reveal targets", () => {
  const targets = Array.from(documentRef.querySelectorAll<HTMLElement>("[data-reveal]"));
  const contract = targets.map((target) => ({
    key: target.dataset.revealKey,
    direction: target.dataset.revealDirection,
    delay: target.dataset.revealDelay,
  }));

  expect(targets).toHaveLength(18);
  expect(contract).toEqual(expectedRevealTargets);
  expect(new Set(contract.map(({ key }) => key)).size).toBe(18);
});
```

- [ ] **Step 2: 정적 계약이 기존 12개 마크업에서 실패하는지 확인한다**

Run:

```powershell
npm.cmd test -- homepage-contract.test.ts
```

Expected: `expected 12 to have a length of 18` 또는 18개 계약 불일치로 FAIL.

- [ ] **Step 3: 브라우저 최초 1회 검사를 18개로 먼저 바꾼다**

`homepage-motion.spec.ts` 첫 테스트에서 `toHaveCount(12)`와 `toHaveLength(12)`를 각각 다음 값으로 교체한다.

```ts
await expect(targets).toHaveCount(18);
expect(Object.keys(counts)).toHaveLength(18);
```

Run:

```powershell
npm.cmd run test:e2e -- --grep "reveals each target"
```

Expected: 현재 DOM이 12개여서 FAIL.

- [ ] **Step 4: 공통 12개 대상에 방향·지연 속성을 추가한다**

`index.html`의 공통 대상 시작 태그를 다음 계약에 맞춘다. 기존 레이아웃 클래스와 텍스트는 유지한다.

```html
<div class="hero-copy reveal-group" data-reveal data-reveal-key="hero-copy" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<aside class="portrait-wrap reveal-media" data-reveal data-reveal-key="portrait" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false" aria-label="강지혜 대표행정사">
<div class="navigator-intro reveal" data-reveal data-reveal-key="navigator-copy" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<div class="finder-panel reveal-group" data-reveal data-reveal-key="navigator-choices" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false">
<div class="section-head reveal" data-reveal data-reveal-key="principles-heading" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<div class="section-head reveal" data-reveal data-reveal-key="insights-heading" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false">
<div class="shell credential-grid reveal-group" data-reveal data-reveal-key="credentials" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false">
<div class="consultation-copy reveal" data-reveal data-reveal-key="consultation-copy" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<div class="office-card reveal-group" data-reveal data-reveal-key="consultation-card" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false">
```

`reveal-hero`, `reveal-panel`, `reveal-from-top`, `reveal-card`, `reveal-credentials`, `stagger-group`처럼 B안 전용인 클래스는 해당 태그에서 제거한다.

- [ ] **Step 5: 세 업무 카드를 개별 대상으로 만든다**

그룹과 세 카드의 **시작 태그만** 다음 네 줄로 교체하고 기존 자식 콘텐츠와 닫는 태그는 그대로 둔다.

```html
<div class="shell practice-grid">
<a class="practice practice-card" href="#navigator" data-reveal data-reveal-key="practice-enterprise" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<a class="practice practice-card" href="#navigator" data-reveal data-reveal-key="practice-procurement" data-reveal-direction="right" data-reveal-delay="60" data-revealed="false">
<a class="practice practice-card" href="#navigator" data-reveal data-reveal-key="practice-visa" data-reveal-direction="left" data-reveal-delay="120" data-revealed="false">
```

- [ ] **Step 6: 세 업무 원칙을 개별 대상으로 만든다**

그룹과 세 카드의 **시작 태그만** 다음 네 줄로 교체한다.

```html
<div class="principle-grid">
<article class="principle" data-reveal data-reveal-key="principle-direct" data-reveal-direction="right" data-reveal-delay="0" data-revealed="false">
<article class="principle" data-reveal data-reveal-key="principle-alternative" data-reveal-direction="left" data-reveal-delay="60" data-revealed="false">
<article class="principle" data-reveal data-reveal-key="principle-field" data-reveal-direction="right" data-reveal-delay="120" data-revealed="false">
```

- [ ] **Step 7: 세 전문정보 카드를 개별 대상으로 만든다**

그룹과 세 카드의 **시작 태그만** 다음 네 줄로 교체한다.

```html
<div class="insight-grid">
<article class="article-card reveal-group" id="guide-1" data-reveal data-reveal-key="insight-procurement" data-reveal-direction="left" data-reveal-delay="0" data-revealed="false">
<article class="article-card featured reveal-group" id="guide-2" data-reveal data-reveal-key="insight-enterprise" data-reveal-direction="right" data-reveal-delay="60" data-revealed="false">
<article class="article-card reveal-group" id="guide-3" data-reveal data-reveal-key="insight-visa" data-reveal-direction="left" data-reveal-delay="120" data-revealed="false">
```

- [ ] **Step 8: 18개 계약과 최초 1회 검사를 통과시킨다**

Run:

```powershell
npm.cmd test -- homepage-contract.test.ts
npm.cmd run test:e2e -- --grep "reveals each target"
```

Expected: 정적 계약 PASS, Playwright가 18개 모두 `data-revealed="true"`로 한 번만 바뀌었음을 확인하고 PASS.

- [ ] **Step 9: Task 1을 커밋한다**

```powershell
git add prototypes/homepage-motion/index.html prototypes/homepage-motion/src/homepage-contract.test.ts prototypes/homepage-motion/tests/homepage-motion.spec.ts
git commit -m "feat: expand dynamic motion to eighteen targets"
```

---

### Task 2: 500ms 좌우 동적 모션 시스템

**Files:**
- Modify: `prototypes/homepage-motion/tests/homepage-motion.spec.ts`
- Create: `prototypes/homepage-motion/src/dynamic-motion.css`
- Modify: `prototypes/homepage-motion/src/main.ts`
- Delete: `prototypes/homepage-motion/src/cinematic-motion.css`

**Interfaces:**
- Consumes: Task 1의 `data-reveal-direction`, `data-reveal-delay`, `data-revealed`
- Produces: CSS 토큰 `--duration-dynamic`, `--distance-dynamic`, `--stagger-dynamic`, 좌우 `translate` 초기 상태와 접근성 최종 상태

- [ ] **Step 1: 동적 계산 스타일 테스트로 기존 B안에서 실패를 만든다**

`applies the approved cinematic motion tokens` 테스트를 다음 코드로 교체한다. Observer를 정지시켜 초기 상태를 유지한다.

```ts
test("applies the approved dynamic c1 motion tokens", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }));
  await page.goto("/");

  const rootTokens = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return {
      duration: style.getPropertyValue("--duration-dynamic").trim(),
      distance: style.getPropertyValue("--distance-dynamic").trim(),
      stagger: style.getPropertyValue("--stagger-dynamic").trim(),
    };
  });
  expect(rootTokens).toEqual({ duration: "500ms", distance: "64px", stagger: "60ms" });

  const left = page.locator('[data-reveal-key="principles-heading"]');
  await expect.poll(() => left.evaluate((target) => {
    const style = getComputedStyle(target);
    return {
      opacity: style.opacity,
      filter: style.filter,
      translate: style.translate,
      duration: style.transitionDuration.split(",")[0].trim(),
    };
  })).toEqual({ opacity: "0.08", filter: "blur(2px)", translate: "-64px", duration: "0.5s" });

  const rightTranslate = await page
    .locator('[data-reveal-key="portrait"]')
    .evaluate((target) => getComputedStyle(target).translate);
  expect(rightTranslate).toBe("64px");
});
```

브라우저가 두 축 형태를 반환하는 경우에만 `translate` 기대값을 `"-64px 0px"`, `"64px 0px"`로 맞춘다. 실제 Chromium 계산값을 먼저 출력해 확인하고 CSS 값은 바꾸지 않는다.

- [ ] **Step 2: 카드 지연과 리빌·호버 분리 테스트를 먼저 작성한다**

기존 `stages cards and exposes a two pixel scroll progress line` 테스트를 다음 코드로 바꾼다.

```ts
test("stages dynamic cards and keeps hover transform independent", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }));
  await page.goto("/");

  const cards = page.locator("#practice .practice-card");
  await cards.evaluateAll((targets) => targets.forEach((target) => {
    (target as HTMLElement).dataset.revealed = "true";
  }));
  const delays = await cards.evaluateAll((targets) =>
    targets.map((target) => getComputedStyle(target).getPropertyValue("--reveal-delay").trim()),
  );
  expect(delays).toEqual(["0ms", "60ms", "120ms"]);

  await expect.poll(() => cards.first().evaluate((target) => getComputedStyle(target).translate)).toBe("none");
  await cards.first().hover();
  await expect.poll(() => cards.first().evaluate((target) => getComputedStyle(target).transform)).not.toBe("none");
  expect(await cards.first().evaluate((target) => getComputedStyle(target).translate)).toBe("none");

  const progress = await page.locator(".scroll-progress").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, height: style.height };
  });
  expect(progress).toEqual({ position: "fixed", height: "2px" });
});
```

- [ ] **Step 3: 동적 테스트가 기존 시네마틱 CSS에서 실패하는지 확인한다**

Run:

```powershell
npm.cmd run test:e2e -- --grep "dynamic c1|stages dynamic"
```

Expected: 동적 토큰이 비어 있고 계산 이동값·지연값이 달라 FAIL.

- [ ] **Step 4: `dynamic-motion.css`를 작성한다**

다음 파일을 새로 만든다.

```css
:root {
  --duration-dynamic: 500ms;
  --distance-dynamic: 64px;
  --stagger-dynamic: 60ms;
  --duration-interaction: 220ms;
  --ease-dynamic: cubic-bezier(0.16, 1, 0.3, 1);
}

.scroll-progress {
  position: fixed;
  z-index: 60;
  top: 0;
  right: 0;
  left: 0;
  display: none;
  height: 2px;
  pointer-events: none;
  background: var(--gold);
  transform: scaleX(0);
  transform-origin: left center;
}

@keyframes wisdom-scroll-progress {
  to { transform: scaleX(1); }
}

[data-reveal] {
  opacity: 1;
  filter: none;
  translate: none;
}

@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) {
    .scroll-progress {
      display: block;
      animation: wisdom-scroll-progress linear both;
      animation-timeline: scroll(root);
    }
  }
}

@media (prefers-reduced-motion: no-preference) {
  .motion-enabled [data-reveal] {
    --reveal-delay: 0ms;
    transition:
      opacity var(--duration-dynamic) var(--ease-dynamic) var(--reveal-delay),
      filter var(--duration-dynamic) var(--ease-dynamic) var(--reveal-delay),
      translate var(--duration-dynamic) var(--ease-dynamic) var(--reveal-delay),
      transform var(--duration-interaction) ease,
      box-shadow var(--duration-interaction) ease,
      background-color var(--duration-interaction) ease,
      border-color var(--duration-interaction) ease;
  }

  .motion-enabled [data-reveal-direction="left"][data-revealed="false"] {
    opacity: 0.08;
    filter: blur(2px);
    translate: calc(var(--distance-dynamic) * -1) 0;
  }

  .motion-enabled [data-reveal-direction="right"][data-revealed="false"] {
    opacity: 0.08;
    filter: blur(2px);
    translate: var(--distance-dynamic) 0;
  }

  .motion-enabled [data-reveal-delay="60"][data-revealed="true"] {
    --reveal-delay: var(--stagger-dynamic);
  }

  .motion-enabled [data-reveal-delay="120"][data-revealed="true"] {
    --reveal-delay: calc(var(--stagger-dynamic) * 2);
  }

  .choice {
    transition: transform var(--duration-interaction) ease,
      background-color var(--duration-interaction) ease,
      border-color var(--duration-interaction) ease;
  }

  .practice:hover,
  .principle:hover,
  .article-card:hover {
    box-shadow: 0 20px 45px rgb(83 65 48 / 10%);
    transform: translateY(-6px);
  }

  .practice .arrow {
    transition: transform var(--duration-interaction) ease;
  }

  .practice:hover .arrow {
    transform: rotate(30deg);
  }

  .choice:hover {
    transform: translateX(4px);
  }

  [data-reveal]:focus-within {
    opacity: 1 !important;
    filter: none !important;
    translate: none !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .scroll-progress { display: none !important; }

  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0ms !important;
    transition-delay: 0ms !important;
  }

  [data-reveal],
  [data-reveal] * {
    opacity: 1 !important;
    filter: none !important;
    translate: none !important;
  }
}
```

- [ ] **Step 5: CSS 엔트리를 동적 파일로 교체한다**

`main.ts`를 다음처럼 바꾼다.

```ts
import "./styles.css";
import "./dynamic-motion.css";
import { createRevealController } from "./motion/reveal-controller";
```

`src/cinematic-motion.css`는 삭제한다. 두 모션 파일을 동시에 로드하지 않는다.

- [ ] **Step 6: 모션 감소 검사를 `translate`까지 확장한다**

`shows final state from the first frame for reduced motion`의 계산 결과와 단언을 다음처럼 바꾼다.

```ts
const states = await page.locator("[data-reveal]").evaluateAll((targets) => targets.map((target) => {
  const style = getComputedStyle(target);
  return {
    opacity: style.opacity,
    translate: style.translate,
    transform: style.transform,
    duration: style.transitionDuration,
  };
}));
expect(states.every((state) =>
  state.opacity === "1"
  && state.translate === "none"
  && state.transform === "none"
  && state.duration === "0s"
)).toBe(true);
```

- [ ] **Step 7: 동적 스타일과 전체 회귀를 검증한다**

Run:

```powershell
npm.cmd run test:e2e -- --grep "dynamic c1|stages dynamic|reduced motion"
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Expected: Vitest 전체 PASS, Playwright 16개 전체 PASS, TypeScript·Vite 빌드 exit code 0. 320·390·768·1024·1440px 모두 가로 넘침이 없고 LCP 회귀가 100ms 이하다.

- [ ] **Step 8: Task 2를 커밋한다**

```powershell
git add prototypes/homepage-motion/src/main.ts prototypes/homepage-motion/src/dynamic-motion.css prototypes/homepage-motion/src/cinematic-motion.css prototypes/homepage-motion/tests/homepage-motion.spec.ts
git commit -m "feat: replace cinematic reveal with dynamic c1 motion"
```

---

### Task 3: 동적 C1 독립 HTML과 최종 전달

**Files:**
- Modify: `prototypes/homepage-motion/src/artifact-contract.test.ts`
- Modify: `prototypes/homepage-motion/scripts/build-standalone.mjs`
- Modify: `prototypes/homepage-motion/scripts/verify-standalone.mjs`
- Modify: `prototypes/homepage-motion/README.md`
- Modify: `AGENT.md`
- Modify: `work-log.md`
- Generate, do not commit: `.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html`

**Interfaces:**
- Consumes: 성공한 Vite 빌드, 18개 대상, 번들 CSS·JavaScript, 대표 사진
- Produces: `npm run verify:standalone`이 검증하는 외부 자산 없는 `wisdom-homepage-dynamic-c1-demo.html`

- [ ] **Step 1: 새 산출물 이름과 18개 검증 계약을 먼저 작성한다**

`artifact-contract.test.ts`를 다음 구조로 정리하면서 verifier를 읽는 상수를 추가한다.

```ts
const verifier = readFileSync(resolve(process.cwd(), "scripts/verify-standalone.mjs"), "utf8");
```

기존 캡처 계약과 새 독립 HTML 계약을 다음처럼 분리한다.

```ts
describe("homepage demo artifact contract", () => {
  it("keeps the approved cinematic capture artifacts", () => {
    expect(capture).toContain("wisdom-homepage-cinematic-desktop.png");
    expect(capture).toContain("wisdom-homepage-cinematic-mobile.png");
    expect(capture).toContain("wisdom-homepage-cinematic-scroll.webm");
  });

it("uses the approved dynamic c1 standalone artifact", () => {
  expect(standalone).toContain("wisdom-homepage-dynamic-c1-demo.html");
  expect(verifier).toContain("wisdom-homepage-dynamic-c1-demo.html");
  expect(verifier).toContain("Expected 18 reveal targets");
});

  it("waits long enough to record the previous 900ms cinematic capture", () => {
    expect(capture).toContain("waitForTimeout(1050)");
  });
});
```

- [ ] **Step 2: 기존 시네마틱 파일명과 12개 검증 때문에 실패하는지 확인한다**

Run:

```powershell
npm.cmd test -- artifact-contract.test.ts
```

Expected: 동적 HTML 파일명과 `Expected 18 reveal targets`가 없어 FAIL.

- [ ] **Step 3: 독립 HTML 출력명을 변경한다**

`build-standalone.mjs`의 출력 경로만 다음처럼 변경한다.

```js
const outputPath = resolve(outputDir, "wisdom-homepage-dynamic-c1-demo.html");
```

CSS·JavaScript·사진 인라인 로직은 변경하지 않는다.

- [ ] **Step 4: `file://` 검증을 새 이름과 18개 대상으로 변경한다**

`verify-standalone.mjs`의 경로와 두 수치를 변경한다.

```js
const filePath = resolve(
  workspaceRoot,
  ".superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html",
);
if (await targets.count() !== 18) throw new Error("Expected 18 reveal targets");
if (!result.headingVisible || result.revealed !== 18) {
  throw new Error(`Invalid standalone state: ${JSON.stringify(result)}`);
}
```

- [ ] **Step 5: 산출물 계약과 독립 실행 검증을 통과시킨다**

Run:

```powershell
npm.cmd test -- artifact-contract.test.ts
npm.cmd run verify:standalone
```

Expected: 계약 PASS. JSON에 `revealed: 18`, `scrollWidth: 390`, `clientWidth: 390`, `pageErrors: []`가 표시되고 exit code 0.

- [ ] **Step 6: README에 새 출력 파일을 기록한다**

검증 절의 독립 HTML 설명을 다음 문구로 갱신한다.

```markdown
`verify:standalone`은 운영 빌드 후 CSS·JavaScript·대표 사진을 포함한
`.superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html`을 만들고,
Chromium에서 서버 없이 직접 열어 18개 좌우 모션과 모바일 너비를 검사합니다.
기존 `wisdom-homepage-cinematic-demo.html`은 비교용으로 보존합니다.
```

- [ ] **Step 7: 전체 검증을 새로 실행한다**

Run:

```powershell
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
npm.cmd run verify:standalone
```

Expected: Vitest 0 failures, Playwright 16/16, build exit code 0, 독립 HTML 검증에 `revealed: 18`과 `pageErrors: []`.

- [ ] **Step 8: 독립 HTML을 메인 프로젝트 렌더 폴더로 복사한다**

소스와 목적지가 모두 프로젝트 내부인지 절대 경로로 확인한 뒤 복사한다.

```powershell
$worktreeRoot = [IO.Path]::GetFullPath((git rev-parse --show-toplevel).Trim())
$gitCommon = [IO.Path]::GetFullPath((git rev-parse --git-common-dir).Trim())
$mainRoot = [IO.Path]::GetFullPath((Split-Path -Parent $gitCommon))
$source = [IO.Path]::GetFullPath((Join-Path $worktreeRoot '.superpowers\brainstorm\renders\wisdom-homepage-dynamic-c1-demo.html'))
$targetDir = [IO.Path]::GetFullPath((Join-Path $mainRoot '.superpowers\brainstorm\renders'))
if (-not $source.StartsWith($worktreeRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Source outside worktree" }
if (-not $targetDir.StartsWith($mainRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Target outside main project" }
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath $source -Destination $targetDir -Force
```

- [ ] **Step 9: 파일 크기와 복사 무결성을 확인한다**

```powershell
$worktreeFile = Join-Path $worktreeRoot '.superpowers\brainstorm\renders\wisdom-homepage-dynamic-c1-demo.html'
$mainFile = Join-Path $mainRoot '.superpowers\brainstorm\renders\wisdom-homepage-dynamic-c1-demo.html'
$worktreeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $worktreeFile).Hash
$mainHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $mainFile).Hash
if ($worktreeHash -ne $mainHash) { throw "Standalone copy hash mismatch" }
$size = (Get-Item -LiteralPath $mainFile).Length
if ($size -le 10000) { throw "Standalone HTML is unexpectedly small: $size" }
$size
```

Expected: 두 SHA-256 값 일치, 파일 크기 10KB 초과.

- [ ] **Step 10: 작업 기록을 갱신한다**

`AGENT.md`와 `work-log.md`에 다음 사실만 기록한다.

- C1 최종값: 18개·500ms·64px·60ms, 모바일 동일 강도
- Task 1과 Task 2 커밋 해시
- 최종 Vitest와 Playwright 실제 통과 수
- 독립 HTML 실제 바이트 크기와 `file://` 검증 결과
- 운영 전 고해상도 상반신 대표 사진 교체 필요

- [ ] **Step 11: Task 3을 커밋한다**

```powershell
git add prototypes/homepage-motion/src/artifact-contract.test.ts prototypes/homepage-motion/scripts/build-standalone.mjs prototypes/homepage-motion/scripts/verify-standalone.mjs prototypes/homepage-motion/README.md AGENT.md work-log.md
git commit -m "feat: deliver dynamic c1 standalone demo"
```

- [ ] **Step 12: 커밋 이후 최종 상태를 확인한다**

```powershell
git status --short
git log -4 --oneline
```

Expected: 작업트리 출력 없음. 최근 로그에 세 구현 커밋과 이 계획 커밋이 표시된다.

## Spec Coverage Map

| 설계 요구 | 구현 태스크 |
|---|---|
| 정확히 18개 키·방향·지연 | Task 1 |
| 500ms·64px·60ms, 모바일 동일 | Task 2 |
| 좌우 개별 `translate`와 호버 `transform` 분리 | Task 2 |
| 최초 1회, reduced-motion, 오류·포커스·해시 복구 | Task 1, Task 2 |
| 2px 진행선과 220ms 상호작용 유지 | Task 2 |
| 320~1440px 반응형과 LCP 예산 | Task 2, Task 3 |
| 외부 자산 없는 단일 HTML | Task 3 |
| 기존 시네마틱 HTML 보존 | Task 3 |
| 작업 기록과 운영 사진 교체 주의 | Task 3 |
