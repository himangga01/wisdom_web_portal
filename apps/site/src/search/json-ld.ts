import type { Locale, PublishedArticleDocument } from "@wisdom/shared";

import { OFFICE, siteContent } from "../content/site-content.js";
import { toLocalizedPath } from "../lib/routes.js";
import { absolutePublicUrl } from "./origin.js";
import type { JsonLdDocument, SearchDocument } from "./types.js";

interface BreadcrumbListItem {
  "@type": "ListItem";
  position: number;
  name: string;
  item: string;
}

function representativeRole(locale: Locale): string {
  return locale === "ko" ? "대표행정사"
    : locale === "en" ? "Representative Administrative Attorney"
      : "代表行政士";
}

function representativeName(locale: Locale): string {
  return locale === "ko" ? "강지혜"
    : locale === "en" ? "Jihye Kang"
      : "姜智慧";
}

function professionalService(document: SearchDocument): Record<string, unknown> {
  const content = siteContent[document.locale];
  const origin = new URL(document.canonicalUrl).origin;
  return {
    "@type": "ProfessionalService",
    "@id": `${origin}/#professional-service`,
    name: content.office.name,
    alternateName: OFFICE.englishName,
    url: absolutePublicUrl(origin, toLocalizedPath(document.locale, "/")),
    telephone: OFFICE.phone,
    email: OFFICE.email,
    address: content.office.address,
    inLanguage: document.locale,
  };
}

function representative(document: SearchDocument): Record<string, unknown> {
  const origin = new URL(document.canonicalUrl).origin;
  return {
    "@type": "Person",
    "@id": `${origin}/#representative`,
    name: representativeName(document.locale),
    jobTitle: representativeRole(document.locale),
    worksFor: { "@id": `${origin}/#professional-service` },
  };
}

function breadcrumbs(document: SearchDocument): Record<string, unknown> {
  const content = siteContent[document.locale];
  const origin = new URL(document.canonicalUrl).origin;
  const home = absolutePublicUrl(origin, toLocalizedPath(document.locale, "/"));
  const items: BreadcrumbListItem[] = [{
    "@type": "ListItem",
    position: 1,
    name: content.navigation.home,
    item: home,
  }];
  if (document.kind === "service") {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: content.navigation.services,
      item: absolutePublicUrl(origin, toLocalizedPath(document.locale, "/services")),
    });
  } else if (document.kind === "article") {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: content.navigation.insights,
      item: absolutePublicUrl(origin, toLocalizedPath(document.locale, "/insights")),
    });
  }
  if (document.canonicalUrl !== home) {
    items.push({
      "@type": "ListItem",
      position: items.length + 1,
      name: document.h1,
      item: document.canonicalUrl,
    });
  }
  return {
    "@type": "BreadcrumbList",
    "@id": `${document.canonicalUrl}#breadcrumb`,
    itemListElement: items,
  };
}

function serviceNode(document: SearchDocument): Record<string, unknown> {
  const origin = new URL(document.canonicalUrl).origin;
  return {
    "@type": "Service",
    "@id": `${document.canonicalUrl}#service`,
    name: document.h1,
    description: document.description,
    url: document.canonicalUrl,
    inLanguage: document.locale,
    provider: { "@id": `${origin}/#professional-service` },
  };
}

function articleNode(document: SearchDocument, article: PublishedArticleDocument): Record<string, unknown> {
  const origin = new URL(document.canonicalUrl).origin;
  return {
    "@type": "Article",
    "@id": `${document.canonicalUrl}#article`,
    headline: document.h1,
    description: document.description,
    url: document.canonicalUrl,
    mainEntityOfPage: document.canonicalUrl,
    inLanguage: document.locale,
    datePublished: article.firstPublishedAt,
    dateModified: article.modifiedAt,
    reviewedBy: {
      "@type": "Person",
      // Only bind to the representative entity when the reviewer actually is the
      // representative; otherwise a distinct reviewer would be falsely asserted
      // as the same person as the representative node.
      ...(article.reviewer.name === representativeName(document.locale)
        ? { "@id": `${origin}/#representative` }
        : {}),
      name: article.reviewer.name,
      jobTitle: article.reviewer.role,
    },
    citation: article.sources.map(({ url }) => url),
  };
}

export function createJsonLdDocument(document: SearchDocument): JsonLdDocument {
  if (document.policy !== "indexable") {
    return { "@context": "https://schema.org", "@graph": [] };
  }
  return {
    "@context": "https://schema.org",
    "@graph": [
      professionalService(document),
      representative(document),
      ...(document.service ? [serviceNode(document)] : []),
      ...(document.article ? [articleNode(document, document.article)] : []),
      breadcrumbs(document),
    ],
  };
}

export function safeJsonLdStringify(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
