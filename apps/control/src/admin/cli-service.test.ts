import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { createStaticKeyProvider } from "../crypto/index.js";
import { decryptAdminTotpSecret } from "../auth/totp.js";
import { verifyAdminPassword } from "../auth/password.js";
import { createAdminSession } from "../auth/session.js";
import { beginAdminLogin } from "../auth/service.js";
import { consumeAdminRecoveryCode } from "../auth/recovery.js";
import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { bootstrapOwner, replaceOwnerMfa, resetOwnerPassword } from "./cli-service.js";
import { parseAdminCliArguments, runAdminCli } from "./cli.js";

const authSecret = Buffer.alloc(32, 61);
const keyProvider = createStaticKeyProvider({ id: "pii-cli-v1", secret: Buffer.alloc(32, 62) });
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

interface EnrollmentArtifact {
  totpUri: string;
  totpSecret: string;
  recoveryCodes: string[];
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function expectOwnerOnlyFile(path: string): void {
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  const whoami = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const currentSid = /S-\d(?:-\d+)+/.exec(whoami)?.[0];
  expect(currentSid).toBeDefined();
  const aclDump = `${path}.acl-test`;
  execFileSync("icacls", [path, "/save", aclDump], { encoding: "utf8", windowsHide: true });
  const sddl = readFileSync(aclDump, "utf16le");
  const accessAces = sddl.match(/\([AD];;[^)]*\)/g) ?? [];
  expect(accessAces).toEqual([`(A;;FA;;;${currentSid})`]);
}

async function seedOwner(prefix = "seed"): Promise<{
  adminId: string;
  artifact: EnrollmentArtifact;
  outputPath: string;
}> {
  const outputPath = join(testDatabase!.directory, `${prefix}-enrollment.json`);
  const result = await bootstrapOwner({ db: testDatabase!.db, keyProvider, authSecret }, {
    username: "owner",
    displayName: "Primary Owner",
    password: "original owner password",
    outputPath,
    nowMs: 1_000,
    requestId: `${prefix}-bootstrap`,
  });
  return {
    adminId: result.adminId,
    artifact: JSON.parse(readFileSync(outputPath, "utf8")) as EnrollmentArtifact,
    outputPath,
  };
}

describe("local administrator CLI service", () => {
  it("bootstraps the first owner with only encrypted or hashed credentials", async () => {
    testDatabase = createTestDatabase();
    const outputPath = join(testDatabase.directory, "owner-enrollment.json");
    const password = "owner password only via stdin";

    const result = await bootstrapOwner({
      db: testDatabase.db,
      keyProvider,
      authSecret,
    }, {
      username: " Owner ",
      displayName: "Primary Owner",
      password,
      outputPath,
      nowMs: 10_000,
      requestId: "cli-bootstrap-1",
    });

    expect(result).toEqual({ adminId: expect.any(String) });
    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as EnrollmentArtifact;
    expect(artifact.totpUri).toContain("otpauth://totp/");
    expect(artifact.totpUri).toContain("algorithm=SHA256");
    expect(artifact.recoveryCodes).toHaveLength(10);
    expect(new Set(artifact.recoveryCodes).size).toBe(10);
    expectOwnerOnlyFile(outputPath);

    const row = testDatabase.db.sqlite.prepare(`
      SELECT id, username, display_name, password_hash, totp_secret_envelope,
             totp_key_id, status, totp_last_counter
      FROM admins
    `).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: result.adminId,
      username: "owner",
      display_name: "Primary Owner",
      totp_key_id: "pii-cli-v1",
      status: "active",
      totp_last_counter: null,
    });
    await expect(verifyAdminPassword(String(row.password_hash), password)).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(decryptAdminTotpSecret(
      keyProvider,
      result.adminId,
      String(row.totp_secret_envelope),
    )).toEqual(decodeBase32(artifact.totpSecret));

    const recoveryRows = testDatabase.db.sqlite.prepare(
      "SELECT code_hash FROM admin_recovery_codes ORDER BY id",
    ).all();
    expect(recoveryRows).toHaveLength(10);
    const persisted = JSON.stringify({
      admins: testDatabase.db.sqlite.prepare("SELECT * FROM admins").all(),
      recoveryRows,
      audit: testDatabase.db.sqlite.prepare("SELECT * FROM audit_events").all(),
    });
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain(artifact.totpSecret);
    for (const code of artifact.recoveryCodes) expect(persisted).not.toContain(code);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT actor_type, actor_id, action, target_type, target_id,
             request_id, metadata_json
      FROM audit_events
    `).get()).toEqual({
      actor_type: "system",
      actor_id: null,
      action: "admin.owner.bootstrapped",
      target_type: "admin",
      target_id: result.adminId,
      request_id: "cli-bootstrap-1",
      metadata_json: null,
    });
  });

  it("resets the owner password atomically and revokes sessions and pre-auth challenges", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("reset");
    const session = createAdminSession(testDatabase.db, authSecret, owner.adminId, 2_000);
    testDatabase.db.sqlite.prepare(`
      INSERT INTO admin_pre_auth_challenges (
        challenge_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(Buffer.alloc(32, 1), owner.adminId, Buffer.alloc(32, 2), 2_000, 302_000);

    await resetOwnerPassword({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "OWNER",
      password: "replacement owner password",
      nowMs: 3_000,
      requestId: "cli-reset-1",
    });

    const row = testDatabase.db.sqlite.prepare(
      "SELECT password_hash FROM admins WHERE id = ?",
    ).get(owner.adminId) as { password_hash: string };
    await expect(verifyAdminPassword(row.password_hash, "replacement owner password")).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(verifyAdminPassword(row.password_hash, "original owner password")).resolves.toMatchObject({
      valid: false,
    });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT revoked_at_ms FROM admin_sessions WHERE admin_id = ?
    `).get(owner.adminId)).toEqual({ revoked_at_ms: 3_000 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT used_at_ms FROM admin_pre_auth_challenges WHERE admin_id = ?
    `).get(owner.adminId)).toEqual({ used_at_ms: 3_000 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT actor_type, action, target_id, request_id, metadata_json
      FROM audit_events WHERE action = 'admin.password.reset'
    `).get()).toEqual({
      actor_type: "system",
      action: "admin.password.reset",
      target_id: owner.adminId,
      request_id: "cli-reset-1",
      metadata_json: null,
    });
    expect(session.sessionToken).not.toContain("replacement owner password");
  });

  it("fences an old-password verification that was already in flight when reset began", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("reset-race");
    const stored = testDatabase.db.sqlite.prepare(
      "SELECT password_hash FROM admins WHERE id = ?",
    ).get(owner.adminId) as { password_hash: string };
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const login = beginAdminLogin({
      db: testDatabase.db,
      keyProvider,
      authSecret,
      dummyPasswordHash: stored.password_hash,
    }, {
      username: "owner",
      password: "original owner password",
      source: "127.0.0.1",
      nowMs: 2_500,
    }, {
      async verifyPassword() {
        markVerificationStarted();
        await verificationGate;
        return { valid: true, needsRehash: false };
      },
    });
    await verificationStarted;
    await resetOwnerPassword({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "owner",
      password: "new password after race",
      nowMs: 3_000,
      requestId: "cli-reset-race",
    });
    releaseVerification();

    await expect(login).resolves.toEqual({ kind: "invalid" });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM admin_pre_auth_challenges WHERE admin_id = ?
    `).get(owner.adminId)).toEqual({ count: 0 });
  });

  it("replaces TOTP and recovery credentials atomically, resets replay state, and revokes sessions", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("replace");
    createAdminSession(testDatabase.db, authSecret, owner.adminId, 2_000);
    testDatabase.db.sqlite.prepare(
      "UPDATE admins SET totp_last_counter = 12 WHERE id = ?",
    ).run(owner.adminId);
    const oldHashes = JSON.stringify(testDatabase.db.sqlite.prepare(
      "SELECT code_hash FROM admin_recovery_codes WHERE admin_id = ? ORDER BY id",
    ).all(owner.adminId));
    const outputPath = join(testDatabase.directory, "replacement-enrollment.json");

    await replaceOwnerMfa({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "owner",
      outputPath,
      nowMs: 4_000,
      requestId: "cli-mfa-replace-1",
    });

    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as EnrollmentArtifact;
    expectOwnerOnlyFile(outputPath);
    expect(artifact.totpSecret).not.toBe(owner.artifact.totpSecret);
    for (const oldCode of owner.artifact.recoveryCodes) {
      expect(artifact.recoveryCodes).not.toContain(oldCode);
    }
    const admin = testDatabase.db.sqlite.prepare(`
      SELECT totp_secret_envelope, totp_key_id, totp_last_counter
      FROM admins WHERE id = ?
    `).get(owner.adminId) as {
      totp_secret_envelope: string;
      totp_key_id: string;
      totp_last_counter: number | null;
    };
    expect(admin.totp_key_id).toBe("pii-cli-v1");
    expect(admin.totp_last_counter).toBeNull();
    expect(decryptAdminTotpSecret(keyProvider, owner.adminId, admin.totp_secret_envelope)).toEqual(
      decodeBase32(artifact.totpSecret),
    );
    const newHashes = JSON.stringify(testDatabase.db.sqlite.prepare(
      "SELECT code_hash FROM admin_recovery_codes WHERE admin_id = ? ORDER BY id",
    ).all(owner.adminId));
    expect(newHashes).not.toBe(oldHashes);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT revoked_at_ms FROM admin_sessions WHERE admin_id = ?",
    ).get(owner.adminId)).toEqual({ revoked_at_ms: 4_000 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events
      WHERE action = 'admin.mfa.replaced'
    `).get()).toEqual({ action: "admin.mfa.replaced", metadata_json: null });
    const persisted = JSON.stringify({
      admin: testDatabase.db.sqlite.prepare("SELECT * FROM admins WHERE id = ?").get(owner.adminId),
      recovery: testDatabase.db.sqlite.prepare(
        "SELECT * FROM admin_recovery_codes WHERE admin_id = ?",
      ).all(owner.adminId),
      audit: testDatabase.db.sqlite.prepare("SELECT * FROM audit_events").all(),
    });
    expect(persisted).not.toContain(artifact.totpSecret);
    for (const code of artifact.recoveryCodes) expect(persisted).not.toContain(code);
  });

  it("rolls back owner bootstrap and removes the enrollment file after a late fault", async () => {
    testDatabase = createTestDatabase();
    const outputPath = join(testDatabase.directory, "fault-bootstrap.json");
    await expect(bootstrapOwner({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "owner",
      displayName: "Owner",
      password: "bootstrap fault password",
      outputPath,
      nowMs: 5_000,
      requestId: "fault-bootstrap",
    }, {
      faultInjector(point) {
        if (point === "after-audit") throw new Error("bootstrap fault");
      },
    })).rejects.toThrow("bootstrap fault");
    expect(testDatabase.db.sqlite.prepare("SELECT COUNT(*) AS count FROM admins").get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 0 });
    expect(existsSync(outputPath)).toBe(false);
  });

  it("removes bootstrap enrollment output when the database transaction cannot start", async () => {
    testDatabase = createTestDatabase();
    const outputPath = join(testDatabase.directory, "begin-fault-bootstrap.json");
    testDatabase.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      await expect(bootstrapOwner({ db: testDatabase.db, keyProvider, authSecret }, {
        username: "owner",
        displayName: "Owner",
        password: "bootstrap begin fault password",
        outputPath,
        nowMs: 5_500,
        requestId: "begin-fault-bootstrap",
      })).rejects.toThrow();
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      if (testDatabase.db.sqlite.inTransaction) testDatabase.db.sqlite.exec("ROLLBACK");
    }
  });

  it("rolls back password and session changes after a late reset fault", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("reset-fault");
    createAdminSession(testDatabase.db, authSecret, owner.adminId, 2_000);
    const before = testDatabase.db.sqlite.prepare(
      "SELECT password_hash FROM admins WHERE id = ?",
    ).get(owner.adminId);

    await expect(resetOwnerPassword({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "owner",
      password: "reset should roll back",
      nowMs: 6_000,
      requestId: "fault-reset",
    }, {
      faultInjector(point) {
        if (point === "after-audit") throw new Error("reset fault");
      },
    })).rejects.toThrow("reset fault");

    expect(testDatabase.db.sqlite.prepare(
      "SELECT password_hash FROM admins WHERE id = ?",
    ).get(owner.adminId)).toEqual(before);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT revoked_at_ms FROM admin_sessions WHERE admin_id = ?",
    ).get(owner.adminId)).toEqual({ revoked_at_ms: null });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE action = 'admin.password.reset'
    `).get()).toEqual({ count: 0 });
  });

  it("rolls back MFA, recovery, and session changes and removes output after a late replacement fault", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("mfa-fault");
    createAdminSession(testDatabase.db, authSecret, owner.adminId, 2_000);
    const beforeAdmin = testDatabase.db.sqlite.prepare(`
      SELECT totp_secret_envelope, totp_key_id, totp_last_counter FROM admins WHERE id = ?
    `).get(owner.adminId);
    const beforeCodes = testDatabase.db.sqlite.prepare(`
      SELECT id, code_hash, created_at_ms, used_at_ms FROM admin_recovery_codes
      WHERE admin_id = ? ORDER BY id
    `).all(owner.adminId);
    const outputPath = join(testDatabase.directory, "fault-replacement.json");

    await expect(replaceOwnerMfa({ db: testDatabase.db, keyProvider, authSecret }, {
      username: "owner",
      outputPath,
      nowMs: 7_000,
      requestId: "fault-mfa",
    }, {
      faultInjector(point) {
        if (point === "after-audit") throw new Error("mfa fault");
      },
    })).rejects.toThrow("mfa fault");

    expect(testDatabase.db.sqlite.prepare(`
      SELECT totp_secret_envelope, totp_key_id, totp_last_counter FROM admins WHERE id = ?
    `).get(owner.adminId)).toEqual(beforeAdmin);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT id, code_hash, created_at_ms, used_at_ms FROM admin_recovery_codes
      WHERE admin_id = ? ORDER BY id
    `).all(owner.adminId)).toEqual(beforeCodes);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT revoked_at_ms FROM admin_sessions WHERE admin_id = ?",
    ).get(owner.adminId)).toEqual({ revoked_at_ms: null });
    expect(existsSync(outputPath)).toBe(false);
  });

  it("accepts only explicit non-secret CLI flags and rejects credentials in argv", () => {
    expect(parseAdminCliArguments([
      "bootstrap", "--username", "owner", "--display-name", "Owner", "--output", "owner.json",
    ])).toEqual({
      command: "bootstrap",
      username: "owner",
      displayName: "Owner",
      outputPath: "owner.json",
    });
    expect(parseAdminCliArguments([
      "password-reset", "--username", "owner",
    ])).toEqual({ command: "password-reset", username: "owner" });
    expect(parseAdminCliArguments([
      "mfa-replace", "--username", "owner", "--output", "owner.json",
    ])).toEqual({ command: "mfa-replace", username: "owner", outputPath: "owner.json" });

    for (const args of [
      ["bootstrap", "--username", "owner", "--display-name", "Owner", "--output", "owner.json", "--password", "raw"],
      ["password-reset", "--username", "owner", "--password=raw"],
      ["mfa-replace", "--username", "owner", "--output", "owner.json", "--totp-secret", "raw"],
      ["mfa-replace", "--username", "owner", "--output", "owner.json", "--recovery-code", "raw"],
      ["password-reset", "--username", "owner", "unexpected"],
      ["password-reset", "--username", "owner", "--username", "other"],
    ]) {
      expect(() => parseAdminCliArguments(args)).toThrow();
    }
  });

  it("reads bootstrap password only from stdin and writes no enrollment secret to status output", async () => {
    testDatabase = createTestDatabase();
    const outputPath = join(testDatabase.directory, "runner-enrollment.json");
    const password = "stdin bootstrap password";
    const statuses: string[] = [];
    let stdinReads = 0;

    await runAdminCli({ db: testDatabase.db, keyProvider, authSecret }, [
      "bootstrap",
      "--username", "owner",
      "--display-name", "Owner",
      "--output", outputPath,
    ], {
      async readStdin() {
        stdinReads += 1;
        return `${password}\n`;
      },
      writeStatus(value) {
        statuses.push(value);
      },
    }, {
      nowMs: 8_000,
      requestId: "cli-runner-bootstrap",
    });

    expect(stdinReads).toBe(1);
    expect(statuses).toEqual([
      JSON.stringify({ event: "admin.cli.succeeded", command: "bootstrap" }),
    ]);
    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as EnrollmentArtifact;
    const emitted = statuses.join("\n");
    expect(emitted).not.toContain(password);
    expect(emitted).not.toContain(artifact.totpSecret);
    for (const code of artifact.recoveryCodes) expect(emitted).not.toContain(code);
  });

  it("reads password reset from stdin only and emits only a generic status", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("runner-reset");
    const password = "password reset from stdin";
    const statuses: string[] = [];
    let stdinReads = 0;

    await runAdminCli({ db: testDatabase.db, keyProvider, authSecret }, [
      "password-reset", "--username", "owner",
    ], {
      async readStdin() {
        stdinReads += 1;
        return `${password}\r\n`;
      },
      writeStatus(value) {
        statuses.push(value);
      },
    }, {
      nowMs: 8_500,
      requestId: "cli-runner-reset",
    });

    expect(stdinReads).toBe(1);
    expect(statuses).toEqual([
      JSON.stringify({ event: "admin.cli.succeeded", command: "password-reset" }),
    ]);
    expect(statuses.join("\n")).not.toContain(password);
    const row = testDatabase.db.sqlite.prepare(
      "SELECT password_hash FROM admins WHERE id = ?",
    ).get(owner.adminId) as { password_hash: string };
    await expect(verifyAdminPassword(row.password_hash, password)).resolves.toMatchObject({ valid: true });
  });

  it("does not read stdin for MFA replacement", async () => {
    testDatabase = createTestDatabase();
    await seedOwner("runner-mfa");
    const outputPath = join(testDatabase.directory, "runner-mfa-replacement.json");
    await runAdminCli({ db: testDatabase.db, keyProvider, authSecret }, [
      "mfa-replace", "--username", "owner", "--output", outputPath,
    ], {
      async readStdin() {
        throw new Error("stdin must not be read");
      },
      writeStatus() {},
    }, {
      nowMs: 9_000,
      requestId: "cli-runner-mfa",
    });
    expect(existsSync(outputPath)).toBe(true);
  });

  it("produces recovery codes that interoperate with the authentication consume flow", async () => {
    testDatabase = createTestDatabase();
    const owner = await seedOwner("runner-recovery");
    const code = owner.artifact.recoveryCodes[0]!;
    expect(consumeAdminRecoveryCode(
      testDatabase.db,
      authSecret,
      owner.adminId,
      code,
      9_500,
    )).toBe(true);
    expect(consumeAdminRecoveryCode(
      testDatabase.db,
      authSecret,
      owner.adminId,
      code,
      9_501,
    )).toBe(false);
  });

  it("exposes separate local-only administrator scripts", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    expect(packageJson.scripts).toMatchObject({
      "admin:bootstrap": "tsx src/admin/cli.ts bootstrap",
      "admin:password-reset": "tsx src/admin/cli.ts password-reset",
      "admin:mfa-replace": "tsx src/admin/cli.ts mfa-replace",
    });
  });
});
