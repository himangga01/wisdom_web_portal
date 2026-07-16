import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireExclusiveDirectoryLock,
  recoverExclusiveDirectoryLock,
} from "../lib/exclusive-lock.mjs";
import {
  databaseMaintenanceLockPath,
  recoverDatabaseMaintenanceLock,
} from "../lib/database-maintenance-lock.mjs";
import {
  recoverReleaseOperationLock,
  releaseOperationLockPath,
} from "../lib/release-operation-lock.mjs";

const codes = Object.freeze({
  lockedCode: "FIXTURE_LOCKED",
  invalidCode: "FIXTURE_INVALID",
  staleCode: "FIXTURE_STALE",
  ownershipCode: "FIXTURE_OWNERSHIP",
  recoveryCode: "FIXTURE_RECOVERY",
  kind: "fixture",
});
const currentIdentity = Object.freeze({
  hostname: "fixture-host",
  bootId: "boot-current",
  processStartId: "process-self",
});

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `wisdom-${name}-`));
  return { root, lockPath: path.join(root, ".fixture-lock") };
}

async function writeOwner(lockPath, overrides = {}) {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    formatVersion: 2,
    kind: "fixture",
    pid: 4242,
    hostname: "fixture-host",
    bootId: "boot-previous",
    processStartId: "process-old",
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  })}\n`);
}

function dependencies(overrides = {}) {
  return {
    identityProvider: async () => currentIdentity,
    lookupProcessStartId: async () => undefined,
    now: new Date("2026-07-16T04:00:00.000Z"),
    minimumAgeMs: 15 * 60_000,
    quarantineToken: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

test("stale lock recovery is dry-run first and quarantines only after exact confirmation", async () => {
  const { root, lockPath } = await fixture("lock-recovery");
  await writeOwner(lockPath);

  const plan = await recoverExclusiveDirectoryLock(lockPath, codes, dependencies());
  assert.equal(plan.dryRun, true);
  assert.equal(plan.staleReason, "previous-boot");
  assert.equal((await stat(lockPath)).isDirectory(), true);
  await assert.rejects(recoverExclusiveDirectoryLock(lockPath, codes, {
    ...dependencies(),
    dryRun: false,
    confirmLockPath: `${lockPath}-wrong`,
  }), { code: "FIXTURE_RECOVERY" });

  const result = await recoverExclusiveDirectoryLock(lockPath, codes, {
    ...dependencies(),
    dryRun: false,
    confirmLockPath: path.resolve(lockPath),
    confirmedAction: "QUARANTINE_STALE_LOCK",
  });
  assert.equal(result.dryRun, false);
  assert.match(path.basename(result.quarantinePath), /^\.fixture-lock\.quarantine-/u);
  assert.deepEqual(await readdir(root), [path.basename(result.quarantinePath)]);
  assert.match(await readFile(path.join(result.quarantinePath, "owner.json"), "utf8"), /boot-previous/u);
});

test("same-boot live owner is never stolen and PID reuse is recoverable", async () => {
  const live = await fixture("lock-live");
  await writeOwner(live.lockPath, { bootId: "boot-current", processStartId: "process-live" });
  await assert.rejects(recoverExclusiveDirectoryLock(live.lockPath, codes, dependencies({
    lookupProcessStartId: async () => "process-live",
  })), { code: "FIXTURE_LOCKED" });
  assert.equal((await stat(live.lockPath)).isDirectory(), true);

  const reused = await fixture("lock-pid-reused");
  await writeOwner(reused.lockPath, { bootId: "boot-current", processStartId: "process-old" });
  const plan = await recoverExclusiveDirectoryLock(reused.lockPath, codes, dependencies({
    lookupProcessStartId: async () => "process-new",
  }));
  assert.equal(plan.staleReason, "pid-reused");
});

test("missing or partial owner requires a bounded age and is never blindly deleted", async () => {
  const missing = await fixture("lock-missing-owner");
  await mkdir(missing.lockPath);
  await assert.rejects(recoverExclusiveDirectoryLock(missing.lockPath, codes, dependencies({
    now: new Date(),
  })), { code: "FIXTURE_STALE" });
  const old = new Date("2026-07-16T00:00:00.000Z");
  await utimes(missing.lockPath, old, old);
  const missingPlan = await recoverExclusiveDirectoryLock(missing.lockPath, codes, dependencies());
  assert.equal(missingPlan.staleReason, "aged-missing-owner");

  const partial = await fixture("lock-partial-owner");
  await mkdir(partial.lockPath);
  await writeFile(path.join(partial.lockPath, "owner.json"), "{\"formatVersion\":2");
  await utimes(partial.lockPath, old, old);
  const partialPlan = await recoverExclusiveDirectoryLock(partial.lockPath, codes, dependencies());
  assert.equal(partialPlan.staleReason, "aged-invalid-owner");
});

test("ordinary acquisition reports stale metadata without automatic takeover", async () => {
  const { lockPath } = await fixture("lock-no-auto-takeover");
  await writeOwner(lockPath);
  await assert.rejects(acquireExclusiveDirectoryLock(lockPath, {
    ...codes,
    identityProvider: async () => currentIdentity,
    lookupProcessStartId: async () => undefined,
  }), { code: "FIXTURE_STALE" });
  assert.equal((await stat(lockPath)).isDirectory(), true);
});

test("a live owner created by another process is recognized as the same process instance", async (t) => {
  const { lockPath } = await fixture("lock-cross-process-live");
  const moduleUrl = new URL("../lib/exclusive-lock.mjs", import.meta.url).href;
  const childSource = `
    import { acquireExclusiveDirectoryLock } from ${JSON.stringify(moduleUrl)};
    await acquireExclusiveDirectoryLock(${JSON.stringify(lockPath)}, ${JSON.stringify(codes)});
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  });
  await Promise.race([
    once(child.stdout, "data"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("child lock owner did not start")), 5_000)),
  ]);

  await assert.rejects(acquireExclusiveDirectoryLock(lockPath, codes), {
    code: "FIXTURE_LOCKED",
  });
});

test("release and database wrappers constrain recovery to their exact lock locations", async () => {
  const release = await fixture("release-lock-wrapper");
  const releaseRoot = path.join(release.root, "releases");
  await mkdir(releaseRoot);
  const releaseLock = releaseOperationLockPath(releaseRoot);
  await writeOwner(releaseLock, { kind: "release" });
  const releasePlan = await recoverReleaseOperationLock(releaseRoot, dependencies());
  assert.equal(releasePlan.lockPath, releaseLock);
  assert.equal(releasePlan.kind, "release");

  const database = path.join(release.root, "data", "portal.sqlite");
  await mkdir(path.dirname(database));
  await writeFile(database, "fixture");
  const databaseLock = databaseMaintenanceLockPath(database);
  await writeOwner(databaseLock, { kind: "backup or restore" });
  const databasePlan = await recoverDatabaseMaintenanceLock(database, dependencies());
  assert.equal(databasePlan.lockPath, databaseLock);
  assert.equal(databasePlan.kind, "backup or restore");
});
