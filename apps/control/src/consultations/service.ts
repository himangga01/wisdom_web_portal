import { randomUUID as nodeRandomUUID, timingSafeEqual } from "node:crypto";

import type { ConsultationReceipt, ConsultationRequest } from "@wisdom/shared";

import { FormTokenExpiredError, verifyFormToken } from "../abuse/form-token.js";
import { applyRateLimitsInTransaction } from "../abuse/rate-limit.js";
import {
  blindIndex,
  blindIndexCandidates,
  encryptPii,
  keyedDigest,
  type KeyProvider,
} from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import type {
  ConsentAuthority,
  ConsentAuthorityResolver,
} from "../consent/service.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export type IntakeFaultPoint =
  | "after-rate-limits"
  | "after-consultation"
  | "after-consent-events"
  | "after-outbox"
  | "after-audit"
  | "after-idempotency";

export interface AcceptConsultationInput {
  consultation: ConsultationRequest;
  formToken: string;
  idempotencyKey: string;
  requestId: string;
  clientIp: string;
  nowMs: number;
}

export interface AcceptConsultationOptions {
  resolveConsentAuthority: ConsentAuthorityResolver;
  randomUUID?: () => string;
  faultInjector?: (point: IntakeFaultPoint) => void;
}

export type IntakeResult =
  | { kind: "created"; status: 201; responseJson: string; receipt: ConsultationReceipt }
  | { kind: "replay"; status: number; responseJson: string }
  | { kind: "conflict" }
  | { kind: "invalid-submission" }
  | { kind: "stale-form-token" }
  | { kind: "stale-consent" }
  | { kind: "consent-unavailable" }
  | { kind: "rate-limited"; retryAfterSeconds: number };

interface IdempotencyRow {
  request_fingerprint: Buffer;
  response_status: number;
  response_json: string;
  expires_at_ms: number;
}

interface ConsentRow {
  id: string;
  bundle_id: string;
  kind: "privacy" | "marketing";
  locale: ConsultationRequest["locale"];
  version: string;
  title: string;
  body_markdown: string;
  content_sha256: Buffer;
  retention_months: 12 | 24;
  effective_at_ms: number | null;
}

export function findConsultationIdsByContact(
  db: ControlDatabase,
  provider: KeyProvider,
  kind: "phone" | "email",
  value: string,
): string[] {
  const column = kind === "phone" ? "phone_blind_index" : "email_blind_index";
  const find = db.sqlite.prepare(`
    SELECT id FROM consultations
    WHERE purged_at_ms IS NULL AND blind_index_key_id = ? AND ${column} = ?
    ORDER BY received_at_ms DESC, id
  `);
  return blindIndexCandidates(provider, kind, value).flatMap((candidate) =>
    (find.all(candidate.keyId, candidate.index) as Array<{ id: string }>).map((row) => row.id)
  );
}

function canonicalRequest(request: ConsultationRequest): string {
  return JSON.stringify({
    locale: request.locale,
    category: request.category,
    name: request.name,
    phone: request.phone,
    email: request.email ?? null,
    company: request.company ?? null,
    preferredContact: request.preferredContact,
    message: request.message,
    privacyConsent: {
      version: request.privacyConsent.version,
      accepted: request.privacyConsent.accepted,
    },
    marketingConsent: {
      version: request.marketingConsent.version,
      accepted: request.marketingConsent.accepted,
    },
  });
}

export function addMonthsClamped(timestampMs: number, months: number): number {
  const source = new Date(timestampMs);
  const targetYear = source.getUTCFullYear() + Math.floor((source.getUTCMonth() + months) / 12);
  const targetMonth = (source.getUTCMonth() + months) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(source.getUTCDate(), lastDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
}

function authoritativeConsentRows(
  db: ControlDatabase,
  request: ConsultationRequest,
  authority: ConsentAuthority,
): { kind: "ok"; rows: ConsentRow[] } | { kind: "stale" | "unavailable" } {
  const published = authority.bundle.documents.filter((document) => document.locale === request.locale);
  const publishedPrivacy = published.find((document) => document.kind === "privacy");
  const publishedMarketing = published.find((document) => document.kind === "marketing");
  if (!publishedPrivacy || !publishedMarketing) return { kind: "unavailable" };
  if (publishedPrivacy.version !== request.privacyConsent.version
    || publishedMarketing.version !== request.marketingConsent.version) {
    return { kind: "stale" };
  }
  const rows = db.sqlite.prepare(`
    SELECT id, bundle_id, kind, locale, version, title, body_markdown,
      content_sha256, retention_months, effective_at_ms
    FROM consent_documents
    WHERE bundle_id = ? AND locale = ? AND kind IN ('privacy','marketing')
    ORDER BY kind
  `).all(authority.bundle.bundleId, request.locale) as ConsentRow[];
  if (rows.length !== 2 || rows[0]?.bundle_id !== rows[1]?.bundle_id) return { kind: "unavailable" };
  const privacy = rows.find((row) => row.kind === "privacy");
  const marketing = rows.find((row) => row.kind === "marketing");
  if (!privacy || !marketing) return { kind: "unavailable" };
  for (const [row, document] of [
    [privacy, publishedPrivacy],
    [marketing, publishedMarketing],
  ] as const) {
    if (row.version !== document.version
      || row.title !== document.title
      || row.body_markdown !== document.bodyMarkdown
      || row.content_sha256.toString("hex") !== document.contentSha256
      || row.retention_months !== document.retentionMonths
      || row.effective_at_ms === null
      || new Date(row.effective_at_ms).toISOString() !== document.effectiveAt) {
      return { kind: "unavailable" };
    }
  }
  return { kind: "ok", rows: [privacy, marketing] };
}

function digestCandidates(provider: KeyProvider, purpose: "idempotency" | "request-fingerprint", value: string) {
  return provider.all().map((material) => ({
    keyId: material.id,
    digest: keyedDigest(provider, purpose, value, material.id),
  }));
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function acceptConsultation(
  db: ControlDatabase,
  provider: KeyProvider,
  input: AcceptConsultationInput,
  options: AcceptConsultationOptions,
): IntakeResult {
  const createId = options.randomUUID ?? nodeRandomUUID;
  const consultationId = createId();
  const receiptId = `receipt_${createId().replaceAll("-", "")}`;
  const receipt: ConsultationReceipt = {
    receiptId,
    receivedAt: new Date(input.nowMs).toISOString(),
    status: "received",
  };
  const responseJson = JSON.stringify(receipt);
  const piiEnvelope = encryptPii(provider, consultationId, {
    name: input.consultation.name,
    phone: input.consultation.phone,
    ...(input.consultation.email ? { email: input.consultation.email } : {}),
    ...(input.consultation.company ? { company: input.consultation.company } : {}),
    message: input.consultation.message,
  });
  const phoneIndex = blindIndex(provider, "phone", input.consultation.phone);
  const emailIndex = input.consultation.email
    ? blindIndex(provider, "email", input.consultation.email)
    : null;
  const idempotencyCandidates = digestCandidates(provider, "idempotency", input.idempotencyKey);
  const canonical = canonicalRequest(input.consultation);

  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const findIdempotency = db.sqlite.prepare(`
      SELECT request_fingerprint, response_status, response_json, expires_at_ms
      FROM idempotency_keys WHERE scope = 'consultation' AND key_hash = ?
    `);
    const deleteIdempotency = db.sqlite.prepare(
      "DELETE FROM idempotency_keys WHERE scope = 'consultation' AND key_hash = ? AND expires_at_ms <= ?",
    );
    for (const candidate of idempotencyCandidates) {
      const existing = findIdempotency.get(candidate.digest) as IdempotencyRow | undefined;
      if (!existing) continue;
      if (existing.expires_at_ms <= input.nowMs) {
        deleteIdempotency.run(candidate.digest, input.nowMs);
        continue;
      }
      const fingerprint = keyedDigest(provider, "request-fingerprint", canonical, candidate.keyId);
      db.sqlite.exec("COMMIT");
      return sameDigest(existing.request_fingerprint, fingerprint)
        ? { kind: "replay", status: existing.response_status, responseJson: existing.response_json }
        : { kind: "conflict" };
    }

    let authority: ConsentAuthority | undefined;
    try {
      authority = options.resolveConsentAuthority();
    } catch {
      authority = undefined;
    }
    if (!authority) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "consent-unavailable" };
    }

    try {
      verifyFormToken(provider, input.formToken, {
        locale: input.consultation.locale,
        privacyVersion: input.consultation.privacyConsent.version,
        marketingVersion: input.consultation.marketingConsent.version,
      }, input.nowMs);
    } catch (error) {
      db.sqlite.exec("ROLLBACK");
      if (error instanceof FormTokenExpiredError) return { kind: "stale-form-token" };
      return { kind: "invalid-submission" };
    }

    const resolvedConsent = authoritativeConsentRows(db, input.consultation, authority);
    if (resolvedConsent.kind !== "ok") {
      db.sqlite.exec("ROLLBACK");
      return resolvedConsent.kind === "stale"
        ? { kind: "stale-consent" }
        : { kind: "consent-unavailable" };
    }
    const consentRows = resolvedConsent.rows;

    const rate = applyRateLimitsInTransaction(db, provider, {
      clientIp: input.clientIp,
      phone: input.consultation.phone,
      ...(input.consultation.email ? { email: input.consultation.email } : {}),
    }, input.nowMs);
    if (!rate.allowed) {
      db.sqlite.exec("COMMIT");
      return { kind: "rate-limited", retryAfterSeconds: rate.retryAfterSeconds };
    }
    options.faultInjector?.("after-rate-limits");

    const privacy = consentRows.find((row) => row.kind === "privacy")!;
    const marketing = consentRows.find((row) => row.kind === "marketing")!;
    const retentionMonths = input.consultation.marketingConsent.accepted
      ? marketing.retention_months
      : privacy.retention_months;
    const retentionExpiresAtMs = addMonthsClamped(input.nowMs, retentionMonths);
    db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      consultationId,
      receiptId,
      input.consultation.locale,
      input.consultation.category,
      input.consultation.preferredContact,
      piiEnvelope,
      provider.active().id,
      phoneIndex,
      emailIndex,
      provider.active().id,
      input.consultation.marketingConsent.accepted ? 1 : 0,
      input.nowMs,
      input.nowMs,
      retentionExpiresAtMs,
    );
    options.faultInjector?.("after-consultation");

    const insertConsent = db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id,
        metadata_json, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'visitor', ?, NULL, ?)
    `);
    insertConsent.run(
      createId(), consultationId, privacy.id, "privacy", "accepted",
      privacy.version, privacy.content_sha256, input.requestId, input.nowMs,
    );
    insertConsent.run(
      createId(), consultationId, marketing.id, "marketing",
      input.consultation.marketingConsent.accepted ? "accepted" : "declined",
      marketing.version, marketing.content_sha256, input.requestId, input.nowMs,
    );
    options.faultInjector?.("after-consent-events");

    const insertOutbox = db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, payload_json, state,
        attempt_count, available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'consultation.received', ?, 'pending', 0, ?, ?, ?)
    `);
    const outboxPayload = JSON.stringify({ receiptId });
    insertOutbox.run(createId(), consultationId, "email", outboxPayload, input.nowMs, input.nowMs, input.nowMs);
    insertOutbox.run(createId(), consultationId, "hermes-telegram", outboxPayload, input.nowMs, input.nowMs, input.nowMs);
    if (input.consultation.marketingConsent.accepted) {
      db.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, payload_json, state,
          attempt_count, available_at_ms, purpose, delivery_cycle,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'email', 'marketing.confirmation', ?, 'pending',
          0, ?, 'marketing', 1, ?, ?)
      `).run(createId(), consultationId, outboxPayload, input.nowMs, input.nowMs, input.nowMs);
    }
    options.faultInjector?.("after-outbox");

    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, action, target_type, target_id, request_id,
        metadata_json, created_at_ms
      ) VALUES (?, 'visitor', 'consultation.received', 'consultation', ?, ?, ?, ?)
    `).run(
      createId(),
      consultationId,
      input.requestId,
      JSON.stringify({ locale: input.consultation.locale, category: input.consultation.category }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");

    const activeIdempotency = idempotencyCandidates.find((candidate) => candidate.keyId === provider.active().id)!;
    const requestFingerprint = keyedDigest(provider, "request-fingerprint", canonical);
    db.sqlite.prepare(`
      INSERT INTO idempotency_keys (
        scope, key_hash, request_fingerprint, consultation_id, response_status,
        response_json, created_at_ms, expires_at_ms
      ) VALUES ('consultation', ?, ?, ?, 201, ?, ?, ?)
    `).run(
      activeIdempotency.digest,
      requestFingerprint,
      consultationId,
      responseJson,
      input.nowMs,
      input.nowMs + IDEMPOTENCY_TTL_MS,
    );
    options.faultInjector?.("after-idempotency");
    db.sqlite.exec("COMMIT");
    return { kind: "created", status: 201, responseJson, receipt };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
