import {
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { ControlDatabase } from "../db/client.js";

const LANDING_TTL_MS = 10 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function digest(secret: Uint8Array, purpose: "capability" | "landing" | "confirmation", value: string): Buffer {
  if (secret.byteLength < 32) throw new Error("Withdrawal secret must contain at least 32 bytes");
  return createHmac("sha256", secret)
    .update(`wisdom:marketing-withdrawal-${purpose}:v1`, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest();
}

function exactOrigin(value: string): URL {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) {
    throw new Error("Public origin must be an exact origin");
  }
  return url;
}

function randomToken(randomBytes: (length: number) => Buffer): string {
  const bytes = randomBytes(32);
  if (bytes.byteLength !== 32) throw new Error("Withdrawal random source must return exactly 32 bytes");
  return bytes.toString("base64url");
}

interface AcceptedMarketingRow {
  consent_event_id: string;
  locale: "ko" | "en" | "zh-Hans" | "zh-Hant";
}

export function mintMarketingWithdrawalCapability(
  db: ControlDatabase,
  secret: Uint8Array,
  input: {
    consultationId: string;
    publicOrigin: string;
    nowMs: number;
    expiresAtMs: number;
    randomBytes?: (length: number) => Buffer;
  },
): { token: string; url: string } {
  if (input.expiresAtMs <= input.nowMs) throw new Error("Withdrawal capability expiry must be in the future");
  const origin = exactOrigin(input.publicOrigin);
  const accepted = db.sqlite.prepare(`
    SELECT e.id consent_event_id, c.locale
    FROM consultations c
    JOIN consent_events e ON e.consultation_id = c.id
    WHERE c.id = ? AND c.marketing_accepted = 1
      AND c.marketing_withdrawn_at_ms IS NULL
      AND e.kind = 'marketing' AND e.decision = 'accepted'
    ORDER BY e.sequence DESC
    LIMIT 1
  `).get(input.consultationId) as AcceptedMarketingRow | undefined;
  if (!accepted) throw new Error("An accepted marketing consent is required");
  const token = randomToken(input.randomBytes ?? nodeRandomBytes);
  db.sqlite.prepare(`
    INSERT INTO marketing_withdrawal_capabilities (
      token_hash, consultation_id, consent_event_id, locale,
      created_at_ms, expires_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    digest(secret, "capability", token),
    input.consultationId,
    accepted.consent_event_id,
    accepted.locale,
    input.nowMs,
    input.expiresAtMs,
  );
  return {
    token,
    url: new URL(`/marketing/withdraw/${token}`, origin).href,
  };
}

function cleanWithdrawalPath(locale: AcceptedMarketingRow["locale"]): string {
  switch (locale) {
    case "ko": return "/marketing/withdraw";
    case "en": return "/en/marketing/withdraw";
    case "zh-Hans": return "/zh-hans/marketing/withdraw";
    case "zh-Hant": return "/zh-hant/marketing/withdraw";
  }
}

export function openMarketingWithdrawalCapability(
  db: ControlDatabase,
  secret: Uint8Array,
  input: {
    token: string;
    publicOrigin: string;
    nowMs: number;
    randomBytes?: (length: number) => Buffer;
  },
):
  | { kind: "invalid" }
  | { kind: "redirect"; location: string; cookie: string; landingToken: string } {
  if (!TOKEN_PATTERN.test(input.token)) return { kind: "invalid" };
  const origin = exactOrigin(input.publicOrigin);
  const tokenHash = digest(secret, "capability", input.token);
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT w.locale
      FROM marketing_withdrawal_capabilities w
      JOIN consultations c ON c.id = w.consultation_id
      WHERE w.token_hash = ? AND w.used_at_ms IS NULL AND w.expires_at_ms > ?
        AND w.landing_hash IS NULL
        AND c.marketing_accepted = 1 AND c.marketing_withdrawn_at_ms IS NULL
    `).get(tokenHash, input.nowMs) as { locale: AcceptedMarketingRow["locale"] } | undefined;
    if (!row) {
      db.sqlite.exec("COMMIT");
      return { kind: "invalid" };
    }
    const landingToken = randomToken(input.randomBytes ?? nodeRandomBytes);
    const updated = db.sqlite.prepare(`
      UPDATE marketing_withdrawal_capabilities
      SET landing_hash = ?, landing_expires_at_ms = ?
      WHERE token_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?
        AND landing_hash IS NULL
    `).run(
      digest(secret, "landing", landingToken),
      input.nowMs + LANDING_TTL_MS,
      tokenHash,
      input.nowMs,
    );
    if (updated.changes !== 1) throw new Error("Withdrawal landing exchange lost its CAS");
    db.sqlite.exec("COMMIT");
    return {
      kind: "redirect",
      location: new URL(cleanWithdrawalPath(row.locale), origin).href,
      cookie: `__Host-wisdom-marketing-withdraw=${landingToken}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
      landingToken,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function getMarketingWithdrawalConfirmation(
  db: ControlDatabase,
  secret: Uint8Array,
  input: { landingToken: string; nowMs: number },
):
  | { kind: "invalid" }
  | { kind: "confirm"; locale: AcceptedMarketingRow["locale"]; confirmationValue: string } {
  if (!TOKEN_PATTERN.test(input.landingToken)) return { kind: "invalid" };
  const row = db.sqlite.prepare(`
    SELECT w.locale
    FROM marketing_withdrawal_capabilities w
    JOIN consultations c ON c.id = w.consultation_id
    WHERE w.landing_hash = ? AND w.landing_expires_at_ms > ? AND w.expires_at_ms > ?
      AND w.used_at_ms IS NULL AND c.marketing_withdrawn_at_ms IS NULL
  `).get(
    digest(secret, "landing", input.landingToken),
    input.nowMs,
    input.nowMs,
  ) as { locale: AcceptedMarketingRow["locale"] } | undefined;
  if (!row) return { kind: "invalid" };
  return {
    kind: "confirm",
    locale: row.locale,
    confirmationValue: digest(secret, "confirmation", input.landingToken).toString("base64url"),
  };
}

function sameConfirmation(secret: Uint8Array, landingToken: string, candidate: string): boolean {
  const expected = digest(secret, "confirmation", landingToken).toString("base64url");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(candidate, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

interface WithdrawalRow {
  consultation_id: string;
  consent_event_id: string;
  used_at_ms: number | null;
  marketing_withdrawn_at_ms: number | null;
  document_id: string;
  document_version: string;
  document_sha256: Buffer;
}

export type WithdrawalFaultPoint =
  | "after-consent-event"
  | "after-consultation"
  | "after-cancellation"
  | "after-capabilities"
  | "after-audit";

export function withdrawMarketingConsent(
  db: ControlDatabase,
  secret: Uint8Array,
  input: {
    landingToken: string;
    confirmationValue: string;
    nowMs: number;
    requestId: string;
  },
  options: { faultInjector?: (point: WithdrawalFaultPoint) => void } = {},
): { kind: "invalid" | "withdrawn" | "already-withdrawn" } {
  if (
    !TOKEN_PATTERN.test(input.landingToken) ||
    !sameConfirmation(secret, input.landingToken, input.confirmationValue)
  ) return { kind: "invalid" };
  const landingHash = digest(secret, "landing", input.landingToken);
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT w.consultation_id, w.consent_event_id, w.used_at_ms,
             c.marketing_withdrawn_at_ms, e.document_id,
             e.document_version, e.document_sha256
      FROM marketing_withdrawal_capabilities w
      JOIN consultations c ON c.id = w.consultation_id
      JOIN consent_events e ON e.id = w.consent_event_id
      WHERE w.landing_hash = ? AND w.landing_expires_at_ms > ?
        AND w.expires_at_ms > ?
    `).get(landingHash, input.nowMs, input.nowMs) as WithdrawalRow | undefined;
    if (!row) {
      db.sqlite.exec("COMMIT");
      return { kind: "invalid" };
    }
    if (row.used_at_ms !== null || row.marketing_withdrawn_at_ms !== null) {
      db.sqlite.exec("COMMIT");
      return { kind: "already-withdrawn" };
    }
    const sequence = (db.sqlite.prepare(`
      SELECT COALESCE(max(sequence), 0) + 1 sequence
      FROM consent_events WHERE consultation_id = ? AND kind = 'marketing'
    `).get(row.consultation_id) as { sequence: number }).sequence;
    db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id,
        metadata_json, occurred_at_ms
      ) VALUES (?, ?, ?, 'marketing', 'withdrawn', ?, ?, ?,
        'visitor', ?, NULL, ?)
    `).run(
      randomUUID(),
      row.consultation_id,
      row.document_id,
      sequence,
      row.document_version,
      row.document_sha256,
      input.requestId,
      input.nowMs,
    );
    options.faultInjector?.("after-consent-event");
    const consultation = db.sqlite.prepare(`
      UPDATE consultations
      SET marketing_withdrawn_at_ms = ?, updated_at_ms = ?, row_version = row_version + 1
      WHERE id = ? AND marketing_accepted = 1 AND marketing_withdrawn_at_ms IS NULL
    `).run(input.nowMs, input.nowMs, row.consultation_id);
    if (consultation.changes !== 1) throw new Error("Marketing withdrawal lost its consultation CAS");
    options.faultInjector?.("after-consultation");
    const cancelled = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'cancelled', last_error_code = 'MARKETING_WITHDRAWN',
          updated_at_ms = ?
      WHERE consultation_id = ? AND purpose = 'marketing' AND state = 'pending'
    `).run(input.nowMs, row.consultation_id).changes;
    options.faultInjector?.("after-cancellation");
    db.sqlite.prepare(`
      UPDATE marketing_withdrawal_capabilities
      SET used_at_ms = COALESCE(used_at_ms, ?)
      WHERE consultation_id = ?
    `).run(input.nowMs, row.consultation_id);
    options.faultInjector?.("after-capabilities");
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, action, target_type, target_id, request_id,
        metadata_json, created_at_ms
      ) VALUES (?, 'visitor', 'marketing.withdrawn', 'consultation', ?, ?, ?, ?)
    `).run(
      randomUUID(),
      row.consultation_id,
      input.requestId,
      JSON.stringify({ cancelledPending: cancelled }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    return { kind: "withdrawn" };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
