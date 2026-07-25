import { PUBLIC_CONTENT_ROUTES } from "@wisdom/shared";
import { describe, expect, it } from "vitest";

import { classifyPageviewPath, referrerOriginFrom } from "./paths.js";

describe("classifyPageviewPath", () => {
  // Every page Site publishes must be countable here. Without this the two
  // workspaces can drift apart and a new page's visits are silently discarded.
  it("classifies every published route in all four locales", () => {
    for (const route of PUBLIC_CONTENT_ROUTES) {
      for (const [prefix, locale] of [
        ["", "ko"],
        ["/en", "en"],
        ["/zh-hans", "zh-Hans"],
        ["/zh-hant", "zh-Hant"],
      ] as const) {
        const pathname = route === "/" ? (prefix || "/") : `${prefix}${route}`;
        expect(classifyPageviewPath(pathname), pathname).toEqual({ path: route, locale });
      }
    }
  });

  it("accepts canonical content routes in every locale prefix", () => {
    expect(classifyPageviewPath("/")).toEqual({ path: "/", locale: "ko" });
    expect(classifyPageviewPath("/en")).toEqual({ path: "/", locale: "en" });
    expect(classifyPageviewPath("/zh-hans/consultation")).toEqual({ path: "/consultation", locale: "zh-Hans" });
    expect(classifyPageviewPath("/zh-hant/services/procurement")).toEqual({ path: "/services/procurement", locale: "zh-Hant" });
  });

  it("accepts published article paths and rejects malformed slugs", () => {
    expect(classifyPageviewPath("/insights/visa-guide-2026")).toEqual({ path: "/insights/visa-guide-2026", locale: "ko" });
    expect(classifyPageviewPath("/en/insights/visa-guide")).toEqual({ path: "/insights/visa-guide", locale: "en" });
    expect(classifyPageviewPath("/insights/Bad-Slug")).toBeUndefined();
    expect(classifyPageviewPath("/insights/-leading")).toBeUndefined();
    expect(classifyPageviewPath(`/insights/${"a".repeat(97)}`)).toBeUndefined();
  });

  it("strips query, fragment, and trailing slash before matching", () => {
    expect(classifyPageviewPath("/about?utm=x#top")).toEqual({ path: "/about", locale: "ko" });
    expect(classifyPageviewPath("/en/about/")).toEqual({ path: "/about", locale: "en" });
  });

  it("rejects unpublished or hostile paths", () => {
    for (const path of ["/admin", "/api/v1/pageview", "/etc/passwd", "/404", "/unknown", "relative", ""]) {
      expect(classifyPageviewPath(path), path).toBeUndefined();
    }
  });
});

describe("referrerOriginFrom", () => {
  const SELF = "https://www.example.test";

  it("keeps only the origin of an external http(s) referrer", () => {
    expect(referrerOriginFrom("https://www.google.com/search?q=%EB%B9%84%EC%9E%90", SELF))
      .toBe("https://www.google.com");
  });

  it("treats same-site, unparseable, and non-http referrers as direct", () => {
    expect(referrerOriginFrom(`${SELF}/insights`, SELF)).toBe("");
    expect(referrerOriginFrom("not a url", SELF)).toBe("");
    expect(referrerOriginFrom("javascript:alert(1)", SELF)).toBe("");
    expect(referrerOriginFrom("", SELF)).toBe("");
    expect(referrerOriginFrom(undefined, SELF)).toBe("");
  });
});
