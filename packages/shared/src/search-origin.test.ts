import { describe, expect, it } from "vitest";

import * as shared from "./index.js";

type PublicOriginParser = (
  value: string | undefined,
  options: { production: boolean },
) => string;

describe("shared public origin parser", () => {
  it("exports Site's exact normalized production HTTPS origin contract", () => {
    const parsePublicOrigin = (shared as { parsePublicOrigin?: PublicOriginParser }).parsePublicOrigin;
    expect(typeof parsePublicOrigin).toBe("function");
    if (!parsePublicOrigin) throw new Error("parsePublicOrigin export missing");

    expect(parsePublicOrigin("https://www.jihye-office.kr", { production: true }))
      .toBe("https://www.jihye-office.kr");
    expect(parsePublicOrigin("https://www.example.com", { production: false }))
      .toBe("https://www.example.com");

    for (const value of [
      undefined,
      "http://www.jihye-office.kr",
      "https://www.jihye-office.kr/",
      "https://www.jihye-office.kr/path",
      "https://www.jihye-office.kr:8443",
      "https://WWW.jihye-office.kr",
      "https://www.example.test",
      "https://preview.jihye-office.kr",
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.1",
      "https://portal.local",
      "https://portal",
    ]) {
      expect(() => parsePublicOrigin(value, { production: true }))
        .toThrow("PUBLIC_ORIGIN_INVALID");
    }
  });
});
