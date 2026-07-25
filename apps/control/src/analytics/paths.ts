import { PUBLIC_CONTENT_ROUTES } from "@wisdom/shared";

// Beacon payload validation. Only paths the site actually publishes are
// counted, so junk submissions cannot pollute the statistics with arbitrary
// strings; everything else is silently dropped by the endpoint.

export type AnalyticsLocale = "ko" | "en" | "zh-Hans" | "zh-Hant";

const LOCALE_PREFIXES: ReadonlyArray<readonly [string, AnalyticsLocale]> = [
  ["/en", "en"],
  ["/zh-hans", "zh-Hans"],
  ["/zh-hant", "zh-Hant"],
];

const ARTICLE_PATH = /^\/insights\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const MAX_PATH_LENGTH = 512;
const MAX_SLUG_LENGTH = 96;

export interface ClassifiedPageviewPath {
  /** Canonical route without the locale prefix (e.g. "/insights/some-slug"). */
  path: string;
  locale: AnalyticsLocale;
}

export function classifyPageviewPath(raw: string): ClassifiedPageviewPath | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PATH_LENGTH) return undefined;
  if (!raw.startsWith("/")) return undefined;
  let path = raw;
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") path = "/";

  let locale: AnalyticsLocale = "ko";
  let route = path;
  for (const [prefix, prefixLocale] of LOCALE_PREFIXES) {
    if (path === prefix) {
      locale = prefixLocale;
      route = "/";
      break;
    }
    if (path.startsWith(`${prefix}/`)) {
      locale = prefixLocale;
      route = path.slice(prefix.length);
      break;
    }
  }

  if ((PUBLIC_CONTENT_ROUTES as readonly string[]).includes(route)) return { path: route, locale };
  const article = ARTICLE_PATH.exec(route);
  if (article && article[1] !== undefined && article[1].length <= MAX_SLUG_LENGTH) {
    return { path: route, locale };
  }
  return undefined;
}

const MAX_REFERRER_ORIGIN_LENGTH = 128;

/**
 * Reduces a raw document.referrer to its origin. Same-site navigation and
 * anything unparseable or non-http(s) counts as direct ("").
 */
export function referrerOriginFrom(raw: unknown, selfOrigin: string | undefined): string {
  if (typeof raw !== "string" || raw === "" || raw.length > 2_048) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  const origin = parsed.origin;
  if (origin === "null" || origin.length > MAX_REFERRER_ORIGIN_LENGTH) return "";
  if (selfOrigin !== undefined && origin === selfOrigin) return "";
  return origin;
}
