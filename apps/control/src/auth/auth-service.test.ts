import argon2 from "argon2";
import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import * as controlModule from "../index.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { closeDatabase, openDatabase, runMigrations } from "../db/client.js";

const control = controlModule as unknown as Record<string, unknown>;
const authSecret = Buffer.alloc(32, 41);
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 7) });
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function requiredFunction<T>(name: string): T {
  expect(control[name], `${name} must be exported`).toBeTypeOf("function");
  return control[name] as T;
}

type BeginLogin = (
  context: {
    db: TestDatabase["db"];
    keyProvider: typeof keyProvider;
    authSecret: Uint8Array;
    dummyPasswordHash: string;
  },
  input: { username: string; password: string; source: string; nowMs: number },
  options?: {
    verifyPassword?: typeof import("./password.js").verifyAdminPassword;
    hashPassword?: typeof import("./password.js").hashAdminPassword;
  },
) => Promise<
  | { kind: "invalid" }
  | {
      kind: "mfa-required";
      challengeToken: string;
      csrfToken: string;
      cookie: string;
      expiresAtMs: number;
    }
>;

type CompleteMfa = (
  context: {
    db: TestDatabase["db"];
    keyProvider: typeof keyProvider;
    authSecret: Uint8Array;
    dummyPasswordHash: string;
  },
  input: {
    username: string;
    source: string;
    challengeToken: string;
    csrfToken: string;
    method: "totp" | "recovery";
    code: string;
    nowMs: number;
    requestId: string;
  },
) =>
  | { kind: "invalid" }
  | { kind: "authenticated"; sessionToken: string; csrfToken: string; cookie: string };

async function insertOwner(options: { passwordHash?: string; totpSecret?: Buffer } = {}) {
  const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
  const encryptTotp = requiredFunction<(
    provider: typeof keyProvider, adminId: string, secret: Uint8Array,
  ) => string>("encryptAdminTotpSecret");
  const passwordHash = options.passwordHash ?? await hashPassword("owner password");
  const totpSecret = options.totpSecret ?? Buffer.alloc(32, 9);
  testDatabase!.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, totp_secret_envelope,
      totp_key_id, status, created_at_ms, updated_at_ms
    ) VALUES ('admin-1', 'owner', 'Owner', ?, ?, 'pii-v1', 'active', 0, 0)
  `).run(passwordHash, encryptTotp(keyProvider, "admin-1", totpSecret));
  return { passwordHash, totpSecret };
}

function context(dummyPasswordHash: string) {
  return {
    db: testDatabase!.db,
    keyProvider,
    authSecret,
    dummyPasswordHash,
  };
}

describe("password to MFA administrator authentication", () => {
  it("uses the dummy Argon path for unknown users and issues no session before MFA", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const verifyPassword = requiredFunction<typeof import("./password.js").verifyAdminPassword>("verifyAdminPassword");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    testDatabase = createTestDatabase();
    const owner = await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    const seenHashes: string[] = [];
    const tracedVerify: typeof verifyPassword = async (hash, password) => {
      seenHashes.push(hash);
      return verifyPassword(hash, password);
    };

    await expect(begin(context(dummyHash), {
      username: "missing",
      password: "dummy password",
      source: "203.0.113.10",
      nowMs: 1_000,
    }, { verifyPassword: tracedVerify })).resolves.toEqual({ kind: "invalid" });
    await expect(begin(context(dummyHash), {
      username: "owner",
      password: "wrong password",
      source: "203.0.113.10",
      nowMs: 1_001,
    }, { verifyPassword: tracedVerify })).resolves.toEqual({ kind: "invalid" });
    expect(seenHashes).toEqual([dummyHash, owner.passwordHash]);

    const success = await begin(context(dummyHash), {
      username: " Owner ",
      password: "owner password",
      source: "203.0.113.10",
      nowMs: 2_000,
    });
    expect(success).toMatchObject({ kind: "mfa-required", expiresAtMs: 302_000 });
    if (success.kind === "mfa-required") {
      expect(success.cookie).toBe(
        `__Host-wisdom-preauth=${success.challengeToken}.${success.csrfToken}; Secure; HttpOnly; SameSite=Strict; Path=/`,
      );
    }
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_pre_auth_challenges").get()).toEqual({ count: 1 });
  });

  it("runs the real dummy Argon2 verification path for unknown and malformed stored hashes", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const verifyPassword = requiredFunction<typeof import("./password.js").verifyAdminPassword>("verifyAdminPassword");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    testDatabase = createTestDatabase();
    await insertOwner({ passwordHash: "malformed-stored-password-hash" });
    const dummyHash = await hashPassword("dummy password");
    const seenHashes: string[] = [];
    const tracedVerify: typeof verifyPassword = async (hash, password) => {
      seenHashes.push(hash);
      return verifyPassword(hash, password);
    };

    await expect(begin(context(dummyHash), {
      username: "missing",
      password: "dummy password",
      source: "203.0.113.10",
      nowMs: 1_000,
    }, { verifyPassword: tracedVerify })).resolves.toEqual({ kind: "invalid" });
    await expect(begin(context(dummyHash), {
      username: "owner",
      password: "dummy password",
      source: "203.0.113.10",
      nowMs: 1_001,
    }, { verifyPassword: tracedVerify })).resolves.toEqual({ kind: "invalid" });
    expect(seenHashes).toEqual([dummyHash, dummyHash]);
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_pre_auth_challenges").get()).toEqual({ count: 0 });
  });

  it("atomically admits file-backed concurrent attempts and denies a racing good password after the limit", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const fail = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => void>("recordAdminLoginFailure");
    const throttle = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => {
      allowed: boolean;
      usernameFailures: number;
      sourceFailures: number;
      usernameAdmissions: number;
      sourceAdmissions: number;
    }>("adminLoginThrottleStatus");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    testDatabase = createTestDatabase();
    const owner = await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    const source = "203.0.113.10";
    for (let index = 0; index < 4; index += 1) {
      fail(testDatabase.db, authSecret, "owner", source, 1_000);
    }
    const competing = openDatabase(testDatabase.path);
    runMigrations(competing);
    let releaseGood!: () => void;
    let markGoodEntered!: () => void;
    const goodGate = new Promise<void>((resolve) => { releaseGood = resolve; });
    const goodEntered = new Promise<void>((resolve) => { markGoodEntered = resolve; });
    const seenGoodHashes: string[] = [];
    const seenBadHashes: string[] = [];
    try {
      const goodAttempt = begin(context(dummyHash), {
        username: "owner",
        password: "owner password",
        source,
        nowMs: 1_000,
      }, {
        verifyPassword: async (hash) => {
          seenGoodHashes.push(hash);
          markGoodEntered();
          await goodGate;
          return { valid: true, needsRehash: false };
        },
      });
      await goodEntered;
      expect(throttle(testDatabase.db, authSecret, "owner", source, 1_000)).toMatchObject({
        allowed: false,
        usernameFailures: 4,
        sourceFailures: 4,
        usernameAdmissions: 1,
        sourceAdmissions: 1,
      });
      const badAttempt = begin({ ...context(dummyHash), db: competing }, {
        username: "owner",
        password: "wrong password",
        source,
        nowMs: 1_000,
      }, {
        verifyPassword: async (hash) => {
          seenBadHashes.push(hash);
          return { valid: false, needsRehash: false };
        },
      });

      await expect(badAttempt).resolves.toEqual({ kind: "invalid" });
      expect(throttle(testDatabase.db, authSecret, "owner", source, 1_000)).toMatchObject({
        allowed: false,
        usernameFailures: 5,
        sourceFailures: 5,
        usernameAdmissions: 1,
        sourceAdmissions: 1,
      });
      releaseGood();
      await expect(goodAttempt).resolves.toEqual({ kind: "invalid" });
      expect(seenGoodHashes).toEqual([owner.passwordHash]);
      expect(seenBadHashes).toEqual([dummyHash]);
      expect(throttle(testDatabase.db, authSecret, "owner", source, 1_000)).toMatchObject({
        allowed: false,
        usernameFailures: 5,
        sourceFailures: 5,
        usernameAdmissions: 0,
        sourceAdmissions: 0,
      });
      expect(testDatabase.db.sqlite.prepare(
        "SELECT count(*) count FROM admin_pre_auth_challenges",
      ).get()).toEqual({ count: 0 });
    } finally {
      releaseGood();
      closeDatabase(competing);
    }
  });

  it("bounds concurrent real and dummy password KDF work", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    testDatabase = createTestDatabase();
    const owner = await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    let active = 0;
    let entered = 0;
    let maximumActive = 0;
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const seenHashes: string[] = [];
    const verifyPassword = async (hash: string) => {
      seenHashes.push(hash);
      entered += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (entered <= 4) await firstWave;
      active -= 1;
      return { valid: false as const, needsRehash: false as const };
    };
    const attempts = Array.from({ length: 6 }, (_, index) => begin(context(dummyHash), {
      username: "owner",
      password: "wrong password",
      source: `203.0.113.${index + 1}`,
      nowMs: 2_000,
    }, { verifyPassword }));
    try {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(maximumActive).toBe(4);
    } finally {
      releaseFirstWave();
    }
    await expect(Promise.all(attempts)).resolves.toEqual(
      Array.from({ length: 6 }, () => ({ kind: "invalid" })),
    );
    expect(seenHashes).toEqual([
      owner.passwordHash,
      owner.passwordHash,
      owner.passwordHash,
      owner.passwordHash,
      owner.passwordHash,
      dummyHash,
    ]);
  });

  it("transfers a released KDF permit to queued work without late-arrival barging", async () => {
    type Permit = { release(): void };
    const createGate = requiredFunction<(limit: number) => {
      acquire(): Promise<Permit>;
    }>("createPasswordKdfGate");
    const gate = createGate(1);
    const first = await gate.acquire();
    const queued = gate.acquire();
    first.release();

    let lateSettled = false;
    const late = gate.acquire().then((permit) => {
      lateSettled = true;
      return permit;
    });
    const queuedPermit = await queued;
    await Promise.resolve();
    expect(lateSettled).toBe(false);
    queuedPermit.release();
    const latePermit = await late;
    expect(lateSettled).toBe(true);
    latePermit.release();
  });

  it("keeps a needed password rehash inside the same KDF concurrency permit", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    testDatabase = createTestDatabase();
    await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    let activeRehashes = 0;
    let maximumActiveRehashes = 0;
    let releaseRehashes!: () => void;
    const rehashGate = new Promise<void>((resolve) => { releaseRehashes = resolve; });
    const attempts = Array.from({ length: 5 }, (_, index) => begin(context(dummyHash), {
      username: "owner",
      password: "owner password",
      source: `192.0.2.${index + 1}`,
      nowMs: 3_000,
    }, {
      verifyPassword: async () => ({ valid: true, needsRehash: true }),
      hashPassword: async () => {
        activeRehashes += 1;
        maximumActiveRehashes = Math.max(maximumActiveRehashes, activeRehashes);
        await rehashGate;
        activeRehashes -= 1;
        return "pending-rehash";
      },
    }));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const observedMaximum = maximumActiveRehashes;
    releaseRehashes();
    const results = await Promise.all(attempts);
    expect(observedMaximum).toBe(4);
    expect(results.every((result) => result.kind === "mfa-required")).toBe(true);
  });

  it("promotes a weaker password hash only after TOTP and rejects challenge or counter replay", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const verifyPassword = requiredFunction<typeof import("./password.js").verifyAdminPassword>("verifyAdminPassword");
    const totpCode = requiredFunction<(secret: Uint8Array, nowMs: number) => string>("totpCode");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    testDatabase = createTestDatabase();
    const weak = await argon2.hash("owner password", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
      salt: Buffer.alloc(8, 29),
    });
    const owner = await insertOwner({ passwordHash: weak });
    const dummyHash = await hashPassword("dummy password");
    const started = await begin(context(dummyHash), {
      username: "owner",
      password: "owner password",
      source: "203.0.113.10",
      nowMs: 30_000,
    });
    expect(started.kind).toBe("mfa-required");
    expect(testDatabase.db.sqlite.prepare("SELECT password_hash FROM admins WHERE id = 'admin-1'").get()).toEqual({
      password_hash: weak,
    });
    const pending = testDatabase.db.sqlite.prepare(
      "SELECT pending_password_hash FROM admin_pre_auth_challenges",
    ).get() as { pending_password_hash: string };
    expect(pending.pending_password_hash).not.toBe(weak);
    if (started.kind !== "mfa-required") return;

    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "totp",
      code: totpCode(owner.totpSecret, 31_000),
      nowMs: 31_000,
      requestId: "request-mfa-1",
    })).toMatchObject({ kind: "authenticated", cookie: expect.stringContaining("__Host-wisdom-admin=") });
    const upgraded = testDatabase.db.sqlite.prepare(
      "SELECT password_hash, totp_last_counter FROM admins WHERE id = 'admin-1'",
    ).get() as { password_hash: string; totp_last_counter: number };
    await expect(verifyPassword(upgraded.password_hash, "owner password")).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(upgraded.totp_last_counter).toBe(1);
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 1 });

    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "totp",
      code: totpCode(owner.totpSecret, 31_000),
      nowMs: 31_001,
      requestId: "request-mfa-replay",
    })).toEqual({ kind: "invalid" });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 1 });
  });

  it("binds pre-auth CSRF, expires at five minutes, and counts every MFA failure", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    const throttle = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => { usernameFailures: number; sourceFailures: number }>("adminLoginThrottleStatus");
    testDatabase = createTestDatabase();
    await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    const started = await begin(context(dummyHash), {
      username: "owner", password: "owner password", source: "203.0.113.10", nowMs: 0,
    });
    if (started.kind !== "mfa-required") throw new Error("expected pre-auth challenge");

    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: "A".repeat(43),
      method: "totp",
      code: "000000",
      nowMs: 1,
      requestId: "request-bad-csrf",
    })).toEqual({ kind: "invalid" });
    expect(throttle(testDatabase.db, authSecret, "owner", "203.0.113.10", 1)).toMatchObject({
      usernameFailures: 1,
      sourceFailures: 1,
    });
    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "totp",
      code: "000000",
      nowMs: 5 * 60 * 1_000,
      requestId: "request-expired",
    })).toEqual({ kind: "invalid" });
  });

  it("CAS-binds the pre-auth CSRF digest when consuming a challenge", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const totpCode = requiredFunction<(secret: Uint8Array, nowMs: number) => string>("totpCode");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    testDatabase = createTestDatabase();
    const owner = await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    const started = await begin(context(dummyHash), {
      username: "owner", password: "owner password", source: "203.0.113.10", nowMs: 30_000,
    });
    if (started.kind !== "mfa-required") throw new Error("expected pre-auth challenge");
    testDatabase.db.sqlite.exec(`
      CREATE TRIGGER mutate_preauth_csrf_after_totp
      AFTER UPDATE OF totp_last_counter ON admins
      BEGIN
        UPDATE admin_pre_auth_challenges
        SET csrf_hash = randomblob(32)
        WHERE admin_id = NEW.id AND used_at_ms IS NULL;
      END;
    `);

    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "totp",
      code: totpCode(owner.totpSecret, 31_000),
      nowMs: 31_000,
      requestId: "request-csrf-cas",
    })).toEqual({ kind: "invalid" });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT totp_last_counter FROM admins WHERE id = 'admin-1'",
    ).get()).toEqual({ totp_last_counter: null });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT used_at_ms FROM admin_pre_auth_challenges",
    ).get()).toEqual({ used_at_ms: null });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
  });

  it("accepts one recovery code as full MFA, resets failures, and rejects reuse", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const replaceCodes = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, adminId: string, nowMs: number,
    ) => string[]>("replaceAdminRecoveryCodes");
    const fail = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => void>("recordAdminLoginFailure");
    const throttle = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => { usernameFailures: number; sourceFailures: number }>("adminLoginThrottleStatus");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    testDatabase = createTestDatabase();
    await insertOwner();
    const dummyHash = await hashPassword("dummy password");
    const codes = replaceCodes(testDatabase.db, authSecret, "admin-1", 0);
    fail(testDatabase.db, authSecret, "owner", "203.0.113.10", 1);
    const started = await begin(context(dummyHash), {
      username: "owner", password: "owner password", source: "203.0.113.10", nowMs: 2,
    });
    if (started.kind !== "mfa-required") throw new Error("expected pre-auth challenge");

    expect(complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "recovery",
      code: codes[0]!,
      nowMs: 3,
      requestId: "request-recovery",
    })).toMatchObject({ kind: "authenticated" });
    expect(throttle(testDatabase.db, authSecret, "owner", "203.0.113.10", 3)).toMatchObject({
      usernameFailures: 0,
      sourceFailures: 0,
    });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT used_at_ms FROM admin_recovery_codes WHERE used_at_ms IS NOT NULL",
    ).all()).toEqual([{ used_at_ms: 3 }]);
  });

  it.each([
    ["TOTP counter", `
      CREATE TRIGGER fault_write BEFORE UPDATE OF totp_last_counter ON admins
      WHEN NEW.totp_last_counter IS NOT OLD.totp_last_counter
      BEGIN SELECT RAISE(ABORT, 'injected TOTP counter fault'); END;
    `],
    ["pre-auth consume", `
      CREATE TRIGGER fault_write BEFORE UPDATE OF used_at_ms ON admin_pre_auth_challenges
      WHEN NEW.used_at_ms IS NOT OLD.used_at_ms
      BEGIN SELECT RAISE(ABORT, 'injected pre-auth fault'); END;
    `],
    ["password promotion", `
      CREATE TRIGGER fault_write BEFORE UPDATE OF password_hash ON admins
      WHEN NEW.password_hash IS NOT OLD.password_hash
      BEGIN SELECT RAISE(ABORT, 'injected password fault'); END;
    `],
    ["session insert", `
      CREATE TRIGGER fault_write BEFORE INSERT ON admin_sessions
      BEGIN SELECT RAISE(ABORT, 'injected session fault'); END;
    `],
    ["throttle reset", `
      CREATE TRIGGER fault_write BEFORE DELETE ON admin_login_buckets
      BEGIN SELECT RAISE(ABORT, 'injected throttle fault'); END;
    `],
    ["audit insert", `
      CREATE TRIGGER fault_write BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'injected audit fault'); END;
    `],
  ])("rolls back the full MFA unit when the %s write fails", async (_stage, triggerSql) => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const totpCode = requiredFunction<(secret: Uint8Array, nowMs: number) => string>("totpCode");
    const fail = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, username: string, source: string, nowMs: number,
    ) => void>("recordAdminLoginFailure");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    testDatabase = createTestDatabase();
    const weak = await argon2.hash("owner password", {
      type: argon2.argon2id,
      memoryCost: 12_288,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
    const owner = await insertOwner({ passwordHash: weak });
    const dummyHash = await hashPassword("dummy password");
    fail(testDatabase.db, authSecret, "owner", "203.0.113.10", 29_000);
    const started = await begin(context(dummyHash), {
      username: "owner", password: "owner password", source: "203.0.113.10", nowMs: 30_000,
    });
    if (started.kind !== "mfa-required") throw new Error("expected pre-auth challenge");
    const before = {
      admin: testDatabase.db.sqlite.prepare(`
        SELECT password_hash, totp_last_counter, last_login_at_ms, updated_at_ms
        FROM admins WHERE id = 'admin-1'
      `).get(),
      challenge: testDatabase.db.sqlite.prepare(`
        SELECT used_at_ms, csrf_hash FROM admin_pre_auth_challenges
      `).get(),
      bucketCount: testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_login_buckets").get(),
    };
    testDatabase.db.sqlite.exec(triggerSql);

    expect(() => complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "totp",
      code: totpCode(owner.totpSecret, 31_000),
      nowMs: 31_000,
      requestId: `request-fault-${String(_stage)}`,
    })).toThrow(/injected/);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT password_hash, totp_last_counter, last_login_at_ms, updated_at_ms
      FROM admins WHERE id = 'admin-1'
    `).get()).toEqual(before.admin);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT used_at_ms, csrf_hash FROM admin_pre_auth_challenges
    `).get()).toEqual(before.challenge);
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_login_buckets").get()).toEqual(
      before.bucketCount,
    );
  });

  it("rolls back recovery-code consumption when a later MFA write fails", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const replaceCodes = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array, adminId: string, nowMs: number,
    ) => string[]>("replaceAdminRecoveryCodes");
    const begin = requiredFunction<BeginLogin>("beginAdminLogin");
    const complete = requiredFunction<CompleteMfa>("completeAdminMfa");
    testDatabase = createTestDatabase();
    await insertOwner();
    const codes = replaceCodes(testDatabase.db, authSecret, "admin-1", 0);
    const dummyHash = await hashPassword("dummy password");
    const started = await begin(context(dummyHash), {
      username: "owner", password: "owner password", source: "203.0.113.10", nowMs: 1,
    });
    if (started.kind !== "mfa-required") throw new Error("expected pre-auth challenge");
    testDatabase.db.sqlite.exec(`
      CREATE TRIGGER fault_after_recovery BEFORE INSERT ON admin_sessions
      BEGIN SELECT RAISE(ABORT, 'injected post-recovery fault'); END;
    `);

    expect(() => complete(context(dummyHash), {
      username: "owner",
      source: "203.0.113.10",
      challengeToken: started.challengeToken,
      csrfToken: started.csrfToken,
      method: "recovery",
      code: codes[0]!,
      nowMs: 2,
      requestId: "request-recovery-fault",
    })).toThrow(/injected/);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM admin_recovery_codes WHERE used_at_ms IS NOT NULL",
    ).get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT used_at_ms FROM admin_pre_auth_challenges",
    ).get()).toEqual({ used_at_ms: null });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
  });
});
