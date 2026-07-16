import {
  computePublishedArticleContentSha256,
  type Locale,
  type PublishedArticleDocument,
} from "@wisdom/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PublicPage from "./PublicPage.astro";
import type { PublicRoute } from "../lib/routes.js";
import type { PublishedContent } from "../content/published-articles.js";
import { buildSearchIndex } from "../search/search-index.js";
import { testPublishedConsentBundle, testPublishedManifest } from "../test/published-content.js";

const searchOrigin = "https://www.jihye-office.kr";

function publishedContent(articles: readonly PublishedArticleDocument[]): PublishedContent {
  const byArticleId = new Map<string, PublishedArticleDocument[]>();
  for (const article of articles) {
    byArticleId.set(article.articleId, [...(byArticleId.get(article.articleId) ?? []), article]);
  }
  return {
    manifest: testPublishedManifest(),
    consentBundle: testPublishedConsentBundle(),
    articles,
    byRoute: new Map(articles.map((article) => [article.route, article])),
    byArticleId,
  };
}

async function renderPage(
  locale: Locale,
  route: PublicRoute,
  articles: readonly PublishedArticleDocument[] = [],
): Promise<string> {
  const container = await AstroContainer.create();
  const prefix = locale === "ko" ? ""
    : locale === "en" ? "/en"
      : locale === "zh-Hans" ? "/zh-hans" : "/zh-hant";
  const localizedRoute = route === "/" ? prefix || "/" : `${prefix}${route}`;
  const releaseContent = publishedContent(articles);
  const searchDocument = buildSearchIndex(searchOrigin, releaseContent).byRoute.get(
    localizedRoute,
  );
  if (!searchDocument) throw new Error("Missing test search document");
  return container.renderToString(PublicPage, {
    partial: false,
    props: { locale, route, articles, searchDocument, consentBundle: releaseContent.consentBundle },
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
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain(`rel="canonical" href="${searchOrigin}/en"`);
    expect(html).toContain(`rel="alternate" hreflang="ko" href="${searchOrigin}/"`);
    expect(html).toContain(`rel="alternate" hreflang="x-default" href="${searchOrigin}/"`);
    expect(html).toContain('type="application/ld+json"');
    expect(html.toLowerCase()).not.toContain("nosourceinfo");
    expect(html).not.toMatch(/representative-brochure|https?:\/\/[^"']+\.(?:avif|webp|jpe?g|png)/i);
    expect(html).not.toMatch(/portrait-asset-slot|data-asset-slot|reserved slot|approved representative portrait/i);
    expect(html).toContain('class="brand-illustration" role="img"');
    expect(html).toContain('aria-label="Bronze, sand, and ivory geometric brand illustration"');
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
    for (const answerSection of ["scope", "preparation", "process"]) {
      expect(html).toContain(`data-answer-section="${answerSection}"`);
    }
    expect(html).not.toContain("Official sources");
    expect(html).not.toContain('datetime="2026-07-16T00:00:00.000Z"');
    expect(html).not.toContain('href="https://www.pps.go.kr/"');
    const jsonLd = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
    expect(jsonLd).toBeDefined();
    const graph = JSON.parse(jsonLd!)["@graph"] as Array<Record<string, unknown>>;
    const serviceNode = graph.find((node) => node["@type"] === "Service");
    expect(serviceNode).toMatchObject({
      name: "Public Procurement",
      description: "Production, product, and registration support for entering public procurement.",
    });
    expect(serviceNode).not.toHaveProperty("reviewedBy");
    expect(serviceNode).not.toHaveProperty("dateModified");
    expect(serviceNode).not.toHaveProperty("citation");
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

  it("renders the sealed consent documents as escaped text with exact intake metadata", async () => {
    const privacy = await renderPage("en", "/privacy");
    const withdrawal = await renderPage("en", "/marketing/withdraw");
    const missing = await renderPage("zh-Hans", "/404");
    const bundle = testPublishedConsentBundle();
    const privacyDocument = bundle.documents.find(({ locale, kind }) => locale === "en" && kind === "privacy")!;
    const marketingDocument = bundle.documents.find(({ locale, kind }) => locale === "en" && kind === "marketing")!;

    expect(privacy).toContain("&lt;script&gt;alert(&quot;text only&quot;)&lt;/script&gt;");
    expect(privacy).not.toContain('<script>alert("text only")</script>');
    expect(privacy).toContain(`data-consent-version="${privacyDocument.version}"`);
    expect(privacy).toContain(`data-consent-effective-at="${privacyDocument.effectiveAt}"`);
    expect(privacy).toContain(`data-consent-sha256="${privacyDocument.contentSha256}"`);
    expect(privacy).toContain('data-consent-retention-months="12"');
    expect(privacy).toContain("privacy-2026-07-16");
    expect(withdrawal).toContain(marketingDocument.bodyMarkdown);
    expect(withdrawal).toContain(`data-consent-version="${marketingDocument.version}"`);
    expect(withdrawal).toContain(`data-consent-effective-at="${marketingDocument.effectiveAt}"`);
    expect(withdrawal).toContain(`data-consent-sha256="${marketingDocument.contentSha256}"`);
    expect(withdrawal).toContain('data-consent-retention-months="24"');
    expect(withdrawal).toContain("one-time withdrawal link");
    expect(withdrawal).toContain("support channels; they do not withdraw consent by themselves");
    expect(privacy).not.toContain("Do not use before legal review");
    expect(withdrawal).not.toContain("Do not use before legal review");
    expect(missing).toContain('name="robots" content="noindex, follow"');
    expect(privacy).toContain('name="robots" content="noindex, follow"');
    expect(withdrawal).toContain('name="robots" content="noindex, follow"');
    expect(privacy).not.toContain('rel="alternate" hreflang=');
    expect(missing).toContain('href="/zh-hans"');
  });

  it("lists only articles published for the exact page locale", async () => {
    const common = {
      schemaVersion: 1 as const,
      articleId: "11111111-1111-4111-8111-111111111111",
      slug: "guide",
      contentSha256: "0".repeat(64),
      bodyMarkdown: "## Guide\n\nSafe body.",
      bodyHtml: "<h2>Guide</h2>\n<p>Safe body.</p>\n",
      revisionCreatedAt: "2026-07-01T00:00:00.000Z",
      approvedAt: "2026-07-02T00:00:00.000Z",
      firstPublishedAt: "2026-07-03T00:00:00.000Z",
      modifiedAt: "2026-07-03T00:00:00.000Z",
      reviewer: { name: "Reviewer", role: "Administrative Attorney" },
      sources: [{
        id: "source-1",
        url: "https://example.test/source",
        sourceTimestamp: "2026-06-30T00:00:00.000Z",
      }],
    };
    const english: PublishedArticleDocument = {
      ...common,
      locale: "en",
      revisionId: "22222222-2222-4222-8222-222222222222",
      route: "/en/insights/guide",
      title: "Reviewed procurement guide",
      summary: "English summary visible only on the English listing.",
    };
    const korean: PublishedArticleDocument = {
      ...common,
      locale: "ko",
      revisionId: "33333333-3333-4333-8333-333333333333",
      route: "/insights/guide",
      title: "검수된 조달 안내",
      summary: "한국어 목록에서만 보이는 요약입니다.",
    };
    for (const article of [english, korean]) {
      article.contentSha256 = computePublishedArticleContentSha256({
        title: article.title,
        summary: article.summary,
        bodyMarkdown: article.bodyMarkdown,
        sources: article.sources,
        locale: article.locale,
      });
    }

    const html = await renderPage("en", "/insights", [korean, english]);

    expect(html).toContain("Reviewed procurement guide");
    expect(html).toContain("English summary visible only on the English listing.");
    expect(html).toContain('href="/en/insights/guide"');
    expect(html).not.toContain("검수된 조달 안내");
    expect(html).not.toContain("한국어 목록에서만 보이는 요약입니다.");
  });
});
