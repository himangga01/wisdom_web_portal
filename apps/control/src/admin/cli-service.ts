import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { hashAdminPassword } from "../auth/password.js";
import {
  generateAdminRecoveryCodes,
  insertAdminRecoveryCodeHashes,
} from "../auth/recovery.js";
import { encryptAdminTotpSecret } from "../auth/totp.js";
import { normalizeAdminUsername } from "../auth/throttle.js";
import { authDigest } from "../auth/digest.js";

const TOTP_ISSUER = "JIHYE Administrative Attorney";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface AdminCliServiceContext {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  authSecret: Uint8Array;
}

export type AdminCliFaultPoint =
  | "after-admin"
  | "after-recovery-codes"
  | "after-sessions"
  | "after-audit";

export interface AdminCliServiceOptions {
  faultInjector?: (point: AdminCliFaultPoint) => void;
}

interface EnrollmentMaterial {
  secret: Buffer;
  secretBase32: string;
  recoveryCodes: string[];
  serialized: string;
}

function base32Encode(value: Uint8Array): string {
  let accumulator = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += BASE32_ALPHABET[(accumulator >>> bitCount) & 31];
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bitCount)) & 31];
  return encoded;
}

function validateOutputPath(outputPath: string): string {
  if (outputPath.length === 0 || outputPath.includes("\0")) {
    throw new Error("An explicit enrollment output file is required");
  }
  return outputPath;
}

function createEnrollmentMaterial(username: string): EnrollmentMaterial {
  const secret = randomBytes(32);
  const secretBase32 = base32Encode(secret);
  const recoveryCodes = generateAdminRecoveryCodes();
  const label = `${TOTP_ISSUER}:${username}`;
  const uri = `otpauth://totp/${encodeURIComponent(label)}?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA256&digits=6&period=30`;
  return {
    secret,
    secretBase32,
    recoveryCodes,
    serialized: `${JSON.stringify({
      totpUri: uri,
      totpSecret: secretBase32,
      recoveryCodes,
    }, null, 2)}\n`,
  };
}

function writeOwnerOnlyPosixFile(path: string, contents: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  let descriptorOpen = true;
  let complete = false;
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptorOpen = false;
    complete = true;
  } finally {
    if (descriptorOpen) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original secure-file failure.
      }
    }
    if (!complete) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Best effort after a filesystem failure; no database write has started.
      }
    }
  }
}

function windowsOwnerSid(): string {
  const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1_024,
  });
  const sid = result.status === 0 ? /S-\d(?:-\d+)+/.exec(result.stdout)?.[0] : undefined;
  if (!sid) throw new Error("Unable to resolve the Windows owner SID");
  return sid;
}

function restrictWindowsFileToOwner(path: string): void {
  const sid = windowsOwnerSid();
  for (const arguments_ of [
    [path, "/inheritance:r"],
    [path, "/grant:r", `*${sid}:(F)`],
  ]) {
    const result = spawnSync("icacls", arguments_, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      maxBuffer: 64 * 1_024,
    });
    if (result.status !== 0) throw new Error("Unable to create an owner-only enrollment file");
  }
}

function writeOwnerOnlyWindowsFile(path: string, contents: string): void {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  let descriptorOpen = true;
  let finalCreated = false;
  let complete = false;
  try {
    restrictWindowsFileToOwner(temporaryPath);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptorOpen = false;
    linkSync(temporaryPath, path);
    finalCreated = true;
    unlinkSync(temporaryPath);
    complete = true;
  } finally {
    if (descriptorOpen) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original secure-file failure.
      }
    }
    if (!complete) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best effort for an empty or already-restricted temporary file.
      }
      if (finalCreated) {
        try {
          rmSync(path, { force: true });
        } catch {
          // Best effort after a filesystem failure; no database write has started.
        }
      }
    }
  }
}

function writeOwnerOnlyFile(path: string, contents: string): void {
  const validatedPath = validateOutputPath(path);
  if (process.platform === "win32") {
    writeOwnerOnlyWindowsFile(validatedPath, contents);
  } else {
    writeOwnerOnlyPosixFile(validatedPath, contents);
  }
}

function normalizedOwnerInput(username: string, displayName: string): {
  username: string;
  displayName: string;
} {
  const normalizedUsername = normalizeAdminUsername(username);
  const normalizedDisplayName = displayName.trim().normalize("NFKC");
  if (!normalizedUsername || normalizedUsername.length > 128) throw new Error("Invalid owner username");
  if (!normalizedDisplayName || normalizedDisplayName.length > 128) throw new Error("Invalid owner display name");
  return { username: normalizedUsername, displayName: normalizedDisplayName };
}

function validatePassword(password: string): void {
  if (password.length === 0 || password.length > 1_024 || password.includes("\0")) {
    throw new Error("Invalid password input");
  }
}

interface ActiveAdminRow {
  id: string;
}

function activeAdminByUsername(context: AdminCliServiceContext, username: string): ActiveAdminRow | undefined {
  return context.db.sqlite.prepare(`
    SELECT id FROM admins WHERE username = ? AND status = 'active'
  `).get(username) as ActiveAdminRow | undefined;
}

function revokeSessionsAndChallenges(
  context: AdminCliServiceContext,
  adminId: string,
  nowMs: number,
): void {
  context.db.sqlite.prepare(`
    UPDATE admin_sessions SET revoked_at_ms = ?
    WHERE admin_id = ? AND revoked_at_ms IS NULL
  `).run(nowMs, adminId);
  context.db.sqlite.prepare(`
    UPDATE admin_pre_auth_challenges SET used_at_ms = ?
    WHERE admin_id = ? AND used_at_ms IS NULL
  `).run(nowMs, adminId);
}

function fencePendingPasswordVerifications(
  context: AdminCliServiceContext,
  username: string,
): void {
  context.db.sqlite.prepare(`
    DELETE FROM admin_login_admissions WHERE username_hash = ?
  `).run(authDigest(context.authSecret, "login-username", username));
}

function insertCliAudit(
  context: AdminCliServiceContext,
  action: "admin.owner.bootstrapped" | "admin.password.reset" | "admin.mfa.replaced",
  adminId: string,
  requestId: string,
  nowMs: number,
): void {
  context.db.sqlite.prepare(`
    INSERT INTO audit_events (
      id, actor_type, actor_id, action, target_type, target_id,
      request_id, metadata_json, created_at_ms
    ) VALUES (?, 'system', NULL, ?, 'admin', ?, ?, NULL, ?)
  `).run(randomUUID(), action, adminId, requestId, nowMs);
}

export async function bootstrapOwner(
  context: AdminCliServiceContext,
  input: {
    username: string;
    displayName: string;
    password: string;
    outputPath: string;
    nowMs: number;
    requestId: string;
  },
  options: AdminCliServiceOptions = {},
): Promise<{ adminId: string }> {
  const owner = normalizedOwnerInput(input.username, input.displayName);
  validatePassword(input.password);
  const passwordHash = await hashAdminPassword(input.password);
  const adminId = randomUUID();
  const enrollment = createEnrollmentMaterial(owner.username);
  const totpEnvelope = encryptAdminTotpSecret(context.keyProvider, adminId, enrollment.secret);
  writeOwnerOnlyFile(input.outputPath, enrollment.serialized);

  let transactionStarted = false;
  try {
    context.db.sqlite.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const existing = context.db.sqlite.prepare("SELECT COUNT(*) AS count FROM admins").get() as { count: number };
    if (existing.count !== 0) throw new Error("The first owner has already been bootstrapped");
    context.db.sqlite.prepare(`
      INSERT INTO admins (
        id, username, display_name, password_hash, totp_secret_envelope,
        totp_key_id, totp_last_counter, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)
    `).run(
      adminId,
      owner.username,
      owner.displayName,
      passwordHash,
      totpEnvelope,
      context.keyProvider.active().id,
      input.nowMs,
      input.nowMs,
    );
    options.faultInjector?.("after-admin");
    insertAdminRecoveryCodeHashes(
      context.db,
      context.authSecret,
      adminId,
      enrollment.recoveryCodes,
      input.nowMs,
    );
    options.faultInjector?.("after-recovery-codes");
    insertCliAudit(context, "admin.owner.bootstrapped", adminId, input.requestId, input.nowMs);
    options.faultInjector?.("after-audit");
    context.db.sqlite.exec("COMMIT");
    transactionStarted = false;
    return { adminId };
  } catch (error) {
    if (transactionStarted && context.db.sqlite.inTransaction) context.db.sqlite.exec("ROLLBACK");
    rmSync(input.outputPath, { force: true });
    throw error;
  }
}

export async function resetOwnerPassword(
  context: AdminCliServiceContext,
  input: {
    username: string;
    password: string;
    nowMs: number;
    requestId: string;
  },
  options: AdminCliServiceOptions = {},
): Promise<{ adminId: string }> {
  const username = normalizeAdminUsername(input.username);
  if (!username || username.length > 128) throw new Error("Invalid owner username");
  validatePassword(input.password);
  const passwordHash = await hashAdminPassword(input.password);

  let transactionStarted = false;
  try {
    context.db.sqlite.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const admin = activeAdminByUsername(context, username);
    if (!admin) throw new Error("Active owner not found");
    const changed = context.db.sqlite.prepare(`
      UPDATE admins SET password_hash = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'active'
    `).run(passwordHash, input.nowMs, admin.id);
    if (changed.changes !== 1) throw new Error("Active owner not found");
    fencePendingPasswordVerifications(context, username);
    options.faultInjector?.("after-admin");
    revokeSessionsAndChallenges(context, admin.id, input.nowMs);
    options.faultInjector?.("after-sessions");
    insertCliAudit(context, "admin.password.reset", admin.id, input.requestId, input.nowMs);
    options.faultInjector?.("after-audit");
    context.db.sqlite.exec("COMMIT");
    transactionStarted = false;
    return { adminId: admin.id };
  } catch (error) {
    if (transactionStarted && context.db.sqlite.inTransaction) context.db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export async function replaceOwnerMfa(
  context: AdminCliServiceContext,
  input: {
    username: string;
    outputPath: string;
    nowMs: number;
    requestId: string;
  },
  options: AdminCliServiceOptions = {},
): Promise<{ adminId: string }> {
  const username = normalizeAdminUsername(input.username);
  if (!username || username.length > 128) throw new Error("Invalid owner username");
  const initialAdmin = activeAdminByUsername(context, username);
  if (!initialAdmin) throw new Error("Active owner not found");
  const enrollment = createEnrollmentMaterial(username);
  const material = context.keyProvider.active();
  const totpEnvelope = encryptAdminTotpSecret(context.keyProvider, initialAdmin.id, enrollment.secret);
  writeOwnerOnlyFile(input.outputPath, enrollment.serialized);

  let transactionStarted = false;
  try {
    context.db.sqlite.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const admin = activeAdminByUsername(context, username);
    if (!admin || admin.id !== initialAdmin.id) throw new Error("Active owner not found");
    const changed = context.db.sqlite.prepare(`
      UPDATE admins
      SET totp_secret_envelope = ?, totp_key_id = ?, totp_last_counter = NULL,
          updated_at_ms = ?
      WHERE id = ? AND status = 'active'
    `).run(totpEnvelope, material.id, input.nowMs, admin.id);
    if (changed.changes !== 1) throw new Error("Active owner not found");
    options.faultInjector?.("after-admin");
    context.db.sqlite.prepare("DELETE FROM admin_recovery_codes WHERE admin_id = ?").run(admin.id);
    insertAdminRecoveryCodeHashes(
      context.db,
      context.authSecret,
      admin.id,
      enrollment.recoveryCodes,
      input.nowMs,
    );
    options.faultInjector?.("after-recovery-codes");
    revokeSessionsAndChallenges(context, admin.id, input.nowMs);
    options.faultInjector?.("after-sessions");
    insertCliAudit(context, "admin.mfa.replaced", admin.id, input.requestId, input.nowMs);
    options.faultInjector?.("after-audit");
    context.db.sqlite.exec("COMMIT");
    transactionStarted = false;
    return { adminId: admin.id };
  } catch (error) {
    if (transactionStarted && context.db.sqlite.inTransaction) context.db.sqlite.exec("ROLLBACK");
    rmSync(input.outputPath, { force: true });
    throw error;
  }
}
