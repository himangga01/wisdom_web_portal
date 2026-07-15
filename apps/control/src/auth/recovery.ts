import { randomBytes, randomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { authDigest } from "./digest.js";

export function adminRecoveryCodeDigest(secret: Uint8Array, adminId: string, code: string): Buffer {
  return authDigest(secret, "recovery-code", adminId, code);
}

export function generateAdminRecoveryCodes(): string[] {
  const codes = Array.from({ length: 10 }, () => randomBytes(16).toString("base64url"));
  if (new Set(codes).size !== codes.length) throw new Error("Recovery code collision");
  return codes;
}

export function insertAdminRecoveryCodeHashes(
  db: ControlDatabase,
  secret: Uint8Array,
  adminId: string,
  codes: readonly string[],
  nowMs: number,
): void {
  if (codes.length !== 10 || new Set(codes).size !== codes.length) {
    throw new Error("Exactly ten unique recovery codes are required");
  }
  const insert = db.sqlite.prepare(`
    INSERT INTO admin_recovery_codes (id, admin_id, code_hash, created_at_ms)
    VALUES (?, ?, ?, ?)
  `);
  for (const code of codes) {
    insert.run(randomUUID(), adminId, adminRecoveryCodeDigest(secret, adminId, code), nowMs);
  }
}

export function replaceAdminRecoveryCodes(
  db: ControlDatabase,
  secret: Uint8Array,
  adminId: string,
  nowMs: number,
): string[] {
  const codes = generateAdminRecoveryCodes();
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    db.sqlite.prepare("DELETE FROM admin_recovery_codes WHERE admin_id = ?").run(adminId);
    insertAdminRecoveryCodeHashes(db, secret, adminId, codes, nowMs);
    db.sqlite.exec("COMMIT");
    return codes;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function consumeAdminRecoveryCode(
  db: ControlDatabase,
  secret: Uint8Array,
  adminId: string,
  code: string,
  nowMs: number,
): boolean {
  const digest = adminRecoveryCodeDigest(secret, adminId, code);
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = db.sqlite.prepare(`
      UPDATE admin_recovery_codes SET used_at_ms = ?
      WHERE admin_id = ? AND code_hash = ? AND used_at_ms IS NULL
    `).run(nowMs, adminId, digest);
    db.sqlite.exec("COMMIT");
    return result.changes === 1;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
