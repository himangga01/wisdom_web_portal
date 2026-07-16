import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function readOwner(lockPath, code) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (
      owner?.formatVersion !== 1 ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
      typeof owner.hostname !== "string" || owner.hostname.length === 0 ||
      typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/u.test(owner.token)
    ) throw new Error("Invalid lock owner metadata");
    return owner;
  } catch (error) {
    fail(code, "Exclusive lock owner metadata is missing or invalid", error);
  }
}

export async function acquireExclusiveDirectoryLock(lockPath, {
  lockedCode,
  invalidCode,
  staleCode,
  ownershipCode,
  kind,
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  if (
    typeof lockPath !== "string" || !path.isAbsolute(lockPath) || /[\0\r\n]/u.test(lockPath) ||
    [lockedCode, invalidCode, staleCode, ownershipCode, kind].some((value) =>
      typeof value !== "string" || value.length === 0
    )
  ) {
    fail(invalidCode ?? "EXCLUSIVE_LOCK_INVALID", "Exclusive lock configuration is invalid");
  }

  const hostname = os.hostname();
  let stalePath;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") fail(invalidCode, "Unable to create exclusive lock", error);
    const existing = await readOwner(lockPath, staleCode);
    if (existing.hostname !== hostname || await processIsAlive(existing.pid)) {
      fail(lockedCode, `Another ${kind} operation owns the exclusive lock`, error);
    }
    stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
      await mkdir(lockPath, { mode: 0o700 });
    } catch (takeoverError) {
      await rm(stalePath, { recursive: true, force: true });
      if (takeoverError.code === "EEXIST" || takeoverError.code === "ENOENT") {
        fail(lockedCode, `Another ${kind} operation acquired the exclusive lock`, takeoverError);
      }
      fail(invalidCode, "Unable to recover a stale exclusive lock", takeoverError);
    }
    await rm(stalePath, { recursive: true, force: true });
  }

  const token = randomUUID();
  try {
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      formatVersion: 1,
      kind,
      pid: process.pid,
      hostname,
      token,
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    fail(invalidCode, "Unable to record exclusive lock owner", error);
  }

  let released = false;
  return async () => {
    if (released) return;
    const owner = await readOwner(lockPath, ownershipCode);
    if (owner.token !== token || owner.pid !== process.pid || owner.hostname !== hostname) {
      fail(ownershipCode, "Exclusive lock ownership changed before release");
    }
    const releasePath = `${lockPath}.release-${token}`;
    try {
      await rename(lockPath, releasePath);
      const movedOwner = await readOwner(releasePath, ownershipCode);
      if (movedOwner.token !== token || movedOwner.pid !== process.pid || movedOwner.hostname !== hostname) {
        fail(ownershipCode, "Exclusive lock ownership changed during release");
      }
      await rm(releasePath, { recursive: true });
      released = true;
    } catch (error) {
      if (error.code === ownershipCode) throw error;
      fail(ownershipCode, "Unable to release the owned exclusive lock", error);
    }
  };
}
