import { describe, expect, it } from "vitest";

import * as contractModule from "./contracts.js";

interface RuntimeSchema {
  safeParse(input: unknown): { success: boolean };
}

const contracts = contractModule as unknown as Record<string, unknown>;

function schema(name: string): RuntimeSchema {
  const candidate = contracts[name];
  expect(candidate, `${name} must be exported`).toBeDefined();
  return candidate as RuntimeSchema;
}

describe("shared contract enums", () => {
  it("accepts exactly the four launch locales", () => {
    expect(contracts.LOCALES).toEqual(["ko", "en", "zh-Hans", "zh-Hant"]);

    const localeSchema = schema("localeSchema");
    for (const locale of ["ko", "en", "zh-Hans", "zh-Hant"]) {
      expect(localeSchema.safeParse(locale).success).toBe(true);
    }
    expect(localeSchema.safeParse("zh").success).toBe(false);
  });

  it("accepts exactly the approved consultation categories", () => {
    expect(contracts.CONSULTATION_CATEGORIES).toEqual([
      "procurement",
      "credibility",
      "safety-esg",
      "business-certification",
      "licensing-entity",
      "immigration-visa",
      "other",
    ]);

    const categorySchema = schema("consultationCategorySchema");
    for (const category of contracts.CONSULTATION_CATEGORIES as string[]) {
      expect(categorySchema.safeParse(category).success).toBe(true);
    }
    expect(categorySchema.safeParse("unknown").success).toBe(false);
  });

  it("accepts exactly the approved consultation statuses", () => {
    expect(contracts.CONSULTATION_STATUSES).toEqual([
      "received",
      "acknowledged",
      "in_progress",
      "closed",
      "spam",
    ]);

    const statusSchema = schema("consultationStatusSchema");
    for (const status of contracts.CONSULTATION_STATUSES as string[]) {
      expect(statusSchema.safeParse(status).success).toBe(true);
    }
    expect(statusSchema.safeParse("published").success).toBe(false);
  });

  it("accepts phone and email as the only preferred contact methods", () => {
    expect(contracts.PREFERRED_CONTACT_METHODS).toEqual(["phone", "email"]);

    const preferredContactSchema = schema("preferredContactSchema");
    expect(preferredContactSchema.safeParse("phone").success).toBe(true);
    expect(preferredContactSchema.safeParse("email").success).toBe(true);
    expect(preferredContactSchema.safeParse("kakao").success).toBe(false);
  });

  it("publishes the approved notification and article enums", () => {
    expect(contracts.NOTIFICATION_CHANNELS).toEqual(["email", "hermes-telegram"]);
    expect(contracts.EMAIL_PAYLOAD_MODES).toEqual(["receipt-only", "full-inquiry"]);
    expect(contracts.ARTICLE_STATES).toEqual([
      "draft",
      "in_review",
      "approved",
      "published",
      "rejected",
    ]);

    expect(schema("notificationChannelSchema").safeParse("sms").success).toBe(false);
    expect(schema("emailPayloadModeSchema").safeParse("receipt-only").success).toBe(true);
    expect(schema("articleStateSchema").safeParse("published").success).toBe(true);
  });
});

describe("shared API shapes", () => {
  it("accepts only a received consultation receipt with an ISO timestamp", () => {
    const receiptSchema = schema("consultationReceiptSchema");

    expect(
      receiptSchema.safeParse({
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "2026-07-15T04:30:00.000Z",
        status: "received",
      }).success,
    ).toBe(true);
    expect(
      receiptSchema.safeParse({
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "15 July 2026",
        status: "acknowledged",
      }).success,
    ).toBe(false);
  });

  it("validates API errors with optional field errors and a required request id", () => {
    const errorSchema = schema("apiErrorSchema");

    expect(
      errorSchema.safeParse({
        code: "VALIDATION_ERROR",
        message: "입력값을 확인해 주세요.",
        fieldErrors: { email: ["올바른 이메일 주소를 입력해 주세요."] },
        requestId: "request_01JZZZZZZZZZZZZZZZZZZZZZZZ",
      }).success,
    ).toBe(true);
    expect(
      errorSchema.safeParse({
        code: "VALIDATION_ERROR",
        message: "입력값을 확인해 주세요.",
      }).success,
    ).toBe(false);
  });
});
