import { LOCALES } from "@wisdom/shared";
import { describe, expect, it } from "vitest";

describe("typed localized site content", () => {
  it("has non-empty core translations and fails closed on a missing key", async () => {
    const { siteContent, validateSiteContent } = await import("./site-content.js");

    expect(Object.keys(siteContent)).toEqual(LOCALES);
    expect(() => validateSiteContent(siteContent)).not.toThrow();

    const incomplete = structuredClone(siteContent);
    incomplete.en.navigation.home = "";
    expect(() => validateSiteContent(incomplete)).toThrow("en.navigation.home");

    const missing = structuredClone(siteContent);
    Reflect.deleteProperty(missing.en.navigation, "about");
    expect(() => validateSiteContent(missing)).toThrow("en.navigation.about");
  });

  it("contains every required localized content section", async () => {
    const { siteContent } = await import("./site-content.js");

    for (const locale of LOCALES) {
      const content = siteContent[locale];
      expect(Object.keys(content.navigation)).toEqual([
        "home",
        "about",
        "services",
        "process",
        "insights",
        "consultation",
        "location",
      ]);
      expect(Object.keys(content.buttons)).toEqual([
        "consultation",
        "phone",
        "kakao",
        "blog",
        "map",
        "exploreServices",
        "backHome",
      ]);
      expect(Object.keys(content.headings)).toEqual([
        "home",
        "about",
        "services",
        "process",
        "insights",
        "consultation",
        "location",
        "privacy",
        "marketingWithdraw",
        "notFound",
      ]);
      expect(Object.keys(content.meta)).toEqual([
        "home",
        "about",
        "services",
        "process",
        "insights",
        "consultation",
        "location",
        "privacy",
        "marketingWithdraw",
        "notFound",
      ]);
      expect(content.forms.consultation).toMatchObject({
        labels: expect.any(Object),
        help: expect.any(Object),
        errors: expect.any(Object),
      });
      expect(content.footer).toEqual(expect.any(Object));
      expect(content.office).toEqual(expect.any(Object));
      expect(content.policies).toEqual(expect.any(Object));
    }
  });

  it("uses local i18next resources without locale fallback", async () => {
    const { createTranslator, i18nOptions } = await import("../i18n/index.js");

    expect(i18nOptions.fallbackLng).toBe(false);
    for (const locale of LOCALES) {
      const t = await createTranslator(locale);
      expect(t("navigation.home").trim()).not.toBe("");
      expect(t("forms.consultation.submit").trim()).not.toBe("");
      expect(t("meta.home.title").trim()).not.toBe("");
    }
  });
});
