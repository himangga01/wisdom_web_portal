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
});

test("keeps native choice inputs visually hidden for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const inputs = page.locator('.finder-panel > input[type="radio"]');
  await expect(inputs).toHaveCount(4);
  const states = await inputs.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      opacity: style.opacity,
      width: rect.width,
      height: rect.height,
    };
  }));

  expect(states.every(({ opacity, width, height }) => (
    opacity === "0" && width <= 1 && height <= 1
  ))).toBe(true);
});

test("keeps cta hover feedback stationary for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const primary = page.locator(".primary").first();
  const primaryBackground = await primary.evaluate((element) => getComputedStyle(element).backgroundColor);
  await primary.hover();
  await expect.poll(() => primary.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  expect(await primary.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(primaryBackground);

  const headerCta = page.locator(".header-cta");
  await headerCta.hover();
  await expect.poll(() => headerCta.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
});

test("uses contrasting focus outlines on dark brown surfaces", async ({ page }) => {
  await page.goto("/");

  const focusState = async (selector: string, surfaceSelector: string) => {
    const target = page.locator(selector);
    await target.focus();
    await expect(target).toBeFocused();
    return target.evaluate((element, closestSurface) => {
      const parseRgb = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      const luminance = (color: string) => {
        const channels = parseRgb(color).map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const style = getComputedStyle(element);
      const surface = element.closest(closestSurface);
      if (!(surface instanceof HTMLElement)) throw new Error(`Missing focus surface: ${closestSurface}`);
      const outlineLuminance = luminance(style.outlineColor);
      const surfaceLuminance = luminance(getComputedStyle(surface).backgroundColor);
      return {
        matchesFocusVisible: element.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        contrast: (Math.max(outlineLuminance, surfaceLuminance) + 0.05)
          / (Math.min(outlineLuminance, surfaceLuminance) + 0.05),
      };
    }, surfaceSelector);
  };

  const featured = await focusState('.article-card.featured a', ".article-card.featured");
  expect(featured).toMatchObject({
    matchesFocusVisible: true,
    outlineStyle: "solid",
    outlineWidth: "2px",
  });
  expect(featured.contrast).toBeGreaterThanOrEqual(3);

  const footer = await focusState('footer a[href="#privacy"]', "footer");
  expect(footer).toMatchObject({
    matchesFocusVisible: true,
    outlineStyle: "solid",
    outlineWidth: "2px",
  });
  expect(footer.contrast).toBeGreaterThanOrEqual(3);
});

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
