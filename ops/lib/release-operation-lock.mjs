import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  acquireExclusiveDirectoryLock,
  recoverExclusiveDirectoryLock,
} from "./exclusive-lock.mjs";
import { assertNoSymlinkPath } from "./safe-paths.mjs";

export function releaseOperationLockPath(releaseRoot) {
  if (typeof releaseRoot !== "string" || !path.isAbsolute(releaseRoot) || /[\0\r\n]/u.test(releaseRoot)) {
    throw Object.assign(new Error("Release root must be absolute"), { code: "RELEASE_OPERATION_LOCK_INVALID" });
  }
  return path.join(path.resolve(releaseRoot), ".release-operation-lock");
}

async function assertReleaseRoot(releaseRoot) {
  const lockPath = releaseOperationLockPath(releaseRoot);
  await assertNoSymlinkPath(releaseRoot, "RELEASE_OPERATION_LOCK_INVALID");
  const metadata = await lstat(releaseRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw Object.assign(new Error("Release root must be a real directory"), { code: "RELEASE_OPERATION_LOCK_INVALID" });
  }
  return lockPath;
}

const releaseLockConfig = Object.freeze({
    lockedCode: "RELEASE_OPERATION_LOCKED",
    invalidCode: "RELEASE_OPERATION_LOCK_INVALID",
    staleCode: "RELEASE_OPERATION_LOCK_STALE",
    ownershipCode: "RELEASE_OPERATION_LOCK_OWNERSHIP_LOST",
    recoveryCode: "RELEASE_OPERATION_LOCK_RECOVERY_REFUSED",
    kind: "release",
});

export async function acquireReleaseOperationLock(releaseRoot) {
  const lockPath = await assertReleaseRoot(releaseRoot);
  return acquireExclusiveDirectoryLock(lockPath, releaseLockConfig);
}

export async function recoverReleaseOperationLock(releaseRoot, options = {}) {
  const lockPath = await assertReleaseRoot(releaseRoot);
  return recoverExclusiveDirectoryLock(lockPath, releaseLockConfig, options);
}
