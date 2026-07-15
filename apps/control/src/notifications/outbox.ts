import { randomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";

const LEASE_MS = 2 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export interface ClaimedNotification {
  id: string;
  deliveryId: string;
  consultationId: string;
  channel: "email" | "hermes-telegram";
  eventType: string;
  payloadJson: string | null;
  purpose: "transactional" | "marketing" | "test";
  deliveryCycle: number;
  attemptNo: number;
  workerId: string;
  attemptId: string;
}

interface OutboxRow {
  id: string;
  consultation_id: string;
  channel: ClaimedNotification["channel"];
  event_type: string;
  payload_json: string | null;
  purpose: ClaimedNotification["purpose"];
  delivery_cycle: number;
  attempt_count: number;
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

function recoverExpiredLeases(db: ControlDatabase, nowMs: number): void {
  const expired = db.sqlite.prepare(`
    SELECT id, delivery_cycle, attempt_count
    FROM notification_outbox
    WHERE state = 'processing' AND lease_expires_at_ms <= ?
  `).all(nowMs) as Array<{ id: string; delivery_cycle: number; attempt_count: number }>;
  const finishAttempt = db.sqlite.prepare(`
    UPDATE notification_delivery_attempts
    SET outcome_code = 'LEASE_EXPIRED', finished_at_ms = ?
    WHERE outbox_id = ? AND delivery_cycle = ? AND attempt_no = ?
      AND finished_at_ms IS NULL
  `);
  const release = db.sqlite.prepare(`
    UPDATE notification_outbox
    SET state = ?, available_at_ms = ?, locked_at_ms = NULL,
        lease_expires_at_ms = NULL, locked_by = NULL,
        last_error_code = 'LEASE_EXPIRED', updated_at_ms = ?
    WHERE id = ? AND state = 'processing' AND lease_expires_at_ms <= ?
  `);
  for (const row of expired) {
    finishAttempt.run(nowMs, row.id, row.delivery_cycle, row.attempt_count);
    release.run(row.attempt_count >= MAX_ATTEMPTS ? "failed" : "pending", nowMs, nowMs, row.id, nowMs);
  }
}

export function claimNotification(
  db: ControlDatabase,
  input: { workerId: string; nowMs: number; attemptId?: () => string },
): ClaimedNotification | undefined {
  if (!input.workerId.trim()) throw new Error("Notification worker ID is required");
  return transaction(db, () => {
    recoverExpiredLeases(db, input.nowMs);
    const row = db.sqlite.prepare(`
      SELECT id, consultation_id, channel, event_type, payload_json,
             purpose, delivery_cycle, attempt_count
      FROM notification_outbox
      WHERE state = 'pending' AND available_at_ms <= ? AND attempt_count < ?
      ORDER BY available_at_ms, created_at_ms, id
      LIMIT 1
    `).get(input.nowMs, MAX_ATTEMPTS) as OutboxRow | undefined;
    if (!row) return undefined;
    const attemptNo = row.attempt_count + 1;
    const claimed = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'processing', attempt_count = ?, locked_at_ms = ?,
          lease_expires_at_ms = ?, locked_by = ?, updated_at_ms = ?
      WHERE id = ? AND state = 'pending' AND attempt_count = ?
    `).run(
      attemptNo,
      input.nowMs,
      input.nowMs + LEASE_MS,
      input.workerId,
      input.nowMs,
      row.id,
      row.attempt_count,
    );
    if (claimed.changes !== 1) return undefined;
    const attemptId = (input.attemptId ?? randomUUID)();
    db.sqlite.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, delivery_cycle, attempt_no, worker_id, started_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(attemptId, row.id, row.delivery_cycle, attemptNo, input.workerId, input.nowMs);
    return {
      id: row.id,
      deliveryId: row.id,
      consultationId: row.consultation_id,
      channel: row.channel,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      purpose: row.purpose,
      deliveryCycle: row.delivery_cycle,
      attemptNo,
      workerId: input.workerId,
      attemptId,
    };
  });
}

function assertOwnedClaim(db: ControlDatabase, claim: ClaimedNotification, nowMs: number): void {
  const row = db.sqlite.prepare(`
    SELECT 1 ok
    FROM notification_outbox o
    JOIN notification_delivery_attempts a
      ON a.outbox_id = o.id
     AND a.delivery_cycle = o.delivery_cycle
     AND a.attempt_no = o.attempt_count
    WHERE o.id = ? AND o.state = 'processing' AND o.locked_by = ?
      AND o.delivery_cycle = ? AND o.attempt_count = ?
      AND o.lease_expires_at_ms > ?
      AND a.id = ? AND a.worker_id = ? AND a.finished_at_ms IS NULL
  `).get(
    claim.id,
    claim.workerId,
    claim.deliveryCycle,
    claim.attemptNo,
    nowMs,
    claim.attemptId,
    claim.workerId,
  );
  if (!row) throw new Error("Notification claim, attempt, or lease is no longer valid");
}

export function finalizeNotificationSuccess(
  db: ControlDatabase,
  claim: ClaimedNotification,
  nowMs: number,
  providerMessageId: string,
): void {
  transaction(db, () => {
    assertOwnedClaim(db, claim, nowMs);
    const attempt = db.sqlite.prepare(`
      UPDATE notification_delivery_attempts
      SET outcome_code = 'SENT', provider_message_id = ?, finished_at_ms = ?
      WHERE id = ? AND outbox_id = ? AND delivery_cycle = ? AND attempt_no = ?
        AND worker_id = ? AND finished_at_ms IS NULL
    `).run(
      providerMessageId,
      nowMs,
      claim.attemptId,
      claim.id,
      claim.deliveryCycle,
      claim.attemptNo,
      claim.workerId,
    );
    if (attempt.changes !== 1) throw new Error("Notification delivery attempt could not be finalized");
    const outbox = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'sent', provider_message_id = ?, last_error_code = NULL,
          sent_at_ms = ?, updated_at_ms = ?, locked_at_ms = NULL,
          lease_expires_at_ms = NULL, locked_by = NULL
      WHERE id = ? AND state = 'processing' AND locked_by = ?
        AND delivery_cycle = ? AND attempt_count = ? AND lease_expires_at_ms > ?
    `).run(
      providerMessageId,
      nowMs,
      nowMs,
      claim.id,
      claim.workerId,
      claim.deliveryCycle,
      claim.attemptNo,
      nowMs,
    );
    if (outbox.changes !== 1) throw new Error("Notification claim could not be finalized");
  });
}

export function finalizeNotificationFailure(
  db: ControlDatabase,
  claim: ClaimedNotification,
  nowMs: number,
  outcomeCode: string,
): void {
  transaction(db, () => {
    assertOwnedClaim(db, claim, nowMs);
    const terminal = claim.attemptNo >= MAX_ATTEMPTS;
    const availableAtMs = terminal
      ? nowMs
      : nowMs + (RETRY_DELAYS_MS[claim.attemptNo - 1] ?? RETRY_DELAYS_MS.at(-1)!);
    const attempt = db.sqlite.prepare(`
      UPDATE notification_delivery_attempts
      SET outcome_code = ?, finished_at_ms = ?
      WHERE id = ? AND outbox_id = ? AND delivery_cycle = ? AND attempt_no = ?
        AND worker_id = ? AND finished_at_ms IS NULL
    `).run(
      outcomeCode,
      nowMs,
      claim.attemptId,
      claim.id,
      claim.deliveryCycle,
      claim.attemptNo,
      claim.workerId,
    );
    if (attempt.changes !== 1) throw new Error("Notification delivery attempt could not be finalized");
    const outbox = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = ?, available_at_ms = ?, last_error_code = ?,
          updated_at_ms = ?, locked_at_ms = NULL,
          lease_expires_at_ms = NULL, locked_by = NULL
      WHERE id = ? AND state = 'processing' AND locked_by = ?
        AND delivery_cycle = ? AND attempt_count = ? AND lease_expires_at_ms > ?
    `).run(
      terminal ? "failed" : "pending",
      availableAtMs,
      outcomeCode,
      nowMs,
      claim.id,
      claim.workerId,
      claim.deliveryCycle,
      claim.attemptNo,
      nowMs,
    );
    if (outbox.changes !== 1) throw new Error("Notification claim could not be finalized");
  });
}

export function cancelClaimedNotification(
  db: ControlDatabase,
  claim: ClaimedNotification,
  nowMs: number,
  outcomeCode: string,
): void {
  transaction(db, () => {
    assertOwnedClaim(db, claim, nowMs);
    const attempt = db.sqlite.prepare(`
      UPDATE notification_delivery_attempts
      SET outcome_code = ?, finished_at_ms = ?
      WHERE id = ? AND outbox_id = ? AND delivery_cycle = ? AND attempt_no = ?
        AND worker_id = ? AND finished_at_ms IS NULL
    `).run(
      outcomeCode,
      nowMs,
      claim.attemptId,
      claim.id,
      claim.deliveryCycle,
      claim.attemptNo,
      claim.workerId,
    );
    if (attempt.changes !== 1) throw new Error("Notification delivery attempt could not be finalized");
    const outbox = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'cancelled', last_error_code = ?, updated_at_ms = ?,
          locked_at_ms = NULL, lease_expires_at_ms = NULL, locked_by = NULL
      WHERE id = ? AND state = 'processing' AND locked_by = ?
        AND delivery_cycle = ? AND attempt_count = ? AND lease_expires_at_ms > ?
    `).run(
      outcomeCode,
      nowMs,
      claim.id,
      claim.workerId,
      claim.deliveryCycle,
      claim.attemptNo,
      nowMs,
    );
    if (outbox.changes !== 1) throw new Error("Notification claim could not be finalized");
  });
}

export function requeueFailedNotification(
  db: ControlDatabase,
  id: string,
  nowMs: number,
  audit?: { actorAdminId: string; requestId: string },
): boolean {
  return transaction(db, () => {
    const changed = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'pending', attempt_count = 0, available_at_ms = ?,
          delivery_cycle = delivery_cycle + 1, provider_message_id = NULL,
          last_error_code = NULL, sent_at_ms = NULL, updated_at_ms = ?,
          locked_at_ms = NULL, lease_expires_at_ms = NULL, locked_by = NULL
      WHERE id = ? AND state = 'failed'
    `).run(nowMs, nowMs, id).changes === 1;
    if (changed && audit) {
      db.sqlite.prepare(`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, target_type, target_id,
          request_id, metadata_json, created_at_ms
        ) VALUES (?, 'admin', ?, 'notification.failed.requeued',
          'notification', ?, ?, NULL, ?)
      `).run(randomUUID(), audit.actorAdminId, id, audit.requestId, nowMs);
    }
    return changed;
  });
}
