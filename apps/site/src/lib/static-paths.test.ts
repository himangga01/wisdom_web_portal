import {
  computePublishedArticleContentSha256,
  type Locale,
  type PublishedArticleDocument,
  type PublishedManifest,
} from "@wisdom/shared";
import { describe, expect, it } from "vitest";

import type { PublishedContent } from "../content/published-articles.js";
import { createPublicStaticPaths } from "./static-paths.js";
import { buildSearchIndex } from "../search/search-index.js";

function article(locale: Locale, slug: string, revisionId: string): PublishedArticleDocument {
  const prefix = locale === "ko" ? "" : locale === "en" ? "/en" : locale === "zh-Hans" ? "/zh-hans" : "/zh-hant";
  const document: PublishedArticleDocument = {
    schemaVersion: 1,
    articleId: "11111111-1111-4111-8111-111111111111",
    locale,
    slug,
    revisionId,
    contentSha256: "0".repeat(64),
    route: `${prefix}/insights/${slug}`,
    title: `${locale} title`,
    summary: `${locale} summary`,
    bodyMarkdown: "## Guide\n\nSafe.",
    bodyHtml: "<h2>Guide</h2>\n<p>Safe.</p>\n",
    revisionCreatedAt: "2026-07-01T00:00:00.000Z",
    approvedAt: "2026-07-02T00:00:00.000Z",
    firstPublishedAt: "2026-07-03T00:00:00.000Z",
    modifiedAt: "2026-07-03T00:00:00.000Z",
    reviewer: { name: "Reviewer", role: "Administrative Attorney" },
    sources: [{ id: "source-1", url: "https://example.test/source", sourceTimestamp: "2026-06-30T00:00:00.000Z" }],
  };
  document.contentSha256 = computePublishedArticleContentSha256({
    title: document.title,
    summary: document.summary,
    bodyMarkdown: document.bodyMarkdown,
    sources: document.sources,
    locale: document.locale,
  });
  return document;
}

function content(articles: readonly PublishedArticleDocument[]): PublishedContent {
  const byArticleId = new Map<string, PublishedArticleDocument[]>();
  for (const item of articles) {
    const related = byArticleId.get(item.articleId) ?? [];
    related.push(item);
    byArticleId.set(item.articleId, related);
  }
  return {
    manifest: { schemaVersion: 1, entries: [] } satisfies PublishedManifest,
    articles,
    byRoute: new Map(articles.map((item) => [item.route, item])),
    byArticleId,
  };
}

describe("catch-all static path integration", () => {
  it("keeps the existing sixty-three catch-all pages and appends only exact article routes", () => {
    const korean = article("ko", "jodal-guide", "22222222-2222-4222-8222-222222222222");
    const english = article("en", "procurement-guide", "33333333-3333-4333-8333-333333333333");
    const published = content([korean, english]);
    const searchIndex = buildSearchIndex("https://www.jihye-office.kr", published);
    const paths = createPublicStaticPaths(published, searchIndex);

    expect(paths).toHaveLength(65);
    expect(paths.filter(({ props }) => props.kind === "base")).toHaveLength(63);
    expect(paths.filter(({ props }) => props.kind === "article")).toHaveLength(2);
    expect(paths).toContainEqual({
      params: { path: "en/insights" },
      props: expect.objectContaining({
        kind: "base",
        locale: "en",
        route: "/insights",
        articles: [english],
        searchDocument: expect.objectContaining({
          canonicalUrl: "https://www.jihye-office.kr/en/insights",
        }),
      }),
    });
    expect(paths).toContainEqual({
      params: { path: "en/insights/procurement-guide" },
      props: expect.objectContaining({
        kind: "article",
        article: english,
        localeLinks: [
          { locale: "ko", href: korean.route },
          { locale: "en", href: english.route },
        ],
        xDefaultHref: korean.route,
        searchDocument: expect.objectContaining({
          canonicalUrl: "https://www.jihye-office.kr/en/insights/procurement-guide",
        }),
      }),
    });
    expect(paths.some(({ params }) => params.path === "zh-hans/insights/procurement-guide")).toBe(false);
  });
});
