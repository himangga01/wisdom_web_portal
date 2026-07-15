import { CONSULTATION_CATEGORIES, LOCALES } from "@wisdom/shared";
import { describe, expect, it } from "vitest";

describe("approved office and service catalog", () => {
  it("exposes the complete six-group catalog in every locale", async () => {
    const { SERVICE_CATEGORY_SLUGS, siteContent } = await import("./site-content.js");
    const expectedSlugs = CONSULTATION_CATEGORIES.filter((slug) => slug !== "other");

    expect(SERVICE_CATEGORY_SLUGS).toEqual(expectedSlugs);
    for (const locale of LOCALES) {
      expect(siteContent[locale].services.categories.map(({ slug }) => slug)).toEqual(expectedSlugs);
      expect(siteContent[locale].services.categories.map(({ items }) => items.length)).toEqual([
        5,
        9,
        4,
        6,
        7,
        12,
      ]);
      for (const category of siteContent[locale].services.categories) {
        expect(category.title.trim()).not.toBe("");
        expect(category.summary.trim()).not.toBe("");
        expect(category.items.every((item) => item.trim() !== "")).toBe(true);
      }
    }
  });

  it("uses only the approved office identity and supplied representative facts", async () => {
    const { OFFICE, REPRESENTATIVE } = await import("./site-content.js");

    expect(OFFICE).toEqual({
      name: "지혜행정사사무소",
      englishName: "JIHYE Administrative Attorney",
      representative: "강지혜 행정사",
      phone: "010-8415-0023",
      fax: "0504-051-0023",
      email: "kjihye0023@naver.com",
      address: "서울특별시 송파구 법원로 92, 212호 (문정동, 파트너스1)",
      blogUrl: "https://m.blog.naver.com/wisdom_jhk",
      mapUrl: "https://naver.me/GprFCirq",
    });
    expect(REPRESENTATIVE.education).toEqual([
      "한양대학교 경영학 학사·석사",
      "아주대학교 대학원 교육학·상담 석사",
      "남서울대학교 AI공공조달학 석사과정",
    ]);
    expect(REPRESENTATIVE.career).toEqual(["공공조달연구소 이사"]);
    expect(REPRESENTATIVE.qualifications).toEqual(["제11회 행정사", "ISO 45001 심사원"]);
    expect(JSON.stringify({ OFFICE, REPRESENTATIVE })).not.toMatch(
      /수상|후기|성공률|성공 사례|순위|고객사/,
    );
  });
});
