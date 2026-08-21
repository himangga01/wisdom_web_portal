import {
  computePublishedArticleContentSha256,
  type PublishedArticleDocument,
} from "@wisdom/shared";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PublishedArticle from "./PublishedArticle.astro";
import type { PublishedContent } from "../content/published-articles.js";
import { buildSearchIndex } from "../search/search-index.js";
import { testPublishedConsentBundle, testPublishedManifest } from "../test/published-content.js";

const articleWithoutHash: Omit<PublishedArticleDocument, "contentSha256"> = {
  schemaVersion: 1,
  articleId: "11111111-1111-4111-8111-111111111111",
  locale: "en",
  slug: "procurement-guide",
  revisionId: "22222222-2222-4222-8222-222222222222",
  route: "/en/insights/procurement-guide",
  title: "Reviewed procurement guide",
  summary: "A practical starting point for entering Korean public procurement.",
  bodyMarkdown: "## Start\n\nReviewed guidance.\n",
  bodyHtml: "<h2>Start</h2>\n<p>Reviewed guidance.</p>",
  revisionCreatedAt: "2026-07-01T00:00:00.000Z",
  approvedAt: "2026-07-02T00:00:00.000Z",
  firstPublishedAt: "2026-07-03T00:00:00.000Z",
  modifiedAt: "2026-07-04T00:00:00.000Z",
  reviewer: { name: "Jihye Kang", role: "Administrative Attorney" },
  sources: [{
    id: "source-1",
    url: "https://example.test/procurement-source",
    sourceTimestamp: "2026-06-30T00:00:00.000Z",
  }],
};
const article: PublishedArticleDocument = {
  ...articleWithoutHash,
  contentSha256: computePublishedArticleContentSha256({
    title: articleWithoutHash.title,
    summary: articleWithoutHash.summary,
    bodyMarkdown: articleWithoutHash.bodyMarkdown,
    sources: articleWithoutHash.sources,
    locale: articleWithoutHash.locale,
  }),
};

function testContent(articles: readonly PublishedArticleDocument[]): PublishedContent {
  const byArticleId = new Map<string, PublishedArticleDocument[]>();
  for (const item of articles) {
    byArticleId.set(item.articleId, [...(byArticleId.get(item.articleId) ?? []), item]);
  }
  return {
    manifest: testPublishedManifest(),
    consentBundle: testPublishedConsentBundle(),
    articles,
    byRoute: new Map(articles.map((item) => [item.route, item])),
    byArticleId,
  };
}

describe("published article DOM", () => {
  it("renders reviewed HTML, provenance, and only available locale alternates", async () => {
    const container = await AstroContainer.create();
    const korean = { ...article, locale: "ko" as const, route: "/insights/jodal-guide", slug: "jodal-guide" };
    korean.contentSha256 = computePublishedArticleContentSha256({
      title: korean.title,
      summary: korean.summary,
      bodyMarkdown: korean.bodyMarkdown,
      sources: korean.sources,
      locale: korean.locale,
    });
    const content = testContent([korean, article]);
    const searchDocument = buildSearchIndex("https://www.jihye-office.kr", content).byRoute.get(article.route)!;
    const html = await container.renderToString(PublishedArticle, {
      partial: false,
      props: {
        article,
        localeLinks: [
          { locale: "ko", href: "/insights/jodal-guide" },
          { locale: "en", href: article.route },
        ],
        xDefaultHref: "/insights/jodal-guide",
        searchDocument,
      },
      request: new Request(`https://example.test${article.route}`),
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toMatch(/<html[^>]+lang="en"/);
    expect(html.match(/<article\b/g)).toHaveLength(1);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(article.title);
    expect(html).toContain(article.summary);
    expect(html).toContain("<h2>Start</h2>");
    expect(html).toContain("<p>Reviewed guidance.</p>");
    expect(html).not.toContain("MARKDOWN_ONLY");
    expect(html).toContain('href="https://example.test/procurement-source"');
    expect(html).toContain("Jihye Kang");
    expect(html).toContain("Administrative Attorney");
    expect(html).not.toContain("Authored by");
    expect(html).toContain('datetime="2026-07-03T00:00:00.000Z"');
    expect(html).toContain('datetime="2026-07-04T00:00:00.000Z"');
    expect(html).toContain('rel="canonical" href="https://www.jihye-office.kr/en/insights/procurement-guide"');
    expect(html).toContain('rel="alternate" hreflang="ko" href="https://www.jihye-office.kr/insights/jodal-guide"');
    expect(html).toContain(`rel="alternate" hreflang="en" href="https://www.jihye-office.kr${article.route}"`);
    expect(html).toContain('rel="alternate" hreflang="x-default" href="https://www.jihye-office.kr/insights/jodal-guide"');
    const jsonLd = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
    expect(jsonLd).toBeDefined();
    const articleNode = (JSON.parse(jsonLd!)["@graph"] as Array<Record<string, unknown>>)
      .find((node) => node["@type"] === "Article");
    expect(articleNode).toMatchObject({
      headline: article.title,
      reviewedBy: {
        name: "Jihye Kang",
        jobTitle: "Administrative Attorney",
      },
    });
    expect((articleNode?.reviewedBy as Record<string, unknown>)).not.toHaveProperty("@id");
    expect(articleNode).not.toHaveProperty("author");
    expect(html).toMatch(/href="\/en\/insights"[^>]+aria-current="page"/);
    expect(html).not.toMatch(/hreflang="zh-(?:Hans|Hant)"/);
    expect(html).not.toContain("/zh-hans/insights/");
    expect(html).not.toContain("/zh-hant/insights/");
  });

  it("omits x-default when no Korean revision is published", async () => {
    const container = await AstroContainer.create();
    const content = testContent([article]);
    const searchDocument = buildSearchIndex("https://www.jihye-office.kr", content).byRoute.get(article.route)!;
    const html = await container.renderToString(PublishedArticle, {
      partial: false,
      props: {
        article,
        localeLinks: [{ locale: "en", href: article.route }],
        xDefaultHref: undefined,
        searchDocument,
      },
      request: new Request(`https://example.test${article.route}`),
    });

    expect(html).not.toContain('hreflang="x-default"');
  });
});
