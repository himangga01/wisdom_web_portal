import { randomUUID as nodeRandomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";

const WAL_CHECKPOINT_ATTEMPTS = 3;

export type PurgeFaultPoint =
  | "after-consultations"
  | "after-outbox"
  | "after-expired-records"
  | "after-audit";

export interface PurgeOptions {
  nowMs: number;
  apply?: boolean;
  batchSize?: number;
  randomUUID?: () => string;
  faultInjector?: (point: PurgeFaultPoint) => void;
  checkpointWal?: () => unknown;
}

export interface PurgeResult {
  dueCount: number;
  purgedCount: number;
}

interface DueRow {
  id: string;
  retention_expires_at_ms: number;
}

interface WalCheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

function assertBatchSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Purge batch size must be an integer between 1 and 1000");
  }
}

function selectDue(db: ControlDatabase, nowMs: number, batchSize: number): DueRow[] {
  return db.sqlite.prepare(`
    SELECT id, retention_expires_at_ms
    FROM consultations
    WHERE purged_at_ms IS NULL AND retention_expires_at_ms <= ?
    ORDER BY retention_expires_at_ms, id
    LIMIT ?
  `).all(nowMs, batchSize) as DueRow[];
}

function parseWalCheckpointResult(value: unknown): WalCheckpointRow {
  if (!Array.isArray(value) || value.length !== 1) {
    throw Object.assign(new Error("Retention WAL checkpoint returned an invalid result"), {
      code: "RETENTION_WAL_CHECKPOINT_FAILED",
    });
  }
  const row = value[0] as Partial<WalCheckpointRow> | undefined;
  const busy = row?.busy;
  const log = row?.log;
  const checkpointed = row?.checkpointed;
  if (
    !Number.isSafeInteger(busy) || Number(busy) < 0 ||
    !Number.isSafeInteger(log) || Number(log) < 0 ||
    !Number.isSafeInteger(checkpointed) || Number(checkpointed) < 0
  ) {
    throw Object.assign(new Error("Retention WAL checkpoint returned an invalid result"), {
      code: "RETENTION_WAL_CHECKPOINT_FAILED",
    });
  }
  return { busy: Number(busy), log: Number(log), checkpointed: Number(checkpointed) };
}

function truncateWalAfterPurge(checkpoint: () => unknown): void {
  for (let attempt = 1; attempt <= WAL_CHECKPOINT_ATTEMPTS; attempt += 1) {
    let row: WalCheckpointRow;
    try {
      row = parseWalCheckpointResult(checkpoint());
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
        if (attempt < WAL_CHECKPOINT_ATTEMPTS) continue;
        throw Object.assign(new Error("Retention WAL checkpoint remained busy after bounded retries"), {
          code: "RETENTION_WAL_CHECKPOINT_BUSY",
          cause: error,
        });
      }
      if (code === "RETENTION_WAL_CHECKPOINT_FAILED") throw error;
      throw Object.assign(new Error("Retention WAL checkpoint failed after the purge commit"), {
        code: "RETENTION_WAL_CHECKPOINT_FAILED",
        cause: error,
      });
    }
    if (row.busy === 0) {
      if (row.log === 0 && row.checkpointed === 0) return;
      throw Object.assign(new Error("Retention WAL checkpoint did not truncate the WAL"), {
        code: "RETENTION_WAL_CHECKPOINT_FAILED",
      });
    }
  }
  throw Object.assign(new Error("Retention WAL checkpoint remained busy after bounded retries"), {
    code: "RETENTION_WAL_CHECKPOINT_BUSY",
  });
}

export function purgeExpiredConsultations(
  db: ControlDatabase,
  options: PurgeOptions,
): PurgeResult {
  const batchSize = options.batchSize ?? 100;
  assertBatchSize(batchSize);
  if (options.apply !== true) {
    return { dueCount: selectDue(db, options.nowMs, batchSize).length, purgedCount: 0 };
  }

  const createId = options.randomUUID ?? nodeRandomUUID;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const due = selectDue(db, options.nowMs, batchSize);
    const clearConsultation = db.sqlite.prepare(`
      UPDATE consultations
      SET pii_envelope = NULL,
          pii_key_id = NULL,
          phone_blind_index = NULL,
          email_blind_index = NULL,
          blind_index_key_id = NULL,
          purged_at_ms = ?,
          updated_at_ms = ?,
          row_version = row_version + 1
      WHERE id = ? AND purged_at_ms IS NULL
    `);
    let purgedCount = 0;
    for (const row of due) {
      purgedCount += clearConsultation.run(options.nowMs, options.nowMs, row.id).changes;
    }
    options.faultInjector?.("after-consultations");

    const clearOutbox = db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = CASE
            WHEN state IN ('pending','processing','failed') THEN 'cancelled'
            ELSE state
          END,
          payload_json = NULL,
          locked_at_ms = NULL,
          locked_by = NULL,
          updated_at_ms = ?
      WHERE consultation_id = ?
    `);
    for (const row of due) clearOutbox.run(options.nowMs, row.id);
    options.faultInjector?.("after-outbox");

    db.sqlite.prepare("DELETE FROM idempotency_keys WHERE expires_at_ms <= ?").run(options.nowMs);
    db.sqlite.prepare("DELETE FROM abuse_buckets WHERE expires_at_ms <= ?").run(options.nowMs);
    options.faultInjector?.("after-expired-records");

    const insertAudit = db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, action, target_type, target_id, request_id,
        metadata_json, created_at_ms
      ) VALUES (?, 'system', 'consultation.purged', 'consultation', ?, ?, ?, ?)
    `);
    for (const row of due) {
      insertAudit.run(
        createId(),
        row.id,
        `retention-purge:${options.nowMs}`,
        JSON.stringify({ retentionExpiresAtMs: row.retention_expires_at_ms }),
        options.nowMs,
      );
    }
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    truncateWalAfterPurge(
      options.checkpointWal ?? (() => db.sqlite.pragma("wal_checkpoint(TRUNCATE)")),
    );
    return { dueCount: due.length, purgedCount };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
