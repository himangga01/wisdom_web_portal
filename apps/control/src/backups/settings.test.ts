import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  changeAutomaticBackupSetting,
  readBackupSettings,
  type ChangeAutomaticBackupInput,
} from "./settings.js";

const ADMIN_ID = "admin-backup-owner";
const DISABLE_AUDIT_ID = "00000000-0000-4000-8000-000000000701";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedAdmin(db: TestDatabase["db"]): void {
  db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status, created_at_ms, updated_at_ms
    ) VALUES (?, 'backup-owner', 'Backup Owner', 'argon-placeholder', 'active', 0, 0)
  `).run(ADMIN_ID);
}

function changeInput(
  overrides: Partial<ChangeAutomaticBackupInput> = {},
): ChangeAutomaticBackupInput {
  return {
    automaticEnabled: false,
    expectedRowVersion: 1,
    actorAdminId: ADMIN_ID,
    requestId: "request-disable",
    nowMs: 1_721_188_800_000,
    ...overrides,
  };
}

function auditCount(db: TestDatabase["db"]): number {
  return (db.sqlite.prepare(`
    SELECT count(*) count FROM audit_events
    WHERE action IN ('automatic_backup.enabled', 'automatic_backup.disabled')
  `).get() as { count: number }).count;
}

function expectBackupControlInvalid(operation: () => unknown): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({
    code: "BACKUP_CONTROL_INVALID",
    message: "Backup control state is invalid",
  });
  expect(String((thrown as Error).message)).not.toMatch(
    /backup_settings|sqlite|no such table|constraint/i,
  );
}

describe("automatic backup settings", () => {
  it("reads the migration default as enabled", () => {
    testDatabase = createTestDatabase();

    expect(readBackupSettings(testDatabase.db)).toEqual({
      automaticEnabled: true,
      rowVersion: 1,
      updatedAtMs: 0,
      updatedByAdminId: null,
    });
  });

  it("atomically disables automatic backups and writes the exact audit metadata", () => {
    testDatabase = createTestDatabase();
    const { db } = testDatabase;
    seedAdmin(db);

    const changed = changeAutomaticBackupSetting(db, {
      automaticEnabled: false,
      expectedRowVersion: 1,
      actorAdminId: ADMIN_ID,
      requestId: "request-disable",
      nowMs: 1_721_188_800_000,
    }, { randomUUID: () => DISABLE_AUDIT_ID });

    expect(changed).toMatchObject({
      kind: "updated",
      httpStatus: 200,
      settings: { automaticEnabled: false, rowVersion: 2 },
    });
    expect(changed.settings).toEqual({
      automaticEnabled: false,
      rowVersion: 2,
      updatedAtMs: 1_721_188_800_000,
      updatedByAdminId: ADMIN_ID,
    });
    expect(db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      action: "automatic_backup.disabled",
      metadata_json: JSON.stringify({
        previousAutomaticEnabled: true,
        automaticEnabled: false,
        rowVersion: 2,
      }),
    });
    expect(db.sqlite.prepare(`
      SELECT actor_type, actor_id, request_id, created_at_ms FROM audit_events
      WHERE id = ?
    `).get(DISABLE_AUDIT_ID)).toEqual({
      actor_type: "admin",
      actor_id: ADMIN_ID,
      request_id: "request-disable",
      created_at_ms: 1_721_188_800_000,
    });
  });

  it("uses the enabled audit action when changing OFF to ON", () => {
    testDatabase = createTestDatabase();
    const { db } = testDatabase;
    seedAdmin(db);
    db.sqlite.prepare(`
      UPDATE backup_settings
      SET automatic_enabled = 0, row_version = 7, updated_at_ms = 1_000,
          updated_by_admin_id = ?
      WHERE singleton = 1
    `).run(ADMIN_ID);

    expect(changeAutomaticBackupSetting(db, changeInput({
      automaticEnabled: true,
      expectedRowVersion: 7,
      requestId: "request-enable",
      nowMs: 2_000,
    }), { randomUUID: () => "00000000-0000-4000-8000-000000000702" })).toEqual({
      kind: "updated",
      httpStatus: 200,
      settings: {
        automaticEnabled: true,
        rowVersion: 8,
        updatedAtMs: 2_000,
        updatedByAdminId: ADMIN_ID,
      },
    });
    expect(db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events
    `).get()).toEqual({
      action: "automatic_backup.enabled",
      metadata_json: JSON.stringify({
        previousAutomaticEnabled: false,
        automaticEnabled: true,
        rowVersion: 8,
      }),
    });
  });

  it("returns unchanged without advancing the row or writing an audit event", () => {
    testDatabase = createTestDatabase();
    seedAdmin(testDatabase.db);

    expect(changeAutomaticBackupSetting(testDatabase.db, changeInput({
      automaticEnabled: true,
      requestId: "request-unchanged",
    }), {
      randomUUID() {
        throw new Error("an unchanged request must not allocate an audit id");
      },
    })).toEqual({
      kind: "unchanged",
      httpStatus: 200,
      settings: {
        automaticEnabled: true,
        rowVersion: 1,
        updatedAtMs: 0,
        updatedByAdminId: null,
      },
    });
    expect(readBackupSettings(testDatabase.db)).toEqual({
      automaticEnabled: true,
      rowVersion: 1,
      updatedAtMs: 0,
      updatedByAdminId: null,
    });
    expect(auditCount(testDatabase.db)).toBe(0);
    expect(testDatabase.db.sqlite.inTransaction).toBe(false);
  });

  it("returns a 409 conflict for a stale row version before same-state handling", () => {
    testDatabase = createTestDatabase();
    seedAdmin(testDatabase.db);

    expect(changeAutomaticBackupSetting(testDatabase.db, changeInput({
      automaticEnabled: true,
      expectedRowVersion: 0,
      requestId: "request-stale",
    }))).toEqual({
      kind: "conflict",
      httpStatus: 409,
      settings: {
        automaticEnabled: true,
        rowVersion: 1,
        updatedAtMs: 0,
        updatedByAdminId: null,
      },
    });
    expect(auditCount(testDatabase.db)).toBe(0);
    expect(testDatabase.db.sqlite.inTransaction).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid change timestamp %s without corrupting the policy row",
    (nowMs) => {
      testDatabase = createTestDatabase();
      seedAdmin(testDatabase.db);

      expect(() => changeAutomaticBackupSetting(
        testDatabase!.db,
        changeInput({ nowMs }),
      )).toThrow("Automatic backup change timestamp is invalid");
      expect(readBackupSettings(testDatabase.db)).toEqual({
        automaticEnabled: true,
        rowVersion: 1,
        updatedAtMs: 0,
        updatedByAdminId: null,
      });
      expect(auditCount(testDatabase.db)).toBe(0);
      expect(testDatabase.db.sqlite.inTransaction).toBe(false);
    },
  );

  it.each([
    ["missing singleton", "DELETE FROM backup_settings"],
    ["wrong singleton", "UPDATE backup_settings SET singleton = 2"],
    ["invalid boolean", "UPDATE backup_settings SET automatic_enabled = 2"],
    ["fractional boolean", "UPDATE backup_settings SET automatic_enabled = 0.5"],
    ["zero revision", "UPDATE backup_settings SET row_version = 0"],
    ["fractional revision", "UPDATE backup_settings SET row_version = 1.5"],
    ["negative timestamp", "UPDATE backup_settings SET updated_at_ms = -1"],
    ["fractional timestamp", "UPDATE backup_settings SET updated_at_ms = 0.5"],
  ])("fails closed with a sanitized error for a %s", (_label, mutation) => {
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.pragma("ignore_check_constraints = ON");
    testDatabase.db.sqlite.exec(mutation);

    expectBackupControlInvalid(() => readBackupSettings(testDatabase!.db));
  });

  it("fails closed when multiple policy rows are present", () => {
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.exec(`
      DROP TABLE backup_settings;
      CREATE TABLE backup_settings (
        singleton INTEGER,
        automatic_enabled INTEGER,
        row_version INTEGER,
        updated_at_ms INTEGER,
        updated_by_admin_id TEXT
      );
      INSERT INTO backup_settings VALUES (1, 1, 1, 0, NULL);
      INSERT INTO backup_settings VALUES (1, 0, 2, 1, NULL);
    `);

    expectBackupControlInvalid(() => readBackupSettings(testDatabase!.db));
  });

  it("fails closed when the updater id is not stored as text", () => {
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.pragma("foreign_keys = OFF");
    testDatabase.db.sqlite.prepare(`
      UPDATE backup_settings SET updated_by_admin_id = ? WHERE singleton = 1
    `).run(Buffer.from([1]));

    expectBackupControlInvalid(() => readBackupSettings(testDatabase!.db));
  });

  it("sanitizes SQLite read failures and rolls back a change attempt", () => {
    testDatabase = createTestDatabase();
    seedAdmin(testDatabase.db);
    testDatabase.db.sqlite.exec("DROP TABLE backup_settings");

    expectBackupControlInvalid(() => readBackupSettings(testDatabase!.db));
    expectBackupControlInvalid(() => changeAutomaticBackupSetting(
      testDatabase!.db,
      changeInput(),
    ));
    expect(testDatabase.db.sqlite.inTransaction).toBe(false);
    expect(auditCount(testDatabase.db)).toBe(0);
  });

  it("returns conflict without audit when the CAS update changes no row", () => {
    testDatabase = createTestDatabase();
    seedAdmin(testDatabase.db);
    testDatabase.db.sqlite.exec(`
      CREATE TRIGGER backup_settings_ignore_update
      BEFORE UPDATE ON backup_settings
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    expect(changeAutomaticBackupSetting(testDatabase.db, changeInput())).toEqual({
      kind: "conflict",
      httpStatus: 409,
      settings: {
        automaticEnabled: true,
        rowVersion: 1,
        updatedAtMs: 0,
        updatedByAdminId: null,
      },
    });
    expect(auditCount(testDatabase.db)).toBe(0);
    expect(testDatabase.db.sqlite.inTransaction).toBe(false);
  });

  it.each(["after-settings", "after-audit"] as const)(
    "rolls back the setting and audit after an injected %s fault",
    (faultPoint) => {
      testDatabase = createTestDatabase();
      seedAdmin(testDatabase.db);

      expect(() => changeAutomaticBackupSetting(testDatabase!.db, changeInput(), {
        randomUUID: () => DISABLE_AUDIT_ID,
        faultInjector(point) {
          if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
        },
      })).toThrow(`injected ${faultPoint}`);
      expect(readBackupSettings(testDatabase.db)).toEqual({
        automaticEnabled: true,
        rowVersion: 1,
        updatedAtMs: 0,
        updatedByAdminId: null,
      });
      expect(auditCount(testDatabase.db)).toBe(0);
      expect(testDatabase.db.sqlite.inTransaction).toBe(false);
    },
  );
});
