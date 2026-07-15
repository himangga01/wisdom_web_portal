import { randomBytes } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { authDigest, equalDigest } from "./digest.js";

const SESSION_COOKIE = "__Host-wisdom-admin";
const ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1_000;
const IDLE_TTL_MS = 30 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CreatedAdminSession {
  sessionToken: string;
  csrfToken: string;
  cookie: string;
  expiresAtMs: number;
  idleExpiresAtMs: number;
}

export interface ResolvedAdminSession {
  adminId: string;
  sessionToken: string;
  csrfToken: string;
  csrfHash: Buffer;
  expiresAtMs: number;
  idleExpiresAtMs: number;
}

function tokenDigest(secret: Uint8Array, sessionToken: string): Buffer {
  return authDigest(secret, "session-token", sessionToken);
}

function csrfDigest(secret: Uint8Array, sessionToken: string, csrfToken: string): Buffer {
  return authDigest(secret, "session-csrf", sessionToken, csrfToken);
}

export function adminSessionCookie(sessionToken: string, csrfToken: string): string {
  return `${SESSION_COOKIE}=${sessionToken}.${csrfToken}; Secure; HttpOnly; SameSite=Strict; Path=/`;
}

export function clearAdminSessionCookie(): string {
  return `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseSessionCookie(cookieHeader: string): { sessionToken: string; csrfToken: string } | undefined {
  for (const segment of cookieHeader.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) continue;
    const value = trimmed.slice(SESSION_COOKIE.length + 1);
    const [sessionToken, csrfToken, extra] = value.split(".");
    if (extra !== undefined || !sessionToken || !csrfToken) return undefined;
    if (!TOKEN_PATTERN.test(sessionToken) || !TOKEN_PATTERN.test(csrfToken)) return undefined;
    return { sessionToken, csrfToken };
  }
  return undefined;
}

export function createAdminSession(
  db: ControlDatabase,
  secret: Uint8Array,
  adminId: string,
  nowMs: number,
): CreatedAdminSession {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + ABSOLUTE_TTL_MS;
  const idleExpiresAtMs = nowMs + IDLE_TTL_MS;
  db.sqlite.prepare(`
    INSERT INTO admin_sessions (
      token_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms,
      idle_expires_at_ms, last_seen_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenDigest(secret, sessionToken),
    adminId,
    csrfDigest(secret, sessionToken, csrfToken),
    nowMs,
    expiresAtMs,
    idleExpiresAtMs,
    nowMs,
  );
  return {
    sessionToken,
    csrfToken,
    cookie: adminSessionCookie(sessionToken, csrfToken),
    expiresAtMs,
    idleExpiresAtMs,
  };
}

interface SessionRow {
  admin_id: string;
  csrf_hash: Buffer;
  expires_at_ms: number;
  idle_expires_at_ms: number;
}

export function resolveAdminSession(
  db: ControlDatabase,
  secret: Uint8Array,
  cookieHeader: string,
  nowMs: number,
  options: { renew?: boolean } = {},
): ResolvedAdminSession | undefined {
  const parsed = parseSessionCookie(cookieHeader);
  if (!parsed) return undefined;
  const digest = tokenDigest(secret, parsed.sessionToken);
  const row = db.sqlite.prepare(`
    SELECT s.admin_id, s.csrf_hash, s.expires_at_ms, s.idle_expires_at_ms
    FROM admin_sessions s
    JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND a.status = 'active'
  `).get(digest) as SessionRow | undefined;
  if (!row || nowMs >= row.expires_at_ms || nowMs >= row.idle_expires_at_ms) return undefined;
  const idleExpiresAtMs = Math.min(nowMs + IDLE_TTL_MS, row.expires_at_ms);
  if (options.renew !== false) {
    db.sqlite.prepare(`
      UPDATE admin_sessions SET last_seen_at_ms = ?, idle_expires_at_ms = ?
      WHERE token_hash = ? AND revoked_at_ms IS NULL
    `).run(nowMs, idleExpiresAtMs, digest);
  }
  return {
    adminId: row.admin_id,
    sessionToken: parsed.sessionToken,
    csrfToken: parsed.csrfToken,
    csrfHash: row.csrf_hash,
    expiresAtMs: row.expires_at_ms,
    idleExpiresAtMs,
  };
}

export function verifyAdminCsrf(
  secret: Uint8Array,
  sessionToken: string,
  expectedHash: Uint8Array,
  supplied: string,
): boolean {
  if (!TOKEN_PATTERN.test(supplied)) return false;
  return equalDigest(expectedHash, csrfDigest(secret, sessionToken, supplied));
}

export function revokeAdminSession(
  db: ControlDatabase,
  secret: Uint8Array,
  sessionToken: string,
  nowMs: number,
): boolean {
  if (!TOKEN_PATTERN.test(sessionToken)) return false;
  return db.sqlite.prepare(`
    UPDATE admin_sessions SET revoked_at_ms = ?
    WHERE token_hash = ? AND revoked_at_ms IS NULL
  `).run(nowMs, tokenDigest(secret, sessionToken)).changes === 1;
}

export function revokeAllAdminSessions(
  db: ControlDatabase,
  adminId: string,
  nowMs: number,
): number {
  return db.sqlite.prepare(`
    UPDATE admin_sessions SET revoked_at_ms = ?
    WHERE admin_id = ? AND revoked_at_ms IS NULL
  `).run(nowMs, adminId).changes;
}
