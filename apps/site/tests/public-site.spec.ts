import AxeBuilder from "@axe-core/playwright";
import { consultationRequestSchema } from "@wisdom/shared";
import { expect, test } from "@playwright/test";

import { PUBLIC_ROUTE_ENTRIES } from "../src/lib/routes.js";
import { siteContent } from "../src/content/site-content.js";

const publicOrigin = "https://www.jihye-office.kr";

function consentResponse(locale: string, versionDate = "2026-07-16") {
  const document = (kind: "privacy" | "marketing") => ({
    version: `${kind}-${locale}-${versionDate}`,
    title: `${kind === "privacy" ? "Privacy collection" : "Marketing communications"} (${locale})`,
    bodyMarkdown: `${kind === "privacy" ? "Required consultation privacy terms" : "Optional marketing terms"} for ${locale}.`,
    contentSha256: (kind === "privacy" ? "a" : "b").repeat(64),
    effectiveAt: `${versionDate}T00:00:00.000Z`,
    retentionMonths: kind === "privacy" ? 12 : 24,
    required: kind === "privacy",
  });
  return {
    locale,
    documents: { privacy: document("privacy"), marketing: document("marketing") },
    formToken: `signed-form-token-${locale.toLowerCase()}`,
  };
}

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

test("renders the intentional brand illustration and sealed policy documents", async ({ page }) => {
  await page.goto("/en");
  const illustration = page.locator('.brand-illustration[role="img"]');
  await expect(illustration).toHaveAttribute(
    "aria-label",
    "Bronze, sand, and ivory geometric brand illustration",
  );
  await expect(page.locator("picture[data-asset-slot], .portrait-asset-slot")).toHaveCount(0);

  await page.goto("/en/privacy");
  const privacy = page.locator('article[data-consent-kind="privacy"]');
  await expect(privacy).toHaveAttribute(
    "data-consent-sha256",
    "24d8249c198ed4a94e556243dd251630ae693f7608c1b83be2059b23324fc3c0",
  );
  await expect(privacy).toHaveAttribute("data-consent-version", "privacy-2026-07-16");
  await expect(privacy).toHaveAttribute("data-consent-effective-at", "2026-07-16T00:00:00.000Z");
  await expect(privacy).toHaveAttribute("data-consent-retention-months", "12");
  await expect(privacy.locator("pre")).toHaveText(
    '<script>alert("text only")</script>\n\nExact privacy terms.',
  );
  await expect(privacy.locator("script")).toHaveCount(0);

  await page.goto("/en/marketing/withdraw");
  const marketing = page.locator('article[data-consent-kind="marketing"]');
  await expect(marketing).toHaveAttribute(
    "data-consent-sha256",
    "9cc4da2279cc53a7cb8c40e2f1ee945aa3f2f2546ad1a7904772843579864940",
  );
  await expect(marketing).toHaveAttribute("data-consent-version", "marketing-2026-07-16");
  await expect(marketing).toHaveAttribute("data-consent-effective-at", "2026-07-16T00:00:00.000Z");
  await expect(marketing).toHaveAttribute("data-consent-retention-months", "24");
  await expect(marketing).toContainText("one-time withdrawal link");
  await expect(marketing).toContainText("support channels; they do not withdraw consent by themselves");
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
  await expect(form.locator('[name="phone"]')).toHaveAttribute("maxlength", "40");
  await expect(form.locator('[name="privacyConsent"]')).toBeChecked({ checked: false });
  await expect(form.locator('[name="privacyConsent"]')).toHaveAttribute("required", "");
  await expect(form.locator('[name="marketingConsent"]')).not.toBeChecked();
  await expect(form.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByText(/Do not enter resident, passport/)).toBeVisible();
  await expect(page.getByText(/success/i)).toHaveCount(0);
});

test("matches native phone validity to the shared eight-to-twenty digit contract", async ({ page }) => {
  await page.goto("/en/consultation");
  const phone = page.locator('[name="phone"]');
  const cases = [
    { value: "--------", valid: false },
    { value: "02-123-456", valid: true },
    { value: "+12 (345) 6789-0123-4567-890", valid: true },
    { value: "1234567", valid: false },
    { value: "123456789012345678901", valid: false },
  ] as const;

  for (const { value, valid } of cases) {
    await phone.fill(value);
    expect(await phone.inputValue(), value).toBe(value);
    expect(await phone.evaluate((control: HTMLInputElement) => control.checkValidity()), value)
      .toBe(valid);
  }
});

test("submits schema-valid JSON with unchecked marketing and renders a validated receipt", async ({ page }) => {
  let capturedBody: unknown;
  let capturedHeaders: Record<string, string> = {};
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(consentResponse("en")),
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
  await expect(page.locator('[data-consent-document="privacy"] summary'))
    .toHaveText("Privacy collection (en)");
  await expect(page.locator('[data-consent-document="privacy"] [data-consent-version]'))
    .toHaveText("privacy-en-2026-07-16");
  await page.locator('[data-consent-document="privacy"] summary').click();
  await expect(page.getByText("Required consultation privacy terms for en.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send consultation request" })).toBeEnabled();
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
    privacyConsent: { version: "privacy-en-2026-07-16", accepted: true },
    marketingConsent: { version: "marketing-en-2026-07-16", accepted: false },
  });
  expect(envelope.antiAbuse).toEqual({ formToken: "signed-form-token-en", website: "" });
});

test("reloads stale consent, clears choices, and requires a fresh explicit agreement", async ({ page }) => {
  let consentLoads = 0;
  let submissions = 0;
  await page.route("**/api/v1/consent-documents**", async (route) => {
    consentLoads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(consentResponse("en", consentLoads === 1 ? "2026-07-16" : "2026-07-17")),
    });
  });
  await page.route("**/api/v1/consultations", async (route) => {
    submissions += 1;
    if (submissions === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "CONSENT_VERSION_STALE",
          message: "Consent version changed",
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
        receivedAt: "2026-07-17T02:00:00.000Z",
        status: "received",
      }),
    });
  });

  await page.goto("/en/consultation");
  await page.selectOption('[name="category"]', "procurement");
  await page.fill('[name="name"]', "Hong Gildong");
  await page.fill('[name="phone"]', "+82 (10) 1234-5678");
  await page.fill('[name="message"]', "Please review our public procurement registration plan.");
  await page.check('[name="privacyConsent"]');
  const submit = page.getByRole("button", { name: "Send consultation request" });
  await submit.click();

  await expect(page.locator("[data-form-status]")).toContainText("consent documents changed");
  await expect(page.locator('[name="privacyConsent"]')).not.toBeChecked();
  await expect(page.locator('[name="marketingConsent"]')).not.toBeChecked();
  await expect(page.locator('[data-consent-document="privacy"] [data-consent-version]'))
    .toHaveText("privacy-en-2026-07-17");
  expect(submissions).toBe(1);

  await page.check('[name="privacyConsent"]');
  await submit.click();
  await expect(page.locator("[data-form-status]")).toContainText("receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ");
  expect(submissions).toBe(2);
});

test("reuses an idempotency key for retries and rotates it when the submission changes", async ({ page }) => {
  const idempotencyKeys: string[] = [];
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(consentResponse("en")),
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

test("clears consent and blocks submission until the changed locale bundle is visible", async ({ page }) => {
  let releaseChineseConsent!: () => void;
  let markChineseConsentStarted!: () => void;
  const chineseConsentStarted = new Promise<void>((resolve) => {
    markChineseConsentStarted = resolve;
  });
  const chineseConsentRelease = new Promise<void>((resolve) => {
    releaseChineseConsent = resolve;
  });
  let capturedBody: unknown;

  await page.route("**/api/v1/consent-documents**", async (route) => {
    const locale = new URL(route.request().url()).searchParams.get("locale");
    if (locale === "zh-Hans") {
      markChineseConsentStarted();
      await chineseConsentRelease;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(consentResponse(locale ?? "en")),
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
  await expect(page.locator('[name="privacyConsent"]')).toBeEnabled();
  await page.selectOption('[name="category"]', "procurement");
  await page.fill('[name="name"]', "Hong Gildong");
  await page.fill('[name="phone"]', "+82 (10) 1234-5678");
  await page.fill('[name="message"]', "Please review our public procurement registration plan.");
  await page.check('[name="privacyConsent"]');
  const submit = page.locator('button[type="submit"]');

  await page.selectOption('[name="locale"]', "zh-Hans");
  await chineseConsentStarted;
  await expect(page.locator('[name="privacyConsent"]')).not.toBeChecked();
  await expect(page.locator('[name="privacyConsent"]')).toBeDisabled();
  await expect(submit).toBeDisabled();
  expect(capturedBody).toBeUndefined();
  releaseChineseConsent();

  await expect(page.locator('[name="privacyConsent"]')).toBeEnabled();
  await expect(page.locator('[data-consent-document="privacy"] [data-consent-version]'))
    .toHaveText("privacy-zh-Hans-2026-07-16");
  await page.check('[name="privacyConsent"]');
  await submit.click();

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
    locale: "zh-Hans",
    privacyConsent: { version: "privacy-zh-Hans-2026-07-16" },
    marketingConsent: { version: "marketing-zh-Hans-2026-07-16" },
  });
  expect(envelope.antiAbuse.formToken).toBe("signed-form-token-zh-hans");
});

test("submits checked marketing consent and shows localized API failure", async ({ page }) => {
  let capturedBody: unknown;
  await page.route("**/api/v1/consent-documents**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(consentResponse("zh-Hans")),
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
    marketingConsent: { version: "marketing-zh-Hans-2026-07-16", accepted: true },
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

test("serves the locale-specific 404 document when JavaScript is disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto("http://127.0.0.1:4321/en/404");

  expect(response?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(siteContent.en.headings.notFound);
  await context.close();
});

test("replaces the unusable no-JavaScript consultation form with direct contact links", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4321/en/consultation");

  await expect(page.locator("[data-consultation-form] .form-grid")).toBeHidden();
  await expect(page.locator("[data-consultation-form] .form-submit")).toBeHidden();
  await expect(page.locator('.no-script-note a[href^="tel:"]')).toBeVisible();
  await expect(page.locator('.no-script-note a[href^="mailto:"]')).toBeVisible();
  await context.close();
});

test.describe("search discovery surface", () => {
  test("emits one self-canonical and a reciprocal absolute locale graph", async ({ page }) => {
    const expected = [
      `${publicOrigin}/services/procurement`,
      `${publicOrigin}/en/services/procurement`,
      `${publicOrigin}/zh-hans/services/procurement`,
      `${publicOrigin}/zh-hant/services/procurement`,
    ];
    for (const pathname of [
      "/services/procurement",
      "/en/services/procurement",
      "/zh-hans/services/procurement",
      "/zh-hant/services/procurement",
    ]) {
      await page.goto(pathname);
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        `${publicOrigin}${pathname}`,
      );
      const alternates = await page.locator('link[rel="alternate"][hreflang]:not([hreflang="x-default"])')
        .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
      expect(alternates).toEqual(expected);
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]'))
        .toHaveAttribute("href", `${publicOrigin}/services/procurement`);
    }
  });

  test("keeps service content visible without invented provenance claims", async ({ page }) => {
    await page.goto("/en/services/procurement");

    await expect(page.locator("[data-answer-section]")).toHaveCount(3);
    await expect(page.locator('[data-answer-section="scope"]')).toContainText(
      "Direct production certificate",
    );
    await expect(page.locator(".service-evidence")).toHaveCount(0);
    await expect(page.locator('a[href="https://www.pps.go.kr/"]')).toHaveCount(0);

    const graph = await page.locator('script[type="application/ld+json"]').evaluate((script) => (
      JSON.parse(script.textContent ?? "")["@graph"] as Array<Record<string, unknown>>
    ));
    const service = graph.find((node) => node["@type"] === "Service");
    expect(service).toMatchObject({
      name: await page.locator("h1").textContent(),
      description: await page.locator(".page-hero p").last().textContent(),
    });
    expect(service).not.toHaveProperty("reviewedBy");
    expect(service).not.toHaveProperty("dateModified");
    expect(service).not.toHaveProperty("citation");
    expect(JSON.stringify(graph)).not.toMatch(/"@type":"(?:Attorney|Review|AggregateRating)"|nosourceinfo/);
  });

  test("serves exact sitemap, RSS, and crawler controls", async ({ request }) => {
    const sitemapResponse = await request.get("/sitemap.xml");
    expect(sitemapResponse.status()).toBe(200);
    expect(sitemapResponse.headers()["content-type"]).toMatch(/^(?:application|text)\/xml/);
    const sitemap = await sitemapResponse.text();
    const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(sitemapUrls).toHaveLength(52);
    expect(new Set(sitemapUrls).size).toBe(52);
    expect(sitemap).not.toMatch(/admin|api\/|consultation|marketing\/withdraw|verification|naver[^<]*\.html/i);

    const rssResponse = await request.get("/rss.xml");
    expect(rssResponse.status()).toBe(200);
    expect(rssResponse.headers()["content-type"])
      .toMatch(/^(?:application\/(?:rss\+xml|xml)|text\/xml)/);
    const rss = await rssResponse.text();
    expect(rss.match(/<item>/g)).toHaveLength(4);
    expect(rss).not.toMatch(/<script|javascript:|private canary|draft canary/i);

    const robotsResponse = await request.get("/robots.txt");
    expect(robotsResponse.status()).toBe(200);
    expect(robotsResponse.headers()["content-type"]).toContain("text/plain");
    const robots = await robotsResponse.text();
    for (const agent of ["Googlebot", "Yeti", "OAI-SearchBot", "Google-Extended", "ChatGPT-User", "GPTBot"]) {
      expect(robots).toContain(`User-agent: ${agent}`);
    }
    expect(robots).toContain(`Sitemap: ${publicOrigin}/sitemap.xml`);
    expect(robots.toLowerCase()).not.toContain("nosourceinfo");
  });

  test("keeps accessible utility pages out of hreflang and marks them noindex", async ({ page }) => {
    for (const pathname of [
      "/consultation",
      "/en/privacy",
      "/zh-hans/marketing/withdraw",
    ]) {
      const response = await page.goto(pathname);
      expect(response?.status(), pathname).toBe(200);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, follow");
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
      await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(0);
      expect((await page.content()).toLowerCase()).not.toContain("nosourceinfo");
    }
  });
});

test.describe("published insight fixture", () => {
  test.skip(
    !process.env.WISDOM_PUBLISHED_CONTENT_DIR,
    "Run with the tracked immutable published-content fixture.",
  );

  test("lists exact-locale articles and renders availability-aware alternates", async ({ page, request }) => {
    await page.goto("/en/insights");
    await expect(page.getByRole("heading", { name: "Reviewed procurement entry guide" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Visa extension preparation checklist" })).toBeVisible();
    await expect(page.getByText("검수된 조달 진입 안내", { exact: true })).toHaveCount(0);

    await page.goto("/en/insights/procurement-entry-guide");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Reviewed procurement entry guide",
    );
    await expect(page.locator("article.published-article")).toHaveCount(1);
    await expect(page.locator(".published-article-body")).toContainText(
      "Confirm the procurement route before preparing evidence.",
    );
    await expect(page.locator(".article-provenance")).toContainText("Reviewed by");
    await expect(page.locator(".article-provenance")).not.toContainText("Authored by");
    const articleGraph = await page.locator('script[type="application/ld+json"]').evaluate((script) => (
      JSON.parse(script.textContent ?? "")["@graph"] as Array<Record<string, unknown>>
    ));
    expect(articleGraph.find((node) => node["@type"] === "Article")).not.toHaveProperty("author");
    await expect(page.locator('link[rel="alternate"][hreflang="ko"]')).toHaveAttribute(
      "href",
      `${publicOrigin}/insights/jodal-entry-guide`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
      "href",
      `${publicOrigin}/en/insights/procurement-entry-guide`,
    );
    await expect(page.locator('link[rel="alternate"][hreflang="zh-Hant"]')).toHaveCount(1);
    await expect(page.locator('link[rel="alternate"][hreflang="zh-Hans"]')).toHaveCount(0);
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
      "href",
      `${publicOrigin}/insights/jodal-entry-guide`,
    );
    await expect(page.locator('.language-links a[hreflang="zh-Hans"]')).toHaveCount(0);

    const missingLocale = await request.get(
      "/zh-hans/insights/procurement-entry-guide",
      { maxRedirects: 0 },
    );
    expect(missingLocale.status()).toBe(404);
  });

  test("omits x-default for an English-only article", async ({ page }) => {
    await page.goto("/en/insights/visa-extension-checklist");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Visa extension preparation checklist",
    );
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveCount(1);
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(0);
    await expect(page.locator('.language-links a[hreflang="ko"]')).toHaveCount(0);
  });

  test("keeps published guidance visible and navigable without JavaScript", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(
      "http://127.0.0.1:4321/en/insights/procurement-entry-guide",
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator(".published-article-body")).toContainText(
      "Confirm the procurement route before preparing evidence.",
    );
    await context.close();
  });

  for (const width of [320, 390, 768, 1440]) {
    test(`has no published-page overflow at ${width}px`, async ({ browserName, page }) => {
      await page.setViewportSize(physicalViewportSize(browserName, width, 900));
      for (const pathname of [
        "/en/insights",
        "/en/insights/procurement-entry-guide",
      ]) {
        await page.goto(pathname);
        expect(await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })), pathname).toEqual({ clientWidth: width, scrollWidth: width });
      }
    });
  }

  for (const pathname of [
    "/en/insights",
    "/en/insights/procurement-entry-guide",
  ]) {
    test(`has no serious published-page accessibility violations on ${pathname}`, async ({ page }) => {
      await page.goto(pathname);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations.filter(({ impact }) => impact === "critical" || impact === "serious"))
        .toEqual([]);
    });
  }
});
