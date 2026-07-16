import { describe, expect, it } from "vitest";

import { absolutePublicUrl, parsePublicOrigin } from "./origin.js";

describe("production public origin", () => {
  it("accepts one exact production HTTPS origin and owns absolute URL construction", () => {
    const origin = parsePublicOrigin("https://www.jihye-office.kr", { production: true });

    expect(origin).toBe("https://www.jihye-office.kr");
    expect(absolutePublicUrl(origin, "/en/services/procurement"))
      .toBe("https://www.jihye-office.kr/en/services/procurement");
  });

  it.each([
    undefined,
    "",
    "http://www.jihye-office.kr",
    "https://user:pass@www.jihye-office.kr",
    "https://www.jihye-office.kr/base",
    "https://www.jihye-office.kr/",
    "https://www.jihye-office.kr:443",
    "https://www.JIHYE-office.kr",
    "https://www.jihye-office.kr?preview=1",
    "https://localhost",
    "https://127.0.0.1",
    "https://www.example.com",
    "https://www.example.test",
    "https://staging.jihye-office.kr",
    "https://preview.jihye-office.kr",
  ])("rejects missing, non-production, staging, or non-origin input: %s", (value) => {
    expect(() => parsePublicOrigin(value, { production: true })).toThrow(
      "PUBLIC_ORIGIN_INVALID",
    );
  });

  it("allows an explicit test origin only outside the production gate", () => {
    expect(parsePublicOrigin("https://www.example.test", { production: false }))
      .toBe("https://www.example.test");
  });

  it.each(["relative", "//other.test/path", "/path?query=1", "/path#fragment"])(
    "rejects a non-canonical public path: %s",
    (path) => {
      expect(() => absolutePublicUrl("https://www.jihye-office.kr", path)).toThrow(
        "PUBLIC_PATH_INVALID",
      );
    },
  );
});
