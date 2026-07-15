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
  await expect(targets).toHaveCount(18);
  for (let index = 0; index < await targets.count(); index += 1) {
    await targets.nth(index).scrollIntoViewIfNeeded();
    await expect(targets.nth(index)).toHaveAttribute("data-revealed", "true");
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  const counts = await page.evaluate(() => (window as unknown as Window & {
    __revealCounts: Record<string, number>;
  }).__revealCounts);
  expect(Object.keys(counts)).toHaveLength(18);
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

  const heading = page.locator('[data-reveal-key="principles-heading"]');
  await expect.poll(() => heading.evaluate((target) => {
    const style = getComputedStyle(target);
    return {
      opacity: style.opacity,
      filter: style.filter,
      duration: style.transitionDuration,
    };
  })).toEqual({
    opacity: "0.12",
    filter: "blur(6px)",
    duration: "0.9s",
  });

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

  const delays = await page.locator("#practice .practice-card > :first-child").evaluateAll((contents) =>
    contents.map((content) => getComputedStyle(content).transitionDelay),
  );
  expect(delays).toEqual(["0s", "0.1s", "0.2s"]);

  const progress = await page.locator(".scroll-progress").evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, height: style.height };
  });
  expect(progress).toEqual({ position: "fixed", height: "2px" });
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

test("keeps content visible when IntersectionObserver is missing", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    value: undefined,
    configurable: true,
  }));
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((targets) => targets.every((target) => getComputedStyle(target).opacity === "1"))).toBe(true);
});

test("recovers when observer construction throws", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor() {
        throw new Error("forced initialization failure");
      }
    },
  }));
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((targets) => targets.every((target) => getComputedStyle(target).opacity === "1"))).toBe(true);
});

test("keeps content and consultation link usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
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
  const metrics = await page.evaluate(() => (window as unknown as Window & {
    __motionMetrics: { cls: number; lcp: number };
  }).__motionMetrics);
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
        if (latest) (window as unknown as Window & { __lcp: { time: number } }).__lcp.time = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const value = await page.evaluate(() => (window as unknown as Window & { __lcp: { time: number } }).__lcp.time);
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
