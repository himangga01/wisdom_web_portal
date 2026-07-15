import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";

import * as consultationModule from "./consultation.js";

const consultation = consultationModule as unknown as Record<string, unknown>;

function requestSchema(): ZodType {
  const candidate = consultation.consultationRequestSchema;
  expect(candidate, "consultationRequestSchema must be exported").toBeDefined();
  return candidate as ZodType;
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locale: "ko",
    category: "procurement",
    name: "홍길동",
    phone: "010-1234-5678",
    preferredContact: "phone",
    message: "공공조달 등록 준비 절차와 필요한 서류를 상담하고 싶습니다.",
    privacyConsent: { version: "2026-07-15", accepted: true },
    marketingConsent: { version: "2026-07-15", accepted: false },
    ...overrides,
  };
}

function issuePaths(result: ReturnType<ZodType["safeParse"]>): string[] {
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => issue.path.map(String).join("."));
}

describe("consultation request validation", () => {
  it("accepts an approved request and normalizes trimmed contact fields", () => {
    const result = requestSchema().safeParse(
      validRequest({
        name: "  홍길동  ",
        phone: "+82 (10) 1234-5678",
        email: "  client@example.com  ",
        company: "  지혜기업  ",
        message: "  공공조달 등록 준비 절차와 필요한 서류를 상담하고 싶습니다.  ",
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        name: "홍길동",
        phone: "+821012345678",
        email: "client@example.com",
        company: "지혜기업",
        message: "공공조달 등록 준비 절차와 필요한 서류를 상담하고 싶습니다.",
      });
    }
  });

  it("requires versioned privacy consent accepted as true", () => {
    const rejected = requestSchema().safeParse(
      validRequest({ privacyConsent: { version: "2026-07-15", accepted: false } }),
    );
    const missingVersion = requestSchema().safeParse(
      validRequest({ privacyConsent: { version: "   ", accepted: true } }),
    );

    expect(rejected.success).toBe(false);
    expect(issuePaths(rejected)).toContain("privacyConsent.accepted");
    expect(missingVersion.success).toBe(false);
    expect(issuePaths(missingVersion)).toContain("privacyConsent.version");
  });

  it("requires email when email is the preferred contact method", () => {
    const result = requestSchema().safeParse(validRequest({ preferredContact: "email" }));

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("email");
  });

  it("requires email when marketing consent is accepted", () => {
    const result = requestSchema().safeParse(
      validRequest({
        marketingConsent: { version: "2026-07-15", accepted: true },
      }),
    );

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("email");
  });

  it("uses standard email validation when an email is present", () => {
    const invalid = requestSchema().safeParse(validRequest({ email: "not-an-email" }));
    const valid = requestSchema().safeParse(
      validRequest({ preferredContact: "email", email: "client@example.com" }),
    );

    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toContain("email");
    expect(valid.success).toBe(true);
  });

  it("enforces the trimmed message length from 20 through 2000 characters", () => {
    const minimum = requestSchema().safeParse(validRequest({ message: `  ${"가".repeat(20)}  ` }));
    const belowMinimum = requestSchema().safeParse(validRequest({ message: "가".repeat(19) }));
    const maximum = requestSchema().safeParse(validRequest({ message: "가".repeat(2000) }));
    const aboveMaximum = requestSchema().safeParse(validRequest({ message: "가".repeat(2001) }));

    expect(minimum.success).toBe(true);
    if (minimum.success) {
      expect(minimum.data).toMatchObject({ message: "가".repeat(20) });
    }
    expect(belowMinimum.success).toBe(false);
    expect(maximum.success).toBe(true);
    expect(aboveMaximum.success).toBe(false);
  });

  it("enforces name, company, and normalized phone boundaries", () => {
    expect(requestSchema().safeParse(validRequest({ name: "가" })).success).toBe(false);
    expect(requestSchema().safeParse(validRequest({ name: "가".repeat(50) })).success).toBe(true);
    expect(requestSchema().safeParse(validRequest({ name: "가".repeat(51) })).success).toBe(false);
    expect(requestSchema().safeParse(validRequest({ company: "가".repeat(100) })).success).toBe(true);
    expect(requestSchema().safeParse(validRequest({ company: "가".repeat(101) })).success).toBe(false);
    expect(requestSchema().safeParse(validRequest({ phone: "12-34 56-78" })).success).toBe(true);
    expect(requestSchema().safeParse(validRequest({ phone: "123-4567" })).success).toBe(false);
    expect(requestSchema().safeParse(validRequest({ phone: "1".repeat(20) })).success).toBe(true);
    expect(requestSchema().safeParse(validRequest({ phone: "1".repeat(21) })).success).toBe(false);
    expect(requestSchema().safeParse(validRequest({ phone: "010/1234/5678" })).success).toBe(false);
  });
});
