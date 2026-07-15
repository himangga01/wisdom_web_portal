import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { closeDatabase, isDatabaseReady, openDatabase, runMigrations } from "./client.js";
import { REQUIRED_INDEXES, REQUIRED_TABLES, SCHEMA_VERSION } from "./schema.js";

let testDatabase: TestDatabase | undefined;

afterEach(() => testDatabase?.close());

describe("SQLite durability and migrations", () => {
  it("rejects migration histories that are not an exact contiguous known prefix", () => {
    const histories = [
      [{ version: 2, name: "admin-notification-withdrawal" }],
      [{ version: 1, name: "wrong-name" }],
      [
        { version: 1, name: "initial-control-schema" },
        { version: 3, name: "future-schema" },
      ],
    ];
    for (const history of histories) {
      const db = openDatabase(":memory:");
      try {
        db.sqlite.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
          )
        `);
        const insert = db.sqlite.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, 0)",
        );
        for (const row of history) insert.run(row.version, row.name);
        expect(() => runMigrations(db, 1_000), JSON.stringify(history)).toThrow(/migration/i);
        expect(db.sqlite.prepare(
          "SELECT count(*) count FROM sqlite_master WHERE type = 'table' AND name = 'consultations'",
        ).get()).toEqual({ count: 0 });
      } finally {
        closeDatabase(db);
      }
    }
  });

  it("reports ready only for the exact full history and required v2 schema invariants", () => {
    for (const mutation of [
      "ALTER TABLE consultations DROP COLUMN marketing_withdrawn_at_ms",
      "DROP TABLE admin_pre_auth_challenges",
      "DROP INDEX notification_outbox_lease_idx",
    ]) {
      const database = createTestDatabase();
      try {
        expect(isDatabaseReady(database.db)).toBe(true);
        database.db.sqlite.exec(mutation);
        expect(isDatabaseReady(database.db), mutation).toBe(false);
      } finally {
        database.close();
      }
    }
  });

  it("upgrades a file-backed v1 database to v2 without losing consultations or sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "wisdom-control-v1-"));
    const path = join(directory, "control.sqlite");
    const v1 = openDatabase(path);
    (runMigrations as unknown as (db: typeof v1, nowMs: number, targetVersion: number) => void)(v1, 1_000, 1);
    expect(v1.sqlite.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({ version: 1 });
    v1.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('consultation-v1', 'receipt-v1', 'received', 'ko', 'procurement', 'phone',
        'opaque-envelope', 'pii-v1', ?, NULL, 'pii-v1', 0, 1000, 1000, 2000, 1)
    `).run(Buffer.alloc(32, 1));
    v1.sqlite.prepare(`
      INSERT INTO admins (
        id, username, display_name, password_hash, status, created_at_ms, updated_at_ms
      ) VALUES ('admin-v1', 'owner', 'Owner', 'argon-placeholder', 'active', 1000, 1000)
    `).run();
    v1.sqlite.prepare(`
      INSERT INTO admin_sessions (
        token_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms,
        idle_expires_at_ms, last_seen_at_ms
      ) VALUES (?, 'admin-v1', ?, 1000, 2000, 1500, 1000)
    `).run(Buffer.alloc(32, 2), Buffer.alloc(32, 3));
    closeDatabase(v1);

    const upgraded = openDatabase(path);
    runMigrations(upgraded, 3_000);
    expect(upgraded.sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(upgraded.sqlite.prepare("SELECT id FROM consultations").all()).toEqual([{ id: "consultation-v1" }]);
    expect(upgraded.sqlite.prepare("SELECT admin_id FROM admin_sessions").all()).toEqual([{ admin_id: "admin-v1" }]);
    const v2Tables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => (row as { name: string }).name);
    expect(v2Tables).toEqual(expect.arrayContaining([
      "admin_recovery_codes",
      "admin_pre_auth_challenges",
      "admin_login_buckets",
      "notification_delivery_attempts",
      "marketing_withdrawal_capabilities",
    ]));
    const columns = (table: string) => (
      upgraded.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns("consultations")).toContain("marketing_withdrawn_at_ms");
    expect(columns("admins")).toContain("totp_last_counter");
    expect(columns("notification_outbox")).toEqual(expect.arrayContaining([
      "lease_expires_at_ms",
      "purpose",
      "delivery_cycle",
    ]));
    expect(() => upgraded.sqlite.prepare(`
      INSERT INTO admin_login_buckets (
        subject_kind, subject_hash, window_start_ms, failure_count, expires_at_ms
      ) VALUES ('invalid', ?, 0, 1, 1)
    `).run(Buffer.alloc(32))).toThrow();

    closeDatabase(upgraded);
    const restarted = openDatabase(path);
    runMigrations(restarted, 4_000);
    expect(restarted.sqlite.prepare("SELECT count(*) count FROM schema_migrations").get()).toEqual({ count: 2 });
    closeDatabase(restarted);
    rmSync(directory, { force: true, recursive: true });
  });

  it("normalizes a legacy v1 processing outbox row before a v2 restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "wisdom-control-v1-outbox-"));
    const path = join(directory, "control.sqlite");
    const v1 = openDatabase(path);
    try {
      (runMigrations as unknown as (db: typeof v1, nowMs: number, targetVersion: number) => void)(v1, 1_000, 1);
      v1.sqlite.prepare(`
        INSERT INTO consultations (
          id, receipt_id, status, locale, category, preferred_contact,
          pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
          marketing_accepted, received_at_ms, updated_at_ms,
          retention_expires_at_ms, row_version
        ) VALUES ('legacy-consultation', 'legacy-receipt', 'received', 'ko', 'procurement', 'phone',
          'opaque-envelope', 'pii-v1', ?, 'pii-v1', 0, 1000, 1000, 2000, 1)
      `).run(Buffer.alloc(32, 9));
      v1.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, state, attempt_count,
          available_at_ms, locked_at_ms, locked_by, created_at_ms, updated_at_ms
        ) VALUES ('legacy-delivery', 'legacy-consultation', 'email',
          'consultation.received', 'processing', 1, 1000, 1000, 'legacy-worker', 1000, 1000)
      `).run();
    } finally {
      closeDatabase(v1);
    }

    const upgraded = openDatabase(path);
    try {
      runMigrations(upgraded, 2_000);
      expect(upgraded.sqlite.prepare(`
        SELECT state, locked_at_ms, locked_by, lease_expires_at_ms, purpose, delivery_cycle
        FROM notification_outbox WHERE id = 'legacy-delivery'
      `).get()).toEqual({
        state: "pending",
        locked_at_ms: null,
        locked_by: null,
        lease_expires_at_ms: null,
        purpose: "transactional",
        delivery_cycle: 1,
      });
    } finally {
      closeDatabase(upgraded);
    }

    const restarted = openDatabase(path);
    try {
      runMigrations(restarted, 3_000);
      expect(restarted.sqlite.prepare(`
        SELECT state, locked_at_ms, locked_by, lease_expires_at_ms
        FROM notification_outbox WHERE id = 'legacy-delivery'
      `).get()).toEqual({
        state: "pending",
        locked_at_ms: null,
        locked_by: null,
        lease_expires_at_ms: null,
      });
    } finally {
      closeDatabase(restarted);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("applies repeatable migrations and required PRAGMAs on every connection", () => {
    testDatabase = createTestDatabase();
    runMigrations(testDatabase.db);

    const pragma = (name: string) => testDatabase!.db.sqlite.pragma(name, { simple: true });
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(2);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("secure_delete")).toBe(1);
    expect(testDatabase.db.sqlite.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({
      version: SCHEMA_VERSION,
    });

    const tables = testDatabase.db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining([...REQUIRED_TABLES]));

    const indexes = testDatabase.db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(expect.arrayContaining([...REQUIRED_INDEXES]));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO admin_pre_auth_challenges (
        challenge_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms
      ) VALUES (?, 'missing-admin', ?, 0, 1)
    `).run(Buffer.alloc(31), Buffer.alloc(32))).toThrow();

    const insertConsultation = testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 1, 0, 0, 1000, 1)
    `);
    insertConsultation.run("consultation-a", "receipt-a", Buffer.alloc(32, 1));
    insertConsultation.run("consultation-b", "receipt-b", Buffer.alloc(32, 2));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('consultation-c', 'receipt-c', 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 0, 0, 0, 1000, 1)
    `).run(Buffer.alloc(32, 5));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES ('marketing-document', 'bundle', 'marketing', 'ko', 'm-v1',
        'Marketing', 'Terms', ?, 24, 'active', 0)
    `).run(Buffer.alloc(32, 3));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES ('privacy-document', 'bundle', 'privacy', 'ko', 'p-v1',
        'Privacy', 'Terms', ?, 12, 'active', 0)
    `).run(Buffer.alloc(32, 6));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('marketing-event-a', 'consultation-a', 'marketing-document',
        'marketing', 'accepted', 1, 'm-v1', ?, 'visitor', 'request-a', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'marketing-event-a', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 4))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('privacy-event-b', 'consultation-b', 'privacy-document',
        'privacy', 'accepted', 1, 'p-v1', ?, 'visitor', 'request-b', 0)
    `).run(Buffer.alloc(32, 6));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'privacy-event-b', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 7))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('declined-event-b', 'consultation-b', 'marketing-document',
        'marketing', 'declined', 1, 'm-v1', ?, 'visitor', 'request-b', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'declined-event-b', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 8))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('accepted-event-c', 'consultation-c', 'marketing-document',
        'marketing', 'accepted', 1, 'm-v1', ?, 'visitor', 'request-c', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-c', 'accepted-event-c', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 9))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-a', 'marketing-event-a', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 10));
    expect(() => testDatabase!.db.sqlite.prepare(`
      UPDATE marketing_withdrawal_capabilities
      SET consultation_id = 'consultation-b'
      WHERE token_hash = ?
    `).run(Buffer.alloc(32, 10))).toThrow();
  });

  it("enforces foreign keys and reopens a file-backed WAL database", () => {
    testDatabase = createTestDatabase();
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("event", "missing", "missing", "privacy", "accepted", 1, "v1", Buffer.alloc(32), "visitor", "req", 1)).toThrow();

    const path = testDatabase.path;
    closeDatabase(testDatabase.db);
    const reopened = openDatabase(path);
    runMigrations(reopened);
    expect(reopened.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    closeDatabase(reopened);
  });
});
