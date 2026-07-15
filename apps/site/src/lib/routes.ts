import { LOCALES, type Locale } from "@wisdom/shared";

export const CONTENT_ROUTES = [
  "/",
  "/about",
  "/services",
  "/services/procurement",
  "/services/credibility",
  "/services/safety-esg",
  "/services/business-certification",
  "/services/licensing-entity",
  "/services/immigration-visa",
  "/process",
  "/insights",
  "/consultation",
  "/location",
  "/privacy",
  "/marketing/withdraw",
] as const;

export type ContentRoute = (typeof CONTENT_ROUTES)[number];
export type PublicRoute = ContentRoute | "/404";

const localePrefixes: Record<Locale, string> = {
  ko: "",
  en: "/en",
  "zh-Hans": "/zh-hans",
  "zh-Hant": "/zh-hant",
};

export function toLocalizedPath(locale: Locale, route: PublicRoute): string {
  const prefix = localePrefixes[locale];
  return route === "/" ? prefix || "/" : `${prefix}${route}`;
}

export const PUBLIC_ROUTE_ENTRIES = LOCALES.flatMap((locale) =>
  [...CONTENT_ROUTES, "/404" as const].map((route) => ({
    locale,
    route,
    pathname: toLocalizedPath(locale, route),
  })),
);

function routeWithoutLocalePrefix(pathname: string): PublicRoute {
  const cleanPath = (pathname.split(/[?#]/, 1)[0] || "/").replace(/\/+$/, "") || "/";
  for (const prefix of ["/zh-hans", "/zh-hant", "/en"] as const) {
    if (cleanPath === prefix) return "/";
    if (cleanPath.startsWith(`${prefix}/`)) {
      return cleanPath.slice(prefix.length) as PublicRoute;
    }
  }
  return cleanPath as PublicRoute;
}

export function localeLinksForPath(pathname: string): Array<{ locale: Locale; href: string }> {
  const route = routeWithoutLocalePrefix(pathname);
  return LOCALES.map((locale) => ({ locale, href: toLocalizedPath(locale, route) }));
}
