import { randomUUID } from "node:crypto";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { authDigest, equalDigest } from "./digest.js";
import { createPasswordKdfGate } from "./kdf-gate.js";
import {
  hashAdminPassword,
  isAdminPasswordHashFormatValid,
  verifyAdminPassword,
} from "./password.js";
import {
  adminPreAuthChallengeDigest,
  adminPreAuthCookie,
  adminPreAuthCsrfDigest,
  createAdminPreAuthChallenge,
} from "./preauth.js";
import { adminRecoveryCodeDigest } from "./recovery.js";
import { createAdminSession } from "./session.js";
import {
  adminLoginThrottleStatus,
  normalizeAdminUsername,
  recordAdminLoginFailure,
  recordReservedAdminLoginFailure,
  reserveAdminLoginAttempt,
  settleSuccessfulAdminLoginAttempt,
} from "./throttle.js";
import { decryptAdminTotpSecret, verifyTotp } from "./totp.js";

export interface AdminAuthContext {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  authSecret: Uint8Array;
  dummyPasswordHash: string;
}

export interface BeginAdminLoginInput {
  username: string;
  password: string;
  source: string;
  nowMs: number;
}

export type BeginAdminLoginResult =
  | { kind: "invalid" }
  | {
      kind: "mfa-required";
      challengeToken: string;
      csrfToken: string;
      cookie: string;
      expiresAtMs: number;
    };

interface AdminPasswordRow {
  id: string;
  password_hash: string;
  status: "active" | "disabled";
}

const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 4;
const passwordKdfGate = createPasswordKdfGate(MAX_CONCURRENT_PASSWORD_VERIFICATIONS);

export async function beginAdminLogin(
  context: AdminAuthContext,
  input: BeginAdminLoginInput,
  options: {
    verifyPassword?: typeof verifyAdminPassword;
    hashPassword?: typeof hashAdminPassword;
  } = {},
): Promise<BeginAdminLoginResult> {
  const username = normalizeAdminUsername(input.username);
  const admission = reserveAdminLoginAttempt(
    context.db,
    context.authSecret,
    username,
    input.source,
    input.nowMs,
  );
  const admin = context.db.sqlite.prepare(`
    SELECT id, password_hash, status FROM admins WHERE username = ?
  `).get(username) as AdminPasswordRow | undefined;
  const eligible = admin?.status === "active" && admission.allowed;
  const storedHashUsable = eligible && isAdminPasswordHashFormatValid(admin.password_hash);
  const verify = options.verifyPassword ?? verifyAdminPassword;
  const hashPassword = options.hashPassword ?? hashAdminPassword;
  const permit = await passwordKdfGate.acquire();
  let result: Awaited<ReturnType<typeof verifyAdminPassword>>;
  let pendingPasswordHash: string | undefined;
  try {
    result = await verify(
      storedHashUsable ? admin.password_hash : context.dummyPasswordHash,
      input.password,
    );
    if (storedHashUsable && result.valid && result.needsRehash) {
      pendingPasswordHash = await hashPassword(input.password);
    }
  } finally {
    permit.release();
  }
  if (!storedHashUsable || !result.valid) {
    recordReservedAdminLoginFailure(
      context.db,
      context.authSecret,
      username,
      input.source,
      input.nowMs,
      admission.admissionId,
    );
    return { kind: "invalid" };
  }
  const settled = settleSuccessfulAdminLoginAttempt(
    context.db,
    context.authSecret,
    username,
    input.source,
    input.nowMs,
    admission.admissionId!,
    () => createAdminPreAuthChallenge(
      context.db,
      context.authSecret,
      admin.id,
      input.nowMs,
      pendingPasswordHash,
    ),
  );
  if (!settled.allowed) return { kind: "invalid" };
  const challenge = settled.value;
  return {
    kind: "mfa-required",
    ...challenge,
    cookie: adminPreAuthCookie(challenge.challengeToken, challenge.csrfToken),
  };
}

export interface CompleteAdminMfaInput {
  username: string;
  source: string;
  challengeToken: string;
  csrfToken: string;
  method: "totp" | "recovery";
  code: string;
  nowMs: number;
  requestId: string;
}

export type CompleteAdminMfaResult =
  | { kind: "invalid" }
  | {
      kind: "authenticated";
      sessionToken: string;
      csrfToken: string;
      cookie: string;
    };

interface PreAuthRow {
  admin_id: string;
  csrf_hash: Buffer;
  pending_password_hash: string | null;
  expires_at_ms: number;
  used_at_ms: number | null;
  username: string;
  status: "active" | "disabled";
  totp_secret_envelope: string | null;
  totp_last_counter: number | null;
}

function sourceDigest(secret: Uint8Array, source: string): Buffer {
  return authDigest(secret, "login-source", source.trim().toLowerCase());
}

function usernameDigest(secret: Uint8Array, username: string): Buffer {
  return authDigest(secret, "login-username", normalizeAdminUsername(username));
}

function recordMfaFailure(context: AdminAuthContext, input: CompleteAdminMfaInput): CompleteAdminMfaResult {
  recordAdminLoginFailure(context.db, context.authSecret, input.username, input.source, input.nowMs);
  return { kind: "invalid" };
}

export function completeAdminMfa(
  context: AdminAuthContext,
  input: CompleteAdminMfaInput,
): CompleteAdminMfaResult {
  const throttle = adminLoginThrottleStatus(
    context.db,
    context.authSecret,
    input.username,
    input.source,
    input.nowMs,
  );
  if (!throttle.allowed) return recordMfaFailure(context, input);

  const challengeHash = adminPreAuthChallengeDigest(context.authSecret, input.challengeToken);
  context.db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = context.db.sqlite.prepare(`
      SELECT p.admin_id, p.csrf_hash, p.pending_password_hash, p.expires_at_ms,
             p.used_at_ms, a.username, a.status, a.totp_secret_envelope,
             a.totp_last_counter
      FROM admin_pre_auth_challenges p
      JOIN admins a ON a.id = p.admin_id
      WHERE p.challenge_hash = ?
    `).get(challengeHash) as PreAuthRow | undefined;
    const expectedCsrf = adminPreAuthCsrfDigest(
      context.authSecret,
      input.challengeToken,
      input.csrfToken,
    );
    const validChallenge =
      row !== undefined &&
      row.status === "active" &&
      row.used_at_ms === null &&
      input.nowMs < row.expires_at_ms &&
      normalizeAdminUsername(input.username) === row.username &&
      equalDigest(row.csrf_hash, expectedCsrf);
    if (!validChallenge || !row) {
      context.db.sqlite.exec("COMMIT");
      return recordMfaFailure(context, input);
    }

    let secondFactorAccepted = false;
    if (input.method === "totp" && row.totp_secret_envelope !== null) {
      let counter: number | undefined;
      try {
        const secret = decryptAdminTotpSecret(context.keyProvider, row.admin_id, row.totp_secret_envelope);
        counter = verifyTotp(secret, input.code, input.nowMs, row.totp_last_counter ?? undefined);
      } catch {
        counter = undefined;
      }
      if (counter !== undefined) {
        secondFactorAccepted = context.db.sqlite.prepare(`
          UPDATE admins SET totp_last_counter = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'active'
            AND (totp_last_counter IS NULL OR totp_last_counter < ?)
        `).run(counter, input.nowMs, row.admin_id, counter).changes === 1;
      }
    } else if (input.method === "recovery") {
      secondFactorAccepted = context.db.sqlite.prepare(`
        UPDATE admin_recovery_codes SET used_at_ms = ?
        WHERE admin_id = ? AND code_hash = ? AND used_at_ms IS NULL
      `).run(
        input.nowMs,
        row.admin_id,
        adminRecoveryCodeDigest(context.authSecret, row.admin_id, input.code),
      ).changes === 1;
    }
    if (!secondFactorAccepted) {
      context.db.sqlite.exec("ROLLBACK");
      return recordMfaFailure(context, input);
    }

    const used = context.db.sqlite.prepare(`
      UPDATE admin_pre_auth_challenges SET used_at_ms = ?
      WHERE challenge_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?
        AND csrf_hash = ?
    `).run(input.nowMs, challengeHash, input.nowMs, expectedCsrf);
    if (used.changes !== 1) {
      context.db.sqlite.exec("ROLLBACK");
      return recordMfaFailure(context, input);
    }
    context.db.sqlite.prepare(`
      UPDATE admins
      SET password_hash = COALESCE(?, password_hash), last_login_at_ms = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(row.pending_password_hash, input.nowMs, input.nowMs, row.admin_id);
    const session = createAdminSession(context.db, context.authSecret, row.admin_id, input.nowMs);
    context.db.sqlite.prepare(`
      DELETE FROM admin_login_buckets
      WHERE (subject_kind = 'username' AND subject_hash = ?)
         OR (subject_kind = 'source' AND subject_hash = ?)
    `).run(
      usernameDigest(context.authSecret, row.username),
      sourceDigest(context.authSecret, input.source),
    );
    context.db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, 'admin.login.succeeded', 'admin', ?, ?, NULL, ?)
    `).run(randomUUID(), row.admin_id, row.admin_id, input.requestId, input.nowMs);
    context.db.sqlite.exec("COMMIT");
    return {
      kind: "authenticated",
      sessionToken: session.sessionToken,
      csrfToken: session.csrfToken,
      cookie: session.cookie,
    };
  } catch (error) {
    if (context.db.sqlite.inTransaction) context.db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
