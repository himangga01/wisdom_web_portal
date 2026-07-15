import { describe, expect, it } from "vitest";

const expectedContentRoutes = [
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

describe("localized public route generation", () => {
  it("generates every approved content route and localized 404 for four locales", async () => {
    const routes = await import("./routes.js");

    expect(routes.CONTENT_ROUTES).toEqual(expectedContentRoutes);
    expect(routes.PUBLIC_ROUTE_ENTRIES).toHaveLength(64);
    expect(new Set(routes.PUBLIC_ROUTE_ENTRIES.map(({ pathname }) => pathname)).size).toBe(64);

    for (const locale of ["ko", "en", "zh-Hans", "zh-Hant"] as const) {
      for (const route of [...expectedContentRoutes, "/404"] as const) {
        expect(routes.PUBLIC_ROUTE_ENTRIES).toContainEqual({
          locale,
          route,
          pathname: routes.toLocalizedPath(locale, route),
        });
      }
    }
  });

  it("preserves the ASCII route while changing only the locale prefix", async () => {
    const { localeLinksForPath } = await import("./routes.js");

    expect(localeLinksForPath("/zh-hans/services/procurement")).toEqual([
      { locale: "ko", href: "/services/procurement" },
      { locale: "en", href: "/en/services/procurement" },
      { locale: "zh-Hans", href: "/zh-hans/services/procurement" },
      { locale: "zh-Hant", href: "/zh-hant/services/procurement" },
    ]);
    expect(localeLinksForPath("/en")).toEqual([
      { locale: "ko", href: "/" },
      { locale: "en", href: "/en" },
      { locale: "zh-Hans", href: "/zh-hans" },
      { locale: "zh-Hant", href: "/zh-hant" },
    ]);
  });
});
