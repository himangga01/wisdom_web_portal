#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESULT_BYTES = 4 * 1024;

function fail(code = "MONITOR_DATABASE_QUERY_FAILED") {
  const error = new Error("Database aggregate check failed");
  error.code = code;
  throw error;
}

function pathChanged() {
  fail("DB_PATH_CHANGED");
}

function protectedMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o022n) === 0n;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function walkIndependentSecurePath(databasePath) {
  const parsed = path.parse(databasePath);
  let current = parsed.root;
  const components = [];
  for (const segment of databasePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink() || !protectedMode(metadata)) pathChanged();
    components.push({ path: current, metadata });
  }
  return components;
}

function assertSameWalk(expected, actual) {
  if (expected.length !== actual.length) pathChanged();
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].path !== actual[index].path || !sameIdentity(expected[index].metadata, actual[index].metadata)) pathChanged();
  }
}

async function openIndependentSecureDatabase(databasePath) {
  if (
    typeof databasePath !== "string" || databasePath.length > 4_096 || !path.isAbsolute(databasePath) ||
    path.normalize(databasePath) !== databasePath || path.resolve(databasePath) !== databasePath || /[\0\r\n]/u.test(databasePath)
  ) pathChanged();
  let components;
  let handle;
  try {
    components = await walkIndependentSecurePath(databasePath);
    if (await realpath(databasePath) !== databasePath) pathChanged();
    handle = await open(databasePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat({ bigint: true });
    const walkedFile = components.at(-1)?.metadata;
    if (!metadata.isFile() || !protectedMode(metadata) || !walkedFile || !sameIdentity(walkedFile, metadata)) pathChanged();
    return { databasePath, components, handle, metadata };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error?.code === "DB_PATH_CHANGED") throw error;
    pathChanged();
  }
}

async function assertDatabasePathUnchanged(guard) {
  try {
    const components = await walkIndependentSecurePath(guard.databasePath);
    assertSameWalk(guard.components, components);
    if (await realpath(guard.databasePath) !== guard.databasePath) pathChanged();
    const current = await open(guard.databasePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const currentMetadata = await current.stat({ bigint: true });
      const heldMetadata = await guard.handle.stat({ bigint: true });
      if (!sameIdentity(guard.metadata, heldMetadata) || !sameIdentity(guard.metadata, currentMetadata)) pathChanged();
    } finally {
      await current.close().catch(() => undefined);
    }
  } catch (error) {
    if (error?.code === "DB_PATH_CHANGED") throw error;
    pathChanged();
  }
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

export async function queryDatabaseAggregates(databasePath, {
  nowMs = Date.now(),
  staleBeforeMs = nowMs - 15 * 60_000,
  afterSqliteOpen,
  beforeFinalIdentityCheck,
} = {}) {
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    !Number.isSafeInteger(staleBeforeMs) || staleBeforeMs < 0 || staleBeforeMs > nowMs
  ) fail();
  if (afterSqliteOpen !== undefined && typeof afterSqliteOpen !== "function") fail();
  if (beforeFinalIdentityCheck !== undefined && typeof beforeFinalIdentityCheck !== "function") fail();
  const { default: Database } = await import("better-sqlite3");
  const guard = await openIndependentSecureDatabase(databasePath);
  let database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
    await afterSqliteOpen?.();
    await assertDatabasePathUnchanged(guard);
    const main = database.pragma("database_list").find(({ name }) => name === "main");
    if (!main || path.resolve(main.file) !== databasePath) pathChanged();
    let mainCanonical;
    try {
      mainCanonical = await realpath(main.file);
    } catch {
      pathChanged();
    }
    if (mainCanonical !== databasePath) pathChanged();
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    const count = (sql) => Number(database.prepare(sql).get().count);
    const result = {
      notificationFailures: count("SELECT count(*) count FROM notification_outbox WHERE state = 'failed'"),
      translationFailures: count("SELECT count(*) count FROM article_translation_jobs WHERE state = 'failed'"),
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
      notificationStalled: Number(database.prepare(`
        SELECT count(*) count FROM notification_outbox
        WHERE (state = 'pending' AND available_at_ms <= ?)
          OR (state = 'processing' AND lease_expires_at_ms <= ?)
      `).get(staleBeforeMs, nowMs).count),
      translationStalled: Number(database.prepare(`
        SELECT count(*) count FROM article_translation_jobs
        WHERE (state = 'queued' AND available_at_ms <= ?)
          OR (state = 'running' AND lease_expires_at_ms <= ?)
      `).get(staleBeforeMs, nowMs).count),
      indexNowStalled: Number(database.prepare(`
        SELECT count(*) count FROM publication_outbox
        WHERE (state = 'pending' AND available_at_ms <= ?)
          OR (state = 'processing' AND lease_expires_at_ms <= ?)
      `).get(staleBeforeMs, nowMs).count),
      retentionOverdue: Number(database.prepare(`
        SELECT count(*) count FROM consultations
        WHERE purged_at_ms IS NULL AND retention_expires_at_ms <= ?
      `).get(nowMs).count),
    };
    if (!Object.values(result).every(boundedCount)) fail();
    await beforeFinalIdentityCheck?.();
    await assertDatabasePathUnchanged(guard);
    return result;
  } catch (error) {
    if (error?.code === "DB_PATH_CHANGED") throw error;
    fail();
  } finally {
    database?.close();
    await guard.handle.close().catch(() => undefined);
  }
}

async function main() {
  if (
    process.argv.length !== 8 || process.argv[2] !== "--database" ||
    process.argv[4] !== "--now-ms" || process.argv[6] !== "--stale-before-ms"
  ) fail();
  const nowMs = Number(process.argv[5]);
  const staleBeforeMs = Number(process.argv[7]);
  const result = await queryDatabaseAggregates(process.argv[3], { nowMs, staleBeforeMs });
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) fail();
  process.stdout.write(`${output}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const changed = error?.code === "DB_PATH_CHANGED";
    process.stderr.write(changed ? "DB_PATH_CHANGED\n" : "MONITOR_DATABASE_QUERY_FAILED\n");
    process.exitCode = changed ? 4 : 2;
  }
}
