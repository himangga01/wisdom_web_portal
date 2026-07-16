import type { PublishedManifest } from "@wisdom/shared";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadPublishedContent, type PublishedContent } from "../content/published-articles.js";
import { buildSearchIndex } from "./search-index.js";

const origin = "https://www.jihye-office.kr";
const fixtureDirectory = fileURLToPath(
  new URL("../content/__fixtures__/published-content", import.meta.url),
);

function emptyPublishedContent(): PublishedContent {
  return {
    manifest: { schemaVersion: 1, entries: [] } satisfies PublishedManifest,
    articles: [],
    byRoute: new Map(),
    byArticleId: new Map(),
  };
}

describe("public search document graph", () => {
  it("builds one absolute self-canonical and a reciprocal four-locale graph for indexable base pages", () => {
    const index = buildSearchIndex(origin, emptyPublishedContent());
    const english = index.byRoute.get("/en/services/procurement");

    expect(english).toMatchObject({
      policy: "indexable",
      locale: "en",
      route: "/en/services/procurement",
      canonicalUrl: `${origin}/en/services/procurement`,
      xDefaultUrl: `${origin}/services/procurement`,
    });
    expect(english?.alternates).toEqual([
      { locale: "ko", url: `${origin}/services/procurement` },
      { locale: "en", url: `${origin}/en/services/procurement` },
      { locale: "zh-Hans", url: `${origin}/zh-hans/services/procurement` },
      { locale: "zh-Hant", url: `${origin}/zh-hant/services/procurement` },
    ]);
    for (const sibling of english?.alternates ?? []) {
      expect(index.byCanonical.get(sibling.url)?.alternates).toEqual(english?.alternates);
    }
  });

  it("uses the explicit noindex matrix and excludes it from discovery sets", () => {
    const index = buildSearchIndex(origin, emptyPublishedContent());

    for (const route of [
      "/consultation",
      "/en/privacy",
      "/zh-hans/marketing/withdraw",
      "/zh-hant/404",
    ]) {
      expect(index.byRoute.get(route)).toMatchObject({ policy: "noindex" });
      expect(index.byRoute.get(route)?.alternates).toEqual([]);
    }
    expect(index.indexable.some(({ route }) => route.includes("consultation"))).toBe(false);
    expect(index.indexNowUrls).toEqual(index.indexable.map(({ canonicalUrl }) => canonicalUrl).sort());
  });

  it("keeps article translations connected by article ID and never invents a missing locale", () => {
    const content = loadPublishedContent(fixtureDirectory);
    const index = buildSearchIndex(origin, content);
    const english = index.byRoute.get("/en/insights/procurement-entry-guide");

    expect(english?.alternates).toEqual([
      { locale: "ko", url: `${origin}/insights/jodal-entry-guide` },
      { locale: "en", url: `${origin}/en/insights/procurement-entry-guide` },
      { locale: "zh-Hant", url: `${origin}/zh-hant/insights/caigou-ruzhu-zhinan` },
    ]);
    expect(english?.xDefaultUrl).toBe(`${origin}/insights/jodal-entry-guide`);
    expect(index.byRoute.has("/zh-hans/insights/procurement-entry-guide")).toBe(false);

    const englishOnly = index.byRoute.get("/en/insights/visa-extension-checklist");
    expect(englishOnly?.alternates).toEqual([
      { locale: "en", url: `${origin}/en/insights/visa-extension-checklist` },
    ]);
    expect(englishOnly?.xDefaultUrl).toBeUndefined();
  });

  it("has unique localized metadata and reproduces a previous release SEO set exactly", () => {
    const content = loadPublishedContent(fixtureDirectory);
    const first = buildSearchIndex(origin, content);
    const empty = buildSearchIndex(origin, emptyPublishedContent());
    const rollback = buildSearchIndex(origin, content);

    for (const locale of ["ko", "en", "zh-Hans", "zh-Hant"] as const) {
      const localized = first.indexable.filter((document) => document.locale === locale);
      expect(new Set(localized.map(({ title }) => title)).size).toBe(localized.length);
      expect(new Set(localized.map(({ description }) => description)).size).toBe(localized.length);
      expect(new Set(localized.map(({ h1 }) => h1)).size).toBe(localized.length);
    }
    expect(empty.indexable.length).toBe(first.indexable.length - content.articles.length);
    expect(rollback.indexNowUrls).toEqual(first.indexNowUrls);
    expect(rollback.releaseSetSha256).toBe(first.releaseSetSha256);
  });
});
