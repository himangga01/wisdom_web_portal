import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { applyRateLimitsInTransaction, type RateLimitInput } from "./rate-limit.js";

const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 5) });
let database: TestDatabase | undefined;
afterEach(() => database?.close());

function attempt(input: RateLimitInput, nowMs: number) {
  database!.db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = applyRateLimitsInTransaction(database!.db, provider, input, nowMs);
    database!.db.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (database!.db.sqlite.inTransaction) database!.db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

describe("daily abuse limits", () => {
  it("expires counters one hour after their fixed window closes", () => {
    database = createTestDatabase();
    const start = Date.UTC(2026, 6, 16, 0, 0, 0);
    expect(attempt({ clientIp: "198.51.100.1", phone: "01012345678" }, start)).toEqual({ allowed: true });
    expect(database.db.sqlite.prepare(`
      SELECT window_kind, expires_at_ms FROM abuse_buckets
      WHERE subject_kind = 'ip' ORDER BY window_kind
    `).all()).toEqual([
      { window_kind: "day", expires_at_ms: start + 25 * 60 * 60 * 1_000 },
      { window_kind: "ten_minute", expires_at_ms: start + 70 * 60 * 1_000 },
    ]);
  });

  it("allows ten contact submissions across ten-minute windows and rejects the eleventh", () => {
    database = createTestDatabase();
    const start = Date.UTC(2026, 6, 16, 0, 0, 0);
    for (let index = 0; index < 10; index += 1) {
      expect(attempt({
        clientIp: `198.51.100.${index + 1}`,
        phone: "01012345678",
      }, start + index * 10 * 60 * 1_000)).toEqual({ allowed: true });
    }
    expect(attempt({
      clientIp: "198.51.100.20",
      phone: "01012345678",
    }, start + 10 * 10 * 60 * 1_000)).toMatchObject({ allowed: false });
  });

  it("allows twenty IP submissions across ten-minute windows and rejects the twenty-first", () => {
    database = createTestDatabase();
    const start = Date.UTC(2026, 6, 16, 0, 0, 0);
    for (let index = 0; index < 20; index += 1) {
      expect(attempt({
        clientIp: "198.51.100.50",
        phone: `0100000${String(index).padStart(4, "0")}`,
      }, start + index * 10 * 60 * 1_000)).toEqual({ allowed: true });
    }
    expect(attempt({
      clientIp: "198.51.100.50",
      phone: "01099999999",
    }, start + 20 * 10 * 60 * 1_000)).toMatchObject({ allowed: false });
  });

  it("uses the latest reset when ten-minute and daily limits are exceeded together", () => {
    database = createTestDatabase();
    const start = Date.UTC(2026, 6, 16, 0, 0, 0);
    for (let index = 0; index < 7; index += 1) {
      expect(attempt({
        clientIp: `198.51.100.${index + 1}`,
        phone: "01012345678",
      }, start + index * 10 * 60 * 1_000)).toEqual({ allowed: true });
    }
    const crowdedWindow = start + 12 * 60 * 60 * 1_000 + 1_000;
    for (let index = 0; index < 3; index += 1) {
      expect(attempt({
        clientIp: `203.0.113.${index + 1}`,
        phone: "01012345678",
      }, crowdedWindow)).toEqual({ allowed: true });
    }

    expect(attempt({
      clientIp: "203.0.113.10",
      phone: "01012345678",
    }, crowdedWindow)).toEqual({
      allowed: false,
      retryAfterSeconds: Math.ceil((start + 24 * 60 * 60 * 1_000 - crowdedWindow) / 1_000),
    });
  });
});
