import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadPublishedContent } from "../content/published-articles.js";
import { renderRss, renderSitemap } from "./feeds.js";
import { buildSearchIndex } from "./search-index.js";

const origin = "https://www.jihye-office.kr";
const fixtureDirectory = fileURLToPath(
  new URL("../content/__fixtures__/published-content", import.meta.url),
);

function values(xml: string, tag: "loc" | "guid"): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?: isPermaLink="true")?>([^<]+)</${tag}>`, "g"))]
    .map((match) => match[1]!);
}

describe("sitemap and RSS discovery artifacts", () => {
  it("makes the sitemap URL set exactly equal to indexable self-canonicals", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));
    const sitemap = renderSitemap(index);

    expect(values(sitemap, "loc").sort()).toEqual(
      index.indexable.map(({ canonicalUrl }) => canonicalUrl).sort(),
    );
    expect((sitemap.match(/<lastmod>2026-07-03<\/lastmod>/g) ?? []).length).toBeGreaterThan(0);
    expect(sitemap).toContain(
      `hreflang="x-default" href="${origin}/insights/jodal-entry-guide"`,
    );
    expect(sitemap).not.toMatch(/admin|api\/|consultation|marketing\/withdraw|verification|naver.*\.html/i);
  });

  it("feeds only approved fixture articles with canonical IDs, locale, dates, and escaped sanitized HTML", () => {
    const content = loadPublishedContent(fixtureDirectory);
    const index = buildSearchIndex(origin, content);
    const rss = renderRss(index);
    const articleUrls = index.indexable
      .filter(({ kind }) => kind === "article")
      .map(({ canonicalUrl }) => canonicalUrl)
      .sort();

    expect(values(rss, "guid").sort()).toEqual(articleUrls);
    expect((rss.match(/<item>/g) ?? [])).toHaveLength(content.articles.length);
    expect(rss).toContain("<dc:language>zh-Hant</dc:language>");
    expect(rss).toContain("<pubDate>Fri, 03 Jul 2026 00:00:00 GMT</pubDate>");
    expect(rss).toContain("&lt;h2&gt;What to confirm first&lt;/h2&gt;");
    expect(rss).not.toMatch(/<script|javascript:|MARKDOWN_ONLY|draft|private canary/i);
    expect(rss).not.toMatch(/\/(?:admin|api|consultation|marketing\/withdraw|verification)(?:\/|<)|naver[^<]*\.html/i);
  });
});
