import {
  LOCALES,
  publishedArticleRoute,
  type Locale,
  type PublishedArticleDocument,
} from "@wisdom/shared";

import type { PublishedContent } from "../content/published-articles.js";

export interface ArticleLocaleLink {
  locale: Locale;
  href: string;
}

export interface PublishedArticleRouteEntry {
  kind: "article";
  pathname: string;
  locale: Locale;
  article: PublishedArticleDocument;
  localeLinks: readonly ArticleLocaleLink[];
  xDefaultHref: string | undefined;
}

export function articleRoute(locale: Locale, slug: string): string {
  return publishedArticleRoute(locale, slug);
}

export function articleLocaleLinks(
  content: PublishedContent,
  articleId: string,
): readonly ArticleLocaleLink[] {
  const related = content.byArticleId.get(articleId) ?? [];
  return LOCALES.flatMap((locale) => {
    const article = related.find((candidate) => candidate.locale === locale);
    return article ? [{ locale, href: article.route }] : [];
  });
}

export function articlesForLocale(
  content: PublishedContent,
  locale: Locale,
): readonly PublishedArticleDocument[] {
  return content.articles.filter((article) => article.locale === locale);
}

export function publishedArticleRouteEntries(
  content: PublishedContent,
): readonly PublishedArticleRouteEntry[] {
  return content.articles.map((article) => {
    const localeLinks = articleLocaleLinks(content, article.articleId);
    return {
      kind: "article",
      pathname: article.route,
      locale: article.locale,
      article,
      localeLinks,
      xDefaultHref: localeLinks.find(({ locale }) => locale === "ko")?.href,
    };
  });
}
