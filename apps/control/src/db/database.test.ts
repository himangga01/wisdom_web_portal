import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { closeDatabase, openDatabase, runMigrations } from "./client.js";
import { REQUIRED_INDEXES, REQUIRED_TABLES, SCHEMA_VERSION } from "./schema.js";

let testDatabase: TestDatabase | undefined;

afterEach(() => testDatabase?.close());

describe("SQLite durability and migrations", () => {
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
