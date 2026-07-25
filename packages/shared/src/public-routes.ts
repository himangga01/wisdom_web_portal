/**
 * The approved public content routes, without a locale prefix.
 *
 * This is a cross-workspace contract with two independent consumers that must
 * never disagree: Site generates exactly these pages (four locales each) and
 * Control uses the same list twice — to require every localized page in a
 * publication release, and to allowlist the paths the pageview beacon counts.
 * A route that exists in only one of the two is a silent failure: Site would
 * publish a page whose visits Control discards as unknown. Keeping the list
 * here makes that drift impossible.
 */
export const PUBLIC_CONTENT_ROUTES = [
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

export type PublicContentRoute = (typeof PUBLIC_CONTENT_ROUTES)[number];
