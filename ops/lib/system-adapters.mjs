import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultRun(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, ...spawnOptions } = options;
    const child = spawn(executable, args, {
      ...spawnOptions,
      shell: false,
      stdio: spawnOptions.stdio ?? ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(resolve);
      else finish(reject, Object.assign(new Error("External command failed"), {
        code: "EXTERNAL_COMMAND_FAILED",
        exitCode: code,
        signal,
      }));
    });
    if (stdin !== undefined) {
      if (!(stdin instanceof Uint8Array) || child.stdin === null) {
        finish(reject, Object.assign(new Error("External command stdin is unavailable"), {
          code: "EXTERNAL_COMMAND_STDIN_UNAVAILABLE",
        }));
        return;
      }
      child.stdin.once("error", (error) => {
        if (error?.code !== "EPIPE") finish(reject, error);
      });
      child.stdin.end(stdin);
    }
  });
}

function validatePath(candidate) {
  return typeof candidate === "string" && path.isAbsolute(candidate) && !/[\0\r\n]/u.test(candidate);
}

async function assertNoIdentityResidue(output) {
  let entries;
  try {
    entries = await readdir(path.dirname(output), { withFileTypes: true });
  } catch {
    fail("AGE_ADAPTER_INPUT_INVALID", "age output directory is unavailable");
  }
  if (entries.some((entry) => entry.name.includes(".identity-"))) {
    fail("AGE_IDENTITY_RESIDUE_DETECTED", "legacy age identity residue requires operator cleanup");
  }
}

export function createAgeAdapter({ executable, run = defaultRun }) {
  if (!validatePath(executable)) fail("AGE_ADAPTER_INPUT_INVALID", "age executable must be absolute");
  return {
    encrypt: async ({ input, output, recipient }) => {
      if (!validatePath(input) || !validatePath(output) || typeof recipient !== "string" || !recipient.startsWith("age1")) {
        fail("AGE_ADAPTER_INPUT_INVALID", "age encryption input is invalid");
      }
      await run(executable, ["--recipient", recipient, "--output", output, input], {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
    decrypt: async ({ input, output, identity }) => {
      if (!validatePath(input) || !validatePath(output) || typeof identity !== "string" || identity.length < 16 || /[\0\r\n]/u.test(identity)) {
        fail("AGE_ADAPTER_INPUT_INVALID", "age decryption input is invalid");
      }
      await assertNoIdentityResidue(output);
      const identityBytes = Buffer.from(`${identity}\n`, "utf8");
      try {
        await run(executable, ["--decrypt", "--identity", "-", "--output", output, input], {
          shell: false,
          stdio: ["pipe", "ignore", "ignore"],
          stdin: identityBytes,
        });
      } finally {
        identityBytes.fill(0);
      }
    },
  };
}

export function createSqliteAdapter({
  loadDatabase = async () => (await import("better-sqlite3")).default,
  expectedSchemaVersion = 5,
} = {}) {
  return {
    checkpoint: async (source) => {
      const Database = await loadDatabase();
      const database = new Database(source);
      try {
        database.pragma("wal_checkpoint(PASSIVE)");
      } finally {
        database.close();
      }
    },
    onlineBackup: async (source, destination) => {
      const Database = await loadDatabase();
      const database = new Database(source);
      try {
        await database.backup(destination);
      } finally {
        database.close();
      }
    },
    inspect: async (databasePath) => {
      const Database = await loadDatabase();
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const integrityRows = database.pragma("integrity_check");
        const integrity = integrityRows.every((row) => Object.values(row).every((value) => value === "ok")) ? "ok" : "corrupt";
        const schemaVersion = Number(database.pragma("user_version", { simple: true }));
        const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
        return { integrity, schemaVersion, sqliteVersion };
      } finally {
        database.close();
      }
    },
    schemaCompatible: async ({ schemaVersion }) => schemaVersion === expectedSchemaVersion,
    enforceRetention: async (databasePath, nowMs) => {
      if (!validatePath(databasePath) || !Number.isSafeInteger(nowMs) || nowMs < 0) {
        fail("RESTORE_RETENTION_INVALID", "Restore retention input is invalid");
      }
      const Database = await loadDatabase();
      const database = new Database(databasePath, { fileMustExist: true });
      try {
        const schemaVersion = Number(database.pragma("user_version", { simple: true }));
        if (schemaVersion !== expectedSchemaVersion) {
          fail("RESTORE_SCHEMA_INCOMPATIBLE", "Restore retention requires the current schema");
        }
        database.pragma("foreign_keys = ON");
        database.pragma("journal_mode = DELETE");
        const selectDue = database.prepare(`
          SELECT id, retention_expires_at_ms
          FROM consultations
          WHERE purged_at_ms IS NULL AND retention_expires_at_ms <= ?
          ORDER BY retention_expires_at_ms, id
          LIMIT 1000
        `);
        const clearConsultation = database.prepare(`
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
        const clearOutbox = database.prepare(`
          UPDATE notification_outbox
          SET state = CASE
                WHEN state IN ('pending','processing','failed') THEN 'cancelled'
                ELSE state
              END,
              payload_json = NULL,
              locked_at_ms = NULL,
              lease_expires_at_ms = NULL,
              locked_by = NULL,
              updated_at_ms = ?
          WHERE consultation_id = ?
        `);
        const insertAudit = database.prepare(`
          INSERT INTO audit_events (
            id, actor_type, action, target_type, target_id, request_id,
            metadata_json, created_at_ms
          ) VALUES (?, 'system', 'consultation.purged', 'consultation', ?, ?, ?, ?)
        `);
        const purgeBatch = database.transaction((rows) => {
          let purged = 0;
          for (const row of rows) {
            const changed = clearConsultation.run(nowMs, nowMs, row.id).changes;
            if (changed !== 1) continue;
            clearOutbox.run(nowMs, row.id);
            insertAudit.run(
              randomUUID(),
              row.id,
              `restore-retention:${nowMs}`,
              JSON.stringify({ retentionExpiresAtMs: row.retention_expires_at_ms }),
              nowMs,
            );
            purged += 1;
          }
          return purged;
        });
        let purgedCount = 0;
        for (;;) {
          const rows = selectDue.all(nowMs);
          if (rows.length === 0) break;
          purgedCount += purgeBatch(rows);
        }
        database.transaction(() => {
          database.prepare("DELETE FROM idempotency_keys WHERE expires_at_ms <= ?").run(nowMs);
          database.prepare("DELETE FROM abuse_buckets WHERE expires_at_ms <= ?").run(nowMs);
        })();
        const remaining = Number(database.prepare(`
          SELECT count(*) count FROM consultations
          WHERE purged_at_ms IS NULL AND retention_expires_at_ms <= ?
        `).get(nowMs).count);
        if (remaining !== 0) {
          fail("RESTORE_RETENTION_INCOMPLETE", "Restore retention did not clear every overdue record");
        }
        return { purgedCount };
      } finally {
        database.close();
      }
    },
  };
}
