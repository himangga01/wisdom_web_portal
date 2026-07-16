import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

test("age decrypt streams identity through stdin, never a file or process argument", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-adapter-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-residue-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-age-encrypt-"));
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-restore-retention-"));
  const databasePath = path.join(directory, "restored.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA user_version = 5;
    CREATE TABLE consultations (
      id TEXT PRIMARY KEY, pii_envelope TEXT, pii_key_id TEXT,
      phone_blind_index BLOB, email_blind_index BLOB, blind_index_key_id TEXT,
      retention_expires_at_ms INTEGER NOT NULL, purged_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL, row_version INTEGER NOT NULL
    );
    CREATE TABLE notification_outbox (
      consultation_id TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT,
      locked_at_ms INTEGER, lease_expires_at_ms INTEGER, locked_by TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE idempotency_keys (expires_at_ms INTEGER NOT NULL);
    CREATE TABLE abuse_buckets (expires_at_ms INTEGER NOT NULL);
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, request_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    INSERT INTO consultations VALUES
      ('expired', 'expired-private', 'pii-v1', x'01', x'02', 'pii-v1', 100, NULL, 1, 1),
      ('future', 'future-private', 'pii-v1', x'03', x'04', 'pii-v1', 101, NULL, 1, 1);
    INSERT INTO notification_outbox VALUES
      ('expired', 'processing', 'private-payload', 90, 110, 'worker', 90),
      ('future', 'pending', 'future-payload', NULL, NULL, NULL, 90);
    INSERT INTO idempotency_keys VALUES (100), (101);
    INSERT INTO abuse_buckets VALUES (100), (101);
  `);
  database.close();

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
      SELECT consultation_id, state, payload_json, locked_at_ms, lease_expires_at_ms, locked_by
      FROM notification_outbox ORDER BY consultation_id
    `).all(), [
      {
        consultation_id: "expired", state: "cancelled", payload_json: null,
        locked_at_ms: null, lease_expires_at_ms: null, locked_by: null,
      },
      {
        consultation_id: "future", state: "pending", payload_json: "future-payload",
        locked_at_ms: null, lease_expires_at_ms: null, locked_by: null,
      },
    ]);
    assert.equal(inspected.prepare("SELECT count(*) count FROM audit_events").get().count, 1);
    assert.equal(inspected.prepare("SELECT count(*) count FROM idempotency_keys").get().count, 1);
    assert.equal(inspected.prepare("SELECT count(*) count FROM abuse_buckets").get().count, 1);
  } finally {
    inspected.close();
  }
});
