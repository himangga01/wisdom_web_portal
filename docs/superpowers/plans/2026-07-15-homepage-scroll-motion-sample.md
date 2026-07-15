# 홈페이지 스크롤 모션 샘플 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 추천 하이브리드 홈페이지에 Tailwind CSS v4 기반의 절제된 최초 1회 스크롤 리빌을 적용하고, 데스크톱·모바일에서 직접 확인할 수 있는 샘플을 만든다.

**Architecture:** 기존 무모션 목업은 비교본으로 보존하고 `prototypes/homepage-motion`에 독립 Vite 정적 사이트를 만든다. 모션 상태는 프레임워크에 의존하지 않는 TypeScript `RevealController`가 담당하고, Tailwind의 정적 의미 클래스와 `data-revealed` 속성이 표현을 담당한다. Vitest는 단방향 상태와 복구 로직을, Playwright는 실제 스크롤·모션 감소·무자바스크립트·반응형 동작을 검증한다.

**Tech Stack:** Node.js 20+, Vite, TypeScript, Tailwind CSS v4, `@tailwindcss/vite`, Vitest, happy-dom, Playwright Chromium

## Global Constraints

- Tailwind CSS v4 계열을 로컬 설치하고 정확한 버전은 `package-lock.json`에 고정한다.
- Docker를 사용하지 않고 Node.js와 npm 패키지를 로컬에 설치한다.
- Tailwind Play CDN과 GSAP·Lottie·Framer Motion을 사용하지 않는다.
- 모션 대상은 페이지 전체 정확히 8개이며 한 섹션에 최대 2개다.
- 헤더, H1, 주 상담 CTA, 모든 선택 버튼, 연락처, 법적 고지와 푸터는 첫 페인트부터 표시한다.
- 각 대상은 페이지 로드 후 `waiting → revealed`로 정확히 한 번만 전환하며 다시 숨지 않는다.
- 스크롤 Observer는 `rootMargin: "0px 0px -12% 0px"`, `threshold: 0.01`을 사용한다.
- `duration-fast`는 400ms, `duration-base`는 600ms, 데스크톱 지연은 80ms·최대 160ms, 모바일 지연은 0ms다.
- 숨김 규칙은 `prefers-reduced-motion: no-preference` 안에서만 활성화한다.
- `.motion-enabled`가 없으면 모든 콘텐츠는 `opacity: 1`과 최종 transform 상태다.
- 320, 390, 768, 1024, 1440px에서 가로 스크롤이 없어야 한다.
- 브라우저 기준은 Safari 16.4+, Chrome·Edge 111+, Firefox 128+이며 Chromium 자동화와 iOS Safari 수동 검증을 분리한다.
- 기준 설계 문서는 `docs/superpowers/specs/2026-07-15-homepage-scroll-motion-design.md`다.
- 기준 무모션 목업은 `.superpowers/brainstorm/mockups/hybrid/h1-recommended-hybrid.html`이며 수정하지 않는다.

## File Structure

| 경로 | 책임 |
|---|---|
| `.gitignore` | 로컬 빌드·테스트·브레인스토밍 산출물 제외 |
| `prototypes/homepage-motion/package.json` | 샘플 실행·빌드·검사 명령 |
| `prototypes/homepage-motion/package-lock.json` | 설치 버전 고정 |
| `prototypes/homepage-motion/tsconfig.json` | 브라우저 TypeScript 검사 |
| `prototypes/homepage-motion/vite.config.ts` | Tailwind Vite 플러그인과 Vitest 환경 |
| `prototypes/homepage-motion/playwright.config.ts` | 실제 브라우저·로컬 서버 설정 |
| `prototypes/homepage-motion/index.html` | 승인된 홈페이지 콘텐츠와 8개 모션 대상 |
| `prototypes/homepage-motion/src/styles.css` | Tailwind 토큰·컴포넌트·모션 상태 |
| `prototypes/homepage-motion/src/main.ts` | 브라우저 컨트롤러 초기화와 HMR 정리 |
| `prototypes/homepage-motion/src/motion/reveal-controller.ts` | 최초 1회 상태 전환·복구·이벤트 정리 |
| `prototypes/homepage-motion/src/motion/reveal-controller.test.ts` | 상태 머신 단위 테스트 |
| `prototypes/homepage-motion/src/homepage-contract.test.ts` | 콘텐츠·모션 개수·CTA·다국어 정적 계약 |
| `prototypes/homepage-motion/tests/homepage-motion.spec.ts` | 반응형·스크롤·접근성·복구 E2E |
| `prototypes/homepage-motion/scripts/capture-motion.mjs` | PNG와 WebM 샘플 생성 |
| `prototypes/homepage-motion/public/images/representative-brochure.jpg` | 시안용 브로슈어 이미지 복사본 |
| `prototypes/homepage-motion/README.md` | 실행·검증·이미지 교체 안내 |

---

### Task 1: Vite·Tailwind 테스트 가능한 샘플 기반 구성

**Files:**
- Create: `.gitignore`
- Create: `prototypes/homepage-motion/package.json`
- Create: `prototypes/homepage-motion/package-lock.json`
- Create: `prototypes/homepage-motion/tsconfig.json`
- Create: `prototypes/homepage-motion/vite.config.ts`
- Create: `prototypes/homepage-motion/playwright.config.ts`
- Create: `prototypes/homepage-motion/index.html`
- Create: `prototypes/homepage-motion/src/main.ts`
- Create: `prototypes/homepage-motion/src/styles.css`

**Interfaces:**
- Consumes: Node.js 20+와 npm
- Produces: `npm run dev`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run capture`

- [ ] **Step 1: 기반이 아직 없음을 확인한다**

Run:

```powershell
Test-Path 'prototypes/homepage-motion/package.json'
```

Expected: `False`

- [ ] **Step 2: 디렉터리와 npm 패키지를 만든다**

Run:

```powershell
New-Item -ItemType Directory -Force 'prototypes/homepage-motion/src/motion','prototypes/homepage-motion/tests','prototypes/homepage-motion/scripts','prototypes/homepage-motion/public/images' | Out-Null
Set-Location 'prototypes/homepage-motion'
npm init -y
npm pkg set type=module
npm pkg set private=true --json
npm pkg set scripts.dev=vite scripts.preview="vite preview" scripts.build="tsc --noEmit && vite build" scripts.test="vitest run" scripts.test:e2e="playwright test" scripts.capture="npm run build && node scripts/capture-motion.mjs"
npm install -D vite typescript tailwindcss @tailwindcss/vite vitest happy-dom @playwright/test @types/node
npx playwright install chromium
```

Expected: `package-lock.json`이 생기고 모든 설치 명령이 exit code 0으로 끝난다.

- [ ] **Step 3: TypeScript와 Vite 설정을 작성한다**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals", "node"]
  },
  "include": ["src", "tests", "vite.config.ts", "playwright.config.ts"]
}
```

`vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
  },
});
```

`playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
```

- [ ] **Step 4: 최소 진입 파일을 작성한다**

`index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="지혜행정사사무소 홈페이지 스크롤 모션 샘플">
    <title>지혜행정사사무소 — Scroll Motion Sample</title>
  </head>
  <body>
    <main><h1>지혜행정사사무소 모션 샘플</h1></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts`:

```ts
import "./styles.css";
```

`src/styles.css`:

```css
@import "tailwindcss";

@layer base {
  body {
    @apply m-0 bg-[#fffdfa] text-[#2f2a25];
  }
}
```

- [ ] **Step 5: 루트 무시 규칙을 작성한다**

`.gitignore`:

```gitignore
.codex-remote-attachments/
.superpowers/
prototypes/homepage-motion/node_modules/
prototypes/homepage-motion/dist/
prototypes/homepage-motion/playwright-report/
prototypes/homepage-motion/test-results/
```

- [ ] **Step 6: 빌드 기반을 검증한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' run build
```

Expected: TypeScript 오류 0건, Vite build 성공, `dist/index.html` 생성.

- [ ] **Step 7: 기반 구성을 커밋한다**

```powershell
git add .gitignore prototypes/homepage-motion
git commit -m "chore: scaffold Tailwind motion prototype"
```

---

### Task 2: 최초 1회 RevealController를 테스트 우선으로 구현

**Files:**
- Create: `prototypes/homepage-motion/src/motion/reveal-controller.test.ts`
- Create: `prototypes/homepage-motion/src/motion/reveal-controller.ts`
- Modify: `prototypes/homepage-motion/src/main.ts`

**Interfaces:**
- Consumes: `[data-reveal][data-revealed="false"]`, `IntersectionObserver`, `MediaQueryList`
- Produces: `createRevealController(overrides?: Partial<RevealEnvironment>): RevealController`
- Produces: `RevealController.start()`, `reveal(target)`, `revealAll()`, `destroy()`

- [ ] **Step 1: Observer 옵션과 일회 전환 실패 테스트를 작성한다**

`reveal-controller.test.ts`에 테스트용 Observer와 미디어쿼리 객체를 포함해 다음 계약을 작성한다.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRevealController, type ObserverLike } from "./reveal-controller";

function createMediaQuery(matches = false): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

describe("RevealController core", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = `
      <section data-reveal data-revealed="false"></section>
      <section data-reveal data-revealed="false"></section>
    `;
  });

  it("uses the approved observer boundary and enables motion last", () => {
    const observed: Element[] = [];
    let receivedOptions: IntersectionObserverInit | undefined;
    const observer: ObserverLike = {
      observe: (target) => observed.push(target),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: (_callback, options) => {
        receivedOptions = options;
        expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
        return observer;
      },
    });

    controller.start();

    expect(receivedOptions).toEqual({ rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
    expect(observed).toHaveLength(2);
    expect(document.documentElement.classList.contains("motion-enabled")).toBe(true);
  });

  it("changes a target to revealed only once", () => {
    const target = document.querySelector<HTMLElement>("[data-reveal]")!;
    const unobserve = vi.fn();
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => ({ observe: vi.fn(), unobserve, disconnect: vi.fn() }),
    });
    controller.start();

    expect(controller.reveal(target)).toBe(true);
    expect(controller.reveal(target)).toBe(false);
    expect(target.dataset.revealed).toBe("true");
    expect(unobserve).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 단위 테스트가 실패하는지 확인한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test -- reveal-controller.test.ts
```

Expected: FAIL with module `./reveal-controller` not found.

- [ ] **Step 3: 핵심 인터페이스와 단방향 상태를 구현한다**

`reveal-controller.ts`에는 다음 타입과 동작을 구현한다.

```ts
export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => ObserverLike;

export interface RevealEnvironment {
  documentRef: Document;
  windowRef: Window;
  root: HTMLElement;
  targets: HTMLElement[];
  mediaQuery: MediaQueryList;
  createObserver: ObserverFactory | null;
}

export interface RevealController {
  start(): void;
  reveal(target: HTMLElement): boolean;
  revealAll(): void;
  destroy(): void;
}

export function createRevealController(
  overrides: Partial<RevealEnvironment> = {},
): RevealController {
  const documentRef = overrides.documentRef ?? document;
  const windowRef = overrides.windowRef ?? window;
  const root = overrides.root ?? documentRef.documentElement;
  const targets = overrides.targets ?? Array.from(documentRef.querySelectorAll<HTMLElement>("[data-reveal]"));
  const mediaQuery = overrides.mediaQuery ?? windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  const hasFactoryOverride = Object.prototype.hasOwnProperty.call(overrides, "createObserver");
  const createObserver = hasFactoryOverride
    ? (overrides.createObserver ?? null)
    : typeof windowRef.IntersectionObserver === "function"
      ? (callback: IntersectionObserverCallback, options: IntersectionObserverInit) =>
          new windowRef.IntersectionObserver(callback, options)
      : null;
  let observer: ObserverLike | null = null;
  let started = false;

  const reveal = (target: HTMLElement): boolean => {
    if (target.dataset.revealed === "true") return false;
    target.dataset.revealed = "true";
    observer?.unobserve(target);
    return true;
  };

  const revealAll = (): void => {
    root.classList.remove("motion-enabled");
    targets.forEach(reveal);
    observer?.disconnect();
  };

  const start = (): void => {
    if (started) return;
    started = true;
    if (mediaQuery.matches || createObserver === null) {
      revealAll();
      return;
    }
    try {
      observer = createObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) reveal(entry.target as HTMLElement);
        });
      }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
      targets.forEach((target) => observer?.observe(target));
      root.classList.add("motion-enabled");
    } catch {
      revealAll();
    }
  };

  const destroy = (): void => {
    revealAll();
    started = false;
  };

  return { start, reveal, revealAll, destroy };
}
```

`src/main.ts`:

```ts
import "./styles.css";
import { createRevealController } from "./motion/reveal-controller";

const revealController = createRevealController();
revealController.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => revealController.destroy());
}
```

- [ ] **Step 4: 핵심 단위 테스트를 통과시킨다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test -- reveal-controller.test.ts
```

Expected: 2 tests passed.

- [ ] **Step 5: 핵심 컨트롤러를 커밋한다**

```powershell
git add prototypes/homepage-motion/src
git commit -m "feat: add one-time reveal controller"
```

---

### Task 3: 모션 감소·오류·포커스·해시 복구 계약 추가

**Files:**
- Modify: `prototypes/homepage-motion/src/motion/reveal-controller.test.ts`
- Modify: `prototypes/homepage-motion/src/motion/reveal-controller.ts`

**Interfaces:**
- Consumes: `MediaQueryList.change`, `focusin`, `hashchange`, `pageshow`, `resize`
- Produces: 루트 클래스가 없으면 항상 보이는 원자적 복구
- Produces: `destroy()` 호출 후 등록 이벤트와 Observer가 모두 정리된 상태

- [ ] **Step 1: 실패·접근성·생명주기 테스트를 추가한다**

다음 테스트 이름과 단언을 같은 파일에 추가한다.

```ts
it("shows every target without constructing an observer for reduced motion", () => {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  const createObserver = vi.fn();
  const controller = createRevealController({ mediaQuery: createMediaQuery(true), createObserver });
  controller.start();
  expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
  expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
  expect(createObserver).not.toHaveBeenCalled();
});

it("shows every target when IntersectionObserver is unsupported", () => {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  const controller = createRevealController({ mediaQuery: createMediaQuery(false), createObserver: null });
  controller.start();
  expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
  expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
});

it("recovers atomically when observer construction throws", () => {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  const controller = createRevealController({
    mediaQuery: createMediaQuery(false),
    createObserver: () => { throw new Error("forced initialization failure"); },
  });
  controller.start();
  expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
  expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
});

it("reveals an interactive ancestor before focus is painted", () => {
  document.body.innerHTML = `<section data-reveal data-revealed="false"><a href="#consultation">상담</a></section>`;
  const target = document.querySelector<HTMLElement>("[data-reveal]")!;
  const controller = createRevealController({
    mediaQuery: createMediaQuery(false),
    createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
  });
  controller.start();
  target.querySelector("a")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(target.dataset.revealed).toBe("true");
});

it("disconnects and reveals all when reduced motion turns on", () => {
  let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
  const disconnect = vi.fn();
  const mediaQuery = {
    matches: false,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      changeListener = listener as (event: MediaQueryListEvent) => void;
    },
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList;
  const controller = createRevealController({
    mediaQuery,
    createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect }),
  });
  controller.start();
  changeListener?.({ matches: true } as MediaQueryListEvent);
  expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
  expect(disconnect).toHaveBeenCalled();
});

it("reveals the destination before a hash navigation is painted", () => {
  document.body.innerHTML = `<section id="principles"><div data-reveal data-revealed="false"></div></section>`;
  window.history.replaceState({}, "", "#principles");
  const target = document.querySelector<HTMLElement>("[data-reveal]")!;
  const controller = createRevealController({
    mediaQuery: createMediaQuery(false),
    createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
  });
  controller.start();
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(target.dataset.revealed).toBe("true");
  window.history.replaceState({}, "", "/");
});

it("reveals targets that a fast scroll has already passed", () => {
  const target = document.querySelector<HTMLElement>("[data-reveal]")!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
    x: 0, y: -200, top: -200, right: 300, bottom: -20, left: 0,
    width: 300, height: 180, toJSON: () => ({}),
  });
  const controller = createRevealController({
    mediaQuery: createMediaQuery(false),
    createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
  });
  controller.start();
  window.dispatchEvent(new Event("pageshow"));
  expect(target.dataset.revealed).toBe("true");
});
```

- [ ] **Step 2: 새 테스트가 실패하는지 확인한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test -- reveal-controller.test.ts
```

Expected: focus, media change 또는 이벤트 정리 관련 테스트가 FAIL.

- [ ] **Step 3: 복구 이벤트와 단방향 새로고침을 구현한다**

`start()`가 Observer를 만든 뒤 아래 핸들러를 연결하고 `.motion-enabled`는 마지막에 추가한다.

```ts
const revealPassedTargets = (): void => {
  targets.forEach((target) => {
    if (target.dataset.revealed !== "true" && target.getBoundingClientRect().bottom < 0) {
      reveal(target);
    }
  });
};

const revealHashTarget = (): void => {
  const id = decodeURIComponent(windowRef.location.hash.slice(1));
  if (!id) return;
  const anchor = documentRef.getElementById(id);
  if (!anchor) return;
  const direct = anchor.closest<HTMLElement>("[data-reveal]");
  const descendants = Array.from(anchor.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (direct) reveal(direct);
  descendants.forEach(reveal);
};

const onFocusIn = (event: Event): void => {
  const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-reveal]") : null;
  if (element) reveal(element);
};

const onMotionPreference = (event: MediaQueryListEvent): void => {
  if (event.matches) {
    detachEvents();
    revealAll();
  }
};

const onViewportState = (): void => {
  revealPassedTargets();
  revealHashTarget();
};

const attachEvents = (): void => {
  documentRef.addEventListener("focusin", onFocusIn, true);
  windowRef.addEventListener("hashchange", revealHashTarget);
  windowRef.addEventListener("pageshow", onViewportState);
  windowRef.addEventListener("resize", onViewportState, { passive: true });
  mediaQuery.addEventListener("change", onMotionPreference);
};

const detachEvents = (): void => {
  documentRef.removeEventListener("focusin", onFocusIn, true);
  windowRef.removeEventListener("hashchange", revealHashTarget);
  windowRef.removeEventListener("pageshow", onViewportState);
  windowRef.removeEventListener("resize", onViewportState);
  mediaQuery.removeEventListener("change", onMotionPreference);
};

const prepareMediaTarget = (target: HTMLElement): void => {
  if (!target.classList.contains("reveal-media")) return;
  target.style.willChange = "opacity, transform";
  let cleared = false;
  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    target.style.removeProperty("will-change");
  };
  target.addEventListener("transitionend", clear, { once: true });
  windowRef.setTimeout(clear, 1000);
};
```

Task 2의 `start()`와 `destroy()`를 다음 코드로 교체한다. `.motion-enabled`는 Observer 생성, 대상 등록, 복구 이벤트 연결이 모두 성공한 뒤 마지막에 추가한다.

```ts
const start = (): void => {
  if (started) return;
  started = true;
  if (mediaQuery.matches || createObserver === null) {
    revealAll();
    return;
  }
  try {
    observer = createObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) reveal(entry.target as HTMLElement);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
    targets.forEach((target) => {
      prepareMediaTarget(target);
      if (target.getBoundingClientRect().bottom < 0) reveal(target);
      else observer?.observe(target);
    });
    revealHashTarget();
    attachEvents();
    root.classList.add("motion-enabled");
  } catch {
    detachEvents();
    revealAll();
  }
};

const destroy = (): void => {
  detachEvents();
  revealAll();
  started = false;
};
```

- [ ] **Step 4: 전체 단위 테스트와 타입 검사를 통과시킨다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test
npm --prefix 'prototypes/homepage-motion' run build
```

Expected: 모든 Vitest 테스트 PASS, TypeScript 오류 0건.

- [ ] **Step 5: 복구 로직을 커밋한다**

```powershell
git add prototypes/homepage-motion/src/motion
git commit -m "feat: harden reveal accessibility and fallbacks"
```

---

### Task 4: 승인된 홈페이지를 Tailwind와 8개 모션 대상으로 변환

**Files:**
- Create: `prototypes/homepage-motion/src/homepage-contract.test.ts`
- Modify: `prototypes/homepage-motion/index.html`
- Modify: `prototypes/homepage-motion/src/styles.css`
- Create: `prototypes/homepage-motion/public/images/representative-brochure.jpg`

**Interfaces:**
- Consumes: 기존 무모션 목업의 본문, 브랜드 색상, 상담 문구와 세 전문영역
- Produces: `[data-reveal]` 정확히 8개와 `.reveal`, `.reveal-media`, `.reveal-group`
- Produces: 외부 CDN 없는 Tailwind 빌드 페이지

- [ ] **Step 1: 홈페이지 정적 계약 테스트를 작성한다**

`homepage-contract.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const windowRef = new Window();
windowRef.document.write(html);
const documentRef = windowRef.document;

describe("homepage contract", () => {
  it("contains the eight approved reveal targets", () => {
    const targets = Array.from(documentRef.querySelectorAll<HTMLElement>("[data-reveal]"));
    const keys = targets.map((target) => target.dataset.revealKey);
    expect(targets).toHaveLength(8);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(8);
  });

  it("keeps interactive reveal containers visible", () => {
    documentRef.querySelectorAll<HTMLElement>("[data-reveal]").forEach((target) => {
      if (target.querySelector("a, button, input, label")) {
        expect(target.classList.contains("reveal-group")).toBe(true);
      }
    });
  });

  it("contains equal practice entries and multilingual controls", () => {
    expect(documentRef.querySelectorAll("#practice .practice-card")).toHaveLength(3);
    expect(documentRef.body.textContent).toContain("기업행정");
    expect(documentRef.body.textContent).toContain("공공조달");
    expect(documentRef.body.textContent).toContain("출입국·비자");
    for (const language of ["KO", "EN", "简", "繁"]) {
      expect(documentRef.body.textContent).toContain(language);
    }
  });

  it("uses a local Tailwind entry and no CDN", () => {
    expect(html).toContain('/src/main.ts');
    expect(html).not.toMatch(/cdn\.tailwindcss|@tailwindcss\/browser|https:\/\/cdn\./);
  });
});
```

- [ ] **Step 2: 계약 테스트가 실패하는지 확인한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test -- homepage-contract.test.ts
```

Expected: reveal target count와 전문영역 계약이 FAIL.

- [ ] **Step 3: 기존 목업을 복사하고 로컬 이미지 경로를 만든다**

Run:

```powershell
Copy-Item -LiteralPath '.superpowers/brainstorm/mockups/hybrid/h1-recommended-hybrid.html' -Destination 'prototypes/homepage-motion/index.html' -Force
Copy-Item -LiteralPath '.codex-remote-attachments/019f6109-0cc5-7fc2-a443-ec6609dc8c97/e8040a3d-f176-43d1-8459-a839a130f376/1-Photo-1.jpg' -Destination 'prototypes/homepage-motion/public/images/representative-brochure.jpg' -Force
```

`index.html`의 인라인 `<style>` 전체를 제거하고 `<body>` 끝에 다음 진입점을 둔다.

```html
<script type="module" src="/src/main.ts"></script>
```

대표 사진의 로컬 절대 경로는 `/images/representative-brochure.jpg`로 교체한다.

- [ ] **Step 4: 정확히 8개 대상에 상태 속성을 부여한다**

기존 클래스는 유지하면서 다음 요소에만 속성을 추가한다.

```html
<aside class="portrait-wrap reveal-media" data-reveal data-reveal-key="portrait" data-revealed="false" aria-label="강지혜 대표행정사">
<div class="shell practice-grid reveal-group" data-reveal data-reveal-key="practice" data-revealed="false">
<div class="navigator-intro reveal" data-reveal data-reveal-key="navigator-copy" data-revealed="false">
<div class="section-head reveal" data-reveal data-reveal-key="principles-heading" data-revealed="false">
<div class="principle-grid reveal-group" data-reveal data-reveal-key="principles-group" data-revealed="false">
<div class="section-head reveal" data-reveal data-reveal-key="insights-heading" data-revealed="false">
<div class="insight-grid reveal-group" data-reveal data-reveal-key="insights-group" data-revealed="false">
<div class="consultation-copy reveal" data-reveal data-reveal-key="consultation-copy" data-revealed="false">
```

세 전문영역 링크에는 `practice-card` 클래스를 추가한다. 헤더, H1, CTA, 업무 선택 입력, 연락처와 푸터에는 `data-reveal`을 추가하지 않는다.

- [ ] **Step 5: Tailwind 토큰과 상태 규칙을 작성한다**

`src/styles.css`의 시작 부분은 다음과 같이 고정한다.

```css
@import "tailwindcss";

@theme {
  --color-brand-gold: #a78d6c;
  --color-brand-paper: #fffdfa;
  --color-brand-brown: #5d4936;
  --color-brand-ink: #2f2a25;
  --color-brand-sand: #d8cabb;
  --font-sans: "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif;
  --font-serif: "Iropke Batang", "Noto Serif KR", "Nanum Myeongjo", Georgia, serif;
}

@layer base {
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { @apply m-0 bg-brand-paper font-sans text-brand-ink; line-height: 1.65; word-break: keep-all; }
  a { @apply text-inherit no-underline; }
  button, input, label { font: inherit; }
  :focus-visible { @apply outline-2 outline-offset-4 outline-brand-brown; }
}

@layer utilities {
  .reveal, .reveal-media, .reveal-group {
    --reveal-distance: 16px;
    --reveal-duration: 600ms;
    --reveal-delay: 0ms;
    opacity: 1;
    transform: none;
    transition-property: opacity, transform;
    transition-duration: var(--reveal-duration);
    transition-delay: min(var(--reveal-delay), 160ms);
    transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
  }
  .reveal-media { --reveal-duration: 400ms; transform-origin: center; }
  @media (prefers-reduced-motion: no-preference) {
    .motion-enabled .reveal[data-revealed="false"] { opacity: 0; transform: translateY(var(--reveal-distance)); }
    .motion-enabled .reveal-media[data-revealed="false"] { opacity: .55; transform: scale(1.015); }
    .motion-enabled .reveal-group[data-revealed="false"] { opacity: 1; transform: translateY(var(--reveal-distance)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .reveal, .reveal-media, .reveal-group {
      opacity: 1;
      transform: none;
      transition-duration: 0ms;
      transition-delay: 0ms;
    }
  }
  @media (max-width: 640px) {
    .reveal, .reveal-media, .reveal-group { --reveal-distance: 10px; --reveal-delay: 0ms; }
  }
}
```

시각 스타일은 기존 목업의 클래스명을 `@layer components` 안에서 유지하고 공통 속성을 Tailwind `@apply`로 묶는다. 핵심 구조는 다음 값으로 고정한다.

```css
@layer components {
  .shell { width: min(1320px, calc(100% - 96px)); @apply mx-auto; }
  .serif { @apply font-serif; }
  .site-header { @apply relative z-10 border-b border-brand-sand bg-brand-paper/95; }
  .header-inner { min-height: 92px; @apply grid grid-cols-[310px_1fr_auto] items-center gap-8; }
  .hero { @apply overflow-hidden pt-16; }
  .hero-grid { min-height: 630px; @apply grid grid-cols-[minmax(0,1.13fr)_minmax(390px,.87fr)] gap-20; }
  .portrait-wrap { min-height: 630px; @apply relative; }
  .portrait-frame { @apply absolute inset-y-0 right-0 left-6 overflow-hidden bg-brand-sand; background: url('/images/representative-brochure.jpg') left bottom / 320% auto no-repeat; }
  .practice-summary { @apply mt-12 border-y border-brand-sand; }
  .practice-grid, .principle-grid, .insight-grid { @apply grid grid-cols-3; }
  .practice-card { min-height: 205px; @apply relative border-brand-sand px-8 py-7; }
  .navigator-section, .insights { @apply bg-brand-paper py-28; }
  .navigator-shell { min-height: 630px; @apply grid grid-cols-[.72fr_1.28fr] border border-brand-sand bg-white; }
  .navigator-intro { @apply relative overflow-hidden bg-brand-ink px-12 py-14 text-white; }
  .principles, .consultation { @apply py-24; }
  .credential-bar { @apply bg-brand-ink py-10 text-white; }
  footer { @apply border-t border-brand-sand bg-brand-paper py-10; }
  @media (max-width: 1080px) {
    .header-inner { @apply grid-cols-[1fr_auto]; }
    nav { @apply hidden; }
    .hero-grid { @apply grid-cols-2 gap-10; }
  }
  @media (max-width: 760px) {
    .shell { width: min(1320px, calc(100% - 24px)); }
    .header-inner { min-height: 76px; }
    .hero { @apply pt-10; }
    .hero-grid, .navigator-shell { @apply block; }
    .portrait-wrap { min-height: 310px; @apply mt-10; }
    .portrait-frame { @apply left-0; }
    .practice-grid, .principle-grid, .insight-grid { @apply grid-cols-1; }
    .navigator-section, .insights, .principles, .consultation { @apply py-16; }
  }
}
```

기존 목업의 브랜드·히어로·버튼·업무 찾기·카드·상담·푸터 세부 선택자는 같은 `@layer components` 안으로 옮기고, 원래 숫자값을 유지한다. Tailwind 빌드 밖의 별도 CSS 파일과 인라인 `<style>`은 두지 않는다.

- [ ] **Step 6: 정적 계약과 프로덕션 빌드를 통과시킨다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test -- homepage-contract.test.ts
npm --prefix 'prototypes/homepage-motion' run build
```

Expected: 4 contract tests PASS, build 성공, 외부 CDN 문자열 0건.

- [ ] **Step 7: Tailwind 홈페이지를 커밋한다**

```powershell
git add prototypes/homepage-motion
git commit -m "feat: build Tailwind homepage motion sample"
```

---

### Task 5: 실제 브라우저 회귀 검사를 작성

**Files:**
- Create: `prototypes/homepage-motion/tests/homepage-motion.spec.ts`
- Modify: `prototypes/homepage-motion/playwright.config.ts`

**Interfaces:**
- Consumes: Vite 서버와 8개 `[data-reveal]` 요소
- Produces: 일회 재생, reduced-motion, 오류 복구, 무자바스크립트, 가로 넘침, CLS·LCP 실험실 지표 증거

- [ ] **Step 1: 모션 브라우저 테스트를 작성한다**

`homepage-motion.spec.ts`에 다음 검사를 구현한다.

```ts
import { expect, test } from "@playwright/test";

test("reveals each target no more than once", async ({ page }) => {
  await page.addInitScript(() => {
    const counts: Record<string, number> = {};
    Object.defineProperty(window, "__revealCounts", { value: counts, configurable: true });
    new MutationObserver((records) => {
      records.forEach((record) => {
        const target = record.target as HTMLElement;
        const key = target.dataset.revealKey;
        if (key && target.dataset.revealed === "true") counts[key] = (counts[key] ?? 0) + 1;
      });
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-revealed"],
    });
  });
  await page.goto("/");
  const targets = page.locator("[data-reveal]");
  await expect(targets).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) {
    await targets.nth(index).scrollIntoViewIfNeeded();
    await expect(targets.nth(index)).toHaveAttribute("data-revealed", "true");
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const counts = await page.evaluate(() => (window as Window & { __revealCounts: Record<string, number> }).__revealCounts);
  expect(Object.keys(counts)).toHaveLength(8);
  expect(Object.values(counts).every((count) => count === 1)).toBe(true);
});

test("shows final state from the first frame for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  const states = await page.locator("[data-reveal]").evaluateAll((targets) => targets.map((target) => {
    const style = getComputedStyle(target);
    return { opacity: style.opacity, transform: style.transform, duration: style.transitionDuration };
  }));
  expect(states.every((state) => state.opacity === "1" && state.transform === "none" && state.duration === "0s")).toBe(true);
});

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  });
}
```

- [ ] **Step 2: 복구 경로 테스트를 작성한다**

같은 파일에 Observer 미지원, 생성 예외, 자바스크립트 비활성화 테스트를 추가한다.

```ts
test("keeps content visible when IntersectionObserver is missing", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", { value: undefined, configurable: true }));
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((targets) => targets.every((target) => getComputedStyle(target).opacity === "1"))).toBe(true);
});

test("recovers when observer construction throws", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class { constructor() { throw new Error("forced initialization failure"); } },
  }));
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((targets) => targets.every((target) => getComputedStyle(target).opacity === "1"))).toBe(true);
});

test("keeps content and consultation link usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "상담 요청서 작성" }).first()).toBeVisible();
  expect(await page.locator("[data-reveal]").evaluateAll((targets) => targets.every((target) => getComputedStyle(target).opacity === "1"))).toBe(true);
  await context.close();
});

test("reveals a direct hash destination and remains stable after rotation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#principles");
  await expect(page.locator('[data-reveal-key="principles-heading"]')).toHaveAttribute("data-revealed", "true");
  await page.setViewportSize({ width: 844, height: 390 });
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  await expect(page.locator('[data-reveal-key="principles-heading"]')).toHaveAttribute("data-revealed", "true");
});

test("never moves keyboard focus into invisible content", async ({ page }) => {
  await page.goto("/");
  for (let press = 0; press < 24; press += 1) {
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return true;
      const target = active.closest<HTMLElement>("[data-reveal]");
      return target === null || getComputedStyle(target).opacity === "1";
    });
    expect(visible).toBe(true);
  }
});

test("stays inside local lab performance budgets", async ({ page }) => {
  await page.addInitScript(() => {
    const metrics = { cls: 0, lcp: 0 };
    Object.defineProperty(window, "__motionMetrics", { value: metrics, configurable: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "layout-shift" && !(entry as PerformanceEntry & { hadRecentInput: boolean }).hadRecentInput) {
          metrics.cls += (entry as PerformanceEntry & { value: number }).value;
        }
        if (entry.entryType === "largest-contentful-paint") metrics.lcp = entry.startTime;
      }
    }).observe({ entryTypes: ["layout-shift", "largest-contentful-paint"] });
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(800);
  const metrics = await page.evaluate(() => (window as Window & { __motionMetrics: { cls: number; lcp: number } }).__motionMetrics);
  expect(metrics.cls).toBeLessThanOrEqual(0.1);
  expect(metrics.lcp).toBeGreaterThan(0);
  expect(metrics.lcp).toBeLessThanOrEqual(2500);
});

test("keeps the representative photo motion LCP regression within 100ms", async ({ browser }) => {
  const measure = async (reducedMotion: "reduce" | "no-preference") => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(() => {
      Object.defineProperty(window, "__lcp", { value: { time: 0 }, configurable: true });
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries.at(-1);
        if (latest) (window as Window & { __lcp: { time: number } }).__lcp.time = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const value = await page.evaluate(() => (window as Window & { __lcp: { time: number } }).__lcp.time);
    await context.close();
    return value;
  };
  const normal: number[] = [];
  const reduced: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    normal.push(await measure("no-preference"));
    reduced.push(await measure("reduce"));
  }
  const median = (values: number[]) => [...values].sort((left, right) => left - right)[1];
  expect(median(normal) - median(reduced)).toBeLessThanOrEqual(100);
});
```

- [ ] **Step 3: 통합 회귀 검사를 실행한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' run test:e2e
```

Expected: 앞선 단위 테스트와 정적 계약으로 구현한 동작이 실제 Chromium에서도 모두 PASS한다.

- [ ] **Step 4: 실패가 있으면 원인을 분리해 해당 계약만 수정한다**

수정 전 `superpowers:systematic-debugging`을 사용한다. 실패 분류는 `reveal-controller.ts` 상태 복구, `styles.css` reduced-motion, `index.html` 8개 대상, 반응형 가로 넘침의 네 범주로 제한한다. 원인을 확인한 뒤 한 범주만 수정하고 해당 테스트를 다시 실행한다.

- [ ] **Step 5: 단위·E2E·빌드를 모두 통과시킨다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test
npm --prefix 'prototypes/homepage-motion' run test:e2e
npm --prefix 'prototypes/homepage-motion' run build
```

Expected: Vitest 0 failures, Playwright 0 failures, build exit code 0.

- [ ] **Step 6: 브라우저 회귀 검사를 커밋한다**

```powershell
git add prototypes/homepage-motion
git commit -m "test: verify homepage scroll motion behavior"
```

---

### Task 6: 시각 산출물·사용 안내·최종 검증

**Files:**
- Create: `prototypes/homepage-motion/scripts/capture-motion.mjs`
- Create: `prototypes/homepage-motion/README.md`
- Modify: `AGENT.md`
- Modify: `work-log.md`
- Generate, do not commit: `.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-desktop.png`
- Generate, do not commit: `.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-mobile.png`
- Generate, do not commit: `.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-scroll.webm`

**Interfaces:**
- Consumes: 성공한 Vite production build
- Produces: 사용자에게 전달할 HTML 실행 방법, PNG 2개, WebM 1개, 검증 요약

- [ ] **Step 1: 자동 캡처 스크립트를 작성한다**

`capture-motion.mjs`를 다음 코드로 작성한다.

```js
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const renderDir = resolve(workspaceRoot, ".superpowers/brainstorm/renders");
const desktopPng = resolve(renderDir, "h1-recommended-hybrid-motion-desktop.png");
const mobilePng = resolve(renderDir, "h1-recommended-hybrid-motion-mobile.png");
const scrollVideo = resolve(renderDir, "h1-recommended-hybrid-motion-scroll.webm");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const url = "http://127.0.0.1:4173";

await mkdir(renderDir, { recursive: true });

const server = spawn(npmCommand, ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4173"], {
  cwd: prototypeRoot,
  stdio: "ignore",
  windowsHide: true,
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Vite preview did not become ready");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(url, { waitUntil: "networkidle" });
  await desktopPage.screenshot({ path: desktopPng, fullPage: false });
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 1600 },
    recordVideo: { dir: renderDir, size: { width: 390, height: 1600 } },
  });
  const mobilePage = await mobile.newPage();
  const video = mobilePage.video();
  await mobilePage.goto(url, { waitUntil: "networkidle" });
  await mobilePage.screenshot({ path: mobilePng, fullPage: false });
  const scrollHeight = await mobilePage.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= scrollHeight; y += 600) {
    await mobilePage.evaluate((nextY) => window.scrollTo({ top: nextY, behavior: "smooth" }), y);
    await mobilePage.waitForTimeout(450);
  }
  await mobile.close();
  if (video) await video.saveAs(scrollVideo);
} finally {
  await browser?.close();
  server.kill();
}
```

- [ ] **Step 2: 실행 안내를 작성한다**

`README.md`에 다음 명령과 주의사항을 명시한다.

```powershell
npm install
npm run dev -- --host 0.0.0.0
npm test
npm run test:e2e
npm run build
npm run capture
```

브로슈어 사진은 시안용 저해상도 크롭이며 운영 배포 전 고해상도 상반신 원본으로 교체해야 한다. 운영본에서는 정적 파일을 AVIF·WebP·JPEG로 변환하고 고정 `width`·`height`를 유지한다.

- [ ] **Step 3: 샘플 산출물을 생성한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' run capture
```

Expected: 세 출력 파일이 생성되고 각 파일 크기가 10KB보다 크다.

- [ ] **Step 4: 최종 검증 명령을 실행한다**

Run:

```powershell
npm --prefix 'prototypes/homepage-motion' test
npm --prefix 'prototypes/homepage-motion' run test:e2e
npm --prefix 'prototypes/homepage-motion' run build
git diff --check
Get-Item '.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-desktop.png','.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-mobile.png','.superpowers/brainstorm/renders/h1-recommended-hybrid-motion-scroll.webm' | Select-Object Name,Length
```

Expected: 모든 테스트 0 failures, build 성공, `git diff --check` 실제 오류 0건, 세 파일 모두 10KB 초과.

- [ ] **Step 5: 작업 기록과 사용 안내를 커밋한다**

`AGENT.md`와 `work-log.md`에는 구현 태스크별 커밋, 최종 테스트 수, 렌더 크기, 남은 고해상도 사진 교체 작업만 기록한다.

```powershell
git add prototypes/homepage-motion AGENT.md work-log.md
git commit -m "docs: add motion sample usage and verification"
```

## Spec Coverage Map

| 설계 요구 | 구현 태스크 |
|---|---|
| Tailwind v4 로컬 빌드·CDN 미사용 | Task 1, Task 4 |
| 모션 대상 8개·상호작용 요소 즉시 표시 | Task 4 |
| 최초 1회 단방향 상태 | Task 2, Task 5 |
| reduced-motion 첫 프레임 최종 상태 | Task 3, Task 4, Task 5 |
| Observer 미지원·초기화 예외 복구 | Task 3, Task 5 |
| 포커스·해시·BFCache·화면 회전 | Task 3, Task 5 |
| 320~1440px 가로 넘침 없음 | Task 5 |
| 대표 사진 고정 영역·모션 예산 | Task 4 |
| CLS 0.1 이하·로컬 LCP 2.5초 이하·사진 모션 회귀 100ms 이하 | Task 5 |
| 직접 확인 가능한 PNG·스크롤 영상 | Task 6 |
| 실행 안내와 고해상도 사진 교체 고지 | Task 6 |
