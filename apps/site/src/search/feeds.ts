import type { SearchDocument, SearchIndex } from "./types.js";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

export function renderSitemap(index: SearchIndex): string {
  const urls = index.indexable.map((document) => {
    const alternates = [
      ...document.alternates.map(({ locale, url }) => (
        `    <xhtml:link rel="alternate" hreflang="${locale}" href="${xml(url)}" />`
      )),
      ...(document.xDefaultUrl ? [
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(document.xDefaultUrl)}" />`,
      ] : []),
    ];
    return [
      "  <url>",
      `    <loc>${xml(document.canonicalUrl)}</loc>`,
      ...(document.lastModified ? [`    <lastmod>${dateOnly(document.lastModified)}</lastmod>`] : []),
      ...alternates,
      "  </url>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

function articleDocuments(index: SearchIndex): SearchDocument[] {
  return index.indexable
    .filter((document) => document.kind === "article" && document.article)
    .sort((left, right) => (
      right.lastModified!.localeCompare(left.lastModified!)
      || left.canonicalUrl.localeCompare(right.canonicalUrl)
    ));
}

export function renderRss(index: SearchIndex): string {
  const items = articleDocuments(index).map((document) => {
    const article = document.article!;
    return [
      "    <item>",
      `      <title>${xml(document.h1)}</title>`,
      `      <link>${xml(document.canonicalUrl)}</link>`,
      `      <guid isPermaLink="true">${xml(document.canonicalUrl)}</guid>`,
      `      <description>${xml(document.description)}</description>`,
      `      <dc:language>${document.locale}</dc:language>`,
      `      <pubDate>${new Date(article.firstPublishedAt).toUTCString()}</pubDate>`,
      `      <atom:updated>${article.modifiedAt}</atom:updated>`,
      `      <content:encoded>${xml(article.bodyHtml)}</content:encoded>`,
      "    </item>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "  <channel>",
    "    <title>JIHYE Administrative Attorney Insights</title>",
    `    <link>${xml(`${index.origin}/insights`)}</link>`,
    "    <description>Reviewed administrative practice guidance</description>",
    "    <language>ko</language>",
    `    <atom:link href="${xml(`${index.origin}/rss.xml`)}" rel="self" type="application/rss+xml" />`,
    ...items,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}
