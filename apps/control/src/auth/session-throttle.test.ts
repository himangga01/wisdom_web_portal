import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import * as controlModule from "../index.js";
import { closeDatabase, openDatabase } from "../db/client.js";

const control = controlModule as unknown as Record<string, unknown>;
const authSecret = Buffer.alloc(32, 31);
let testDatabase: TestDatabase | undefined;
const closeAfter: Array<() => void> = [];

afterEach(() => {
  while (closeAfter.length > 0) closeAfter.pop()?.();
  testDatabase?.close();
  testDatabase = undefined;
});

function requiredFunction<T>(name: string): T {
  expect(control[name], `${name} must be exported`).toBeTypeOf("function");
  return control[name] as T;
}

function insertAdmin(id = "admin-1", username = "owner"): void {
  testDatabase!.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Owner', 'placeholder', 'active', 0, 0)
  `).run(id, username);
}

describe("administrator sessions", () => {
  it("stores only independent 32-byte digests and emits the exact host cookie", () => {
    const createSession = requiredFunction<(
      db: TestDatabase["db"],
      secret: Uint8Array,
      adminId: string,
      nowMs: number,
    ) => {
      sessionToken: string;
      csrfToken: string;
      cookie: string;
      expiresAtMs: number;
      idleExpiresAtMs: number;
    }>("createAdminSession");
    testDatabase = createTestDatabase();
    insertAdmin();

    const session = createSession(testDatabase.db, authSecret, "admin-1", 0);
    expect(Buffer.from(session.sessionToken, "base64url")).toHaveLength(32);
    expect(Buffer.from(session.csrfToken, "base64url")).toHaveLength(32);
    expect(session.sessionToken).not.toBe(session.csrfToken);
    expect(session.cookie).toBe(
      `__Host-wisdom-admin=${session.sessionToken}.${session.csrfToken}; Secure; HttpOnly; SameSite=Strict; Path=/`,
    );
    expect(session.cookie).not.toContain("Domain=");
    expect(session.expiresAtMs).toBe(8 * 60 * 60 * 1_000);
    expect(session.idleExpiresAtMs).toBe(30 * 60 * 1_000);
    const row = testDatabase.db.sqlite.prepare(
      "SELECT token_hash, csrf_hash FROM admin_sessions",
    ).get() as Record<string, unknown>;
    expect(row.token_hash).toBeInstanceOf(Buffer);
    expect(row.csrf_hash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(row)).not.toContain(session.sessionToken);
    expect(JSON.stringify(row)).not.toContain(session.csrfToken);
  });

  it("enforces idle and absolute boundaries, renews idleness, and validates CSRF", () => {
    const createSession = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, adminId: string, nowMs: number,
    ) => { sessionToken: string; csrfToken: string; cookie: string }>("createAdminSession");
    const resolveSession = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, cookieHeader: string, nowMs: number,
    ) => { adminId: string; csrfToken: string; expiresAtMs: number; idleExpiresAtMs: number } | undefined>(
      "resolveAdminSession",
    );
    const verifyCsrf = requiredFunction<(
      secret: Uint8Array, sessionToken: string, expectedHash: Uint8Array, supplied: string,
    ) => boolean>("verifyAdminCsrf");
    testDatabase = createTestDatabase();
    insertAdmin();

    const active = createSession(testDatabase.db, authSecret, "admin-1", 0);
    const cookieHeader = active.cookie.split(";", 1)[0]!;
    const resolved = resolveSession(testDatabase.db, authSecret, cookieHeader, 30 * 60 * 1_000 - 1);
    expect(resolved).toMatchObject({ adminId: "admin-1", csrfToken: active.csrfToken });
    expect(resolved?.idleExpiresAtMs).toBe(60 * 60 * 1_000 - 1);
    const stored = testDatabase.db.sqlite.prepare(
      "SELECT csrf_hash FROM admin_sessions WHERE admin_id = 'admin-1' ORDER BY created_at_ms LIMIT 1",
    ).get() as { csrf_hash: Buffer };
    expect(verifyCsrf(authSecret, active.sessionToken, stored.csrf_hash, active.csrfToken)).toBe(true);
    expect(verifyCsrf(authSecret, active.sessionToken, stored.csrf_hash, "wrong")).toBe(false);

    const idleExpired = createSession(testDatabase.db, authSecret, "admin-1", 100_000);
    expect(resolveSession(
      testDatabase.db,
      authSecret,
      idleExpired.cookie.split(";", 1)[0]!,
      100_000 + 30 * 60 * 1_000,
    )).toBeUndefined();

    const absolute = createSession(testDatabase.db, authSecret, "admin-1", 200_000);
    expect(resolveSession(
      testDatabase.db,
      authSecret,
      absolute.cookie.split(";", 1)[0]!,
      200_000 + 8 * 60 * 60 * 1_000,
    )).toBeUndefined();
  });

  it("revokes one session on logout and every session on credential replacement", () => {
    const createSession = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, adminId: string, nowMs: number,
    ) => { sessionToken: string; cookie: string }>("createAdminSession");
    const revokeSession = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, sessionToken: string, nowMs: number,
    ) => boolean>("revokeAdminSession");
    const revokeAll = requiredFunction<(
      db: TestDatabase["db"], adminId: string, nowMs: number,
    ) => number>("revokeAllAdminSessions");
    const resolveSession = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, cookieHeader: string, nowMs: number,
    ) => unknown>("resolveAdminSession");
    testDatabase = createTestDatabase();
    insertAdmin();
    const first = createSession(testDatabase.db, authSecret, "admin-1", 0);
    const second = createSession(testDatabase.db, authSecret, "admin-1", 1);

    expect(revokeSession(testDatabase.db, authSecret, first.sessionToken, 10)).toBe(true);
    expect(resolveSession(testDatabase.db, authSecret, first.cookie.split(";", 1)[0]!, 11)).toBeUndefined();
    expect(revokeAll(testDatabase.db, "admin-1", 12)).toBe(1);
    expect(resolveSession(testDatabase.db, authSecret, second.cookie.split(";", 1)[0]!, 13)).toBeUndefined();
  });
});

describe("durable dual-axis login throttle", () => {
  it("blocks at five username and twenty source failures and expires at fifteen minutes", () => {
    const status = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => { allowed: boolean; usernameFailures: number; sourceFailures: number }>("adminLoginThrottleStatus");
    const fail = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => void>("recordAdminLoginFailure");
    testDatabase = createTestDatabase();

    for (let index = 0; index < 5; index += 1) fail(testDatabase.db, authSecret, " Owner ", "203.0.113.10", 1);
    expect(status(testDatabase.db, authSecret, "owner", "203.0.113.11", 1)).toMatchObject({
      allowed: false,
      usernameFailures: 5,
    });

    for (let index = 0; index < 15; index += 1) {
      fail(testDatabase.db, authSecret, `other-${index}`, "203.0.113.10", 1);
    }
    expect(status(testDatabase.db, authSecret, "fresh-user", "203.0.113.10", 1)).toMatchObject({
      allowed: false,
      sourceFailures: 20,
    });
    expect(status(testDatabase.db, authSecret, "owner", "203.0.113.10", 15 * 60 * 1_000)).toEqual({
      allowed: true,
      usernameFailures: 0,
      sourceFailures: 0,
      usernameAdmissions: 0,
      sourceAdmissions: 0,
    });
  });

  it("serializes concurrent increments and resets only after full MFA success", () => {
    const status = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => { allowed: boolean; usernameFailures: number; sourceFailures: number }>("adminLoginThrottleStatus");
    const fail = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => void>("recordAdminLoginFailure");
    const reset = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string,
    ) => void>("resetAdminLoginFailures");
    testDatabase = createTestDatabase();
    const second = openDatabase(testDatabase.path);
    closeAfter.push(() => closeDatabase(second));

    fail(testDatabase.db, authSecret, "owner", "203.0.113.10", 1);
    fail(second, authSecret, "owner", "203.0.113.10", 1);
    expect(status(testDatabase.db, authSecret, "owner", "203.0.113.10", 1)).toMatchObject({
      usernameFailures: 2,
      sourceFailures: 2,
    });
    reset(testDatabase.db, authSecret, "owner", "203.0.113.10");
    expect(status(testDatabase.db, authSecret, "owner", "203.0.113.10", 1)).toEqual({
      allowed: true,
      usernameFailures: 0,
      sourceFailures: 0,
      usernameAdmissions: 0,
      sourceAdmissions: 0,
    });
  });
});
