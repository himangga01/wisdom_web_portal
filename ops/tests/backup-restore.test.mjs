import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyBackupRetention, createOnlineBackup } from "../lib/backup.mjs";
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

test("backup freshness alerts after 90 minutes", async () => {
  const backupRoot = await fixtureDirectory("freshness");
  const artifact = path.join(backupRoot, "hourly-20260716T010000Z.age");
  await writeFile(artifact, "verified-ciphertext");
  await writeFile(path.join(backupRoot, "hourly-20260716T010000Z.json"), JSON.stringify({
    verified: true,
    kind: "hourly",
    createdAt: "2026-07-16T01:00:00.000Z",
    encryptedSha256: createHash("sha256").update("verified-ciphertext").digest("hex"),
    encryptedBytes: Buffer.byteLength("verified-ciphertext"),
  }));
  const status = await loadNewestBackupStatus(backupRoot);

  assert.equal(backupFreshness(status, new Date("2026-07-16T02:29:59.000Z")).state, "healthy");
  assert.equal(backupFreshness(status, new Date("2026-07-16T02:30:01.000Z")).state, "stale");
  assert.equal(backupFreshness(undefined, new Date()).state, "missing");

  await writeFile(artifact, "tampered");
  assert.equal(await loadNewestBackupStatus(backupRoot), undefined);
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
    assert.equal(restored.pragma("user_version", { simple: true }), 4);
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
    services: { assertStopped: async () => undefined },
  }), { code: "RESTORE_SIDECAR_PRESENT" });
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
