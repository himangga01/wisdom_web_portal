import { randomUUID as nodeRandomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";

export interface BackupSettings {
  automaticEnabled: boolean;
  rowVersion: number;
  updatedAtMs: number;
  updatedByAdminId: string | null;
}

export interface ChangeAutomaticBackupInput {
  automaticEnabled: boolean;
  expectedRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

export type ChangeAutomaticBackupResult =
  | { kind: "updated" | "unchanged"; httpStatus: 200; settings: BackupSettings }
  | { kind: "conflict"; httpStatus: 409; settings: BackupSettings };

interface BackupSettingsRow {
  singleton: unknown;
  automatic_enabled: unknown;
  row_version: unknown;
  updated_at_ms: unknown;
  updated_by_admin_id: unknown;
}

function invalidBackupControlError(): Error & { code: "BACKUP_CONTROL_INVALID" } {
  return Object.assign(new Error("Backup control state is invalid"), {
    code: "BACKUP_CONTROL_INVALID" as const,
  });
}

function parseBackupSettingsRows(rows: readonly BackupSettingsRow[]): BackupSettings {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    row === undefined ||
    row.singleton !== 1 ||
    (row.automatic_enabled !== 0 && row.automatic_enabled !== 1) ||
    typeof row.row_version !== "number" ||
    !Number.isSafeInteger(row.row_version) ||
    row.row_version <= 0 ||
    typeof row.updated_at_ms !== "number" ||
    !Number.isSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < 0 ||
    (row.updated_by_admin_id !== null && (
      typeof row.updated_by_admin_id !== "string" || row.updated_by_admin_id.length === 0
    ))
  ) {
    throw invalidBackupControlError();
  }
  return {
    automaticEnabled: row.automatic_enabled === 1,
    rowVersion: row.row_version,
    updatedAtMs: row.updated_at_ms,
    updatedByAdminId: row.updated_by_admin_id,
  };
}

export function readBackupSettings(db: ControlDatabase): BackupSettings {
  try {
    const rows = db.sqlite.prepare(`
      SELECT singleton, automatic_enabled, row_version, updated_at_ms, updated_by_admin_id
      FROM backup_settings
      LIMIT 2
    `).all() as BackupSettingsRow[];
    return parseBackupSettingsRows(rows);
  } catch {
    throw invalidBackupControlError();
  }
}

export function changeAutomaticBackupSetting(
  db: ControlDatabase,
  input: ChangeAutomaticBackupInput,
  options: {
    randomUUID?: () => string;
    faultInjector?: (point: "after-settings" | "after-audit") => void;
  } = {},
): ChangeAutomaticBackupResult {
  const createId = options.randomUUID ?? nodeRandomUUID;
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error("Automatic backup change timestamp is invalid");
  }
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const current = readBackupSettings(db);
    if (current.rowVersion !== input.expectedRowVersion) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "conflict", httpStatus: 409, settings: current };
    }
    if (current.automaticEnabled === input.automaticEnabled) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "unchanged", httpStatus: 200, settings: current };
    }

    const nextRowVersion = current.rowVersion + 1;
    if (!Number.isSafeInteger(nextRowVersion)) throw invalidBackupControlError();
    const update = db.sqlite.prepare(`
      UPDATE backup_settings
      SET automatic_enabled = ?, row_version = ?, updated_at_ms = ?, updated_by_admin_id = ?
      WHERE singleton = 1 AND row_version = ? AND automatic_enabled = ?
    `).run(
      input.automaticEnabled ? 1 : 0,
      nextRowVersion,
      input.nowMs,
      input.actorAdminId,
      current.rowVersion,
      current.automaticEnabled ? 1 : 0,
    );
    if (update.changes !== 1) {
      const latest = readBackupSettings(db);
      db.sqlite.exec("ROLLBACK");
      return { kind: "conflict", httpStatus: 409, settings: latest };
    }
    options.faultInjector?.("after-settings");

    const settings: BackupSettings = {
      automaticEnabled: input.automaticEnabled,
      rowVersion: nextRowVersion,
      updatedAtMs: input.nowMs,
      updatedByAdminId: input.actorAdminId,
    };
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, ?, 'backup_settings', '1', ?, ?, ?)
    `).run(
      createId(),
      input.actorAdminId,
      input.automaticEnabled ? "automatic_backup.enabled" : "automatic_backup.disabled",
      input.requestId,
      JSON.stringify({
        previousAutomaticEnabled: current.automaticEnabled,
        automaticEnabled: input.automaticEnabled,
        rowVersion: nextRowVersion,
      }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");

    db.sqlite.exec("COMMIT");
    return { kind: "updated", httpStatus: 200, settings };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
