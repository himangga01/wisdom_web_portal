import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { bucketAddress } from "../abuse/client-ip.js";

// First-party, cookieless visit statistics. Privacy model (see
// docs/architecture/first-party-analytics-plan.md): a visitor is identified
// only for a single Seoul calendar day by HMAC(daily salt, truncated IP + UA).
// The salt is destroyed on rotation and the per-day hashes are pruned the next
// day, so the only long-lived data is anonymous aggregate counts.

export interface AnalyticsDatabase {
  sqlite: Database.Database;
}

export interface PageviewInput {
  nowMs: number;
  address: string;
  userAgent: string;
  path: string;
  locale: "ko" | "en" | "zh-Hans" | "zh-Hant";
  /** Referring origin ("" for direct / same-site navigation). */
  referrerOrigin: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analytics_daily_salt (
  day  TEXT PRIMARY KEY,
  salt BLOB NOT NULL CHECK (length(salt) = 32)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS analytics_visitor_days (
  day TEXT NOT NULL,
  visitor_hash BLOB NOT NULL CHECK (length(visitor_hash) = 32),
  PRIMARY KEY (day, visitor_hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS analytics_site_days (
  day TEXT PRIMARY KEY,
  views INTEGER NOT NULL CHECK (views >= 0),
  visitors INTEGER NOT NULL CHECK (visitors >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS analytics_page_days (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  views INTEGER NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, path, locale)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS analytics_referrer_days (
  day TEXT NOT NULL,
  referrer_origin TEXT NOT NULL,
  views INTEGER NOT NULL CHECK (views > 0),
  PRIMARY KEY (day, referrer_origin)
) WITHOUT ROWID;
`;

// Aggregates tolerate losing the last few commits on power failure, so NORMAL
// avoids paying the OLTP database's full-fsync cost on every beacon.
export function openAnalyticsDatabase(path: string): AnalyticsDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(SCHEMA);
  return { sqlite };
}

export function closeAnalyticsDatabase(db: AnalyticsDatabase): void {
  db.sqlite.close();
}

// KST is a fixed UTC+9 offset (no DST), so the calendar day is derivable
// without a timezone database.
export function seoulDay(epochMs: number): string {
  return new Date(epochMs + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

/**
 * The bucket the visitor hash is computed over: IPv6 collapses to its /64 (the
 * abuse-bucket convention) and IPv4 — including IPv4-mapped IPv6 — drops its
 * last octet (CNIL audience-measurement truncation guidance).
 */
export function analyticsIpBucket(address: string): string {
  const bucket = bucketAddress(address);
  if (isIP(bucket) === 4) {
    return `${bucket.split(".").slice(0, 3).join(".")}.0/24`;
  }
  return bucket;
}

// Returns today's salt, destroying any previous day's salt first — that
// destruction is what makes cross-day linking impossible.
function ensureDailySalt(db: AnalyticsDatabase, day: string): Buffer {
  db.sqlite.prepare("DELETE FROM analytics_daily_salt WHERE day < ?").run(day);
  db.sqlite.prepare(
    "INSERT OR IGNORE INTO analytics_daily_salt (day, salt) VALUES (?, ?)",
  ).run(day, randomBytes(32));
  const row = db.sqlite.prepare(
    "SELECT salt FROM analytics_daily_salt WHERE day = ?",
  ).get(day) as { salt: Buffer };
  return row.salt;
}

function visitorHash(salt: Buffer, address: string, userAgent: string): Buffer {
  return createHmac("sha256", salt)
    .update(`wisdom:analytics:v1\0${analyticsIpBucket(address)}\0${userAgent}`, "utf8")
    .digest();
}

export function recordPageview(db: AnalyticsDatabase, input: PageviewInput): void {
  const day = seoulDay(input.nowMs);
  const salt = ensureDailySalt(db, day);
  const hash = visitorHash(salt, input.address, input.userAgent);
  const record = db.sqlite.transaction(() => {
    const inserted = db.sqlite.prepare(
      "INSERT OR IGNORE INTO analytics_visitor_days (day, visitor_hash) VALUES (?, ?)",
    ).run(day, hash);
    const visitorDelta = inserted.changes === 1 ? 1 : 0;
    db.sqlite.prepare(`
      INSERT INTO analytics_site_days (day, views, visitors) VALUES (?, 1, ?)
      ON CONFLICT (day) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors
    `).run(day, visitorDelta);
    db.sqlite.prepare(`
      INSERT INTO analytics_page_days (day, path, locale, views) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, path, locale) DO UPDATE SET views = views + 1
    `).run(day, input.path, input.locale);
    db.sqlite.prepare(`
      INSERT INTO analytics_referrer_days (day, referrer_origin, views) VALUES (?, ?, 1)
      ON CONFLICT (day, referrer_origin) DO UPDATE SET views = views + 1
    `).run(day, input.referrerOrigin);
  });
  record.immediate();
}

export const ANALYTICS_ROLLUP_RETENTION_MONTHS = 25;

// The rollover behaviour of Date.UTC keeps this correct across year
// boundaries; end-of-month clamping differences only shift the cutoff by a
// couple of days, which is immaterial for retention pruning.
function retentionCutoffDay(today: string, months: number): string {
  const [year = 0, month = 0, dayOfMonth = 0] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 - months, dayOfMonth)).toISOString().slice(0, 10);
}

export interface AnalyticsPruneResult {
  salts: number;
  visitorDays: number;
  rollupRows: number;
}

/**
 * Daily retention pass: destroys expired salts and per-day visitor hashes
 * (the privacy guarantee) and drops aggregate rows past the retention window.
 */
export function pruneAnalytics(db: AnalyticsDatabase, nowMs: number): AnalyticsPruneResult {
  const today = seoulDay(nowMs);
  const cutoff = retentionCutoffDay(today, ANALYTICS_ROLLUP_RETENTION_MONTHS);
  const run = db.sqlite.transaction(() => {
    const salts = db.sqlite.prepare(
      "DELETE FROM analytics_daily_salt WHERE day < ?",
    ).run(today).changes;
    const visitorDays = db.sqlite.prepare(
      "DELETE FROM analytics_visitor_days WHERE day < ?",
    ).run(today).changes;
    let rollupRows = 0;
    for (const table of ["analytics_site_days", "analytics_page_days", "analytics_referrer_days"]) {
      rollupRows += db.sqlite.prepare(`DELETE FROM ${table} WHERE day < ?`).run(cutoff).changes;
    }
    return { salts, visitorDays, rollupRows };
  });
  return run.immediate();
}
