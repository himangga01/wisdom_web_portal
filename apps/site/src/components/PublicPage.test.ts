import type { Locale } from "@wisdom/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PublicPage from "./PublicPage.astro";
import type { PublicRoute } from "../lib/routes.js";

async function renderPage(locale: Locale, route: PublicRoute): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(PublicPage, {
    partial: false,
    props: { locale, route },
    request: new Request(`https://example.test${route}`),
  });
}

describe("public Astro page DOM", () => {
  it("renders semantic navigation, real locale links, and exactly eighteen home reveals", async () => {
    const html = await renderPage("en", "/");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toMatch(/<html[^>]+lang="en"/);
    expect(html).toMatch(/<nav[^>]+aria-label="[^"]+"/);
    expect(html).toContain('href="/en/services"');
    expect(html).toContain('href="/zh-hans"');
    expect(html).toContain('href="/zh-hant"');
    expect(html).toContain('href="/en/consultation"');
    expect(html.match(/data-reveal(?:=|\s)/g)).toHaveLength(18);
    expect(html).not.toMatch(/representative-brochure|https?:\/\/[^"']+\.(?:avif|webp|jpe?g|png)/i);
  });

  it("renders the complete shared service group on a category route", async () => {
    const html = await renderPage("en", "/services/procurement");

    expect(html).toContain("Public Procurement");
    for (const service of [
      "Direct production certificate",
      "Factory registration",
      "Multiple Award Schedule (MAS)",
      "Innovative product",
      "Excellent procurement product",
    ]) {
      expect(html).toContain(service);
    }
  });

  it("renders the consultation contract as a native form without fake success UI", async () => {
    const html = await renderPage("en", "/consultation");

    expect(html).toMatch(/<form[^>]+action="\/api\/v1\/consultations"[^>]+method="post"/);
    for (const field of [
      "locale",
      "category",
      "name",
      "phone",
      "email",
      "company",
      "preferredContact",
      "message",
      "privacyConsent",
      "marketingConsent",
    ]) {
      expect(html).toMatch(new RegExp(`name="${field}"`));
    }
    expect(html).toMatch(/name="privacyConsent"[^>]+required/);
    expect(html).toMatch(/name="marketingConsent"/);
    expect(html).not.toMatch(/name="marketingConsent"[^>]+checked/);
    expect(html).not.toMatch(/type="file"|name="attachment"|success/i);
  });

  it("renders operational-draft policy gates and a useful localized 404", async () => {
    const privacy = await renderPage("ko", "/privacy");
    const withdrawal = await renderPage("en", "/marketing/withdraw");
    const missing = await renderPage("zh-Hans", "/404");

    expect(privacy).toContain("법률 검토 전 운영 금지");
    expect(withdrawal).toContain("법률 검토 전 운영 금지");
    expect(missing).toContain('name="robots" content="noindex"');
    expect(missing).toContain('href="/zh-hans"');
  });
});
