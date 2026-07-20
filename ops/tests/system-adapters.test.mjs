import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

function createRestoreRetentionFixtureSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 6;
    CREATE TABLE consultations (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','acknowledged','in_progress','closed','spam')),
      locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
      category TEXT NOT NULL CHECK (category IN ('procurement','credibility','safety-esg','business-certification','licensing-entity','immigration-visa','other')),
      preferred_contact TEXT NOT NULL CHECK (preferred_contact IN ('phone','email')),
      pii_envelope TEXT,
      pii_key_id TEXT,
      phone_blind_index BLOB,
      email_blind_index BLOB,
      blind_index_key_id TEXT,
      marketing_accepted INTEGER NOT NULL CHECK (marketing_accepted IN (0,1)),
      received_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      retention_expires_at_ms INTEGER NOT NULL,
      purged_at_ms INTEGER,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
      marketing_withdrawn_at_ms INTEGER CHECK (marketing_withdrawn_at_ms IS NULL OR marketing_accepted = 1),
      CHECK (
        (purged_at_ms IS NULL AND pii_envelope IS NOT NULL AND pii_key_id IS NOT NULL AND phone_blind_index IS NOT NULL AND blind_index_key_id IS NOT NULL)
        OR
        (purged_at_ms IS NOT NULL AND pii_envelope IS NULL AND pii_key_id IS NULL AND phone_blind_index IS NULL AND email_blind_index IS NULL AND blind_index_key_id IS NULL)
      )
    );
    CREATE TABLE notification_outbox (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      channel TEXT NOT NULL CHECK (channel IN ('email','hermes-telegram')),
      event_type TEXT NOT NULL,
      payload_json TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed','cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      available_at_ms INTEGER NOT NULL,
      locked_at_ms INTEGER,
      locked_by TEXT,
      provider_message_id TEXT,
      last_error_code TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      sent_at_ms INTEGER,
      lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
      purpose TEXT NOT NULL DEFAULT 'transactional' CHECK (purpose IN ('transactional','marketing','test')),
      delivery_cycle INTEGER NOT NULL DEFAULT 1 CHECK (delivery_cycle > 0)
    );
    CREATE TABLE notification_delivery_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
      delivery_cycle INTEGER NOT NULL CHECK (delivery_cycle > 0),
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      worker_id TEXT NOT NULL,
      outcome_code TEXT,
      provider_message_id TEXT,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      UNIQUE (outbox_id, delivery_cycle, attempt_no)
    );
    CREATE TABLE idempotency_keys (
      scope TEXT NOT NULL,
      key_hash BLOB NOT NULL CHECK (length(key_hash) = 32),
      request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
      consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, key_hash)
    ) WITHOUT ROWID;
    CREATE TABLE abuse_buckets (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('ip','phone','email')),
      subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
      window_kind TEXT NOT NULL CHECK (window_kind IN ('ten_minute','day')),
      window_start_ms INTEGER NOT NULL,
      count INTEGER NOT NULL CHECK (count > 0),
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (subject_kind, subject_hash, window_kind, window_start_ms)
    ) WITHOUT ROWID;
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('visitor','admin','token','system')),
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      request_id TEXT NOT NULL,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
}

test("age decrypt streams identity through stdin, never a file or process argument", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-age-adapter-")));
  const input = path.join(directory, "backup.age");
  const output = path.join(directory, "restored.sqlite");
  const calls = [];
  let identityBuffer;
  await writeFile(input, "ciphertext");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async (executable, args, options) => {
      calls.push({ executable, args, options });
      identityBuffer = options.stdin;
      assert.equal(Buffer.from(identityBuffer).toString("utf8"), "AGE-SECRET-KEY-OPERATOR\n");
      await writeFile(output, "plaintext-snapshot");
    },
  });

  await adapter.decrypt({
    input,
    output,
    identity: "AGE-SECRET-KEY-OPERATOR",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "ignore", "ignore"]);
  assert.deepEqual(calls[0].args, ["--decrypt", "--identity", "-", "--output", output, input]);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /AGE-SECRET-KEY-OPERATOR/);
  assert.ok(Buffer.from(identityBuffer).every((byte) => byte === 0));
  assert.deepEqual((await readdir(directory)).sort(), ["backup.age", "restored.sqlite"]);
});

test("age decrypt fails closed when a legacy identity residue exists in the output directory", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-age-residue-")));
  const input = path.join(directory, "backup.age");
  const output = path.join(directory, "restored.sqlite");
  const residue = path.join(directory, "previous.sqlite.identity-abandoned");
  let calls = 0;
  await writeFile(input, "ciphertext");
  await writeFile(residue, "AGE-SECRET-KEY-RESIDUE");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async () => { calls += 1; },
  });

  await assert.rejects(adapter.decrypt({
    input,
    output,
    identity: "AGE-SECRET-KEY-OPERATOR",
  }), { code: "AGE_IDENTITY_RESIDUE_DETECTED" });
  assert.equal(calls, 0);
  assert.equal(await readFile(residue, "utf8"), "AGE-SECRET-KEY-RESIDUE");
});

test("age encryption accepts only an age recipient and absolute paths", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-age-encrypt-")));
  const input = path.join(directory, "snapshot.sqlite");
  const output = path.join(directory, "snapshot.age");
  const calls = [];
  await writeFile(input, "snapshot");
  const adapter = createAgeAdapter({
    executable: path.join(path.parse(process.cwd()).root, "opt", "bin", "age"),
    run: async (_executable, args, options) => {
      calls.push({ args, options });
      await writeFile(output, "ciphertext");
    },
  });

  await adapter.encrypt({ input, output, recipient: "age1fixtureoperator" });
  assert.deepEqual(calls[0].args, ["--recipient", "age1fixtureoperator", "--output", output, input]);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(
    adapter.encrypt({ input: "snapshot.sqlite", output, recipient: "not-an-age-recipient" }),
    { code: "AGE_ADAPTER_INPUT_INVALID" },
  );
});

test("SQLite restore retention removes expired PII and cancels its queued delivery", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-restore-retention-")));
  const databasePath = path.join(directory, "restored.sqlite");
  const rawCanary = `EXPIRED-RAW-CANARY-${"R".repeat(512)}`;
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  createRestoreRetentionFixtureSchema(database);
  database.exec(`
    INSERT INTO consultations (
      id, receipt_id, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, purged_at_ms, row_version
    ) VALUES
      ('expired', 'receipt-expired', 'ko', 'procurement', 'phone',
        'expired-private', 'pii-v1', x'01', x'02', 'pii-v1', 0, 1, 1, 100, NULL, 1),
      ('future', 'receipt-future', 'ko', 'procurement', 'phone',
        'future-private', 'pii-v1', x'03', x'04', 'pii-v1', 0, 1, 1, 101, NULL, 1);
    INSERT INTO notification_outbox (
      id, consultation_id, channel, event_type, payload_json, state,
      attempt_count, available_at_ms, locked_at_ms, locked_by,
      last_error_code, created_at_ms, updated_at_ms, lease_expires_at_ms
    ) VALUES
      ('outbox-expired', 'expired', 'email', 'consultation.received', 'private-payload', 'processing',
        1, 1, 90, 'worker', NULL, 1, 90, 110),
      ('outbox-future', 'future', 'email', 'consultation.received', 'future-payload', 'pending',
        0, 1, NULL, NULL, NULL, 1, 90, NULL);
    INSERT INTO notification_delivery_attempts (
      id, outbox_id, delivery_cycle, attempt_no, worker_id,
      outcome_code, started_at_ms, finished_at_ms
    ) VALUES ('attempt-expired', 'outbox-expired', 1, 1, 'worker', NULL, 90, NULL);
    INSERT INTO abuse_buckets (
      subject_kind, subject_hash, window_kind, window_start_ms, count, expires_at_ms
    ) VALUES
      ('ip', zeroblob(32), 'ten_minute', 1, 1, 100),
      ('ip', zeroblob(32), 'ten_minute', 2, 1, 101);
  `);
  database.prepare(`
    INSERT INTO idempotency_keys (
      scope, key_hash, request_fingerprint, consultation_id,
      response_status, response_json, created_at_ms, expires_at_ms
    ) VALUES
      ('consultation', ?, zeroblob(32), 'expired', 201, ?, 1, 100),
      ('consultation', ?, zeroblob(32), 'future', 201, 'future-canary', 1, 101)
  `).run(
    Buffer.alloc(32, 1), rawCanary, Buffer.alloc(32, 2),
  );
  database.close();
  assert.equal((await readFile(databasePath)).includes(Buffer.from(rawCanary)), true);

  const result = await createSqliteAdapter().enforceRetention(databasePath, 100);
  const inspected = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(result, { purgedCount: 1 });
    assert.deepEqual(inspected.prepare(`
      SELECT id, pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, purged_at_ms, updated_at_ms, row_version
      FROM consultations ORDER BY id
    `).all(), [
      {
        id: "expired", pii_envelope: null, pii_key_id: null, phone_blind_index: null,
        email_blind_index: null, blind_index_key_id: null, purged_at_ms: 100,
        updated_at_ms: 100, row_version: 2,
      },
      {
        id: "future", pii_envelope: "future-private", pii_key_id: "pii-v1",
        phone_blind_index: Buffer.from([3]), email_blind_index: Buffer.from([4]),
        blind_index_key_id: "pii-v1", purged_at_ms: null, updated_at_ms: 1, row_version: 1,
      },
    ]);
    assert.deepEqual(inspected.prepare(`
      SELECT consultation_id, state, payload_json, last_error_code,
        locked_at_ms, lease_expires_at_ms, locked_by
      FROM notification_outbox ORDER BY consultation_id
    `).all(), [
      {
        consultation_id: "expired", state: "cancelled", payload_json: null,
        last_error_code: "RETENTION_PURGED",
        locked_at_ms: null, lease_expires_at_ms: null, locked_by: null,
      },
      {
        consultation_id: "future", state: "pending", payload_json: "future-payload",
        last_error_code: null,
        locked_at_ms: null, lease_expires_at_ms: null, locked_by: null,
      },
    ]);
    assert.deepEqual(inspected.prepare(`
      SELECT outcome_code, finished_at_ms
      FROM notification_delivery_attempts WHERE id = 'attempt-expired'
    `).get(), { outcome_code: "RETENTION_PURGED", finished_at_ms: 100 });
    assert.equal(inspected.prepare("SELECT count(*) count FROM audit_events").get().count, 1);
    assert.equal(inspected.prepare("SELECT count(*) count FROM idempotency_keys").get().count, 1);
    assert.equal(inspected.prepare("SELECT count(*) count FROM abuse_buckets").get().count, 1);
  } finally {
    inspected.close();
  }
  assert.equal((await readFile(databasePath)).includes(Buffer.from(rawCanary)), false);
});

test("SQLite restore retention rejects an excessive initial due set before mutation", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-restore-retention-limit-")));
  const databasePath = path.join(directory, "restored.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  createRestoreRetentionFixtureSchema(database);
  database.exec(`
    INSERT INTO consultations (
      id, receipt_id, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, purged_at_ms, row_version
    ) VALUES
      ('expired-1', 'receipt-expired-1', 'ko', 'procurement', 'phone',
        'private-1', 'pii-v1', x'01', NULL, 'pii-v1', 0, 1, 1, 100, NULL, 1),
      ('expired-2', 'receipt-expired-2', 'ko', 'procurement', 'phone',
        'private-2', 'pii-v1', x'02', NULL, 'pii-v1', 0, 1, 1, 100, NULL, 1);
  `);
  database.close();

  await assert.rejects(
    createSqliteAdapter({ maxRetentionRows: 1 }).enforceRetention(databasePath, 100),
    { code: "RESTORE_RETENTION_LIMIT_EXCEEDED" },
  );
  const unchanged = new Database(databasePath, { readonly: true });
  try {
    assert.equal(unchanged.prepare(
      "SELECT count(*) count FROM consultations WHERE pii_envelope IS NOT NULL AND purged_at_ms IS NULL",
    ).get().count, 2);
    assert.equal(unchanged.prepare("SELECT count(*) count FROM audit_events").get().count, 0);
  } finally {
    unchanged.close();
  }
});

test("SQLite restore retention fails closed when a due batch makes no progress", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-restore-retention-progress-")));
  const databasePath = path.join(directory, "restored.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  createRestoreRetentionFixtureSchema(database);
  database.exec(`
    CREATE TRIGGER block_retention_update
      BEFORE UPDATE ON consultations BEGIN SELECT RAISE(IGNORE); END;
    INSERT INTO consultations (
      id, receipt_id, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, purged_at_ms, row_version
    ) VALUES (
      'expired', 'receipt-expired', 'ko', 'procurement', 'phone',
      'private', 'pii-v1', x'01', NULL, 'pii-v1', 0, 1, 1, 100, NULL, 1
    );
  `);
  database.close();

  const adapterUrl = new URL("../lib/system-adapters.mjs", import.meta.url).href;
  const source = `
    import { createSqliteAdapter } from ${JSON.stringify(adapterUrl)};
    try {
      await createSqliteAdapter().enforceRetention(process.argv[1], 100);
      process.stdout.write("unexpected-success\\n");
    } catch (error) {
      process.stderr.write(String(error?.code ?? "UNKNOWN") + "\\n");
      process.exitCode = 2;
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source, databasePath], {
    encoding: "utf8",
    timeout: 1_000,
    windowsHide: true,
  });
  assert.equal(child.signal, null);
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "RESTORE_RETENTION_NO_PROGRESS\n");
});
