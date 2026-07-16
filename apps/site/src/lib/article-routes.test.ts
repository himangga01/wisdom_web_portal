import type { Locale, PublishedArticleDocument, PublishedManifest } from "@wisdom/shared";
import { describe, expect, it } from "vitest";

import type { PublishedContent } from "../content/published-articles.js";
import {
  articleLocaleLinks,
  articlesForLocale,
  articleRoute,
  publishedArticleRouteEntries,
} from "./article-routes.js";

function document(
  locale: Locale,
  slug: string,
  revisionId: string,
  articleId = "11111111-1111-4111-8111-111111111111",
): PublishedArticleDocument {
  const route = articleRoute(locale, slug);
  return {
    schemaVersion: 1,
    articleId,
    locale,
    slug,
    revisionId,
    contentSha256: revisionId.replaceAll("-", "").padEnd(64, "0"),
    route,
    title: `${locale} ${slug}`,
    summary: `Summary for ${locale} ${slug}`,
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
}

function content(articles: readonly PublishedArticleDocument[]): PublishedContent {
  const byArticleId = new Map<string, PublishedArticleDocument[]>();
  for (const article of articles) {
    const related = byArticleId.get(article.articleId) ?? [];
    related.push(article);
    byArticleId.set(article.articleId, related);
  }
  return {
    manifest: { schemaVersion: 1, entries: [] } satisfies PublishedManifest,
    articles,
    byRoute: new Map(articles.map((article) => [article.route, article])),
    byArticleId,
  };
}

describe("published article route projection", () => {
  it("computes canonical locale-prefixed routes", () => {
    expect(articleRoute("ko", "guide")).toBe("/insights/guide");
    expect(articleRoute("en", "guide")).toBe("/en/insights/guide");
    expect(articleRoute("zh-Hans", "guide")).toBe("/zh-hans/insights/guide");
    expect(articleRoute("zh-Hant", "guide")).toBe("/zh-hant/insights/guide");
  });

  it("projects only published locales and preserves each locale's own slug", () => {
    const korean = document("ko", "jodal-silmu", "22222222-2222-4222-8222-222222222222");
    const english = document("en", "procurement-guide", "33333333-3333-4333-8333-333333333333");
    const traditional = document("zh-Hant", "caigou-zhinan", "44444444-4444-4444-8444-444444444444");
    const published = content([traditional, english, korean]);

    expect(articleLocaleLinks(published, korean.articleId)).toEqual([
      { locale: "ko", href: "/insights/jodal-silmu" },
      { locale: "en", href: "/en/insights/procurement-guide" },
      { locale: "zh-Hant", href: "/zh-hant/insights/caigou-zhinan" },
    ]);
    expect(publishedArticleRouteEntries(published)).toEqual([
      expect.objectContaining({
        pathname: traditional.route,
        locale: "zh-Hant",
        article: traditional,
        xDefaultHref: korean.route,
      }),
      expect.objectContaining({
        pathname: english.route,
        locale: "en",
        article: english,
        xDefaultHref: korean.route,
      }),
      expect.objectContaining({
        pathname: korean.route,
        locale: "ko",
        article: korean,
        xDefaultHref: korean.route,
      }),
    ]);
    expect(articlesForLocale(published, "zh-Hans")).toEqual([]);
    expect(articlesForLocale(published, "en")).toEqual([english]);
  });

  it("omits x-default when the article has no published Korean revision", () => {
    const english = document("en", "visa-guide", "55555555-5555-4555-8555-555555555555");
    const simplified = document("zh-Hans", "qianzheng-zhinan", "66666666-6666-4666-8666-666666666666");

    expect(publishedArticleRouteEntries(content([english, simplified]))).toEqual([
      expect.objectContaining({ pathname: english.route, xDefaultHref: undefined }),
      expect.objectContaining({ pathname: simplified.route, xDefaultHref: undefined }),
    ]);
  });
});
