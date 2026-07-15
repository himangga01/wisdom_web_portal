import argon2 from "argon2";
import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import * as controlModule from "../index.js";
import { closeDatabase, openDatabase } from "../db/client.js";
import { createStaticKeyProvider } from "../crypto/index.js";

const control = controlModule as unknown as Record<string, unknown>;
const authSecret = Buffer.alloc(32, 21);
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 7) });
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

function insertAdmin(options: {
  id?: string;
  username?: string;
  totpSecretEnvelope?: string;
  totpKeyId?: string;
} = {}): string {
  const id = options.id ?? "admin-1";
  testDatabase!.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, totp_secret_envelope,
      totp_key_id, status, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'Owner', 'placeholder', ?, ?, 'active', 1000, 1000)
  `).run(
    id,
    options.username ?? "owner",
    options.totpSecretEnvelope ?? null,
    options.totpKeyId ?? null,
  );
  return id;
}

describe("administrator authentication primitives", () => {
  it("hashes Argon2id with frozen parameters and rejects malformed or wrong credentials", async () => {
    const hashPassword = requiredFunction<(password: string) => Promise<string>>("hashAdminPassword");
    const verifyPassword = requiredFunction<(
      hash: string,
      password: string,
    ) => Promise<{ valid: boolean; needsRehash: boolean }>>("verifyAdminPassword");

    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const encodedHash = hash.split("$")[5];
    expect(Buffer.from(encodedHash ?? "", "base64")).toHaveLength(32);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(verifyPassword(hash, "wrong password")).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
    await expect(verifyPassword("not-a-phc", "anything")).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("marks a valid weaker Argon2id hash for replacement only after authentication", async () => {
    const verifyPassword = requiredFunction<(
      hash: string,
      password: string,
    ) => Promise<{ valid: boolean; needsRehash: boolean }>>("verifyAdminPassword");
    const weak = await argon2.hash("owner password", {
      type: argon2.argon2id,
      memoryCost: 12_288,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });

    await expect(verifyPassword(weak, "owner password")).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    const shortSalt = await argon2.hash("owner password", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
      salt: Buffer.alloc(8, 17),
    });
    await expect(verifyPassword(shortSalt, "owner password")).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it("implements RFC 6238 SHA-256 codes, exact windows, and counter replay rejection", () => {
    const totpCode = requiredFunction<(secret: Uint8Array, nowMs: number) => string>("totpCode");
    const verifyTotp = requiredFunction<(
      secret: Uint8Array,
      code: string,
      nowMs: number,
      lastCounter?: number,
    ) => number | undefined>("verifyTotp");
    const rfcSecret = Buffer.from("12345678901234567890123456789012", "ascii");
    expect(totpCode(rfcSecret, 59_000)).toBe("119246");

    const boundaryCode = totpCode(rfcSecret, 29_999);
    expect(verifyTotp(rfcSecret, boundaryCode, 30_000)).toBe(0);
    expect(verifyTotp(rfcSecret, boundaryCode, 30_000, 0)).toBeUndefined();
    expect(verifyTotp(rfcSecret, boundaryCode, 60_000)).toBeUndefined();
    expect(verifyTotp(rfcSecret, "12345", 30_000)).toBeUndefined();
  });

  it("encrypts TOTP secrets with admin-bound AAD and atomically consumes one counter", () => {
    const encryptSecret = requiredFunction<(
      provider: typeof keyProvider,
      adminId: string,
      secret: Uint8Array,
    ) => string>("encryptAdminTotpSecret");
    const decryptSecret = requiredFunction<(
      provider: typeof keyProvider,
      adminId: string,
      envelope: string,
    ) => Buffer>("decryptAdminTotpSecret");
    const totpCode = requiredFunction<(secret: Uint8Array, nowMs: number) => string>("totpCode");
    const consumeTotp = requiredFunction<(
      db: TestDatabase["db"],
      provider: typeof keyProvider,
      adminId: string,
      code: string,
      nowMs: number,
    ) => boolean>("consumeAdminTotp");
    testDatabase = createTestDatabase();
    const secret = Buffer.alloc(32, 11);
    const envelope = encryptSecret(keyProvider, "admin-1", secret);
    insertAdmin({ totpSecretEnvelope: envelope, totpKeyId: "pii-v1" });

    expect(decryptSecret(keyProvider, "admin-1", envelope)).toEqual(secret);
    expect(() => decryptSecret(keyProvider, "admin-2", envelope)).toThrow();
    const second = openDatabase(testDatabase.path);
    closeAfter.push(() => closeDatabase(second));
    const code = totpCode(secret, 90_000);
    expect([
      consumeTotp(testDatabase.db, keyProvider, "admin-1", code, 90_000),
      consumeTotp(second, keyProvider, "admin-1", code, 90_000),
    ].filter(Boolean)).toHaveLength(1);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT totp_last_counter FROM admins WHERE id = 'admin-1'",
    ).get()).toEqual({ totp_last_counter: 3 });
  });

  it("stores ten recovery codes as hashes and consumes exactly one under reuse", () => {
    const replaceCodes = requiredFunction<(
      db: TestDatabase["db"],
      secret: Uint8Array,
      adminId: string,
      nowMs: number,
    ) => string[]>("replaceAdminRecoveryCodes");
    const consumeCode = requiredFunction<(
      db: TestDatabase["db"],
      secret: Uint8Array,
      adminId: string,
      code: string,
      nowMs: number,
    ) => boolean>("consumeAdminRecoveryCode");
    testDatabase = createTestDatabase();
    insertAdmin();
    const codes = replaceCodes(testDatabase.db, authSecret, "admin-1", 2_000);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Za-z0-9_-]{22}$/.test(code))).toBe(true);
    const rows = testDatabase.db.sqlite.prepare(
      "SELECT code_hash FROM admin_recovery_codes ORDER BY id",
    ).all();
    const serializedRows = JSON.stringify(rows);
    expect(rows).toHaveLength(10);
    for (const code of codes) expect(serializedRows).not.toContain(code);

    const second = openDatabase(testDatabase.path);
    closeAfter.push(() => closeDatabase(second));
    expect([
      consumeCode(testDatabase.db, authSecret, "admin-1", codes[0]!, 3_000),
      consumeCode(second, authSecret, "admin-1", codes[0]!, 3_000),
    ].filter(Boolean)).toHaveLength(1);
    expect(consumeCode(testDatabase.db, authSecret, "admin-1", "not-a-code", 3_000)).toBe(false);
  });

  it("shares transaction-neutral recovery generation and hash insertion primitives", () => {
    const generateCodes = requiredFunction<() => string[]>("generateAdminRecoveryCodes");
    const insertHashes = requiredFunction<(
      db: TestDatabase["db"],
      secret: Uint8Array,
      adminId: string,
      codes: readonly string[],
      nowMs: number,
    ) => void>("insertAdminRecoveryCodeHashes");
    testDatabase = createTestDatabase();
    insertAdmin();
    const codes = generateCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Za-z0-9_-]{22}$/.test(code))).toBe(true);

    testDatabase.db.sqlite.exec("BEGIN IMMEDIATE");
    insertHashes(testDatabase.db, authSecret, "admin-1", codes, 2_000);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM admin_recovery_codes WHERE admin_id = 'admin-1'
    `).get()).toEqual({ count: 10 });
    testDatabase.db.sqlite.exec("ROLLBACK");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM admin_recovery_codes WHERE admin_id = 'admin-1'
    `).get()).toEqual({ count: 0 });
  });

  it("stores only digests for a single-use five-minute pre-auth challenge", () => {
    const createChallenge = requiredFunction<(
      db: TestDatabase["db"],
      secret: Uint8Array,
      adminId: string,
      nowMs: number,
      pendingPasswordHash?: string,
    ) => { challengeToken: string; csrfToken: string; expiresAtMs: number }>("createAdminPreAuthChallenge");
    testDatabase = createTestDatabase();
    insertAdmin();
    const challenge = createChallenge(testDatabase.db, authSecret, "admin-1", 10_000, "pending-phc");

    expect(Buffer.from(challenge.challengeToken, "base64url")).toHaveLength(32);
    expect(Buffer.from(challenge.csrfToken, "base64url")).toHaveLength(32);
    expect(challenge.expiresAtMs).toBe(310_000);
    const row = testDatabase.db.sqlite.prepare(
      "SELECT challenge_hash, csrf_hash, pending_password_hash, expires_at_ms FROM admin_pre_auth_challenges",
    ).get() as Record<string, unknown>;
    expect(row).toMatchObject({ pending_password_hash: "pending-phc", expires_at_ms: 310_000 });
    expect(row.challenge_hash).toBeInstanceOf(Buffer);
    expect(row.csrf_hash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(row)).not.toContain(challenge.challengeToken);
    expect(JSON.stringify(row)).not.toContain(challenge.csrfToken);
  });
});
