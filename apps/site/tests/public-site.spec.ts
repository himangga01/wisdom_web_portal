import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { PUBLIC_ROUTE_ENTRIES } from "../src/lib/routes.js";

function physicalViewportSize(browserName: string, width: number, height: number) {
  const windowsWebKitScale = browserName === "webkit" && process.platform === "win32" ? 1.25 : 1;
  return {
    width: Math.floor(width * windowsWebKitScale),
    height: Math.floor(height * windowsWebKitScale),
  };
}

test("serves all sixty-four localized public routes", async ({ request }) => {
  for (const { pathname } of PUBLIC_ROUTE_ENTRIES) {
    const response = await request.get(pathname);
    expect([200, 404], `${pathname} response`).toContain(response.status());
    expect(await response.text(), `${pathname} document`).toContain("<!DOCTYPE html>");
  }
});

test("renders semantic navigation and real language alternatives", async ({ browserName, page }) => {
  await page.setViewportSize(physicalViewportSize(browserName, 1440, 900));
  await page.goto("/en/services/procurement");

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(page.getByRole("link", { name: "한국어" })).toHaveAttribute(
    "href",
    "/services/procurement",
  );
  await expect(page.getByRole("link", { name: "简体中文" })).toHaveAttribute(
    "href",
    "/zh-hans/services/procurement",
  );
  await expect(page.getByText("Direct production certificate", { exact: true })).toBeVisible();
});

test("applies the exact C1 reveal contract once", async ({ page }) => {
  await page.addInitScript(() => {
    const observed = new Set<Element>();
    const everObserved = new Set<Element>();
    const revealCounts: Record<string, number> = {};
    let callback: IntersectionObserverCallback | undefined;
    let callbackCount = 0;
    let observer: IntersectionObserver | undefined;

    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        const key = target.dataset.revealKey;
        if (key && target.dataset.revealed === "true") {
          revealCounts[key] = (revealCounts[key] ?? 0) + 1;
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-revealed"] });

    class ControlledObserver {
      constructor(nextCallback: IntersectionObserverCallback) {
        callback = nextCallback;
        observer = this as unknown as IntersectionObserver;
      }

      observe(target: Element) {
        observed.add(target);
        everObserved.add(target);
      }

      unobserve(target: Element) {
        observed.delete(target);
      }

      disconnect() {
        observed.clear();
      }
    }

    Object.defineProperty(window, "__c1Observer", {
      configurable: true,
      value: {
        trigger() {
          callbackCount += 1;
          callback?.(
            Array.from(everObserved, (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry),
            observer!,
          );
        },
        snapshot() {
          return {
            callbackCount,
            observedCount: observed.size,
            everObservedCount: everObserved.size,
            revealCounts: { ...revealCounts },
          };
        },
      },
    });
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: ControlledObserver,
    });
  });
  await page.goto("/en");

  const targets = page.locator("[data-reveal]");
  await expect(targets).toHaveCount(18);
  await expect(page.locator("html")).toHaveClass(/motion-enabled/);
  await expect.poll(() => page.evaluate(() => (
    window as unknown as Window & {
      __c1Observer: { snapshot(): { everObservedCount: number } };
    }
  ).__c1Observer.snapshot().everObservedCount)).toBe(18);

  const initial = await targets.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      key: (element as HTMLElement).dataset.revealKey,
      revealed: (element as HTMLElement).dataset.revealed,
      direction: (element as HTMLElement).dataset.revealDirection,
      delay: style.transitionDelay.split(",")[0],
      duration: style.transitionDuration.split(",")[0],
      translate: style.translate,
    };
  }));
  expect(initial).toHaveLength(18);
  expect(new Set(initial.map(({ key }) => key)).size).toBe(18);
  expect(initial.every(({ revealed }) => revealed === "false")).toBe(true);
  expect(initial.every(({ duration }) => duration === "0.5s")).toBe(true);
  expect(new Set(initial.map(({ delay }) => delay))).toEqual(new Set(["0s", "0.06s", "0.12s"]));
  expect(initial.every(({ direction, translate }) => (
    direction === "left" ? translate === "-64px"
      : direction === "right" ? translate === "64px"
        : translate === "none"
  )), JSON.stringify(initial)).toBe(true);

  const controlledObserver = () => page.evaluate(() => (
    window as unknown as Window & {
      __c1Observer: {
        trigger(): void;
        snapshot(): {
          callbackCount: number;
          observedCount: number;
          revealCounts: Record<string, number>;
        };
      };
    }
  ).__c1Observer.snapshot());
  await page.evaluate(() => (
    window as unknown as Window & { __c1Observer: { trigger(): void } }
  ).__c1Observer.trigger());
  await expect.poll(() => targets.evaluateAll((elements) => elements.every((element) => {
    const style = getComputedStyle(element);
    return (element as HTMLElement).dataset.revealed === "true"
      && style.opacity === "1"
      && style.translate === "none";
  }))).toBe(true);
  await expect.poll(async () => Object.values((await controlledObserver()).revealCounts)).toEqual(
    Array.from({ length: 18 }, () => 1),
  );

  await page.evaluate(() => (
    window as unknown as Window & { __c1Observer: { trigger(): void } }
  ).__c1Observer.trigger());
  expect(await controlledObserver()).toMatchObject({
    callbackCount: 2,
    observedCount: 0,
    revealCounts: Object.fromEntries(initial.map(({ key }) => [key, 1])),
  });
});

test("falls back to visible content for reduced motion and observer failures", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((elements) =>
    elements.every((element) => getComputedStyle(element).opacity === "1"),
  )).toBe(true);

  await page.addInitScript(() => Object.defineProperty(window, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor() {
        throw new Error("forced observer failure");
      }
    },
  }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/motion-enabled/);
  expect(await page.locator("[data-reveal]").evaluateAll((elements) =>
    elements.every((element) => getComputedStyle(element).opacity === "1"),
  )).toBe(true);
});

test("keeps home content and navigation usable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4321/");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "상담 신청" }).first()).toBeVisible();
  expect(await page.locator("[data-reveal]").evaluateAll((elements) =>
    elements.every((element) => getComputedStyle(element).opacity === "1"),
  )).toBe(true);
  await context.close();
});

for (const width of [320, 390, 768, 1440]) {
  test(`has no horizontal overflow at ${width}px`, async ({ browserName, page }) => {
    await page.setViewportSize(physicalViewportSize(browserName, width, 900));
    await page.goto("/");
    expect(await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))).toEqual({ clientWidth: width, scrollWidth: width });
  });
}

test("renders native consultation constraints and never fakes success", async ({ page }) => {
  await page.goto("/en/consultation");
  const form = page.locator('form[action="/api/v1/consultations"]');

  await expect(form).toHaveAttribute("method", "post");
  await expect(form.locator('[name="message"]')).toHaveAttribute("minlength", "20");
  await expect(form.locator('[name="message"]')).toHaveAttribute("maxlength", "2000");
  await expect(form.locator('[name="privacyConsent"]')).toBeChecked({ checked: false });
  await expect(form.locator('[name="privacyConsent"]')).toHaveAttribute("required", "");
  await expect(form.locator('[name="marketingConsent"]')).not.toBeChecked();
  await expect(form.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText(/Do not enter resident, passport/)).toBeVisible();
  await expect(page.getByText(/success/i)).toHaveCount(0);
});

for (const path of ["/", "/consultation"]) {
  test(`has no serious accessibility violations on ${path}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious"))
      .toEqual([]);
  });
}

test("returns a real localized 404 document", async ({ page }) => {
  const response = await page.goto("/missing-public-route");
  expect(response?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
