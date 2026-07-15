import { CONSULTATION_CATEGORIES, designTokens } from "@wisdom/shared";
import { describe, expect, it } from "vitest";

describe("public site behavior contracts", () => {
  it("accepts only configured secure Kakao destinations", async () => {
    const { getKakaoChatUrl } = await import("./site-config.js");

    for (const unsafe of [undefined, "", "   ", "#", "javascript:alert(1)", "http://example.com"]) {
      expect(getKakaoChatUrl(unsafe)).toBeUndefined();
    }
    expect(getKakaoChatUrl(" https://pf.kakao.com/_example/chat ")).toBe(
      "https://pf.kakao.com/_example/chat",
    );
  });

  it("defines the exact shared consultation fields and no attachment field", async () => {
    const { CONSULTATION_FORM } = await import("./site-config.js");

    expect(CONSULTATION_FORM.action).toBe("/api/v1/consultations");
    expect(CONSULTATION_FORM.method).toBe("post");
    expect(CONSULTATION_FORM.fields).toEqual([
      "locale",
      "category",
      "name",
      "phone",
      "email",
      "company",
      "preferredContact",
      "message",
      "privacyConsent",
      "marketingConsent",
    ]);
    expect(CONSULTATION_FORM.categories).toEqual(CONSULTATION_CATEGORIES);
    expect(CONSULTATION_FORM.fields).not.toContain("attachment");
  });

  it("fixes the approved eighteen reveal targets and shared timing tokens", async () => {
    const { HOME_REVEAL_TARGETS } = await import("../motion/reveal-contract.js");

    expect(HOME_REVEAL_TARGETS).toHaveLength(designTokens.motion.homepageReveal.targetCount);
    expect(new Set(HOME_REVEAL_TARGETS.map(({ key }) => key)).size).toBe(18);
    expect(HOME_REVEAL_TARGETS.map(({ delayMs }) => delayMs)).toEqual([
      0, 0, 0, 60, 120, 0, 0, 0, 0, 60, 120, 0, 0, 60, 120, 0, 0, 0,
    ]);
    expect(new Set(HOME_REVEAL_TARGETS.map(({ direction }) => direction))).toEqual(
      new Set(["left", "right", "fade"]),
    );
    expect(designTokens.motion.homepageReveal).toMatchObject({
      durationMs: 500,
      distancePx: 64,
      staggerMs: 60,
    });
  });
});
