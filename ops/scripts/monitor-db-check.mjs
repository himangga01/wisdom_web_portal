#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_RESULT_BYTES = 4 * 1024;

function fail() {
  const error = new Error("Database aggregate check failed");
  error.code = "MONITOR_DATABASE_QUERY_FAILED";
  throw error;
}

async function assertIndependentSecureDatabase(databasePath) {
  if (
    typeof databasePath !== "string" || databasePath.length > 4_096 || !path.isAbsolute(databasePath) ||
    path.normalize(databasePath) !== databasePath || /[\0\r\n]/u.test(databasePath)
  ) fail();
  const resolved = path.resolve(databasePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) fail();
    if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) fail();
  }
  if (await realpath(resolved) !== resolved) fail();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o022) !== 0)) fail();
  } finally {
    await handle.close();
  }
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--database") fail();
  const databasePath = process.argv[3];
  await assertIndependentSecureDatabase(databasePath);
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
  try {
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    const count = (sql) => Number(database.prepare(sql).get().count);
    const result = {
      notificationFailures: count("SELECT count(*) count FROM notification_outbox WHERE state = 'failed'"),
      publicationFailures: count(`
        SELECT
          (SELECT count(*) FROM release_activations WHERE state IN ('prepared','switched')) +
          (SELECT count(*) FROM releases
            WHERE state = 'failed'
              AND created_at_ms >= COALESCE(
                (SELECT max(created_at_ms) FROM releases WHERE state = 'active'), 0
              )) AS count
      `),
      indexNowFailures: count("SELECT count(*) count FROM publication_outbox WHERE state = 'failed'"),
    };
    if (!Object.values(result).every(boundedCount)) fail();
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) fail();
    process.stdout.write(`${output}\n`);
  } finally {
    database.close();
  }
}

try {
  await main();
} catch {
  process.stderr.write("MONITOR_DATABASE_QUERY_FAILED\n");
  process.exitCode = 2;
}
