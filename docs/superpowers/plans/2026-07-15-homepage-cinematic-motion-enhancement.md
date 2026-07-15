# 홈페이지 시네마틱 모션 강화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 홈페이지 샘플의 모션을 정확히 12개 관찰 대상으로 확장하고, 900ms 시네마틱 리빌·카드 스태거·사진 마스크·스크롤 진행선을 적용한 뒤 서버 없이 실행되는 단일 HTML 데모를 제공한다.

**Architecture:** 기존 `reveal-controller.ts`의 단방향 상태 모델은 변경하지 않고 HTML의 대상 수와 CSS 표현 계층만 확장한다. 1,300줄이 넘는 기존 스타일 파일에서 모션 규칙을 `cinematic-motion.css`로 분리하고, 정적 계약·실제 Chromium 계산 스타일·독립 HTML 검증을 각각 별도 경계로 검사한다.

**Tech Stack:** Vite 8, TypeScript 7, Tailwind CSS v4, Vitest, happy-dom, Playwright Chromium, 순수 CSS Scroll-driven Animations

## Global Constraints

- 관찰 기반 모션 대상은 정확히 12개이며 페이지를 연 뒤 대상별 최초 한 번만 재생한다.
- 기본 전환은 900ms, 사진 전환은 780ms, 호버·포커스 반응은 220ms다.
- 이동거리는 데스크톱 32px, 모바일 16px다.
- 카드 스태거는 데스크톱 100ms·최대 200ms, 모바일 60ms·최대 120ms다.
- 대표 이력 네 칸은 65ms 간격으로 네 번째 칸도 195ms 안에 시작한다.
- 링크·버튼·입력·라벨을 포함하는 그룹은 초기 투명도를 항상 1로 유지한다.
- 모션 감소 설정에서는 진행선·흐림·마스크·전환을 모두 제거한다.
- 자바스크립트 또는 `IntersectionObserver` 실패 시 모든 콘텐츠가 기본 최종 상태로 보인다.
- 320, 390, 768, 1024, 1440px에서 가로 넘침이 없어야 한다.
- 로컬 CLS는 0.1 이하, LCP는 2.5초 이하이며 모션에 따른 LCP 중앙값 차이는 100ms 이하여야 한다.
- Tailwind는 로컬 v4 빌드를 사용하고 CDN과 새 런타임 모션 라이브러리를 추가하지 않는다.
- 최종 전달물은 CSS·JavaScript·대표 사진을 포함한 `wisdom-homepage-cinematic-demo.html` 단일 파일이다.
- Windows PowerShell에서는 실행 정책 충돌을 피하기 위해 계획의 모든 npm 명령을 `npm.cmd`로 실행한다.

---

## 파일 책임 지도

| 파일 | 책임 |
|---|---|
| `prototypes/homepage-motion/index.html` | 12개 관찰 대상, 진행선과 의미 구조 |
| `prototypes/homepage-motion/src/styles.css` | 레이아웃·색상·타이포그래피·기존 컴포넌트 스타일 |
| `prototypes/homepage-motion/src/cinematic-motion.css` | 시네마틱 토큰, 리빌, 스태거, 진행선, 호버, 모션 감소 |
| `prototypes/homepage-motion/src/main.ts` | 기본 스타일 다음에 시네마틱 스타일 로드, 기존 컨트롤러 시작 |
| `prototypes/homepage-motion/src/homepage-contract.test.ts` | 12개 대상과 상호작용 그룹의 정적 HTML 계약 |
| `prototypes/homepage-motion/tests/homepage-motion.spec.ts` | 실제 브라우저 상태, 계산 스타일, 접근성, 반응형, 성능 |
| `prototypes/homepage-motion/scripts/build-standalone.mjs` | 운영 번들과 사진을 단일 HTML로 인라인 |
| `prototypes/homepage-motion/scripts/verify-standalone.mjs` | `file://` 독립 실행과 12개 리빌 검증 |
| `prototypes/homepage-motion/scripts/capture-motion.mjs` | 새 데스크톱·모바일 PNG와 스크롤 WebM 생성 |
| `prototypes/homepage-motion/src/artifact-contract.test.ts` | 산출물 파일명과 캡처 속도 정적 계약 |
| `prototypes/homepage-motion/README.md` | 실행·테스트·단일 HTML 생성 안내 |
| `AGENT.md`, `work-log.md` | 구현 커밋, 검증 수치, 산출물 크기 기록 |

---

### Task 1: HTML 계약을 12개 관찰 대상으로 확장

**Files:**
- Modify: `prototypes/homepage-motion/src/homepage-contract.test.ts`
- Modify: `prototypes/homepage-motion/tests/homepage-motion.spec.ts`
- Modify: `prototypes/homepage-motion/index.html`

**Interfaces:**
- Consumes: 기존 `[data-reveal]`, `data-reveal-key`, `data-revealed` 상태 계약
- Produces: 정확히 12개 키와 `.scroll-progress`, `.stagger-group`, `.reveal-hero`, `.reveal-panel`, `.reveal-credentials`, `.reveal-card`

- [ ] **Step 1: 12개 대상 정적 계약을 먼저 작성한다**

`homepage-contract.test.ts`의 첫 테스트를 다음 코드로 교체하고 진행선 테스트를 추가한다.

```ts
const expectedRevealKeys = [
  "hero-copy",
  "portrait",
  "practice",
  "navigator-copy",
  "navigator-choices",
  "principles-heading",
  "principles-group",
  "insights-heading",
  "insights-group",
  "credentials",
  "consultation-copy",
  "consultation-card",
];

it("contains the twelve approved cinematic reveal targets", () => {
  const targets = Array.from(
    documentRef.querySelectorAll("[data-reveal]"),
  ) as unknown as globalThis.HTMLElement[];
  const keys = targets.map((target) => target.dataset.revealKey);

  expect(targets).toHaveLength(12);
  expect(keys).toEqual(expectedRevealKeys);
  expect(new Set(keys).size).toBe(12);
});

it("contains the cinematic progress indicator", () => {
  const progress = documentRef.querySelector(".scroll-progress") as unknown as globalThis.HTMLElement | null;
  expect(progress).not.toBeNull();
  expect(progress?.getAttribute("aria-hidden")).toBe("true");
});
```

기존 상호작용 그룹 테스트는 유지한다. 링크·버튼·입력·라벨이 있는 모든 `[data-reveal]`이 `.reveal-group`인지 계속 검사해야 한다.

- [ ] **Step 2: 정적 계약이 기존 8개 상태에서 실패하는지 확인한다**

Run:

```powershell
npm.cmd test -- homepage-contract.test.ts
```

Expected: 대상 수가 8이어서 FAIL하고 `.scroll-progress`가 없어서 FAIL.

- [ ] **Step 3: 브라우저 일회 재생 테스트를 12개로 변경한다**

`homepage-motion.spec.ts` 첫 테스트에서 하드코딩한 8을 다음처럼 바꾼다.

```ts
await expect(targets).toHaveCount(12);
for (let index = 0; index < await targets.count(); index += 1) {
  await targets.nth(index).scrollIntoViewIfNeeded();
  await expect(targets.nth(index)).toHaveAttribute("data-revealed", "true");
}

const counts = await page.evaluate(() => (window as unknown as Window & {
  __revealCounts: Record<string, number>;
}).__revealCounts);
expect(Object.keys(counts)).toHaveLength(12);
expect(Object.values(counts).every((count) => count === 1)).toBe(true);
```

- [ ] **Step 4: HTML에 진행선과 네 개 대상을 추가한다**

`<body>` 첫 요소로 진행선을 추가한다.

```html
<div class="scroll-progress" aria-hidden="true"></div>
```

기존 첫 화면 문구를 다음 시작 태그로 바꾼다.

```html
<div class="hero-copy reveal-group reveal-hero"
     data-reveal data-reveal-key="hero-copy" data-revealed="false">
```

기존 대표 사진은 바로 다음 대상이므로 순서는 `hero-copy`, `portrait`가 된다.

세 전문영역 그룹에 스태거 클래스를 추가한다.

```html
<div class="shell practice-grid reveal-group stagger-group"
     data-reveal data-reveal-key="practice" data-revealed="false">
```

기존 업무 선택 패널을 다음 시작 태그로 바꾼다.

```html
<div class="finder-panel reveal-group reveal-panel"
     data-reveal data-reveal-key="navigator-choices" data-revealed="false">
```

업무 원칙·전문정보 카드 그룹에도 `stagger-group`을 추가하고 전문정보 제목에는 `reveal-from-top`을 추가한다.

```html
<div class="principle-grid reveal-group stagger-group"
     data-reveal data-reveal-key="principles-group" data-revealed="false">

<div class="section-head reveal reveal-from-top"
     data-reveal data-reveal-key="insights-heading" data-revealed="false">

<div class="insight-grid reveal-group stagger-group"
     data-reveal data-reveal-key="insights-group" data-revealed="false">
```

대표 이력 그룹을 다음 시작 태그로 바꾼다.

```html
<div class="shell credential-grid reveal-credentials stagger-group"
     data-reveal data-reveal-key="credentials" data-revealed="false">
```

사무소 연락처 카드를 다음 시작 태그로 바꾼다.

```html
<div class="office-card reveal-group reveal-card"
     data-reveal data-reveal-key="consultation-card" data-revealed="false">
```

- [ ] **Step 5: 정적 계약과 기존 단위 테스트를 통과시킨다**

Run:

```powershell
npm.cmd test
```

Expected: Vitest 전체 PASS, 정적 계약에서 12개 키가 지정 순서로 확인됨.

- [ ] **Step 6: HTML 확장을 커밋한다**

```powershell
git add prototypes/homepage-motion/index.html prototypes/homepage-motion/src/homepage-contract.test.ts prototypes/homepage-motion/tests/homepage-motion.spec.ts
git commit -m "feat: expand cinematic reveal targets"
```

---

### Task 2: 시네마틱 CSS와 계산 스타일 계약 구현

**Files:**
- Modify: `prototypes/homepage-motion/tests/homepage-motion.spec.ts`
- Create: `prototypes/homepage-motion/src/cinematic-motion.css`
- Modify: `prototypes/homepage-motion/src/styles.css`
- Modify: `prototypes/homepage-motion/src/main.ts`

**Interfaces:**
- Consumes: Task 1의 12개 키와 클래스
- Produces: `--duration-cinematic`, `--duration-media`, `--distance-cinematic`, `.scroll-progress`와 시네마틱 최종 상태

- [ ] **Step 1: 계산 스타일 회귀 테스트를 먼저 작성한다**

`homepage-motion.spec.ts`에 다음 두 테스트를 추가한다.

```ts
test("applies the approved cinematic motion tokens", async ({ page }) => {
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
      duration: style.getPropertyValue("--duration-cinematic").trim(),
      mediaDuration: style.getPropertyValue("--duration-media").trim(),
      distance: style.getPropertyValue("--distance-cinematic").trim(),
    };
  });
  expect(rootTokens).toEqual({
    duration: "900ms",
    mediaDuration: "780ms",
    distance: "32px",
  });

  const heading = await page.locator('[data-reveal-key="principles-heading"]').evaluate((target) => {
    const style = getComputedStyle(target);
    return {
      opacity: style.opacity,
      filter: style.filter,
      duration: style.transitionDuration,
    };
  });
  expect(heading.opacity).toBe("0.12");
  expect(heading.filter).toBe("blur(6px)");
  expect(heading.duration).toBe("0.9s");

  const interactiveOpacity = await page
    .locator('[data-reveal-key="navigator-choices"]')
    .evaluate((target) => getComputedStyle(target).opacity);
  expect(interactiveOpacity).toBe("1");
});

test("stages cards and exposes a two pixel scroll progress line", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  }));
  await page.goto("/");

  const delays = await page.locator("#practice .practice-card").evaluateAll((cards) =>
    cards.map((card) => getComputedStyle(card).transitionDelay),
  );
  expect(delays).toEqual(["0s", "0.1s", "0.2s"]);

  const progress = await page.locator(".scroll-progress").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, height: style.height };
  });
  expect(progress).toEqual({ position: "fixed", height: "2px" });
});
```

- [ ] **Step 2: 새 계산 스타일 테스트가 실패하는지 확인한다**

Run:

```powershell
npm.cmd run test:e2e -- --grep "cinematic motion tokens|stages cards"
```

Expected: CSS 토큰이 비어 있고 기존 전환이 0.6s여서 FAIL.

- [ ] **Step 3: 기존 모션 규칙을 전용 파일로 분리한다**

`styles.css`에서 다음 세 범위를 삭제한다.

1. `/* 모든 콘텐츠는 기본적으로 보인다... */` 주석부터 첫 번째 `@media (prefers-reduced-motion: no-preference)` 블록 끝까지
2. `@media (max-width: 760px)` 안의 중첩된 `@media (prefers-reduced-motion: no-preference)` 블록
3. 파일 끝의 `@media (prefers-reduced-motion: reduce)` 블록

레이아웃·색상·기존 컴포넌트 규칙은 변경하지 않는다.

- [ ] **Step 4: 시네마틱 모션 전용 CSS를 작성한다**

`src/cinematic-motion.css`를 다음 내용으로 만든다.

```css
:root {
  --duration-cinematic: 900ms;
  --duration-media: 780ms;
  --duration-interaction: 220ms;
  --distance-cinematic: 32px;
  --stagger-card: 100ms;
  --ease-cinematic: cubic-bezier(0.16, 1, 0.3, 1);
}

.scroll-progress {
  position: fixed;
  z-index: 60;
  inset: 0 0 auto;
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

@supports (animation-timeline: scroll()) {
  @media (prefers-reduced-motion: no-preference) {
    .scroll-progress {
      display: block;
      animation: wisdom-scroll-progress linear both;
      animation-timeline: scroll(root);
    }
  }
}

[data-reveal],
.stagger-group > * {
  opacity: 1;
  filter: none;
  transform: none;
}

@media (prefers-reduced-motion: no-preference) {
  .motion-enabled .reveal,
  .motion-enabled .reveal-group,
  .motion-enabled .reveal-media,
  .motion-enabled .reveal-card {
    transition-property: opacity, transform, filter, clip-path;
    transition-duration: var(--duration-cinematic);
    transition-timing-function: var(--ease-cinematic);
  }

  .motion-enabled .reveal[data-revealed="false"] {
    opacity: 0.12;
    filter: blur(6px);
    transform: translate3d(0, var(--distance-cinematic), 0);
  }

  .motion-enabled .reveal-from-top[data-revealed="false"] {
    transform: translate3d(0, calc(var(--distance-cinematic) * -1), 0);
  }

  .motion-enabled .reveal-media {
    transition-duration: var(--duration-media);
  }

  .motion-enabled .reveal-media[data-revealed="false"] {
    opacity: 0.55;
    transform: scale(1.035);
  }

  .motion-enabled .reveal-media .portrait-frame {
    clip-path: inset(0);
    transition: clip-path var(--duration-media) var(--ease-cinematic);
  }

  .motion-enabled .reveal-media[data-revealed="false"] .portrait-frame {
    clip-path: inset(7% 0 9% 0);
  }

  .motion-enabled .reveal-group[data-revealed="false"] {
    opacity: 1;
    transform: translate3d(0, var(--distance-cinematic), 0);
  }

  .motion-enabled .reveal-panel[data-revealed="false"],
  .motion-enabled .reveal-card[data-revealed="false"] {
    transform: translate3d(0, var(--distance-cinematic), 0) scale(0.985);
  }

  .motion-enabled .reveal-hero[data-revealed="false"],
  .motion-enabled .stagger-group[data-revealed="false"] {
    transform: none;
  }

  .motion-enabled .reveal-hero h1,
  .motion-enabled .reveal-hero .hero-lead {
    transition: opacity var(--duration-cinematic) var(--ease-cinematic),
      transform var(--duration-cinematic) var(--ease-cinematic),
      filter var(--duration-cinematic) var(--ease-cinematic);
  }

  .motion-enabled .reveal-hero[data-revealed="false"] h1,
  .motion-enabled .reveal-hero[data-revealed="false"] .hero-lead {
    opacity: 0.35;
    filter: blur(4px);
    transform: translate3d(0, 24px, 0);
  }

  .motion-enabled .stagger-group > * {
    transition: opacity var(--duration-cinematic) var(--ease-cinematic),
      transform var(--duration-cinematic) var(--ease-cinematic),
      box-shadow var(--duration-interaction) ease;
  }

  .motion-enabled .stagger-group[data-revealed="false"] > * {
    transform: translate3d(0, var(--distance-cinematic), 0);
  }

  .motion-enabled .stagger-group > :nth-child(2) { transition-delay: var(--stagger-card); }
  .motion-enabled .stagger-group > :nth-child(3) { transition-delay: calc(var(--stagger-card) * 2); }
  .motion-enabled .reveal-credentials > :nth-child(2) { transition-delay: 65ms; }
  .motion-enabled .reveal-credentials > :nth-child(3) { transition-delay: 130ms; }
  .motion-enabled .reveal-credentials > :nth-child(4) { transition-delay: 195ms; }
}

.practice:hover,
.principle:hover,
.article-card:hover {
  z-index: 1;
  transform: translateY(-6px);
  box-shadow: 0 20px 45px rgba(47, 42, 37, 0.12);
}

.practice .arrow {
  transition: transform var(--duration-interaction) ease,
    border-color var(--duration-interaction) ease;
}

.practice:hover .arrow { transform: rotate(30deg); }
.choice:hover { transform: translateX(4px); }

.reveal-group:focus-within,
.reveal-group:focus-within > *,
.stagger-group:focus-within > * {
  opacity: 1 !important;
  filter: none !important;
  transform: none !important;
  transition-duration: 0ms !important;
  transition-delay: 0ms !important;
}

@media (max-width: 760px) {
  :root {
    --distance-cinematic: 16px;
    --stagger-card: 60ms;
  }

  @media (prefers-reduced-motion: no-preference) {
    .motion-enabled .reveal[data-revealed="false"] {
      opacity: 0.55;
      filter: none;
    }

    .motion-enabled .reveal-media[data-revealed="false"] {
      opacity: 0.7;
      transform: scale(1.02);
    }

    .motion-enabled .reveal-hero[data-revealed="false"] h1,
    .motion-enabled .reveal-hero[data-revealed="false"] .hero-lead {
      opacity: 0.55;
      filter: none;
      transform: translate3d(0, 16px, 0);
    }
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
  [data-reveal] *,
  .stagger-group > * {
    opacity: 1 !important;
    filter: none !important;
    clip-path: none !important;
    transform: none !important;
  }
}
```

- [ ] **Step 5: 시네마틱 CSS를 기본 스타일 다음에 로드한다**

`src/main.ts`의 import를 다음 순서로 바꾼다.

```ts
import "./styles.css";
import "./cinematic-motion.css";
import { createRevealController } from "./motion/reveal-controller";
```

컨트롤러 생성·시작·HMR 정리 코드는 변경하지 않는다.

- [ ] **Step 6: 계산 스타일 테스트와 빌드를 통과시킨다**

Run:

```powershell
npm.cmd run test:e2e -- --grep "cinematic motion tokens|stages cards"
npm.cmd run build
```

Expected: 두 Chromium 테스트 PASS, TypeScript와 Vite build exit code 0.

- [ ] **Step 7: 전체 회귀 검사를 실행한다**

Run:

```powershell
npm.cmd test
npm.cmd run test:e2e
```

Expected: Vitest와 Playwright 모두 0 failures. LCP 회귀가 100ms를 넘으면 `.reveal-media`의 `scale(1.035)`를 제거하고 같은 성능 테스트를 다시 실행한다. 마스크 제거는 확대 제거 후에도 기준을 넘을 때만 허용한다.

- [ ] **Step 8: 시네마틱 CSS를 커밋한다**

```powershell
git add prototypes/homepage-motion/src prototypes/homepage-motion/tests/homepage-motion.spec.ts
git commit -m "feat: add cinematic motion language"
```

---

### Task 3: 단일 HTML 생성과 독립 실행 검증

**Files:**
- Create: `prototypes/homepage-motion/scripts/verify-standalone.mjs`
- Modify: `prototypes/homepage-motion/scripts/build-standalone.mjs`
- Modify: `prototypes/homepage-motion/package.json`
- Modify: `prototypes/homepage-motion/README.md`

**Interfaces:**
- Consumes: `dist/index.html`, 번들 CSS·JavaScript, 대표 사진과 12개 대상
- Produces: `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html`, `npm run verify:standalone`

- [ ] **Step 1: 독립 HTML 브라우저 검증 스크립트를 먼저 작성한다**

`scripts/verify-standalone.mjs`를 다음 내용으로 만든다.

```js
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const filePath = resolve(
  workspaceRoot,
  ".superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html",
);
const html = await readFile(filePath, "utf8");

if (/src="\/assets|href="\/assets|\/images\/representative-brochure/.test(html)) {
  throw new Error("Standalone HTML still contains external asset paths");
}
if (!html.includes("data:image/jpeg;base64,")) {
  throw new Error("Standalone HTML does not contain the embedded portrait");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(pathToFileURL(filePath).href, { waitUntil: "load" });
  const targets = page.locator("[data-reveal]");
  if (await targets.count() !== 12) throw new Error("Expected 12 reveal targets");

  for (let index = 0; index < await targets.count(); index += 1) {
    await targets.nth(index).scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (key) => document.querySelector(`[data-reveal-key="${key}"]`)?.getAttribute("data-revealed") === "true",
      await targets.nth(index).getAttribute("data-reveal-key"),
    );
  }

  const result = await page.evaluate(() => ({
    headingVisible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
    revealed: document.querySelectorAll('[data-revealed="true"]').length,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  if (!result.headingVisible || result.revealed !== 12) {
    throw new Error(`Invalid standalone state: ${JSON.stringify(result)}`);
  }
  if (result.scrollWidth !== result.clientWidth) {
    throw new Error(`Standalone overflows: ${JSON.stringify(result)}`);
  }
  if (pageErrors.length > 0) throw new Error(`Page errors: ${pageErrors.join(" | ")}`);

  console.log(JSON.stringify({ filePath, ...result, pageErrors }));
} finally {
  await browser.close();
}
```

- [ ] **Step 2: 패키지에 검증 명령을 추가하고 실패를 확인한다**

`package.json` scripts에 다음 항목을 추가한다.

```json
"verify:standalone": "npm run standalone && node scripts/verify-standalone.mjs"
```

Run:

```powershell
npm.cmd run verify:standalone
```

Expected: 새 파일명이 아직 생성되지 않아 `ENOENT`로 FAIL.

- [ ] **Step 3: 단일 HTML 출력 파일명을 변경한다**

`build-standalone.mjs`의 출력 경로를 다음 코드로 바꾼다.

```js
const outputPath = resolve(outputDir, "wisdom-homepage-cinematic-demo.html");
```

나머지 CSS·JavaScript·사진 인라인 로직은 변경하지 않는다.

- [ ] **Step 4: 독립 HTML 검증을 통과시킨다**

Run:

```powershell
npm.cmd run verify:standalone
```

Expected: JSON 출력에 `revealed: 12`, `scrollWidth: 390`, `clientWidth: 390`, `pageErrors: []`가 표시되고 exit code 0.

- [ ] **Step 5: README에 단일 파일 명령과 출력명을 갱신한다**

다음 안내를 `README.md`의 검증과 캡처 절에 기록한다.

````markdown
```powershell
npm.cmd run verify:standalone
```

`verify:standalone`은 운영 빌드 후 CSS·JavaScript·대표 사진을 포함한
`.superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html`을 만들고,
Chromium에서 서버 없이 직접 열어 12개 모션과 모바일 너비를 검사합니다.
````

- [ ] **Step 6: 단일 HTML 기능을 커밋한다**

```powershell
git add prototypes/homepage-motion/scripts prototypes/homepage-motion/package.json prototypes/homepage-motion/README.md
git commit -m "feat: deliver cinematic standalone demo"
```

---

### Task 4: 시네마틱 캡처와 최종 검증

**Files:**
- Create: `prototypes/homepage-motion/src/artifact-contract.test.ts`
- Modify: `prototypes/homepage-motion/scripts/capture-motion.mjs`
- Modify: `AGENT.md`
- Modify: `work-log.md`
- Generate, do not commit: `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-desktop.png`
- Generate, do not commit: `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-mobile.png`
- Generate, do not commit: `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-scroll.webm`
- Generate, do not commit: `.superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html`

**Interfaces:**
- Consumes: 성공한 운영 빌드와 시네마틱 단일 HTML
- Produces: 사용자가 직접 열 수 있는 HTML, PNG 2개, WebM 1개와 최종 검증 증거

- [ ] **Step 1: 산출물 계약 테스트를 먼저 작성한다**

`src/artifact-contract.test.ts`를 다음 내용으로 만든다.

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capture = readFileSync(resolve(process.cwd(), "scripts/capture-motion.mjs"), "utf8");
const standalone = readFileSync(resolve(process.cwd(), "scripts/build-standalone.mjs"), "utf8");

describe("cinematic artifact contract", () => {
  it("uses the approved cinematic artifact names", () => {
    expect(capture).toContain("wisdom-homepage-cinematic-desktop.png");
    expect(capture).toContain("wisdom-homepage-cinematic-mobile.png");
    expect(capture).toContain("wisdom-homepage-cinematic-scroll.webm");
    expect(standalone).toContain("wisdom-homepage-cinematic-demo.html");
  });

  it("waits long enough to record the 900ms reveal", () => {
    expect(capture).toContain("waitForTimeout(1050)");
  });
});
```

- [ ] **Step 2: 기존 캡처 파일명과 450ms 대기 때문에 실패하는지 확인한다**

Run:

```powershell
npm.cmd test -- artifact-contract.test.ts
```

Expected: 새 PNG·WebM 파일명과 `waitForTimeout(1050)`가 없어 FAIL.

- [ ] **Step 3: 캡처 파일명과 스크롤 속도를 변경한다**

`capture-motion.mjs`의 경로 상수를 다음처럼 바꾼다.

```js
const desktopPng = resolve(renderDir, "wisdom-homepage-cinematic-desktop.png");
const mobilePng = resolve(renderDir, "wisdom-homepage-cinematic-mobile.png");
const scrollVideo = resolve(renderDir, "wisdom-homepage-cinematic-scroll.webm");
```

모바일 페이지 로드 직후 첫 화면 전환 완료를 기다리고 스크롤 루프를 다음처럼 바꾼다.

```js
await mobilePage.goto(url, { waitUntil: "networkidle" });
await mobilePage.waitForTimeout(1050);
await mobilePage.screenshot({ path: mobilePng, fullPage: false });
const scrollHeight = await mobilePage.evaluate(() => document.documentElement.scrollHeight);
for (let y = 0; y <= scrollHeight; y += 520) {
  await mobilePage.evaluate((nextY) => window.scrollTo({ top: nextY, behavior: "smooth" }), y);
  await mobilePage.waitForTimeout(1050);
}
```

데스크톱도 `goto` 뒤 1050ms 대기한 다음 캡처한다.

- [ ] **Step 4: 산출물 계약과 캡처를 실행한다**

Run:

```powershell
npm.cmd test -- artifact-contract.test.ts
npm.cmd run capture
npm.cmd run verify:standalone
```

Expected: 계약 PASS, PNG 2개·WebM·단일 HTML 생성, 각 명령 exit code 0.

- [ ] **Step 5: 데스크톱과 모바일 이미지를 직접 검사한다**

`view_image`로 다음 두 파일을 원본 해상도로 연다.

```text
.superpowers/brainstorm/renders/wisdom-homepage-cinematic-desktop.png
.superpowers/brainstorm/renders/wisdom-homepage-cinematic-mobile.png
```

확인 항목은 제목 잘림 없음, 대표 사진 인물 크롭 유지, 3대 업무의 동등 비중, 상담 CTA 노출, 390px 헤더 언어 선택 잘림 없음이다. 문제가 있으면 해당 CSS 한 범주만 수정하고 Task 2의 전체 E2E를 다시 실행한다.

- [ ] **Step 6: 전체 검증을 새로 실행한다**

먼저 무시된 시각 산출물을 메인 프로젝트의 렌더 폴더로 복사한다. 소스와 목적지가 모두 프로젝트 내부인지 확인한 다음 실행한다.

```powershell
$worktreeRoot = git rev-parse --show-toplevel
$mainRoot = Split-Path -Parent (git rev-parse --git-common-dir)
$sourceRender = Join-Path $worktreeRoot '.superpowers/brainstorm/renders'
$targetRender = Join-Path $mainRoot '.superpowers/brainstorm/renders'
New-Item -ItemType Directory -Force -Path $targetRender | Out-Null
$artifacts = @(
  (Join-Path $sourceRender 'wisdom-homepage-cinematic-desktop.png')
  (Join-Path $sourceRender 'wisdom-homepage-cinematic-mobile.png')
  (Join-Path $sourceRender 'wisdom-homepage-cinematic-scroll.webm')
  (Join-Path $sourceRender 'wisdom-homepage-cinematic-demo.html')
)
Copy-Item -LiteralPath $artifacts -Destination $targetRender -Force
```

Run:

```powershell
npm.cmd test
npm.cmd run test:e2e
npm.cmd run build
npm.cmd run verify:standalone
git diff --check
Get-Item '.superpowers/brainstorm/renders/wisdom-homepage-cinematic-desktop.png',
         '.superpowers/brainstorm/renders/wisdom-homepage-cinematic-mobile.png',
         '.superpowers/brainstorm/renders/wisdom-homepage-cinematic-scroll.webm',
         '.superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html' |
  Select-Object Name,Length
```

Expected: Vitest·Playwright 0 failures, build와 독립 HTML 검증 exit code 0, `git diff --check` 실제 오류 0건, 네 파일 모두 10KB 초과.

- [ ] **Step 7: 작업 기록을 갱신한다**

`AGENT.md`와 `work-log.md`에 다음 사실만 기록한다.

- 시네마틱 모션 대상을 8개에서 12개로 확장한 커밋
- 최종 Vitest와 Playwright 테스트 수
- 네 산출물의 실제 바이트 크기
- 대표 사진은 운영 전 고해상도 상반신 원본으로 교체해야 한다는 남은 작업

- [ ] **Step 8: 기록과 캡처 계약을 커밋한다**

```powershell
git add prototypes/homepage-motion/src/artifact-contract.test.ts prototypes/homepage-motion/scripts/capture-motion.mjs AGENT.md work-log.md
git commit -m "test: verify cinematic demo artifacts"
```

## Spec Coverage Map

| 설계 요구 | 구현 태스크 |
|---|---|
| 12개 최초 1회 관찰 대상 | Task 1, Task 2 |
| 900ms·780ms·32px·16px 토큰 | Task 2 |
| 사진 확대·마스크와 제목 흐림 | Task 2 |
| 카드 100ms·모바일 60ms·이력 65ms 스태거 | Task 2 |
| 2px 스크롤 진행선과 브라우저 폴백 | Task 1, Task 2 |
| 호버 상승·화살표 회전·선택지 이동 | Task 2 |
| 포커스·모션 감소·Observer 오류 복구 | Task 2 기존 회귀 검사 |
| 320~1440px 반응형·CLS·LCP 예산 | Task 2, Task 4 |
| 서버 없는 단일 HTML | Task 3, Task 4 |
| 새 PNG 2개와 WebM | Task 4 |
