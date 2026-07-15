import AxeBuilder from "@axe-core/playwright";
import { consultationRequestSchema } from "@wisdom/shared";
import { expect, test } from "@playwright/test";

import { PUBLIC_ROUTE_ENTRIES } from "../src/lib/routes.js";
import { siteContent } from "../src/content/site-content.js";

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
  await expect(form.locator('[name="phone"]')).toHaveAttribute("maxlength", "20");
  await expect(form.locator('[name="privacyConsent"]')).toBeChecked({ checked: false });
  await expect(form.locator('[name="privacyConsent"]')).toHaveAttribute("required", "");
  await expect(form.locator('[name="marketingConsent"]')).not.toBeChecked();
  await expect(form.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText(/Do not enter resident, passport/)).toBeVisible();
  await expect(page.getByText(/success/i)).toHaveCount(0);
});

test("submits schema-valid JSON with unchecked marketing and renders a validated receipt", async ({ page }) => {
  let capturedBody: unknown;
  let capturedHeaders: Record<string, string> = {};
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locale: "en",
        documents: {
          privacy: { version: "privacy-2026-07-16" },
          marketing: { version: "marketing-2026-07-16" },
        },
        formToken: "signed-form-token-en",
      }),
    });
  });
  await page.route("**/api/v1/consultations", async (route) => {
    capturedBody = route.request().postDataJSON();
    capturedHeaders = route.request().headers();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "2026-07-16T02:00:00.000Z",
        status: "received",
      }),
    });
  });
  await page.goto("/en/consultation");
  await page.selectOption('[name="category"]', "procurement");
  await page.fill('[name="name"]', "Hong Gildong");
  await page.fill('[name="phone"]', "+82 (10) 1234-5678");
  await page.fill('[name="company"]', "Wisdom Co.");
  await page.fill('[name="message"]', "Please review our public procurement registration plan.");
  await page.check('[name="privacyConsent"]');
  await page.getByRole("button", { name: "Send consultation request" }).click();

  await expect(page.locator("[data-form-status]")).toContainText("receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ");
  expect(capturedHeaders["content-type"]).toContain("application/json");
  expect(capturedHeaders["idempotency-key"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const envelope = capturedBody as {
    consultation: unknown;
    antiAbuse: { formToken: string; website: string };
  };
  expect(consultationRequestSchema.parse(envelope.consultation)).toMatchObject({
    phone: "+821012345678",
    privacyConsent: { version: "privacy-2026-07-16", accepted: true },
    marketingConsent: { version: "marketing-2026-07-16", accepted: false },
  });
  expect(envelope.antiAbuse).toEqual({ formToken: "signed-form-token-en", website: "" });
});

test("reuses an idempotency key for retries and rotates it when the submission changes", async ({ page }) => {
  const idempotencyKeys: string[] = [];
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locale: "en",
        documents: {
          privacy: { version: "privacy-2026-07-16" },
          marketing: { version: "marketing-2026-07-16" },
        },
        formToken: "signed-form-token-en",
      }),
    });
  });
  await page.route("**/api/v1/consultations", async (route) => {
    idempotencyKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (idempotencyKeys.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "TEMPORARILY_UNAVAILABLE",
          message: "Unavailable",
          requestId: "request_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "2026-07-16T02:00:00.000Z",
        status: "received",
      }),
    });
  });

  await page.goto("/en/consultation");
  await page.selectOption('[name="category"]', "procurement");
  await page.fill('[name="name"]', "Hong Gildong");
  await page.fill('[name="phone"]', "+82 (10) 1234-5678");
  await page.fill('[name="company"]', "Wisdom Co.");
  await page.fill('[name="message"]', "Please review our public procurement registration plan.");
  await page.check('[name="privacyConsent"]');
  const submit = page.getByRole("button", { name: "Send consultation request" });

  await submit.click();
  await expect(page.locator("[data-form-status]")).toHaveAttribute("role", "alert");
  await submit.click();
  await expect(page.locator("[data-form-status]")).toContainText("receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ");
  expect(idempotencyKeys[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);

  await page.fill(
    '[name="message"]',
    "Please review our updated public procurement registration plan.",
  );
  await submit.click();
  await expect.poll(() => idempotencyKeys.length).toBe(3);
  expect(idempotencyKeys[2]).not.toBe(idempotencyKeys[1]);
});

test("keeps the submitted locale and consent bundle atomic during a delayed locale change", async ({ page }) => {
  let releaseEnglishConsent!: () => void;
  let markEnglishConsentStarted!: () => void;
  const englishConsentStarted = new Promise<void>((resolve) => {
    markEnglishConsentStarted = resolve;
  });
  const englishConsentRelease = new Promise<void>((resolve) => {
    releaseEnglishConsent = resolve;
  });
  let capturedBody: unknown;

  await page.route("**/api/v1/consent-documents**", async (route) => {
    const locale = new URL(route.request().url()).searchParams.get("locale");
    if (locale === "en") {
      markEnglishConsentStarted();
      await englishConsentRelease;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locale,
        documents: {
          privacy: { version: `privacy-${locale}-2026-07-16` },
          marketing: { version: `marketing-${locale}-2026-07-16` },
        },
        formToken: `signed-form-token-${locale}`,
      }),
    });
  });
  await page.route("**/api/v1/consultations", async (route) => {
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "2026-07-16T02:00:00.000Z",
        status: "received",
      }),
    });
  });

  await page.goto("/en/consultation");
  await englishConsentStarted;
  await page.selectOption('[name="category"]', "procurement");
  await page.fill('[name="name"]', "Hong Gildong");
  await page.fill('[name="phone"]', "+82 (10) 1234-5678");
  await page.fill('[name="message"]', "Please review our public procurement registration plan.");
  await page.check('[name="privacyConsent"]');
  const submit = page.locator('button[type="submit"]');

  await submit.click();
  await expect(submit).toBeDisabled();
  await page.selectOption('[name="locale"]', "zh-Hans");
  releaseEnglishConsent();

  await expect(page.locator("[data-form-status]"))
    .toContainText("receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ");
  const envelope = capturedBody as {
    consultation: {
      locale: string;
      privacyConsent: { version: string };
      marketingConsent: { version: string };
    };
    antiAbuse: { formToken: string };
  };
  expect(envelope.consultation).toMatchObject({
    locale: "en",
    privacyConsent: { version: "privacy-en-2026-07-16" },
    marketingConsent: { version: "marketing-en-2026-07-16" },
  });
  expect(envelope.antiAbuse.formToken).toBe("signed-form-token-en");
});

test("submits checked marketing consent and shows localized API failure", async ({ page }) => {
  let capturedBody: unknown;
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locale: "zh-Hans",
        documents: {
          privacy: { version: "privacy-zh-2026-07-16" },
          marketing: { version: "marketing-zh-2026-07-16" },
        },
        formToken: "signed-form-token-zh-hans",
      }),
    });
  });
  await page.route("**/api/v1/consultations", async (route) => {
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "TEMPORARILY_UNAVAILABLE",
        message: "Unavailable",
        requestId: "request_01JZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    });
  });
  await page.goto("/zh-hans/consultation");
  await page.selectOption('[name="category"]', "other");
  await page.fill('[name="name"]', "张三");
  await page.fill('[name="phone"]', "01012345678");
  await page.fill('[name="email"]', "client@example.com");
  await page.fill('[name="message"]', "请协助审查目前需要办理的行政程序和所需资料。");
  await page.check('[name="privacyConsent"]');
  await page.check('[name="marketingConsent"]');
  await page.getByRole("button", { name: "提交咨询申请" }).click();

  await expect(page.locator("[data-form-status]")).toHaveAttribute("role", "alert");
  await expect(page.locator("[data-form-status]")).toContainText("暂时无法提交咨询申请");
  const envelope = capturedBody as {
    consultation: unknown;
    antiAbuse: { formToken: string; website: string };
  };
  expect(consultationRequestSchema.parse(envelope.consultation)).toMatchObject({
    email: "client@example.com",
    marketingConsent: { version: "marketing-zh-2026-07-16", accepted: true },
  });
  expect(envelope.antiAbuse).toEqual({
    formToken: "signed-form-token-zh-hans",
    website: "",
  });
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

test("localizes direct locale-prefixed misses while preserving HTTP 404", async ({ page, request }) => {
  for (const { pathname, locale } of [
    { pathname: "/en/missing-public-route", locale: "en" as const },
    { pathname: "/zh-hant/missing-public-route", locale: "zh-Hant" as const },
  ]) {
    const response = await page.goto(pathname);
    expect(response?.status(), pathname).toBe(404);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(siteContent[locale].headings.notFound);
    await expect(page.getByRole("link", { name: siteContent[locale].buttons.backHome })).toHaveAttribute(
      "href",
      locale === "en" ? "/en" : "/zh-hant",
    );
  }

  expect((await request.get("/en/404")).status()).toBe(200);
});

test("keeps the Korean 404 fallback when JavaScript is disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto("http://127.0.0.1:4321/en/missing-without-javascript");

  expect(response?.status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(siteContent.ko.headings.notFound);
  await context.close();
});
