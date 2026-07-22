import { randomBytes } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { authDigest, equalDigest } from "./digest.js";

const PRE_AUTH_TTL_MS = 5 * 60 * 1_000;
const PRE_AUTH_COOKIE = "__Host-wisdom-preauth";

export interface AdminPreAuthChallenge {
  challengeToken: string;
  csrfToken: string;
  expiresAtMs: number;
}

export function adminPreAuthChallengeDigest(secret: Uint8Array, challengeToken: string): Buffer {
  return authDigest(secret, "preauth-challenge", challengeToken);
}

export function adminPreAuthCsrfDigest(
  secret: Uint8Array,
  challengeToken: string,
  csrfToken: string,
): Buffer {
  return authDigest(secret, "preauth-csrf", challengeToken, csrfToken);
}

export function adminPreAuthCookie(challengeToken: string, csrfToken: string): string {
  return `${PRE_AUTH_COOKIE}=${challengeToken}.${csrfToken}; Secure; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearAdminPreAuthCookie(): string {
  return `${PRE_AUTH_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function createAdminPreAuthChallenge(
  db: ControlDatabase,
  secret: Uint8Array,
  adminId: string,
  nowMs: number,
  pendingPasswordHash?: string,
): AdminPreAuthChallenge {
  const challengeToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + PRE_AUTH_TTL_MS;
  db.sqlite.prepare(`
    INSERT INTO admin_pre_auth_challenges (
      challenge_hash, admin_id, csrf_hash, pending_password_hash,
      created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    adminPreAuthChallengeDigest(secret, challengeToken),
    adminId,
    adminPreAuthCsrfDigest(secret, challengeToken, csrfToken),
    pendingPasswordHash ?? null,
    nowMs,
    expiresAtMs,
  );
  return { challengeToken, csrfToken, expiresAtMs };
}

export function resolveAdminPreAuthChallenge(
  db: ControlDatabase,
  secret: Uint8Array,
  challengeToken: string,
  csrfToken: string,
  nowMs: number,
): boolean {
  const row = db.sqlite.prepare(`
    SELECT challenge.csrf_hash, challenge.expires_at_ms, challenge.used_at_ms,
      admin.status
    FROM admin_pre_auth_challenges challenge
    JOIN admins admin ON admin.id = challenge.admin_id
    WHERE challenge.challenge_hash = ?
  `).get(adminPreAuthChallengeDigest(secret, challengeToken)) as {
    csrf_hash: Buffer;
    expires_at_ms: number;
    used_at_ms: number | null;
    status: string;
  } | undefined;
  return row !== undefined && row.status === "active" && row.used_at_ms === null &&
    nowMs < row.expires_at_ms && equalDigest(
      row.csrf_hash,
      adminPreAuthCsrfDigest(secret, challengeToken, csrfToken),
    );
}
