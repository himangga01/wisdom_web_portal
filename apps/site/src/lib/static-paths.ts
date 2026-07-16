import type { Locale, PublishedArticleDocument, PublishedConsentBundle } from "@wisdom/shared";

import type { PublishedContent } from "../content/published-articles.js";
import {
  articlesForLocale,
  publishedArticleRouteEntries,
  type ArticleLocaleLink,
} from "./article-routes.js";
import { PUBLIC_ROUTE_ENTRIES, type PublicRoute } from "./routes.js";
import type { SearchDocument, SearchIndex } from "../search/types.js";

export interface BaseStaticPathProps {
  kind: "base";
  locale: Locale;
  route: PublicRoute;
  articles: readonly PublishedArticleDocument[];
  consentBundle: PublishedConsentBundle;
  searchDocument: SearchDocument;
}

export interface ArticleStaticPathProps {
  kind: "article";
  article: PublishedArticleDocument;
  localeLinks: readonly ArticleLocaleLink[];
  xDefaultHref: string | undefined;
  searchDocument: SearchDocument;
}

export type PublicStaticPathProps = BaseStaticPathProps | ArticleStaticPathProps;

export interface PublicStaticPath {
  params: { path: string | undefined };
  props: PublicStaticPathProps;
}

function pathParameter(pathname: string): string | undefined {
  return pathname === "/" ? undefined : pathname.slice(1);
}

function requiredSearchDocument(index: SearchIndex, route: string): SearchDocument {
  const document = index.byRoute.get(route);
  if (!document) throw new Error("SEARCH_STATIC_PATH_MISSING");
  return document;
}

export function createPublicStaticPaths(
  content: PublishedContent,
  searchIndex: SearchIndex,
): readonly PublicStaticPath[] {
  const basePaths: PublicStaticPath[] = PUBLIC_ROUTE_ENTRIES
    .filter(({ pathname }) => pathname !== "/404")
    .map(({ locale, route, pathname }) => ({
      params: { path: pathParameter(pathname) },
      props: {
        kind: "base",
        locale,
        route,
        articles: route === "/insights" ? articlesForLocale(content, locale) : [],
        consentBundle: content.consentBundle,
        searchDocument: requiredSearchDocument(searchIndex, pathname),
      },
    }));
  const articlePaths: PublicStaticPath[] = publishedArticleRouteEntries(content).map((entry) => ({
    params: { path: pathParameter(entry.pathname) },
    props: {
      kind: "article",
      article: entry.article,
      localeLinks: entry.localeLinks,
      xDefaultHref: entry.xDefaultHref,
      searchDocument: requiredSearchDocument(searchIndex, entry.pathname),
    },
  }));
  return [...basePaths, ...articlePaths];
}
