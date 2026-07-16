import path from "node:path";

import { assertNoSymlinkPath } from "./safe-paths.mjs";
import {
  acquireExclusiveDirectoryLock,
  recoverExclusiveDirectoryLock,
} from "./exclusive-lock.mjs";

function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

export function databaseMaintenanceLockPath(databasePath) {
  if (
    typeof databasePath !== "string" ||
    !path.isAbsolute(databasePath) ||
    /[\0\r\n]/u.test(databasePath)
  ) {
    fail("DATABASE_MAINTENANCE_LOCK_INVALID", "Database lock path must be absolute");
  }
  const resolved = path.resolve(databasePath);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.maintenance-lock`);
}

export async function acquireDatabaseMaintenanceLock(databasePath) {
  const lockPath = databaseMaintenanceLockPath(databasePath);
  await assertNoSymlinkPath(path.dirname(lockPath), "DATABASE_MAINTENANCE_LOCK_INVALID");
  return acquireExclusiveDirectoryLock(lockPath, {
    lockedCode: "DATABASE_MAINTENANCE_LOCKED",
    invalidCode: "DATABASE_MAINTENANCE_LOCK_INVALID",
    staleCode: "DATABASE_MAINTENANCE_LOCK_STALE",
    ownershipCode: "DATABASE_MAINTENANCE_LOCK_OWNERSHIP_LOST",
    kind: "backup or restore",
  });
}

export async function recoverDatabaseMaintenanceLock(databasePath, options = {}) {
  const lockPath = databaseMaintenanceLockPath(databasePath);
  await assertNoSymlinkPath(path.dirname(lockPath), "DATABASE_MAINTENANCE_LOCK_INVALID");
  return recoverExclusiveDirectoryLock(lockPath, {
    lockedCode: "DATABASE_MAINTENANCE_LOCKED",
    invalidCode: "DATABASE_MAINTENANCE_LOCK_INVALID",
    staleCode: "DATABASE_MAINTENANCE_LOCK_STALE",
    ownershipCode: "DATABASE_MAINTENANCE_LOCK_OWNERSHIP_LOST",
    recoveryCode: "DATABASE_MAINTENANCE_LOCK_RECOVERY_REFUSED",
    kind: "backup or restore",
  }, options);
}
