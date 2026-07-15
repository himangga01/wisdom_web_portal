import { randomUUID as nodeRandomUUID } from "node:crypto";

import type {
  ConsultationStatus,
  NotificationChannel,
} from "@wisdom/shared";

import type { ControlDatabase } from "../db/client.js";

export type ConsultationWorkflowFaultPoint =
  | "after-status"
  | "after-audit"
  | "after-outbox";

export interface ChangeConsultationStatusInput {
  consultationId: string;
  targetStatus: ConsultationStatus;
  expectedRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
  notificationChannels?: readonly NotificationChannel[];
}

export interface ChangeConsultationStatusOptions {
  randomUUID?: () => string;
  faultInjector?: (point: ConsultationWorkflowFaultPoint) => void;
}

export type ChangeConsultationStatusResult =
  | {
      kind: "updated" | "unchanged";
      httpStatus: 200;
      consultationStatus: ConsultationStatus;
      rowVersion: number;
    }
  | {
      kind: "conflict";
      httpStatus: 409;
      consultationStatus: ConsultationStatus;
      rowVersion: number;
    }
  | {
      kind: "invalid-transition";
      httpStatus: 422;
      consultationStatus: ConsultationStatus;
      rowVersion: number;
    }
  | { kind: "not-found"; httpStatus: 404 };

interface ConsultationWorkflowRow {
  receipt_id: string;
  status: ConsultationStatus;
  row_version: number;
}

const ALLOWED_NEXT_STATUSES: Record<
  ConsultationStatus,
  readonly ConsultationStatus[]
> = {
  received: ["acknowledged", "in_progress", "closed", "spam"],
  acknowledged: ["in_progress", "closed", "spam"],
  in_progress: ["closed", "spam"],
  closed: [],
  spam: [],
};

function isAllowedTransition(
  fromStatus: ConsultationStatus,
  toStatus: ConsultationStatus,
): boolean {
  return ALLOWED_NEXT_STATUSES[fromStatus].includes(toStatus);
}

export function changeConsultationStatus(
  db: ControlDatabase,
  input: ChangeConsultationStatusInput,
  options: ChangeConsultationStatusOptions = {},
): ChangeConsultationStatusResult {
  const createId = options.randomUUID ?? nodeRandomUUID;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT receipt_id, status, row_version
      FROM consultations
      WHERE id = ?
    `).get(input.consultationId) as ConsultationWorkflowRow | undefined;

    if (!row) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "not-found", httpStatus: 404 };
    }
    if (row.row_version !== input.expectedRowVersion) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "conflict",
        httpStatus: 409,
        consultationStatus: row.status,
        rowVersion: row.row_version,
      };
    }
    if (row.status === input.targetStatus) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "unchanged",
        httpStatus: 200,
        consultationStatus: row.status,
        rowVersion: row.row_version,
      };
    }
    if (!isAllowedTransition(row.status, input.targetStatus)) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "invalid-transition",
        httpStatus: 422,
        consultationStatus: row.status,
        rowVersion: row.row_version,
      };
    }

    const nextRowVersion = row.row_version + 1;
    const update = db.sqlite.prepare(`
      UPDATE consultations
      SET status = ?, updated_at_ms = ?, row_version = ?
      WHERE id = ? AND status = ? AND row_version = ?
    `).run(
      input.targetStatus,
      input.nowMs,
      nextRowVersion,
      input.consultationId,
      row.status,
      row.row_version,
    );
    if (update.changes !== 1) {
      db.sqlite.exec("ROLLBACK");
      const current = db.sqlite.prepare(`
        SELECT status, row_version FROM consultations WHERE id = ?
      `).get(input.consultationId) as Pick<
        ConsultationWorkflowRow,
        "status" | "row_version"
      > | undefined;
      if (!current) return { kind: "not-found", httpStatus: 404 };
      return {
        kind: "conflict",
        httpStatus: 409,
        consultationStatus: current.status,
        rowVersion: current.row_version,
      };
    }
    options.faultInjector?.("after-status");

    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, 'consultation.status.changed', 'consultation', ?, ?, ?, ?)
    `).run(
      createId(),
      input.actorAdminId,
      input.consultationId,
      input.requestId,
      JSON.stringify({
        fromStatus: row.status,
        toStatus: input.targetStatus,
        rowVersion: nextRowVersion,
      }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");

    const insertOutbox = db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, payload_json, state,
        attempt_count, available_at_ms, purpose, delivery_cycle,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'transactional', 1, ?, ?)
    `);
    const eventType = `consultation.status.${input.targetStatus}`;
    const payloadJson = JSON.stringify({
      receiptId: row.receipt_id,
      status: input.targetStatus,
    });
    for (const channel of new Set(input.notificationChannels ?? [])) {
      insertOutbox.run(
        createId(),
        input.consultationId,
        channel,
        eventType,
        payloadJson,
        input.nowMs,
        input.nowMs,
        input.nowMs,
      );
    }
    options.faultInjector?.("after-outbox");

    db.sqlite.exec("COMMIT");
    return {
      kind: "updated",
      httpStatus: 200,
      consultationStatus: input.targetStatus,
      rowVersion: nextRowVersion,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
