import { randomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { authDigest } from "./digest.js";

const WINDOW_MS = 15 * 60 * 1_000;
const ADMISSION_TTL_MS = 2 * 60 * 1_000;
const USERNAME_LIMIT = 5;
const SOURCE_LIMIT = 20;

function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLowerCase();
}

function windowStart(nowMs: number): number {
  return Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
}

function subjectDigest(
  secret: Uint8Array,
  kind: "username" | "source",
  value: string,
): Buffer {
  return authDigest(
    secret,
    kind === "username" ? "login-username" : "login-source",
    kind === "username" ? normalizeUsername(value) : value.trim().toLowerCase(),
  );
}

function currentCount(
  db: ControlDatabase,
  kind: "username" | "source",
  digest: Buffer,
  nowMs: number,
): number {
  const row = db.sqlite.prepare(`
    SELECT failure_count FROM admin_login_buckets
    WHERE subject_kind = ? AND subject_hash = ? AND window_start_ms = ? AND expires_at_ms > ?
  `).get(kind, digest, windowStart(nowMs), nowMs) as { failure_count: number } | undefined;
  return row?.failure_count ?? 0;
}

function currentAdmissionCount(
  db: ControlDatabase,
  column: "username_hash" | "source_hash",
  digest: Buffer,
  nowMs: number,
): number {
  const row = db.sqlite.prepare(`
    SELECT count(*) count FROM admin_login_admissions
    WHERE ${column} = ? AND expires_at_ms > ?
  `).get(digest, nowMs) as { count: number };
  return row.count;
}

function transaction<T>(db: ControlDatabase, operation: () => T): T {
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function incrementFailure(
  db: ControlDatabase,
  kind: "username" | "source",
  digest: Buffer,
  nowMs: number,
): void {
  const start = windowStart(nowMs);
  db.sqlite.prepare(`
    INSERT INTO admin_login_buckets (
      subject_kind, subject_hash, window_start_ms, failure_count, expires_at_ms
    ) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(subject_kind, subject_hash, window_start_ms)
    DO UPDATE SET failure_count = failure_count + 1, expires_at_ms = excluded.expires_at_ms
  `).run(kind, digest, start, start + WINDOW_MS);
}

function deleteExpiredState(db: ControlDatabase, nowMs: number): void {
  db.sqlite.prepare("DELETE FROM admin_login_buckets WHERE expires_at_ms <= ?").run(nowMs);
  db.sqlite.prepare("DELETE FROM admin_login_admissions WHERE expires_at_ms <= ?").run(nowMs);
}

export interface AdminLoginAdmission {
  allowed: boolean;
  admissionId?: string;
}

export function reserveAdminLoginAttempt(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
  nowMs: number,
): AdminLoginAdmission {
  const usernameHash = subjectDigest(secret, "username", username);
  const sourceHash = subjectDigest(secret, "source", source);
  return transaction(db, () => {
    deleteExpiredState(db, nowMs);
    const usernameFailures = currentCount(db, "username", usernameHash, nowMs);
    const sourceFailures = currentCount(db, "source", sourceHash, nowMs);
    const usernameAdmissions = currentAdmissionCount(db, "username_hash", usernameHash, nowMs);
    const sourceAdmissions = currentAdmissionCount(db, "source_hash", sourceHash, nowMs);
    const allowed =
      usernameFailures + usernameAdmissions < USERNAME_LIMIT &&
      sourceFailures + sourceAdmissions < SOURCE_LIMIT;
    if (!allowed) return { allowed: false };
    const admissionId = randomUUID();
    db.sqlite.prepare(`
      INSERT INTO admin_login_admissions (
        id, username_hash, source_hash, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(admissionId, usernameHash, sourceHash, nowMs, nowMs + ADMISSION_TTL_MS);
    return { allowed: true, admissionId };
  });
}

export function recordReservedAdminLoginFailure(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
  nowMs: number,
  admissionId?: string,
): void {
  const usernameHash = subjectDigest(secret, "username", username);
  const sourceHash = subjectDigest(secret, "source", source);
  transaction(db, () => {
    deleteExpiredState(db, nowMs);
    if (admissionId !== undefined) {
      db.sqlite.prepare(`
        DELETE FROM admin_login_admissions
        WHERE id = ? AND username_hash = ? AND source_hash = ?
      `).run(admissionId, usernameHash, sourceHash);
    }
    incrementFailure(db, "username", usernameHash, nowMs);
    incrementFailure(db, "source", sourceHash, nowMs);
  });
}

export function settleSuccessfulAdminLoginAttempt<T>(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
  nowMs: number,
  admissionId: string,
  onAllowed: () => T,
): { allowed: false } | { allowed: true; value: T } {
  const usernameHash = subjectDigest(secret, "username", username);
  const sourceHash = subjectDigest(secret, "source", source);
  return transaction(db, () => {
    deleteExpiredState(db, nowMs);
    const released = db.sqlite.prepare(`
      DELETE FROM admin_login_admissions
      WHERE id = ? AND username_hash = ? AND source_hash = ? AND expires_at_ms > ?
    `).run(admissionId, usernameHash, sourceHash, nowMs);
    if (released.changes !== 1) return { allowed: false };
    const usernameFailures = currentCount(db, "username", usernameHash, nowMs);
    const sourceFailures = currentCount(db, "source", sourceHash, nowMs);
    if (usernameFailures >= USERNAME_LIMIT || sourceFailures >= SOURCE_LIMIT) {
      return { allowed: false };
    }
    return { allowed: true, value: onAllowed() };
  });
}

export function adminLoginThrottleStatus(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
  nowMs: number,
): {
  allowed: boolean;
  usernameFailures: number;
  sourceFailures: number;
  usernameAdmissions: number;
  sourceAdmissions: number;
} {
  const usernameHash = subjectDigest(secret, "username", username);
  const sourceHash = subjectDigest(secret, "source", source);
  const usernameFailures = currentCount(db, "username", usernameHash, nowMs);
  const sourceFailures = currentCount(db, "source", sourceHash, nowMs);
  const usernameAdmissions = currentAdmissionCount(db, "username_hash", usernameHash, nowMs);
  const sourceAdmissions = currentAdmissionCount(db, "source_hash", sourceHash, nowMs);
  return {
    allowed:
      usernameFailures + usernameAdmissions < USERNAME_LIMIT &&
      sourceFailures + sourceAdmissions < SOURCE_LIMIT,
    usernameFailures,
    sourceFailures,
    usernameAdmissions,
    sourceAdmissions,
  };
}

export function recordAdminLoginFailure(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
  nowMs: number,
): void {
  recordReservedAdminLoginFailure(db, secret, username, source, nowMs);
}

export function resetAdminLoginFailures(
  db: ControlDatabase,
  secret: Uint8Array,
  username: string,
  source: string,
): void {
  transaction(db, () => {
    db.sqlite.prepare(`
      DELETE FROM admin_login_buckets
      WHERE (subject_kind = 'username' AND subject_hash = ?)
         OR (subject_kind = 'source' AND subject_hash = ?)
    `).run(
      subjectDigest(secret, "username", username),
      subjectDigest(secret, "source", source),
    );
  });
}

export { normalizeUsername as normalizeAdminUsername };
