import type { Locale } from "@wisdom/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PublicPage from "./PublicPage.astro";
import { siteContent } from "../content/site-content.js";
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

  it("localizes homepage labels and representative facts without Korean leakage", async () => {
    const englishHome = await renderPage("en", "/");
    const englishAbout = await renderPage("en", "/about");
    const simplifiedHome = await renderPage("zh-Hans", "/");
    const traditionalAbout = await renderPage("zh-Hant", "/about");

    for (const html of [englishHome, englishAbout, simplifiedHome, traditionalAbout]) {
      for (const koreanFact of [
        "한양대학교 경영학 학사·석사",
        "아주대학교 대학원 교육학·상담 석사",
        "공공조달연구소 이사",
        "제11회 행정사",
      ]) {
        expect(html).not.toContain(koreanFact);
      }
    }

    expect(englishAbout.replaceAll("&#39;", "'")).toContain(
      "Hanyang University, Bachelor's and Master's in Business Administration",
    );
    expect(englishAbout).toContain("Director, Public Procurement Research Institute");
    expect(simplifiedHome).toContain("业务导航");
    expect(simplifiedHome).toContain("公共采购");
    expect(simplifiedHome).not.toMatch(/>Navigator<|>Principles<|>Procurement<|>Enterprise<|>Immigration<|>Profile</);
    expect(traditionalAbout).toContain("漢陽大學經營學學士、碩士");
    expect(traditionalAbout).toContain("公共採購研究所理事");
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
    expect(html).not.toMatch(/type="file"|name="attachment"/i);
    expect(html).toMatch(
      /<div class="form-status" data-form-status role="status" aria-live="polite" hidden[^>]*>\s*<\/div>/,
    );
  });

  it("renders operational-draft policy gates and a useful localized 404", async () => {
    const privacy = await renderPage("ko", "/privacy");
    const withdrawal = await renderPage("en", "/marketing/withdraw");
    const simplifiedPrivacy = await renderPage("zh-Hans", "/privacy");
    const traditionalWithdrawal = await renderPage("zh-Hant", "/marketing/withdraw");
    const missing = await renderPage("zh-Hans", "/404");

    expect(privacy).toContain("법률 검토 전 운영 금지");
    expect(withdrawal).toContain("Do not use before legal review");
    expect(simplifiedPrivacy).toContain("法律审查完成前禁止使用");
    expect(traditionalWithdrawal).toContain("法律審查完成前禁止使用");
    for (const locale of ["en", "zh-Hans", "zh-Hant"] as const) {
      expect(siteContent[locale].policies.launchGate).not.toMatch(/[가-힣]/);
    }
    expect(missing).toContain('name="robots" content="noindex"');
    expect(missing).toContain('href="/zh-hans"');
  });
});
