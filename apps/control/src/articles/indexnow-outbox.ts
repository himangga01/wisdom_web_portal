import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { parseIndexNowPayloadJson } from "./indexnow-payload.js";

export const INDEXNOW_LEASE_MS = 2 * 60_000;
export const INDEXNOW_MAX_ATTEMPTS = 5;

const INDEXNOW_RETRY_BASE_MS = 60_000;
const INDEXNOW_RETRY_MAX_MS = 60 * 60_000;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const INDEXNOW_RETRYABLE_ERROR_CODES = [
  "INDEXNOW_LEASE_EXPIRED",
  "INDEXNOW_HTTP_ERROR",
  "INDEXNOW_RESPONSE_INVALID",
  "INDEXNOW_TRANSPORT_ERROR",
] as const;

type RetryableIndexNowErrorCode = typeof INDEXNOW_RETRYABLE_ERROR_CODES[number];
type TerminalIndexNowErrorCode = "INDEXNOW_PAYLOAD_INVALID";
type IndexNowErrorCode = RetryableIndexNowErrorCode | TerminalIndexNowErrorCode;

export interface IndexNowPayload {
  host: string;
  urls: string[];
}

export interface IndexNowSenderResult {
  status: number;
  providerMessageId?: string;
}

export type IndexNowJsonSender = (
  payload: IndexNowPayload,
) => Promise<IndexNowSenderResult>;

export interface IndexNowDeliveryClaim {
  outboxId: string;
  releaseId: string;
  manifestSha256: Buffer;
  payloadJson: string;
  attemptCount: number;
  workerId: string;
  fencingToken: Buffer;
  leaseExpiresAtMs: number;
}

export interface ClaimIndexNowDeliveryInput {
  workerId: string;
  nowMs: number;
  randomBytes?: (size: number) => Uint8Array;
}

interface IndexNowOutboxCandidate {
  id: string;
  release_id: string;
  manifest_sha256: Buffer;
  payload_json: string;
  attempt_count: number;
}

function assertNowMs(nowMs: number): void {
  if (
    !Number.isSafeInteger(nowMs)
    || nowMs < 0
    || nowMs > Number.MAX_SAFE_INTEGER - INDEXNOW_RETRY_MAX_MS
  ) throw new Error("IndexNow time must be a safe non-negative integer");
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

function createFencingToken(generator: (size: number) => Uint8Array): Buffer {
  const token = Buffer.from(generator(32));
  if (token.length !== 32) throw new Error("IndexNow fencing token must be 32 bytes");
  return token;
}

function recoverExpiredLeases(db: ControlDatabase, nowMs: number): void {
  db.sqlite.prepare(`
    UPDATE publication_outbox
    SET state = 'failed', available_at_ms = ?,
      locked_at_ms = NULL, lease_expires_at_ms = NULL,
      locked_by = NULL, fencing_token = NULL,
      last_error_code = 'INDEXNOW_LEASE_EXPIRED', updated_at_ms = ?
    WHERE state = 'processing' AND lease_expires_at_ms <= ?
  `).run(nowMs, nowMs, nowMs);
}

export function claimIndexNowDelivery(
  db: ControlDatabase,
  input: ClaimIndexNowDeliveryInput,
): IndexNowDeliveryClaim | undefined {
  assertNowMs(input.nowMs);
  if (!WORKER_ID_PATTERN.test(input.workerId)) throw new Error("Invalid IndexNow worker ID");
  const fencingToken = createFencingToken(input.randomBytes ?? nodeRandomBytes);

  return transaction(db, () => {
    recoverExpiredLeases(db, input.nowMs);

    const processing = db.sqlite.prepare(`
      SELECT 1 FROM publication_outbox WHERE state = 'processing' LIMIT 1
    `).get();
    if (processing) return undefined;

    const placeholders = INDEXNOW_RETRYABLE_ERROR_CODES.map(() => "?").join(", ");
    const candidate = db.sqlite.prepare(`
      SELECT id, release_id, manifest_sha256, payload_json, attempt_count
      FROM publication_outbox
      WHERE available_at_ms <= ? AND attempt_count < ? AND (
        state = 'pending'
        OR (state = 'failed' AND last_error_code IN (${placeholders}))
      )
      ORDER BY available_at_ms, created_at_ms, id
      LIMIT 1
    `).get(
      input.nowMs,
      INDEXNOW_MAX_ATTEMPTS,
      ...INDEXNOW_RETRYABLE_ERROR_CODES,
    ) as IndexNowOutboxCandidate | undefined;
    if (!candidate) return undefined;

    const attemptCount = candidate.attempt_count + 1;
    const leaseExpiresAtMs = input.nowMs + INDEXNOW_LEASE_MS;
    const changed = db.sqlite.prepare(`
      UPDATE publication_outbox
      SET state = 'processing', attempt_count = ?, locked_at_ms = ?,
        lease_expires_at_ms = ?, locked_by = ?, fencing_token = ?,
        updated_at_ms = ?
      WHERE id = ? AND attempt_count = ? AND available_at_ms <= ? AND (
        state = 'pending'
        OR (state = 'failed' AND last_error_code IN (${placeholders}))
      )
    `).run(
      attemptCount,
      input.nowMs,
      leaseExpiresAtMs,
      input.workerId,
      fencingToken,
      input.nowMs,
      candidate.id,
      candidate.attempt_count,
      input.nowMs,
      ...INDEXNOW_RETRYABLE_ERROR_CODES,
    );
    if (changed.changes !== 1) return undefined;

    return {
      outboxId: candidate.id,
      releaseId: candidate.release_id,
      manifestSha256: Buffer.from(candidate.manifest_sha256),
      payloadJson: candidate.payload_json,
      attemptCount,
      workerId: input.workerId,
      fencingToken,
      leaseExpiresAtMs,
    };
  });
}

function claimParameters(claim: IndexNowDeliveryClaim): readonly unknown[] {
  return [
    claim.outboxId,
    claim.releaseId,
    claim.manifestSha256,
    claim.payloadJson,
    claim.attemptCount,
    claim.workerId,
    claim.fencingToken,
  ];
}

function hasLiveClaim(
  db: ControlDatabase,
  claim: IndexNowDeliveryClaim,
  nowMs: number,
): boolean {
  return Boolean(db.sqlite.prepare(`
    SELECT 1 FROM publication_outbox
    WHERE id = ? AND release_id = ? AND manifest_sha256 = ?
      AND payload_json = ? AND attempt_count = ? AND state = 'processing'
      AND locked_by = ? AND fencing_token = ? AND lease_expires_at_ms > ?
  `).get(...claimParameters(claim), nowMs));
}

function safeProviderMessageId(value: string | undefined): string | null {
  return typeof value === "string" && PROVIDER_MESSAGE_ID_PATTERN.test(value)
    ? value
    : null;
}

export function completeIndexNowDelivery(
  db: ControlDatabase,
  claim: IndexNowDeliveryClaim,
  input: { nowMs: number; providerMessageId?: string },
): boolean {
  assertNowMs(input.nowMs);
  const providerMessageId = safeProviderMessageId(input.providerMessageId);
  return transaction(db, () => {
    if (!hasLiveClaim(db, claim, input.nowMs)) return false;
    const changed = db.sqlite.prepare(`
      UPDATE publication_outbox
      SET state = 'sent', provider_message_id = ?, last_error_code = NULL,
        sent_at_ms = ?, updated_at_ms = ?, locked_at_ms = NULL,
        lease_expires_at_ms = NULL, locked_by = NULL, fencing_token = NULL
      WHERE id = ? AND release_id = ? AND manifest_sha256 = ?
        AND payload_json = ? AND attempt_count = ? AND state = 'processing'
        AND locked_by = ? AND fencing_token = ? AND lease_expires_at_ms > ?
    `).run(
      providerMessageId,
      input.nowMs,
      input.nowMs,
      ...claimParameters(claim),
      input.nowMs,
    );
    return changed.changes === 1;
  });
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    INDEXNOW_RETRY_BASE_MS * (2 ** Math.max(0, attemptCount - 1)),
    INDEXNOW_RETRY_MAX_MS,
  );
}

function failIndexNowDelivery(
  db: ControlDatabase,
  claim: IndexNowDeliveryClaim,
  input: { nowMs: number; errorCode: IndexNowErrorCode },
): { finalized: boolean; retry: boolean; availableAtMs: number } {
  assertNowMs(input.nowMs);
  const retryable = (INDEXNOW_RETRYABLE_ERROR_CODES as readonly string[]).includes(input.errorCode)
    && claim.attemptCount < INDEXNOW_MAX_ATTEMPTS;
  const availableAtMs = retryable
    ? input.nowMs + retryDelayMs(claim.attemptCount)
    : input.nowMs;
  return transaction(db, () => {
    if (!hasLiveClaim(db, claim, input.nowMs)) {
      return { finalized: false, retry: false, availableAtMs };
    }
    const changed = db.sqlite.prepare(`
      UPDATE publication_outbox
      SET state = 'failed', available_at_ms = ?, last_error_code = ?,
        provider_message_id = NULL, updated_at_ms = ?, locked_at_ms = NULL,
        lease_expires_at_ms = NULL, locked_by = NULL, fencing_token = NULL
      WHERE id = ? AND release_id = ? AND manifest_sha256 = ?
        AND payload_json = ? AND attempt_count = ? AND state = 'processing'
        AND locked_by = ? AND fencing_token = ? AND lease_expires_at_ms > ?
    `).run(
      availableAtMs,
      input.errorCode,
      input.nowMs,
      ...claimParameters(claim),
      input.nowMs,
    );
    return {
      finalized: changed.changes === 1,
      retry: changed.changes === 1 && retryable,
      availableAtMs,
    };
  });
}

function parseIndexNowPayload(payloadJson: string): IndexNowPayload | undefined {
  const payload = parseIndexNowPayloadJson(payloadJson);
  return payload ? { host: payload.host, urls: payload.urls } : undefined;
}

export type IndexNowDeliveryResult =
  | { kind: "idle" }
  | { kind: "fenced"; outboxId: string }
  | { kind: "sent"; outboxId: string; status: number }
  | { kind: "retry-scheduled"; outboxId: string; availableAtMs: number }
  | { kind: "failed"; outboxId: string; errorCode: IndexNowErrorCode };

export interface DeliverNextIndexNowOutboxInput {
  workerId: string;
  now: () => number;
  sendJson: IndexNowJsonSender;
  randomBytes?: (size: number) => Uint8Array;
}

function failureResult(
  db: ControlDatabase,
  claim: IndexNowDeliveryClaim,
  nowMs: number,
  errorCode: IndexNowErrorCode,
): IndexNowDeliveryResult {
  const failed = failIndexNowDelivery(db, claim, { nowMs, errorCode });
  if (!failed.finalized) return { kind: "fenced", outboxId: claim.outboxId };
  if (failed.retry) {
    return {
      kind: "retry-scheduled",
      outboxId: claim.outboxId,
      availableAtMs: failed.availableAtMs,
    };
  }
  return { kind: "failed", outboxId: claim.outboxId, errorCode };
}

export async function deliverNextIndexNowOutbox(
  db: ControlDatabase,
  input: DeliverNextIndexNowOutboxInput,
): Promise<IndexNowDeliveryResult> {
  const claim = claimIndexNowDelivery(db, {
    workerId: input.workerId,
    nowMs: input.now(),
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
  });
  if (!claim) return { kind: "idle" };

  const payload = parseIndexNowPayload(claim.payloadJson);
  if (!payload) {
    return failureResult(db, claim, input.now(), "INDEXNOW_PAYLOAD_INVALID");
  }

  let response: IndexNowSenderResult;
  try {
    response = await input.sendJson({ host: payload.host, urls: [...payload.urls] });
  } catch {
    return failureResult(db, claim, input.now(), "INDEXNOW_TRANSPORT_ERROR");
  }

  if (
    typeof response !== "object"
    || response === null
    || !Number.isInteger(response.status)
    || response.status < 100
    || response.status > 599
  ) {
    return failureResult(db, claim, input.now(), "INDEXNOW_RESPONSE_INVALID");
  }
  if (response.status !== 200 && response.status !== 202) {
    return failureResult(db, claim, input.now(), "INDEXNOW_HTTP_ERROR");
  }

  const completed = completeIndexNowDelivery(db, claim, {
    nowMs: input.now(),
    ...(response.providerMessageId === undefined
      ? {}
      : { providerMessageId: response.providerMessageId }),
  });
  return completed
    ? { kind: "sent", outboxId: claim.outboxId, status: response.status }
    : { kind: "fenced", outboxId: claim.outboxId };
}
