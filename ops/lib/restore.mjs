import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { acquireDatabaseMaintenanceLock } from "./database-maintenance-lock.mjs";
import { assertNoSymlinkPath, ensureRealDirectory } from "./safe-paths.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalized(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function syncFile(filePath) {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function planRestore(input) {
  for (const [name, candidate] of Object.entries({
    backupRoot: input.backupRoot,
    backup: input.backup,
    target: input.target,
    tempRoot: input.tempRoot,
  })) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      fail("RESTORE_INPUT_INVALID", `${name} must be absolute`);
    }
  }
  const backup = path.resolve(input.backup);
  const backupRoot = path.resolve(input.backupRoot);
  const target = path.resolve(input.target);
  const tempRoot = path.resolve(input.tempRoot);
  if (
    !isInside(backupRoot, backup) ||
    path.dirname(backup) !== backupRoot ||
    !/^(?:hourly-\d{8}T\d{6}Z|daily-\d{8})\.age$/u.test(path.basename(backup)) ||
    normalized(target) === normalized(backup) ||
    isInside(backupRoot, target) ||
    isInside(tempRoot, target) ||
    isInside(target, tempRoot)
  ) {
    fail("RESTORE_INPUT_INVALID", "Restore paths violate isolation rules");
  }
  const dryRun = input.dryRun !== false;
  if (!dryRun && input.confirmDestroy !== target) {
    fail("RESTORE_CONFIRMATION_MISMATCH", "--confirm-destroy must exactly equal the resolved target");
  }
  return {
    dryRun,
    backupRoot,
    backup,
    status: backup.replace(/\.age$/u, ".json"),
    target,
    tempRoot,
    steps: ["assert-services-stopped", "verify-encrypted-hash", "decrypt", "integrity-and-schema", "quarantine-old", "atomic-replace", "start-and-ready"],
  };
}

export async function restoreBackup(input, adapters) {
  const plan = planRestore(input);
  if (plan.dryRun) return plan;
  await ensureRealDirectory(path.dirname(plan.target), "RESTORE_TARGET_UNSAFE");
  const releaseMaintenanceLock = await acquireDatabaseMaintenanceLock(plan.target);
  try {
    return await restoreBackupLocked(input, plan, adapters);
  } finally {
    await releaseMaintenanceLock();
  }
}

async function restoreBackupLocked(input, plan, adapters) {
  const now = input.now ?? new Date();
  const quarantinePath = `${plan.target}.quarantine-${stamp(now)}`;
  const failedPath = `${plan.target}.failed-${stamp(now)}`;
  let work;
  let staged;
  let quarantined = false;
  let replaced = false;
  let serviceStopAttempted = false;
  try {
    await adapters.services.assertStopped();
    if (adapters.services.stop) {
      serviceStopAttempted = true;
      await adapters.services.stop();
      await adapters.services.assertStopped();
    }

    await assertNoSymlinkPath(plan.backupRoot, "RESTORE_INPUT_INVALID");
    await assertNoSymlinkPath(plan.backup, "RESTORE_INPUT_INVALID");
    await assertNoSymlinkPath(plan.status, "RESTORE_INPUT_INVALID");
    await ensureRealDirectory(plan.tempRoot, "RESTORE_INPUT_INVALID");
    if (await exists(plan.target)) await assertNoSymlinkPath(plan.target, "RESTORE_TARGET_UNSAFE");
    for (const sidecar of [`${plan.target}-wal`, `${plan.target}-shm`, `${plan.target}-journal`]) {
      if (await exists(sidecar)) fail("RESTORE_SIDECAR_PRESENT", "SQLite sidecars must be handled before restore");
    }

    for (const candidate of [plan.backup, plan.status]) {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail("RESTORE_INPUT_INVALID", "Backup inputs must be regular non-symlink files");
    }
    const status = JSON.parse(await readFile(plan.status, "utf8"));
    const encryptedSha256 = createHash("sha256").update(await readFile(plan.backup)).digest("hex");
    if (status.verified !== true || status.encryptedSha256 !== encryptedSha256) {
      fail("BACKUP_HASH_MISMATCH", "Encrypted backup hash does not match its verified status");
    }

    work = await mkdtemp(path.join(plan.tempRoot, ".restore-work-"));
    await chmod(work, 0o700);
    const decrypted = path.join(work, "decrypted.sqlite");
    staged = path.join(path.dirname(plan.target), `.${path.basename(plan.target)}.restore-${randomUUID()}`);
    if (await exists(quarantinePath) || await exists(failedPath)) {
      fail("RESTORE_TARGET_UNSAFE", "Quarantine or failed target already exists");
    }
    await adapters.age.decrypt({ input: plan.backup, output: decrypted, identity: input.ageIdentity });
    await chmod(decrypted, 0o600);
    const inspection = await adapters.sqlite.inspect(decrypted);
    if (inspection.integrity !== "ok") fail("RESTORE_INTEGRITY_FAILED", "Restored SQLite integrity check failed");
    if (inspection.schemaVersion !== status.schemaVersion || !(await adapters.sqlite.schemaCompatible(inspection))) {
      fail("RESTORE_SCHEMA_INCOMPATIBLE", "Restored schema is not compatible with this release");
    }
    await mkdir(path.dirname(plan.target), { recursive: true, mode: 0o700 });
    await copyFile(decrypted, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o600);
    await syncFile(staged);

    await adapters.services.assertStopped();
    if (await exists(plan.target)) {
      const targetMetadata = await lstat(plan.target);
      if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
        fail("RESTORE_TARGET_UNSAFE", "Restore target or quarantine path is unsafe");
      }
      await copyFile(plan.target, quarantinePath, constants.COPYFILE_EXCL);
      await chmod(quarantinePath, 0o600);
      await syncFile(quarantinePath);
      quarantined = true;
    }
    await rename(staged, plan.target);
    await syncDirectory(path.dirname(plan.target));
    replaced = true;
    await adapters.services.start();
    await adapters.services.checkReady();
    return { ...plan, dryRun: false, quarantinePath: quarantined ? quarantinePath : undefined };
  } catch (error) {
    let recoveryCause;
    if (replaced) {
      try {
        if (adapters.services.stop) await adapters.services.stop();
        await adapters.services.assertStopped();
        await copyFile(plan.target, failedPath, constants.COPYFILE_EXCL);
        await chmod(failedPath, 0o600);
        await syncFile(failedPath);
        if (quarantined) {
          await rename(quarantinePath, plan.target);
        } else {
          await rm(plan.target);
        }
        await syncDirectory(path.dirname(plan.target));
        await adapters.services.start();
        await adapters.services.checkReady();
      } catch (recoveryError) {
        recoveryCause = recoveryError;
      }
    } else if (serviceStopAttempted) {
      try {
        await adapters.services.start();
        await adapters.services.checkReady();
      } catch (recoveryError) {
        recoveryCause = recoveryError;
      }
      if (recoveryCause !== undefined) {
        const restartFailure = new Error(
          "Restore validation failed and the unchanged service could not be recovered",
          { cause: error },
        );
        restartFailure.code = "RESTORE_ORIGINAL_RESTART_FAILED";
        restartFailure.recoveryCause = recoveryCause;
        throw restartFailure;
      }
    }
    if (recoveryCause !== undefined) {
      const rollbackFailure = new Error(
        "Restored database failed readiness and the previous database could not be recovered",
        { cause: error },
      );
      rollbackFailure.code = "RESTORE_ROLLBACK_FAILED";
      rollbackFailure.recoveryCause = recoveryCause;
      throw rollbackFailure;
    }
    throw error;
  } finally {
    if (staged !== undefined) await rm(staged, { force: true });
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  }
}
