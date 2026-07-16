import { lstat } from "node:fs/promises";
import path from "node:path";

import { acquireExclusiveDirectoryLock } from "./exclusive-lock.mjs";
import { assertNoSymlinkPath } from "./safe-paths.mjs";

export async function acquireReleaseOperationLock(releaseRoot) {
  if (typeof releaseRoot !== "string" || !path.isAbsolute(releaseRoot) || /[\0\r\n]/u.test(releaseRoot)) {
    throw Object.assign(new Error("Release root must be absolute"), { code: "RELEASE_OPERATION_LOCK_INVALID" });
  }
  await assertNoSymlinkPath(releaseRoot, "RELEASE_OPERATION_LOCK_INVALID");
  const metadata = await lstat(releaseRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw Object.assign(new Error("Release root must be a real directory"), { code: "RELEASE_OPERATION_LOCK_INVALID" });
  }
  return acquireExclusiveDirectoryLock(path.join(releaseRoot, ".release-operation-lock"), {
    lockedCode: "RELEASE_OPERATION_LOCKED",
    invalidCode: "RELEASE_OPERATION_LOCK_INVALID",
    staleCode: "RELEASE_OPERATION_LOCK_STALE",
    ownershipCode: "RELEASE_OPERATION_LOCK_OWNERSHIP_LOST",
    kind: "release",
  });
}
