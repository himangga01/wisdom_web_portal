import { describe, expect, it } from "vitest";

import {
  adminConsultationListSchema,
  adminDashboardSchema,
  adminSessionSchema,
} from "./admin-api.js";

describe("administrator API runtime schemas", () => {
  it("rejects missing fields, invalid enums, unknown keys, and oversized arrays", () => {
    expect(adminSessionSchema.safeParse({
      stage: "authenticated",
      adminId: "owner",
      csrfToken: "csrf",
      expiresAtMs: 1,
    }).success).toBe(false);
    expect(adminSessionSchema.safeParse({
      stage: "owner",
      adminId: "owner",
      csrfToken: "csrf",
      expiresAtMs: 1,
      idleExpiresAtMs: 1,
    }).success).toBe(false);
    expect(adminDashboardSchema.safeParse({
      counts: [],
      unexpected: true,
    }).success).toBe(false);
    expect(adminConsultationListSchema.safeParse({
      items: Array.from({ length: 21 }, (_, index) => ({
        id: `id-${index}`,
        receiptId: `receipt-${index}`,
        status: "received",
        locale: "ko",
        category: "other",
        receivedAtMs: index,
      })),
      page: { page: 1, pageSize: 20, total: 21, pageCount: 2 },
    }).success).toBe(false);
  });
});
