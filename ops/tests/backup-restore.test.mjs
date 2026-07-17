import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyBackupRetention, createOnlineBackup } from "../lib/backup.mjs";
import { automaticBackupDecision } from "../lib/backup-control.mjs";
import {
  acquireDatabaseMaintenanceLock,
  databaseMaintenanceLockPath,
  recoverDatabaseMaintenanceLock,
} from "../lib/database-maintenance-lock.mjs";
import { backupFreshness, loadNewestBackupStatus } from "../lib/monitoring.mjs";
import { planRestore, restoreBackup } from "../lib/restore.mjs";
import { createSqliteAdapter } from "../lib/system-adapters.mjs";

async function fixtureDirectory(name) {
  return mkdtemp(path.join(os.tmpdir(), `wisdom-${name}-`));
}

function fakeAdapters({ mutateSourceAfterBackup = false, encryptError, decryptError, integrity = "ok", schema = 3 } = {}) {
  return {
    sqlite: {
      checkpoint: async () => undefined,
      onlineBackup: async (source, snapshot) => {
        await copyFile(source, snapshot);
        if (mutateSourceAfterBackup) await writeFile(source, JSON.stringify({ changedAfterSnapshot: true }));
      },
      inspect: async (database) => ({
        integrity,
        schemaVersion: schema,
        sqliteVersion: "3.53.2",
        bytes: Buffer.byteLength(await readFile(database)),
      }),
      schemaCompatible: async ({ schemaVersion }) => schemaVersion === 3,
      enforceRetention: async () => ({ purgedCount: 0 }),
      readBackupControl: async () => ({ automaticEnabled: true, rowVersion: 1, updatedAtMs: 0 }),
      applyBackupControl: async (_databasePath, { automaticEnabled, nowMs }) => ({
        automaticEnabled,
        rowVersion: 2,
        updatedAtMs: nowMs,
      }),
    },
    age: {
      encrypt: async ({ input, output }) => {
        if (encryptError) throw Object.assign(new Error("encryption failed"), { code: encryptError });
        const data = await readFile(input);
        const obscured = Buffer.from(data.map((byte) => byte ^ 0xaa));
        await writeFile(output, Buffer.concat([Buffer.from("AGE-FIXTURE\n"), obscured]));
      },
      decrypt: async ({ input, output }) => {
        if (decryptError) throw Object.assign(new Error("decryption failed"), { code: decryptError });
        const data = await readFile(input);
        const prefix = Buffer.from("AGE-FIXTURE\n");
        if (!data.subarray(0, prefix.length).equals(prefix)) {
          throw Object.assign(new Error("not authenticated"), { code: "AGE_AUTH_FAILED" });
        }
        await writeFile(output, Buffer.from(data.subarray(prefix.length).map((byte) => byte ^ 0xaa)));
      },
    },
  };
}

async function createPolicyRestoreFixture(name, {
  backupAutomaticEnabled,
  targetAutomaticEnabled,
} = {}) {
  const root = await fixtureDirectory(name);
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  const now = new Date("2026-07-17T08:09:10.000Z");
  await writeFile(sourceDb, JSON.stringify({
    schemaVersion: 3,
    automaticEnabled: backupAutomaticEnabled,
    marker: "restored",
  }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-17T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({
    schemaVersion: 3,
    automaticEnabled: targetAutomaticEnabled,
    marker: "original",
  }));
  return {
    root,
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    now,
    input: {
      backupRoot,
      backup: backup.hourlyArtifact,
      target,
      tempRoot: path.join(root, "restore-temp"),
      ageIdentity: "AGE-SECRET-KEY-FIXTURE",
      confirmDestroy: path.resolve(target),
      dryRun: false,
      now,
    },
  };
}

test("backup and restore verification never read an entire file into memory", async () => {
  for (const modulePath of ["../lib/backup.mjs", "../lib/restore.mjs"]) {
    const source = await readFile(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\breadFile\s*\(/u, `${modulePath} must use bounded or streaming reads`);
  }
});

test("backup retention inventories directory entries incrementally under its hard bound", async () => {
  const source = await readFile(new URL("../lib/backup.mjs", import.meta.url), "utf8");
  assert.match(source, /\bopendir\s*\(/u);
  assert.doesNotMatch(source, /\breaddir\s*\(\s*backupRoot\s*\)/u);
});

test("online backup is consistent, encrypted, verified, and leaves no plaintext", async () => {
  const root = await fixtureDirectory("backup");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "protected-temp");
  const original = JSON.stringify({
    schemaVersion: 3,
    consultations: [{ receipt: "receipt-1", ciphertext: "opaque-ciphertext", nonce: "opaque-nonce" }],
  });
  await writeFile(sourceDb, original);

  const result = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters({ mutateSourceAfterBackup: true }));

  assert.equal(result.verified, true);
  assert.equal(path.basename(result.hourlyArtifact), "hourly-20260716T010203Z.age");
  assert.equal(path.basename(result.dailyArtifact), "daily-20260716.age");
  assert.doesNotMatch(await readFile(result.hourlyArtifact, "utf8"), /consultations|receipt-1/);
  const status = JSON.parse(await readFile(result.hourlyStatus, "utf8"));
  assert.deepEqual(status, {
    formatVersion: 1,
    kind: "hourly",
    createdAt: "2026-07-16T01:02:03.000Z",
    sourceDatabase: "portal.sqlite",
    schemaVersion: 3,
    sqliteVersion: "3.53.2",
    encryptedSha256: result.encryptedSha256,
    encryptedBytes: result.encryptedBytes,
    integrity: "ok",
    verified: true,
  });
  assert.deepEqual(await readdir(tempRoot), []);
  assert.equal(await readFile(sourceDb, "utf8"), JSON.stringify({ changedAfterSnapshot: true }));
});

test("backup failure removes pending ciphertext and plaintext work directories", async () => {
  const root = await fixtureDirectory("backup-failure");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "protected-temp");
  await writeFile(sourceDb, "fixture");

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, fakeAdapters({ encryptError: "AGE_ENCRYPT_FAILED" })), { code: "AGE_ENCRYPT_FAILED" });

  assert.deepEqual(await readdir(tempRoot), []);
  assert.deepEqual((await readdir(backupRoot)).filter((name) => name.includes("pending")), []);
});

test("backup and restore serialize on one exclusive database maintenance lock", async () => {
  const root = await fixtureDirectory("database-maintenance-lock");
  const sourceDb = path.join(root, "data", "portal.sqlite");
  const backupRoot = path.join(root, "backups");
  const tempRoot = path.join(root, "temp");
  await mkdir(path.dirname(sourceDb), { recursive: true });
  await writeFile(sourceDb, "database-fixture");

  const releaseLock = await acquireDatabaseMaintenanceLock(sourceDb);
  try {
    await assert.rejects(createOnlineBackup({
      sourceDb,
      backupRoot,
      tempRoot,
      ageRecipient: "age1fixtureoperatorrecipient",
      ageIdentity: "AGE-SECRET-KEY-FIXTURE",
      now: new Date("2026-07-16T02:00:00.000Z"),
    }, fakeAdapters()), { code: "DATABASE_MAINTENANCE_LOCKED" });

    await assert.rejects(restoreBackup({
      backupRoot,
      backup: path.join(backupRoot, "hourly-20260716T010203Z.age"),
      target: sourceDb,
      tempRoot: path.join(root, "restore-temp"),
      ageIdentity: "AGE-SECRET-KEY-FIXTURE",
      confirmDestroy: path.resolve(sourceDb),
      dryRun: false,
    }, {
      ...fakeAdapters(),
      services: { assertStopped: async () => assert.fail("lock must be acquired first") },
    }), { code: "DATABASE_MAINTENANCE_LOCKED" });
  } finally {
    await releaseLock();
  }

  const result = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, fakeAdapters());
  assert.equal(result.verified, true);
});

test("automatic backup rechecks OFF under the maintenance lock before backup filesystem or adapter work", async () => {
  const root = await fixtureDirectory("automatic-backup-disabled");
  const sourceDb = path.join(root, "data", "portal.sqlite");
  const backupRoot = path.join(root, "must-not-create-backups");
  const tempRoot = path.join(root, "must-not-create-temp");
  await mkdir(path.dirname(sourceDb), { recursive: true });
  await writeFile(sourceDb, "database-fixture");
  const calls = { readBackupControl: 0, checkpoint: 0, onlineBackup: 0, encrypt: 0, decrypt: 0 };
  const adapters = fakeAdapters();
  adapters.sqlite.readBackupControl = async () => {
    calls.readBackupControl += 1;
    assert.equal((await lstat(databaseMaintenanceLockPath(sourceDb))).isDirectory(), true);
    return { automaticEnabled: false, rowVersion: 4, updatedAtMs: Date.parse("2026-07-16T02:00:00.000Z") };
  };
  adapters.sqlite.checkpoint = async () => { calls.checkpoint += 1; };
  adapters.sqlite.onlineBackup = async () => { calls.onlineBackup += 1; };
  adapters.age.encrypt = async () => { calls.encrypt += 1; };
  adapters.age.decrypt = async () => { calls.decrypt += 1; };

  const skipped = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
    automatic: true,
  }, adapters);

  assert.deepEqual(skipped, {
    verified: false,
    outcome: "admin-disabled",
    controlRevision: 4,
  });
  assert.deepEqual(calls, { readBackupControl: 1, checkpoint: 0, onlineBackup: 0, encrypt: 0, decrypt: 0 });
  await assert.rejects(lstat(backupRoot), { code: "ENOENT" });
  await assert.rejects(lstat(tempRoot), { code: "ENOENT" });
  await assert.rejects(lstat(databaseMaintenanceLockPath(sourceDb)), { code: "ENOENT" });
});

test("automatic ON follows the existing flow and a later OFF change does not interrupt it", async () => {
  const root = await fixtureDirectory("automatic-backup-enabled");
  const sourceDb = path.join(root, "data", "portal.sqlite");
  const backupRoot = path.join(root, "backups");
  const tempRoot = path.join(root, "temp");
  await mkdir(path.dirname(sourceDb), { recursive: true });
  await writeFile(sourceDb, "database-fixture");
  let automaticEnabled = true;
  let policyReads = 0;
  let checkpointCalls = 0;
  const adapters = fakeAdapters();
  adapters.sqlite.readBackupControl = async () => {
    policyReads += 1;
    assert.equal((await lstat(databaseMaintenanceLockPath(sourceDb))).isDirectory(), true);
    return { automaticEnabled, rowVersion: 5, updatedAtMs: 0 };
  };
  const checkpoint = adapters.sqlite.checkpoint;
  adapters.sqlite.checkpoint = async (...args) => {
    checkpointCalls += 1;
    automaticEnabled = false;
    return checkpoint(...args);
  };

  const result = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T03:00:00.000Z"),
    automatic: true,
  }, adapters);

  assert.equal(result.verified, true);
  assert.equal(policyReads, 1);
  assert.equal(checkpointCalls, 1);
  assert.equal(automaticEnabled, false);
});

test("manual backup omits automatic and never reads administrator policy", async () => {
  const root = await fixtureDirectory("manual-backup-policy-bypass");
  const sourceDb = path.join(root, "data", "portal.sqlite");
  const backupRoot = path.join(root, "backups");
  const tempRoot = path.join(root, "temp");
  await mkdir(path.dirname(sourceDb), { recursive: true });
  await writeFile(sourceDb, "database-fixture");
  const adapters = fakeAdapters();
  let policyReads = 0;
  adapters.sqlite.readBackupControl = async () => {
    policyReads += 1;
    return { automaticEnabled: false, rowVersion: 99, updatedAtMs: 1 };
  };

  const result = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T04:00:00.000Z"),
  }, adapters);

  assert.equal(result.verified, true);
  assert.equal(policyReads, 0);
});

test("database maintenance lock requires confirmed quarantine before reuse and verifies release ownership", async () => {
  const root = await fixtureDirectory("database-maintenance-lock-owner");
  const database = path.join(root, "portal.sqlite");
  const lockPath = databaseMaintenanceLockPath(database);
  await writeFile(database, "fixture");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    formatVersion: 2,
    kind: "backup or restore",
    pid: 999_999_999,
    hostname: os.hostname(),
    bootId: "previous-boot",
    processStartId: "dead-process",
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-16T00:00:00.000Z",
  }));

  await assert.rejects(acquireDatabaseMaintenanceLock(database), {
    code: "DATABASE_MAINTENANCE_LOCK_STALE",
  });
  const recovery = await recoverDatabaseMaintenanceLock(database, {
    dryRun: false,
    confirmLockPath: path.resolve(lockPath),
    confirmedAction: "QUARANTINE_STALE_LOCK",
    identityProvider: async () => ({
      hostname: os.hostname(),
      bootId: "current-boot",
      processStartId: "recovery-process",
    }),
    lookupProcessStartId: async () => undefined,
    now: new Date("2026-07-16T04:00:00.000Z"),
    quarantineToken: "22222222-2222-4222-8222-222222222222",
  });
  assert.match(path.basename(recovery.quarantinePath), /^\.portal\.sqlite\.maintenance-lock\.quarantine-/u);

  const releaseOwned = await acquireDatabaseMaintenanceLock(database);
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, JSON.stringify({
    ...owner,
    token: "11111111-1111-4111-8111-111111111111",
  }));
  await assert.rejects(releaseOwned(), { code: "DATABASE_MAINTENANCE_LOCK_OWNERSHIP_LOST" });
  await rm(lockPath, { recursive: true, force: true });
});

test("hourly status publication failure rolls back the renamed artifact", async () => {
  const root = await fixtureDirectory("backup-status-failure");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "protected-temp");
  await writeFile(sourceDb, "fixture");
  const adapters = fakeAdapters();
  adapters.storage = {
    writeStatus: async () => {
      throw Object.assign(new Error("status disk fault"), { code: "STATUS_WRITE_FAILED" });
    },
  };

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, adapters), { code: "STATUS_WRITE_FAILED" });
  assert.deepEqual((await readdir(backupRoot)).filter((name) => name.startsWith("hourly-")), []);
});

test("an existing daily pair must still match its recorded size and hash", async () => {
  const root = await fixtureDirectory("backup-daily-recheck");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "protected-temp");
  await writeFile(sourceDb, "fixture-one");
  const first = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:00:00.000Z"),
  }, fakeAdapters());
  await writeFile(first.dailyArtifact, "tampered-daily");
  await writeFile(sourceDb, "fixture-two");

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, fakeAdapters()), { code: "BACKUP_DAILY_INCONSISTENT" });
});

test("backup rejects failed integrity before publishing an artifact", async () => {
  const root = await fixtureDirectory("backup-integrity");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "protected-temp");
  await writeFile(sourceDb, "fixture");

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, fakeAdapters({ integrity: "corrupt" })), { code: "BACKUP_INTEGRITY_FAILED" });
  assert.deepEqual((await readdir(backupRoot)).filter((name) => name.endsWith(".age")), []);
});

test("backup rejects symlink roots before writing plaintext or ciphertext", async (t) => {
  const root = await fixtureDirectory("backup-symlink");
  const sourceDb = path.join(root, "portal.sqlite");
  const realBackup = path.join(root, "real-backup");
  const backupRoot = path.join(root, "backup-link");
  const tempRoot = path.join(root, "temp");
  await writeFile(sourceDb, "fixture");
  await mkdir(realBackup);
  try {
    await symlink(realBackup, backupRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, fakeAdapters()), { code: "BACKUP_PATH_UNSAFE" });
  assert.deepEqual(await readdir(realBackup), []);
});

test("backup compares the decrypted snapshot hash before publication", async () => {
  const root = await fixtureDirectory("backup-hash");
  const sourceDb = path.join(root, "portal.sqlite");
  const backupRoot = path.join(root, "encrypted");
  const tempRoot = path.join(root, "temp");
  await writeFile(sourceDb, "original-snapshot");
  const adapters = fakeAdapters();
  adapters.age.decrypt = async ({ output }) => writeFile(output, "different-but-inspectable");

  await assert.rejects(createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T02:00:00.000Z"),
  }, adapters), { code: "BACKUP_VERIFICATION_FAILED" });
  assert.deepEqual((await readdir(backupRoot)).filter((name) => name.endsWith(".age")), []);
});

test("retention keeps 24 hourly and 14 daily verified snapshots", async () => {
  const backupRoot = await fixtureDirectory("retention");
  const encrypted = "ciphertext";
  const encryptedSha256 = createHash("sha256").update(encrypted).digest("hex");
  for (let index = 0; index < 27; index++) {
    const stamp = `202607${String(index + 1).padStart(2, "0")}T000000Z`;
    const base = `hourly-${stamp}`;
    await writeFile(path.join(backupRoot, `${base}.age`), encrypted);
    await writeFile(path.join(backupRoot, `${base}.json`), JSON.stringify({ verified: true, kind: "hourly", createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, encryptedSha256, encryptedBytes: Buffer.byteLength(encrypted) }));
  }
  for (let index = 0; index < 16; index++) {
    const stamp = `202606${String(index + 1).padStart(2, "0")}`;
    const base = `daily-${stamp}`;
    await writeFile(path.join(backupRoot, `${base}.age`), encrypted);
    await writeFile(path.join(backupRoot, `${base}.json`), JSON.stringify({ verified: true, kind: "daily", createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, encryptedSha256, encryptedBytes: Buffer.byteLength(encrypted) }));
  }

  const result = await applyBackupRetention(backupRoot, { hourly: 24, daily: 14 });
  const names = await readdir(backupRoot);
  assert.equal(names.filter((name) => name.startsWith("hourly-") && name.endsWith(".age")).length, 24);
  assert.equal(names.filter((name) => name.startsWith("daily-") && name.endsWith(".age")).length, 14);
  assert.equal(result.deletedArtifacts, 5);
  assert.ok(names.includes("hourly-20260727T000000Z.age"));
});

test("retention ignores oversized status files without reading or deleting their artifacts", async () => {
  const backupRoot = await fixtureDirectory("retention-oversized-status");
  const encrypted = "ciphertext";
  const encryptedSha256 = createHash("sha256").update(encrypted).digest("hex");
  const recentBase = "hourly-20260716T020000Z";
  const oversizedBase = "hourly-20260716T010000Z";
  const metadata = {
    verified: true,
    kind: "hourly",
    encryptedSha256,
    encryptedBytes: Buffer.byteLength(encrypted),
  };

  await writeFile(path.join(backupRoot, `${recentBase}.age`), encrypted);
  await writeFile(path.join(backupRoot, `${recentBase}.json`), JSON.stringify({
    ...metadata,
    createdAt: "2026-07-16T02:00:00.000Z",
  }));
  await writeFile(path.join(backupRoot, `${oversizedBase}.age`), encrypted);
  await writeFile(path.join(backupRoot, `${oversizedBase}.json`), JSON.stringify({
    ...metadata,
    createdAt: "2026-07-16T01:00:00.000Z",
    padding: "x".repeat(17 * 1024),
  }));

  const result = await applyBackupRetention(backupRoot, { hourly: 1, daily: 1 });
  const names = await readdir(backupRoot);
  assert.equal(result.deletedArtifacts, 0);
  assert.ok(names.includes(`${oversizedBase}.age`));
  assert.ok(names.includes(`${oversizedBase}.json`));
});

test("retention rejects directory and candidate inventories above explicit work bounds before deletion", async () => {
  const directoryRoot = await fixtureDirectory("retention-directory-bound");
  await writeFile(path.join(directoryRoot, "one.txt"), "1");
  await writeFile(path.join(directoryRoot, "two.txt"), "2");
  await writeFile(path.join(directoryRoot, "three.txt"), "3");
  await assert.rejects(applyBackupRetention(directoryRoot, { hourly: 1, daily: 1 }, {
    maxDirectoryEntries: 2,
  }), { code: "BACKUP_RETENTION_LIMIT_EXCEEDED" });
  assert.deepEqual((await readdir(directoryRoot)).toSorted(), ["one.txt", "three.txt", "two.txt"]);

  const candidateRoot = await fixtureDirectory("retention-candidate-bound");
  for (const stamp of ["20260716T010000Z", "20260716T020000Z"]) {
    await writeFile(path.join(candidateRoot, `hourly-${stamp}.json`), "{}");
  }
  await assert.rejects(applyBackupRetention(candidateRoot, { hourly: 1, daily: 1 }, {
    maxCandidates: 1,
  }), { code: "BACKUP_RETENTION_LIMIT_EXCEEDED" });
  assert.equal((await readdir(candidateRoot)).length, 2);
});

test("retention bounds deletion count and total artifact hash bytes per run", async () => {
  const backupRoot = await fixtureDirectory("retention-work-bound");
  const encrypted = "ciphertext";
  const encryptedSha256 = createHash("sha256").update(encrypted).digest("hex");
  for (const [index, stamp] of ["20260716T010000Z", "20260716T020000Z", "20260716T030000Z"].entries()) {
    const base = `hourly-${stamp}`;
    await writeFile(path.join(backupRoot, `${base}.age`), encrypted);
    await writeFile(path.join(backupRoot, `${base}.json`), JSON.stringify({
      verified: true,
      kind: "hourly",
      createdAt: `2026-07-16T0${index + 1}:00:00.000Z`,
      encryptedSha256,
      encryptedBytes: Buffer.byteLength(encrypted),
    }));
  }

  const first = await applyBackupRetention(backupRoot, { hourly: 1, daily: 1 }, {
    maxDeletions: 1,
    maxHashBytes: 1_024,
  });
  assert.deepEqual(first, {
    deletedArtifacts: 1,
    deferredArtifacts: 1,
    hashedBytes: Buffer.byteLength(encrypted),
  });
  assert.equal((await readdir(backupRoot)).filter((name) => name.endsWith(".age")).length, 2);

  const second = await applyBackupRetention(backupRoot, { hourly: 1, daily: 1 }, {
    maxDeletions: 1,
    maxHashBytes: Buffer.byteLength(encrypted) - 1,
  });
  assert.deepEqual(second, { deletedArtifacts: 0, deferredArtifacts: 1, hashedBytes: 0 });
  assert.equal((await readdir(backupRoot)).filter((name) => name.endsWith(".age")).length, 2);
});

test("backup freshness alerts after 90 minutes", async () => {
  const backupRoot = await fixtureDirectory("freshness");
  const artifact = path.join(backupRoot, "hourly-20260716T010000Z.age");
  await writeFile(artifact, "verified-ciphertext");
  await writeFile(path.join(backupRoot, "hourly-20260716T010000Z.json"), JSON.stringify({
    verified: true,
    integrity: "ok",
    kind: "hourly",
    createdAt: "2026-07-16T01:00:00.123Z",
    encryptedSha256: createHash("sha256").update("verified-ciphertext").digest("hex"),
    encryptedBytes: Buffer.byteLength("verified-ciphertext"),
  }));
  const status = await loadNewestBackupStatus(backupRoot);

  assert.equal(backupFreshness(status, new Date("2026-07-16T02:29:59.123Z")).state, "healthy");
  assert.equal(backupFreshness(status, new Date("2026-07-16T02:30:00.123Z")).state, "stale");
  assert.equal(backupFreshness(status, new Date("2026-07-16T02:30:01.123Z")).state, "stale");
  assert.equal(backupFreshness(undefined, new Date()).state, "missing");

  await writeFile(artifact, "tampered");
  assert.equal(await loadNewestBackupStatus(backupRoot), undefined);
});

test("frequent freshness checks use protected status and stable artifact size without rehashing bytes", async () => {
  const backupRoot = await fixtureDirectory("freshness-lightweight");
  const artifact = path.join(backupRoot, "hourly-20260716T010000Z.age");
  const original = "verified-ciphertext";
  const sameSizeReplacement = "tampered-ciphertext";
  assert.equal(Buffer.byteLength(sameSizeReplacement), Buffer.byteLength(original));
  await writeFile(artifact, original);
  await writeFile(path.join(backupRoot, "hourly-20260716T010000Z.json"), JSON.stringify({
    verified: true,
    integrity: "ok",
    kind: "hourly",
    createdAt: "2026-07-16T01:00:00.000Z",
    encryptedSha256: createHash("sha256").update(original).digest("hex"),
    encryptedBytes: Buffer.byteLength(original),
  }));
  await writeFile(artifact, sameSizeReplacement);

  const status = await loadNewestBackupStatus(backupRoot);
  assert.equal(status?.verified, true);
  assert.equal(status?.encryptedBytes, Buffer.byteLength(sameSizeReplacement));
});

test("restore is dry-run by default and apply requires exact absolute target confirmation", async () => {
  const root = await fixtureDirectory("restore-plan");
  const backupRoot = path.join(root, "backups");
  const backup = path.join(backupRoot, "hourly-20260716T010203Z.age");
  const target = path.join(root, "data", "portal.sqlite");
  const tempRoot = path.join(root, "temp");
  const plan = planRestore({ backupRoot, backup, target, tempRoot });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.target, path.resolve(target));
  assert.ok(plan.steps.includes("enforce-current-retention"));
  assert.throws(() => planRestore({
    backupRoot,
    backup,
    target,
    tempRoot,
    dryRun: false,
    confirmDestroy: `${path.resolve(target)}x`,
  }), { code: "RESTORE_CONFIRMATION_MISMATCH" });
  assert.throws(() => planRestore({ backupRoot, backup, target: "portal.sqlite", tempRoot }), { code: "RESTORE_INPUT_INVALID" });
});

test("restore policy resolution preserves readable current state and only falls back when unreadable", async () => {
  const { resolveRestoreAutomaticBackupPolicy } = await import("../lib/restore.mjs");
  const target = path.join(path.parse(process.cwd()).root, "fixture", "portal.sqlite");

  assert.deepEqual(await resolveRestoreAutomaticBackupPolicy({ target }, {
    readBackupControl: async () => ({ automaticEnabled: true, rowVersion: 4, updatedAtMs: 10 }),
  }), { automaticEnabled: true, source: "current-target" });
  assert.deepEqual(await resolveRestoreAutomaticBackupPolicy({ target, explicitMode: false }, {
    readBackupControl: async () => {
      throw Object.assign(new Error("unreadable"), { code: "BACKUP_CONTROL_INVALID" });
    },
  }), { automaticEnabled: false, source: "explicit" });
  await assert.rejects(resolveRestoreAutomaticBackupPolicy({ target }, {
    readBackupControl: async () => {
      throw Object.assign(new Error("unreadable"), { code: "BACKUP_CONTROL_INVALID" });
    },
  }), { code: "RESTORE_BACKUP_POLICY_REQUIRED" });
  await assert.rejects(resolveRestoreAutomaticBackupPolicy({ target, explicitMode: false }, {
    readBackupControl: async () => ({ automaticEnabled: true, rowVersion: 4, updatedAtMs: 10 }),
  }), { code: "RESTORE_BACKUP_POLICY_CONFLICT" });
});

test("restore rejects an unsafe target before reading its backup policy", async () => {
  const fixture = await createPolicyRestoreFixture("restore-policy-unsafe-target", {
    backupAutomaticEnabled: true,
    targetAutomaticEnabled: false,
  });
  await rm(fixture.target);
  await mkdir(fixture.target);
  const adapters = fakeAdapters();
  let policyReads = 0;
  let decrypts = 0;
  adapters.sqlite.readBackupControl = async () => {
    policyReads += 1;
    return { automaticEnabled: false, rowVersion: 1, updatedAtMs: 0 };
  };
  const originalDecrypt = adapters.age.decrypt;
  adapters.age.decrypt = async (input) => {
    decrypts += 1;
    return originalDecrypt(input);
  };

  await assert.rejects(restoreBackup(fixture.input, {
    ...adapters,
    services: {
      assertStopped: async () => undefined,
      start: async () => undefined,
      checkReady: async () => undefined,
    },
  }), { code: "RESTORE_TARGET_UNSAFE" });

  assert.equal(policyReads, 0);
  assert.equal(decrypts, 0);
});

test("restore applies the current target policy after retention and before final inspection", async (t) => {
  for (const scenario of [
    { name: "backup OFF and current ON", backupAutomaticEnabled: false, targetAutomaticEnabled: true },
    { name: "backup ON and current OFF", backupAutomaticEnabled: true, targetAutomaticEnabled: false },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createPolicyRestoreFixture(`restore-policy-${scenario.name.replaceAll(" ", "-")}`, scenario);
      const adapters = fakeAdapters();
      const calls = [];
      const originalDecrypt = adapters.age.decrypt;
      const originalInspect = adapters.sqlite.inspect;
      let appliedControl;
      adapters.age.decrypt = async (input) => {
        calls.push(["decrypt"]);
        return originalDecrypt(input);
      };
      adapters.sqlite.readBackupControl = async (databasePath) => {
        calls.push(["read-policy", databasePath]);
        assert.equal(databasePath, fixture.target);
        return {
          automaticEnabled: scenario.targetAutomaticEnabled,
          rowVersion: 7,
          updatedAtMs: 1,
        };
      };
      adapters.sqlite.inspect = async (databasePath) => {
        calls.push(["inspect", path.basename(databasePath)]);
        return originalInspect(databasePath);
      };
      adapters.sqlite.enforceRetention = async (databasePath, nowMs) => {
        calls.push(["retention", path.basename(databasePath), nowMs]);
        return { purgedCount: 0 };
      };
      adapters.sqlite.applyBackupControl = async (databasePath, input) => {
        calls.push(["apply-policy", path.basename(databasePath), input]);
        const staged = JSON.parse(await readFile(databasePath, "utf8"));
        assert.equal(staged.automaticEnabled, scenario.backupAutomaticEnabled);
        staged.automaticEnabled = input.automaticEnabled;
        await writeFile(databasePath, JSON.stringify(staged));
        appliedControl = {
          automaticEnabled: input.automaticEnabled,
          rowVersion: 8,
          updatedAtMs: input.nowMs,
        };
        return appliedControl;
      };

      const result = await restoreBackup(fixture.input, {
        ...adapters,
        services: {
          assertStopped: async () => calls.push(["stopped"]),
          stop: async () => calls.push(["stop"]),
          start: async () => calls.push(["start"]),
          checkReady: async () => calls.push(["ready"]),
        },
      });

      assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).automaticEnabled, scenario.targetAutomaticEnabled);
      assert.equal(result.automaticBackupAfterRestore, scenario.targetAutomaticEnabled);
      assert.equal(result.automaticBackupPolicySource, "current-target");
      assert.equal("backupControl" in result, false);
      const labels = calls.map(([label]) => label);
      assert.deepEqual(labels.slice(0, 4), ["stopped", "stop", "stopped", "read-policy"]);
      assert.ok(labels.indexOf("read-policy") < labels.indexOf("decrypt"));
      assert.ok(labels.indexOf("retention") < labels.indexOf("apply-policy"));
      assert.ok(labels.indexOf("apply-policy") < labels.lastIndexOf("inspect"));
      assert.ok(labels.lastIndexOf("inspect") < labels.lastIndexOf("stopped"));
      const applyInput = calls.find(([label]) => label === "apply-policy")[2];
      assert.equal(applyInput.nowMs, fixture.now.valueOf());
      assert.match(applyInput.requestId, /^restore-policy-\d{8}T\d{6}Z$/u);
      if (scenario.targetAutomaticEnabled) {
        assert.equal(automaticBackupDecision({
          control: appliedControl,
          newestVerified: { createdAt: new Date(fixture.now.valueOf() - 1).toISOString() },
          now: fixture.now,
        }), "run");
      }
    });
  }
});

test("unreadable target policy requires an explicit mode before decrypt or quarantine", async () => {
  const fixture = await createPolicyRestoreFixture("restore-policy-required", {
    backupAutomaticEnabled: true,
    targetAutomaticEnabled: false,
  });
  const adapters = fakeAdapters();
  const calls = [];
  let decryptCalled = false;
  adapters.sqlite.readBackupControl = async () => {
    calls.push("read-policy");
    throw Object.assign(new Error("unreadable"), { code: "BACKUP_CONTROL_INVALID" });
  };
  adapters.age.decrypt = async () => { decryptCalled = true; };

  await assert.rejects(restoreBackup(fixture.input, {
    ...adapters,
    services: {
      assertStopped: async () => calls.push("stopped"),
      stop: async () => calls.push("stop"),
      start: async () => calls.push("start"),
      checkReady: async () => calls.push("ready"),
    },
  }), { code: "RESTORE_BACKUP_POLICY_REQUIRED" });

  assert.deepEqual(calls, ["stopped", "stop", "stopped", "read-policy", "start", "ready"]);
  assert.equal(decryptCalled, false);
  assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).marker, "original");
  assert.equal((await readdir(path.dirname(fixture.target))).some((name) => name.includes(".quarantine-")), false);
});

test("a physically missing target requires an explicit mode before decrypt", async () => {
  const fixture = await createPolicyRestoreFixture("restore-policy-missing-target", {
    backupAutomaticEnabled: true,
    targetAutomaticEnabled: false,
  });
  await rm(fixture.target);
  const adapters = fakeAdapters();
  const sqlite = createSqliteAdapter();
  let decrypts = 0;
  adapters.sqlite.readBackupControl = sqlite.readBackupControl;
  adapters.age.decrypt = async () => { decrypts += 1; };

  await assert.rejects(restoreBackup(fixture.input, {
    ...adapters,
    services: { assertStopped: async () => undefined },
  }), { code: "RESTORE_BACKUP_POLICY_REQUIRED" });

  assert.equal(decrypts, 0);
  await assert.rejects(lstat(fixture.target), { code: "ENOENT" });
  assert.equal((await readdir(path.dirname(fixture.target))).some((name) => name.includes(".quarantine-")), false);
});

test("unreadable target policy accepts explicit enabled and disabled modes", async (t) => {
  for (const explicitMode of [true, false]) {
    await t.test(explicitMode ? "enabled" : "disabled", async () => {
      const fixture = await createPolicyRestoreFixture(`restore-policy-explicit-${explicitMode}`, {
        backupAutomaticEnabled: !explicitMode,
        targetAutomaticEnabled: !explicitMode,
      });
      const adapters = fakeAdapters();
      let appliedMode;
      adapters.sqlite.readBackupControl = async () => {
        throw Object.assign(new Error("unreadable"), { code: "BACKUP_CONTROL_INVALID" });
      };
      adapters.sqlite.applyBackupControl = async (databasePath, input) => {
        appliedMode = input.automaticEnabled;
        const staged = JSON.parse(await readFile(databasePath, "utf8"));
        staged.automaticEnabled = input.automaticEnabled;
        await writeFile(databasePath, JSON.stringify(staged));
        return { automaticEnabled: input.automaticEnabled, rowVersion: 2, updatedAtMs: input.nowMs };
      };

      const result = await restoreBackup({
        ...fixture.input,
        automaticBackupAfterRestore: explicitMode,
      }, {
        ...adapters,
        services: {
          assertStopped: async () => undefined,
          start: async () => undefined,
          checkReady: async () => undefined,
        },
      });

      assert.equal(appliedMode, explicitMode);
      assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).automaticEnabled, explicitMode);
      assert.equal(result.automaticBackupAfterRestore, explicitMode);
      assert.equal(result.automaticBackupPolicySource, "explicit");
    });
  }
});

test("conflicting explicit policy fails before decrypt or quarantine in both directions", async (t) => {
  for (const currentMode of [true, false]) {
    await t.test(currentMode ? "current ON and explicit disabled" : "current OFF and explicit enabled", async () => {
      const fixture = await createPolicyRestoreFixture(`restore-policy-conflict-${currentMode}`, {
        backupAutomaticEnabled: !currentMode,
        targetAutomaticEnabled: currentMode,
      });
      const adapters = fakeAdapters();
      let decryptCalled = false;
      adapters.sqlite.readBackupControl = async () => ({
        automaticEnabled: currentMode,
        rowVersion: 3,
        updatedAtMs: 1,
      });
      adapters.age.decrypt = async () => { decryptCalled = true; };

      await assert.rejects(restoreBackup({
        ...fixture.input,
        automaticBackupAfterRestore: !currentMode,
      }, {
        ...adapters,
        services: {
          assertStopped: async () => undefined,
          start: async () => undefined,
          checkReady: async () => undefined,
        },
      }), { code: "RESTORE_BACKUP_POLICY_CONFLICT" });

      assert.equal(decryptCalled, false);
      assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).marker, "original");
      assert.equal((await readdir(path.dirname(fixture.target))).some((name) => name.includes(".quarantine-")), false);
    });
  }
});

test("staged policy or audit failure never replaces or quarantines the target", async () => {
  const fixture = await createPolicyRestoreFixture("restore-policy-apply-failure", {
    backupAutomaticEnabled: true,
    targetAutomaticEnabled: false,
  });
  const adapters = fakeAdapters();
  const calls = [];
  const originalInspect = adapters.sqlite.inspect;
  adapters.sqlite.readBackupControl = async () => ({ automaticEnabled: false, rowVersion: 1, updatedAtMs: 0 });
  adapters.sqlite.enforceRetention = async () => {
    calls.push("retention");
    return { purgedCount: 0 };
  };
  adapters.sqlite.applyBackupControl = async () => {
    calls.push("apply-policy");
    throw Object.assign(new Error("audit insert failed"), { code: "BACKUP_CONTROL_INVALID" });
  };
  adapters.sqlite.inspect = async (databasePath) => {
    calls.push("inspect");
    return originalInspect(databasePath);
  };

  await assert.rejects(restoreBackup(fixture.input, {
    ...adapters,
    services: {
      assertStopped: async () => calls.push("stopped"),
      stop: async () => calls.push("stop"),
      start: async () => calls.push("start"),
      checkReady: async () => calls.push("ready"),
    },
  }), { code: "BACKUP_CONTROL_INVALID" });

  assert.ok(calls.indexOf("retention") < calls.indexOf("apply-policy"));
  assert.equal(calls.filter((call) => call === "inspect").length, 1);
  assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).marker, "original");
  assert.equal((await readdir(path.dirname(fixture.target))).some((name) => name.includes(".quarantine-")), false);
});

test("readiness rollback restores the original target policy", async () => {
  const fixture = await createPolicyRestoreFixture("restore-policy-readiness-rollback", {
    backupAutomaticEnabled: true,
    targetAutomaticEnabled: false,
  });
  const originalTarget = await readFile(fixture.target, "utf8");
  const adapters = fakeAdapters();
  let applied = false;
  let readinessChecks = 0;
  adapters.sqlite.readBackupControl = async () => ({ automaticEnabled: false, rowVersion: 5, updatedAtMs: 2 });
  adapters.sqlite.applyBackupControl = async (databasePath, input) => {
    applied = true;
    const staged = JSON.parse(await readFile(databasePath, "utf8"));
    staged.automaticEnabled = input.automaticEnabled;
    await writeFile(databasePath, JSON.stringify(staged));
    return { automaticEnabled: false, rowVersion: 6, updatedAtMs: input.nowMs };
  };

  await assert.rejects(restoreBackup(fixture.input, {
    ...adapters,
    services: {
      assertStopped: async () => undefined,
      stop: async () => undefined,
      start: async () => undefined,
      checkReady: async () => {
        readinessChecks += 1;
        if (readinessChecks === 1) {
          throw Object.assign(new Error("restored service not ready"), { code: "RESTORED_SERVICE_NOT_READY" });
        }
      },
    },
  }), { code: "RESTORED_SERVICE_NOT_READY" });

  assert.equal(applied, true);
  assert.equal(await readFile(fixture.target, "utf8"), originalTarget);
  assert.equal(JSON.parse(await readFile(fixture.target, "utf8")).automaticEnabled, false);
});

test("restore rejects a verified hash when the encrypted byte count does not match", async () => {
  const root = await fixtureDirectory("restore-size-mismatch");
  const backupRoot = path.join(root, "backups");
  const backup = path.join(backupRoot, "hourly-20260716T010203Z.age");
  const status = path.join(backupRoot, "hourly-20260716T010203Z.json");
  const target = path.join(root, "portal.sqlite");
  const encrypted = "verified-ciphertext";
  await mkdir(backupRoot, { recursive: true });
  await writeFile(backup, encrypted);
  await writeFile(status, JSON.stringify({
    verified: true,
    schemaVersion: 3,
    encryptedSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptedBytes: Buffer.byteLength(encrypted) + 1,
  }));
  await writeFile(target, "unchanged");
  let decryptCalled = false;

  await assert.rejects(restoreBackup({
    backupRoot,
    backup,
    target,
    tempRoot: path.join(root, "temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...fakeAdapters(),
    age: {
      ...fakeAdapters().age,
      decrypt: async () => {
        decryptCalled = true;
      },
    },
    services: { assertStopped: async () => undefined },
  }), { code: "BACKUP_HASH_MISMATCH" });

  assert.equal(decryptCalled, false);
  assert.equal(await readFile(target, "utf8"), "unchanged");
});

test("restore rejects an oversized status file before decrypting the artifact", async () => {
  const root = await fixtureDirectory("restore-oversized-status");
  const backupRoot = path.join(root, "backups");
  const backup = path.join(backupRoot, "hourly-20260716T010203Z.age");
  const status = path.join(backupRoot, "hourly-20260716T010203Z.json");
  const target = path.join(root, "portal.sqlite");
  const encrypted = "verified-ciphertext";
  await mkdir(backupRoot, { recursive: true });
  await writeFile(backup, encrypted);
  await writeFile(status, JSON.stringify({
    verified: true,
    schemaVersion: 3,
    encryptedSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptedBytes: Buffer.byteLength(encrypted),
    padding: "x".repeat(17 * 1024),
  }));
  await writeFile(target, "unchanged");
  let decryptCalled = false;

  await assert.rejects(restoreBackup({
    backupRoot,
    backup,
    target,
    tempRoot: path.join(root, "temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...fakeAdapters(),
    age: {
      ...fakeAdapters().age,
      decrypt: async () => {
        decryptCalled = true;
      },
    },
    services: { assertStopped: async () => undefined },
  }), { code: "RESTORE_STATUS_INVALID" });

  assert.equal(decryptCalled, false);
  assert.equal(await readFile(target, "utf8"), "unchanged");
});

test("guarded restore verifies encrypted metadata and preserves the old DB in quarantine", async () => {
  const root = await fixtureDirectory("restore");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const backupTemp = path.join(root, "backup-temp");
  const restoreTemp = path.join(root, "restore-temp");
  const target = path.join(root, "data", "portal.sqlite");
  const original = JSON.stringify({ schemaVersion: 3, ciphertext: "opaque", receipt: "receipt-1" });
  await writeFile(sourceDb, original);
  const backupResult = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: backupTemp,
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await (await import("node:fs/promises")).mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old-production-database");
  const serviceCalls = [];

  const result = await restoreBackup({
    backupRoot,
    backup: backupResult.hourlyArtifact,
    target,
    tempRoot: restoreTemp,
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
    now: new Date("2026-07-16T03:04:05.000Z"),
  }, {
    ...fakeAdapters(),
    services: {
      assertStopped: async () => serviceCalls.push("stopped"),
      start: async () => serviceCalls.push("start"),
      checkReady: async () => serviceCalls.push("ready"),
    },
  });

  assert.equal(await readFile(target, "utf8"), original);
  assert.equal(await readFile(result.quarantinePath, "utf8"), "old-production-database");
  assert.deepEqual(serviceCalls, ["stopped", "stopped", "start", "ready"]);
  assert.deepEqual(await readdir(restoreTemp), []);
});

test("restore enforces current retention on the staged database before replacement and startup", async () => {
  const root = await fixtureDirectory("restore-retention");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, expiredPii: "must-not-return" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old-production-db");
  const calls = [];
  const adapters = fakeAdapters();
  adapters.sqlite.enforceRetention = async (databasePath, nowMs) => {
    calls.push(["retention", path.basename(databasePath), nowMs]);
    await writeFile(databasePath, JSON.stringify({ schemaVersion: 3, expiredPii: null }));
    return { purgedCount: 1 };
  };

  await restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
    now: new Date("2026-07-16T03:04:05.000Z"),
  }, {
    ...adapters,
    services: {
      assertStopped: async () => calls.push(["stopped"]),
      start: async () => calls.push(["start"]),
      checkReady: async () => calls.push(["ready"]),
    },
  });

  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { schemaVersion: 3, expiredPii: null });
  assert.deepEqual(calls, [
    ["stopped"],
    ["retention", calls[1][1], Date.parse("2026-07-16T03:04:05.000Z")],
    ["stopped"],
    ["start"],
    ["ready"],
  ]);
  assert.match(calls[1][1], /^\.portal\.sqlite\.restore-/u);
});

test("restore rechecks service quiescence immediately before replacing the database", async () => {
  const root = await fixtureDirectory("restore-final-quiescence");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "new" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old-production-db");
  let stopChecks = 0;

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...fakeAdapters(),
    services: {
      assertStopped: async () => {
        stopChecks++;
        if (stopChecks === 2) {
          throw Object.assign(new Error("service restarted"), { code: "SERVICES_RUNNING" });
        }
      },
      start: async () => undefined,
      checkReady: async () => undefined,
    },
  }), { code: "SERVICES_RUNNING" });

  assert.equal(stopChecks, 2);
  assert.equal(await readFile(target, "utf8"), "old-production-db");
  assert.equal((await readdir(path.dirname(target))).some((name) => name.includes(".quarantine-")), false);
});

test("restore rejects wrong keys, corrupt data, schema mismatch, and running services", async (t) => {
  const root = await fixtureDirectory("restore-failures");
  const backupRoot = path.join(root, "backups");
  const backup = path.join(backupRoot, "hourly-20260716T010203Z.age");
  const status = path.join(backupRoot, "hourly-20260716T010203Z.json");
  const target = path.join(root, "portal.sqlite");
  const tempRoot = path.join(root, "temp");
  await (await import("node:fs/promises")).mkdir(backupRoot, { recursive: true });
  await writeFile(backup, "not-age-ciphertext");
  await writeFile(status, JSON.stringify({
    formatVersion: 1,
    kind: "hourly",
    createdAt: "2026-07-16T01:02:03.000Z",
    schemaVersion: 3,
    encryptedSha256: "wrong",
    verified: true,
  }));
  await writeFile(target, "unchanged");
  const common = {
    backupRoot,
    backup,
    target,
    tempRoot,
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  };

  await t.test("running services", async () => {
    await assert.rejects(restoreBackup(common, {
      ...fakeAdapters(),
      services: { assertStopped: async () => { throw Object.assign(new Error("running"), { code: "SERVICES_RUNNING" }); } },
    }), { code: "SERVICES_RUNNING" });
  });
  await t.test("artifact hash mismatch", async () => {
    await assert.rejects(restoreBackup(common, {
      ...fakeAdapters(),
      services: { assertStopped: async () => undefined },
    }), { code: "BACKUP_HASH_MISMATCH" });
  });
  assert.equal(await readFile(target, "utf8"), "unchanged");
});

test("restore independently rejects wrong age identity, corrupt plaintext, and schema mismatch", async (t) => {
  const root = await fixtureDirectory("restore-validation-failures");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "opaque" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());

  const cases = [
    ["wrong identity", fakeAdapters({ decryptError: "AGE_AUTH_FAILED" }), "AGE_AUTH_FAILED"],
    ["corrupt plaintext", fakeAdapters({ integrity: "corrupt" }), "RESTORE_INTEGRITY_FAILED"],
    ["schema mismatch", fakeAdapters({ schema: 2 }), "RESTORE_SCHEMA_INCOMPATIBLE"],
  ];
  for (const [name, adapters, code] of cases) {
    await t.test(name, async () => {
      const target = path.join(root, name.replace(" ", "-"), "portal.sqlite");
      const tempRoot = path.join(root, `${name.replace(" ", "-")}-temp`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "unchanged-production-db");
      await assert.rejects(restoreBackup({
        backupRoot,
        backup: backup.hourlyArtifact,
        target,
        tempRoot,
        ageIdentity: "AGE-SECRET-KEY-WRONG-OR-FIXTURE",
        confirmDestroy: path.resolve(target),
        dryRun: false,
      }, {
        ...adapters,
        services: { assertStopped: async () => undefined },
      }), { code });
      assert.equal(await readFile(target, "utf8"), "unchanged-production-db");
      assert.deepEqual(await readdir(tempRoot), []);
    });
  }
});

test("pre-replacement restore failure restarts and checks the unchanged service", async () => {
  const root = await fixtureDirectory("restore-pre-replacement-restart");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "opaque" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "unchanged-production-db");
  const calls = [];

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-WRONG",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...fakeAdapters({ decryptError: "AGE_AUTH_FAILED" }),
    services: {
      assertStopped: async () => calls.push("stopped"),
      stop: async () => calls.push("stop"),
      start: async () => calls.push("start"),
      checkReady: async () => calls.push("ready"),
    },
  }), { code: "AGE_AUTH_FAILED" });

  assert.equal(await readFile(target, "utf8"), "unchanged-production-db");
  assert.deepEqual(calls, ["stopped", "stop", "stopped", "start", "ready"]);
});

test("pre-replacement restart failure preserves both sanitized causes", async () => {
  const root = await fixtureDirectory("restore-pre-replacement-restart-failure");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "opaque" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "unchanged-production-db");

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-WRONG",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...fakeAdapters({ decryptError: "AGE_AUTH_FAILED" }),
    services: {
      assertStopped: async () => undefined,
      stop: async () => undefined,
      start: async () => {
        throw Object.assign(new Error("private launch detail"), { code: "SERVICE_START_FAILED" });
      },
      checkReady: async () => undefined,
    },
  }), (error) => {
    assert.equal(error.code, "RESTORE_ORIGINAL_RESTART_FAILED");
    assert.equal(error.message, "Restore validation failed and the unchanged service could not be recovered");
    assert.equal(error.cause?.code, "AGE_AUTH_FAILED");
    assert.equal(error.recoveryCause?.code, "SERVICE_START_FAILED");
    assert.doesNotMatch(error.message, /private launch detail/u);
    return true;
  });
  assert.equal(await readFile(target, "utf8"), "unchanged-production-db");
});

test("a database created by runMigrations survives WAL backup and guarded restore", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { tsImport } = await import("tsx/esm/api");
  const { closeDatabase, openDatabase, runMigrations } = await tsImport(
    "../../apps/control/src/db/client.ts",
    import.meta.url,
  );
  const root = await fixtureDirectory("sqlite-wal-drill");
  const sourceDb = path.join(root, "source.sqlite");
  const target = path.join(root, "restore", "portal.sqlite");
  const writer = openDatabase(sourceDb);
  runMigrations(writer, Date.parse("2026-07-16T00:00:00.000Z"));
  writer.sqlite.exec("CREATE TABLE backup_probe (receipt TEXT PRIMARY KEY, ciphertext TEXT NOT NULL)");
  const insert = writer.sqlite.prepare("INSERT INTO backup_probe (receipt, ciphertext) VALUES (?, ?)");
  insert.run("receipt-before", "opaque-ciphertext-before");
  insert.run("receipt-in-wal", "opaque-ciphertext-in-wal");

  const sqlite = createSqliteAdapter();
  const age = fakeAdapters().age;
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot: path.join(root, "backups"),
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, { sqlite, age });
  closeDatabase(writer);

  await mkdir(path.dirname(target), { recursive: true });
  const old = new Database(target);
  old.exec("CREATE TABLE old_data (value TEXT)");
  old.close();
  await restoreBackup({
    backupRoot: path.dirname(backup.hourlyArtifact),
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    automaticBackupAfterRestore: true,
    dryRun: false,
  }, {
    sqlite,
    age,
    services: {
      assertStopped: async () => undefined,
      start: async () => undefined,
      checkReady: async () => undefined,
    },
  });

  const restored = new Database(target, { readonly: true });
  try {
    assert.deepEqual(restored.prepare("SELECT receipt, ciphertext FROM backup_probe ORDER BY receipt").all(), [
      { receipt: "receipt-before", ciphertext: "opaque-ciphertext-before" },
      { receipt: "receipt-in-wal", ciphertext: "opaque-ciphertext-in-wal" },
    ]);
    assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(restored.pragma("user_version", { simple: true }), 7);
  } finally {
    restored.close();
  }
});

test("restore rejects stale SQLite sidecars before decrypting", async () => {
  const root = await fixtureDirectory("restore-sidecar");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "opaque" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old");
  await writeFile(`${target}-wal`, "stale-wal");
  const adapters = fakeAdapters();
  let policyReads = 0;
  let decrypts = 0;
  adapters.sqlite.readBackupControl = async () => {
    policyReads += 1;
    return { automaticEnabled: true, rowVersion: 1, updatedAtMs: 0 };
  };
  adapters.age.decrypt = async () => { decrypts += 1; };

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
  }, {
    ...adapters,
    services: { assertStopped: async () => undefined },
  }), { code: "RESTORE_SIDECAR_PRESENT" });
  assert.equal(policyReads, 0);
  assert.equal(decrypts, 0);
  assert.equal(await readFile(target, "utf8"), "old");
});

test("readiness failure restores the previous database and services", async () => {
  const root = await fixtureDirectory("restore-readiness");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "new" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old-production-db");
  const calls = [];
  let checks = 0;

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
    now: new Date("2026-07-16T03:04:05.000Z"),
  }, {
    ...fakeAdapters(),
    services: {
      assertStopped: async () => calls.push("stopped"),
      start: async () => calls.push("start"),
      stop: async () => calls.push("stop"),
      checkReady: async () => {
        calls.push("ready");
        checks++;
        if (checks === 1) throw Object.assign(new Error("new DB not ready"), { code: "RESTORED_SERVICE_NOT_READY" });
      },
    },
  }), { code: "RESTORED_SERVICE_NOT_READY" });

  assert.equal(await readFile(target, "utf8"), "old-production-db");
  assert.deepEqual(calls, [
    "stopped", "stop", "stopped", "stopped", "start", "ready",
    "stop", "stopped", "start", "ready",
  ]);
  assert.ok((await readdir(path.dirname(target))).some((name) => name.includes(".failed-20260716T030405Z")));
});

test("restore surfaces a distinct error when readiness rollback also fails", async () => {
  const root = await fixtureDirectory("restore-rollback-failure");
  const sourceDb = path.join(root, "source.sqlite");
  const backupRoot = path.join(root, "backups");
  const target = path.join(root, "data", "portal.sqlite");
  await writeFile(sourceDb, JSON.stringify({ schemaVersion: 3, ciphertext: "new" }));
  const backup = await createOnlineBackup({
    sourceDb,
    backupRoot,
    tempRoot: path.join(root, "backup-temp"),
    ageRecipient: "age1fixtureoperatorrecipient",
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    now: new Date("2026-07-16T01:02:03.000Z"),
  }, fakeAdapters());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "old-production-db");
  let stops = 0;

  await assert.rejects(restoreBackup({
    backupRoot,
    backup: backup.hourlyArtifact,
    target,
    tempRoot: path.join(root, "restore-temp"),
    ageIdentity: "AGE-SECRET-KEY-FIXTURE",
    confirmDestroy: path.resolve(target),
    dryRun: false,
    now: new Date("2026-07-16T03:04:05.000Z"),
  }, {
    ...fakeAdapters(),
    services: {
      assertStopped: async () => undefined,
      start: async () => undefined,
      stop: async () => {
        stops++;
        if (stops === 2) {
          throw Object.assign(new Error("services remained running"), { code: "SERVICE_STOP_TIMEOUT" });
        }
      },
      checkReady: async () => {
        throw Object.assign(new Error("new DB not ready"), { code: "RESTORED_SERVICE_NOT_READY" });
      },
    },
  }), (error) => {
    assert.equal(error.code, "RESTORE_ROLLBACK_FAILED");
    assert.equal(error.cause?.code, "RESTORED_SERVICE_NOT_READY");
    assert.equal(error.recoveryCause?.code, "SERVICE_STOP_TIMEOUT");
    return true;
  });

  assert.equal(await readFile(target, "utf8"), JSON.stringify({ schemaVersion: 3, ciphertext: "new" }));
  assert.equal(await readFile(`${target}.quarantine-20260716T030405Z`, "utf8"), "old-production-db");
});
