import { LOCALES, type Locale, type PublishedArticleDocument } from "@wisdom/shared";
import { createHash } from "node:crypto";

import { type PublishedContent } from "../content/published-articles.js";
import { siteContent, type ServiceCategorySlug } from "../content/site-content.js";
import { articleLocaleLinks } from "../lib/article-routes.js";
import { PUBLIC_ROUTE_ENTRIES, toLocalizedPath, type PublicRoute } from "../lib/routes.js";
import { createJsonLdDocument } from "./json-ld.js";
import { absolutePublicUrl } from "./origin.js";
import {
  assertArticlePublicationQuality,
  buildServicePublication,
} from "./quality-gate.js";
import { getBaseSurface } from "./surface-registry.js";
import type { JsonLdDocument, SearchDocument, SearchIndex } from "./types.js";

function pageKey(route: PublicRoute): keyof (typeof siteContent)["ko"]["meta"] {
  if (route === "/") return "home";
  if (route === "/about") return "about";
  if (route === "/services" || route.startsWith("/services/")) return "services";
  if (route === "/process") return "process";
  if (route === "/insights") return "insights";
  if (route === "/consultation") return "consultation";
  if (route === "/location") return "location";
  if (route === "/privacy") return "privacy";
  if (route === "/marketing/withdraw") return "marketingWithdraw";
  return "notFound";
}

function emptyJsonLd(): JsonLdDocument {
  return { "@context": "https://schema.org", "@graph": [] };
}

function serviceSlug(route: PublicRoute): ServiceCategorySlug | undefined {
  return route.startsWith("/services/")
    ? route.slice("/services/".length) as ServiceCategorySlug
    : undefined;
}

function buildBaseDocument(
  origin: string,
  locale: Locale,
  route: PublicRoute,
  insightsLastModified?: string,
): SearchDocument {
  const surface = getBaseSurface(
    route,
    insightsLastModified ? { insightsLastModified } : {},
  );
  const localizedRoute = toLocalizedPath(locale, route);
  const content = siteContent[locale];
  const slug = serviceSlug(route);
  const service = slug ? buildServicePublication(locale, slug) : undefined;
  const metadata = content.meta[pageKey(route)];
  const document: SearchDocument = {
    kind: service ? "service" : "base",
    policy: surface.policy,
    locale,
    route: localizedRoute,
    canonicalUrl: absolutePublicUrl(origin, localizedRoute),
    title: service?.title ?? metadata.title,
    description: service?.description ?? metadata.description,
    h1: service?.h1 ?? content.headings[pageKey(route)],
    ...(surface.lastModified ? { lastModified: surface.lastModified } : {}),
    alternates: surface.policy === "indexable"
      ? LOCALES.map((alternateLocale) => ({
        locale: alternateLocale,
        url: absolutePublicUrl(origin, toLocalizedPath(alternateLocale, route)),
      }))
      : [],
    ...(surface.policy === "indexable"
      ? { xDefaultUrl: absolutePublicUrl(origin, toLocalizedPath("ko", route)) }
      : {}),
    jsonLd: emptyJsonLd(),
    ...(service ? { service } : {}),
  };
  document.jsonLd = createJsonLdDocument(document);
  return document;
}

function buildArticleDocument(
  origin: string,
  content: PublishedContent,
  article: PublishedArticleDocument,
): SearchDocument {
  assertArticlePublicationQuality(article);
  const localeLinks = articleLocaleLinks(content, article.articleId);
  const korean = localeLinks.find(({ locale }) => locale === "ko");
  const document: SearchDocument = {
    kind: "article",
    policy: "indexable",
    locale: article.locale,
    route: article.route,
    canonicalUrl: absolutePublicUrl(origin, article.route),
    title: `${article.title} | ${siteContent[article.locale].office.name}`,
    description: article.summary,
    h1: article.title,
    lastModified: article.modifiedAt,
    alternates: localeLinks.map(({ locale, href }) => ({
      locale,
      url: absolutePublicUrl(origin, href),
    })),
    ...(korean ? { xDefaultUrl: absolutePublicUrl(origin, korean.href) } : {}),
    jsonLd: emptyJsonLd(),
    article,
  };
  document.jsonLd = createJsonLdDocument(document);
  return document;
}

function assertSearchGraph(documents: readonly SearchDocument[]): void {
  const byCanonical = new Map(documents.map((document) => [document.canonicalUrl, document]));
  if (byCanonical.size !== documents.length) throw new Error("SEARCH_CANONICAL_DUPLICATE");

  for (const document of documents) {
    if (!document.title.trim() || !document.description.trim() || !document.h1.trim()) {
      throw new Error("SEARCH_METADATA_INCOMPLETE");
    }
    if (document.policy === "noindex") {
      if (document.alternates.length || document.xDefaultUrl) throw new Error("SEARCH_NOINDEX_ALTERNATE");
      continue;
    }
    if (!document.alternates.some(({ url }) => url === document.canonicalUrl)) {
      throw new Error("SEARCH_HREFLANG_SELF_MISSING");
    }
    const set = JSON.stringify(document.alternates);
    for (const alternate of document.alternates) {
      const sibling = byCanonical.get(alternate.url);
      if (!sibling || JSON.stringify(sibling.alternates) !== set) {
        throw new Error("SEARCH_HREFLANG_NOT_RECIPROCAL");
      }
    }
    const korean = document.alternates.find(({ locale }) => locale === "ko");
    if (document.xDefaultUrl !== korean?.url) throw new Error("SEARCH_X_DEFAULT_INVALID");
  }

  for (const locale of LOCALES) {
    const localized = documents.filter((document) => (
      document.policy === "indexable" && document.locale === locale
    ));
    for (const values of [
      localized.map(({ title }) => title),
      localized.map(({ description }) => description),
      localized.map(({ h1 }) => h1),
    ]) {
      if (new Set(values).size !== values.length) throw new Error("SEARCH_METADATA_DUPLICATE");
    }
  }
}

export function buildSearchIndex(origin: string, content: PublishedContent): SearchIndex {
  const insightsLastModified = new Map<Locale, string>();
  for (const article of content.articles) {
    const current = insightsLastModified.get(article.locale);
    if (!current || article.modifiedAt > current) {
      insightsLastModified.set(article.locale, article.modifiedAt);
    }
  }
  const documents = [
    ...PUBLIC_ROUTE_ENTRIES.map(({ locale, route }) => buildBaseDocument(
      origin,
      locale,
      route,
      route === "/insights" ? insightsLastModified.get(locale) : undefined,
    )),
    ...content.articles.map((article) => buildArticleDocument(origin, content, article)),
  ];
  assertSearchGraph(documents);
  const indexable = documents.filter(({ policy }) => policy === "indexable");
  const byRoute = new Map(documents.map((document) => [document.route, document]));
  const byCanonical = new Map(documents.map((document) => [document.canonicalUrl, document]));
  const indexNowUrls = indexable.map(({ canonicalUrl }) => canonicalUrl).sort();
  const releaseSetSha256 = createHash("sha256")
    .update(indexNowUrls.join("\n"))
    .digest("hex");
  return {
    origin,
    documents,
    indexable,
    byRoute,
    byCanonical,
    indexNowUrls,
    releaseSetSha256,
  };
}
