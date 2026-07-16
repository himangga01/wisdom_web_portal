import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 8 * 1024;
const DEFAULT_MINIMUM_AGE_MS = 15 * 60_000;
const SELF_PROCESS_START_ID = `${process.pid}:${new Date(Date.now() - process.uptime() * 1_000).toISOString()}`;
const LIVE_PROCESS_INSTANCE_UNAVAILABLE = Symbol("live-process-instance-unavailable");

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

async function defaultBootId() {
  if (process.platform === "darwin") {
    const { stdout } = await execFile("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024,
    });
    const value = stdout.trim();
    if (value) return `darwin:${value}`;
  }
  if (process.platform === "linux") {
    try {
      const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (value) return `linux:${value}`;
    } catch {
      // Fall back to a bounded boot-epoch identity below.
    }
  }
  return `fallback:${os.hostname()}:${Math.floor((Date.now() - os.uptime() * 1_000) / 60_000)}`;
}

async function defaultLookupProcessStartId(pid) {
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const { stdout } = await execFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        maxBuffer: 4 * 1024,
      });
      const value = stdout.trim();
      return value || undefined;
    } catch (error) {
      if (error.code === 1 || error.exitCode === 1) return undefined;
      throw error;
    }
  }
  if (pid === process.pid) return SELF_PROCESS_START_ID;
  return defaultProcessIsAlive(pid) ? LIVE_PROCESS_INSTANCE_UNAVAILABLE : undefined;
}

async function defaultIdentityProvider() {
  const processStartId = await defaultLookupProcessStartId(process.pid);
  if (typeof processStartId !== "string") {
    fail("EXCLUSIVE_LOCK_INVALID", "Current process instance identity is unavailable");
  }
  return {
    hostname: os.hostname(),
    bootId: await defaultBootId(),
    processStartId,
  };
}

function validIdentity(value) {
  return value && typeof value === "object" &&
    typeof value.hostname === "string" && value.hostname.length > 0 && value.hostname.length <= 255 &&
    typeof value.bootId === "string" && value.bootId.length > 0 && value.bootId.length <= 1_024 &&
    typeof value.processStartId === "string" && value.processStartId.length > 0 && value.processStartId.length <= 1_024;
}

function parseOwner(raw, expectedKind) {
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const exact = [
    "bootId", "createdAt", "formatVersion", "hostname", "kind", "pid",
    "processStartId", "token",
  ].sort().join("\0");
  if (
    !owner || typeof owner !== "object" || Array.isArray(owner) ||
    Object.keys(owner).sort().join("\0") !== exact ||
    owner.formatVersion !== 2 || owner.kind !== expectedKind ||
    !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
    !validIdentity(owner) ||
    typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/u.test(owner.token) ||
    typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))
  ) return undefined;
  return owner;
}

async function inspectOwner(lockPath, kind) {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  try {
    const metadata = await lstat(ownerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_OWNER_BYTES) {
      return { status: "invalid", raw: undefined, owner: undefined };
    }
    const raw = await readFile(ownerPath, "utf8");
    const owner = parseOwner(raw, kind);
    return owner
      ? { status: "valid", raw, owner }
      : { status: "invalid", raw, owner: undefined };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", raw: undefined, owner: undefined };
    throw error;
  }
}

function validateConfiguration(lockPath, config, requireRecovery = false) {
  const required = [config.lockedCode, config.invalidCode, config.staleCode, config.ownershipCode, config.kind];
  if (requireRecovery) required.push(config.recoveryCode);
  if (
    typeof lockPath !== "string" || !path.isAbsolute(lockPath) || /[\0\r\n]/u.test(lockPath) ||
    required.some((value) => typeof value !== "string" || value.length === 0)
  ) fail(config.invalidCode ?? "EXCLUSIVE_LOCK_INVALID", "Exclusive lock configuration is invalid");
}

async function readOwnedOwner(lockPath, config) {
  const inspected = await inspectOwner(lockPath, config.kind);
  if (inspected.status !== "valid") {
    fail(config.ownershipCode, "Exclusive lock owner metadata is missing or invalid");
  }
  return inspected.owner;
}

export async function acquireExclusiveDirectoryLock(lockPath, config = {}) {
  validateConfiguration(lockPath, config);
  const identityProvider = config.identityProvider ?? defaultIdentityProvider;
  const lookupProcessStartId = config.lookupProcessStartId ?? defaultLookupProcessStartId;
  const identity = await identityProvider(process.pid);
  if (!validIdentity(identity)) fail(config.invalidCode, "Exclusive lock process identity is invalid");

  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") fail(config.invalidCode, "Unable to create exclusive lock", error);
    const existing = await inspectOwner(lockPath, config.kind);
    if (existing.status !== "valid") {
      fail(config.staleCode, "Exclusive lock requires guarded recovery because owner metadata is missing or invalid");
    }
    if (existing.owner.hostname !== identity.hostname) {
      fail(config.lockedCode, `Another ${config.kind} operation owns the exclusive lock`);
    }
    if (existing.owner.bootId === identity.bootId) {
      let processStartId;
      try {
        processStartId = await lookupProcessStartId(existing.owner.pid);
      } catch (lookupError) {
        fail(config.lockedCode, `Another ${config.kind} operation may own the exclusive lock`, lookupError);
      }
      if (
        processStartId === LIVE_PROCESS_INSTANCE_UNAVAILABLE ||
        processStartId === existing.owner.processStartId
      ) {
        fail(config.lockedCode, `Another ${config.kind} operation owns the exclusive lock`);
      }
    }
    fail(config.staleCode, "Exclusive lock is stale and requires the guarded quarantine ceremony");
  }

  const token = randomUUID();
  try {
    await writeFile(path.join(lockPath, OWNER_FILE), `${JSON.stringify({
      formatVersion: 2,
      kind: config.kind,
      pid: process.pid,
      hostname: identity.hostname,
      bootId: identity.bootId,
      processStartId: identity.processStartId,
      token,
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    fail(config.invalidCode, "Unable to record exclusive lock owner", error);
  }

  let released = false;
  return async () => {
    if (released) return;
    const owner = await readOwnedOwner(lockPath, config);
    if (
      owner.token !== token || owner.pid !== process.pid || owner.hostname !== identity.hostname ||
      owner.bootId !== identity.bootId || owner.processStartId !== identity.processStartId
    ) fail(config.ownershipCode, "Exclusive lock ownership changed before release");
    const releasePath = `${lockPath}.release-${token}`;
    try {
      await rename(lockPath, releasePath);
      const movedOwner = await readOwnedOwner(releasePath, config);
      if (
        movedOwner.token !== token || movedOwner.pid !== process.pid || movedOwner.hostname !== identity.hostname ||
        movedOwner.bootId !== identity.bootId || movedOwner.processStartId !== identity.processStartId
      ) fail(config.ownershipCode, "Exclusive lock ownership changed during release");
      await rm(releasePath, { recursive: true });
      released = true;
    } catch (error) {
      if (error.code === config.ownershipCode) throw error;
      fail(config.ownershipCode, "Unable to release the owned exclusive lock", error);
    }
  };
}

function ownerFingerprint(metadata, inspected) {
  return JSON.stringify({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    mtimeMs: metadata.mtimeMs,
    ownerStatus: inspected.status,
    ownerSha256: inspected.raw === undefined
      ? undefined
      : createHash("sha256").update(inspected.raw).digest("hex"),
  });
}

export async function recoverExclusiveDirectoryLock(lockPath, config = {}, options = {}) {
  validateConfiguration(lockPath, config, true);
  const resolved = path.resolve(lockPath);
  const identityProvider = options.identityProvider ?? defaultIdentityProvider;
  const lookupProcessStartId = options.lookupProcessStartId ?? defaultLookupProcessStartId;
  const identity = await identityProvider(process.pid);
  if (!validIdentity(identity)) fail(config.recoveryCode, "Lock recovery identity is invalid");
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const minimumAgeMs = options.minimumAgeMs ?? DEFAULT_MINIMUM_AGE_MS;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 60_000 || minimumAgeMs > 24 * 60 * 60_000) {
    fail(config.recoveryCode, "Lock recovery time bounds are invalid");
  }

  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    fail(config.recoveryCode, "Lock recovery path is unavailable", error);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(config.recoveryCode, "Lock recovery path must be a real directory");
  }
  const canonicalParent = await realpath(path.dirname(resolved));
  if (path.resolve(canonicalParent, path.basename(resolved)) !== resolved) {
    fail(config.recoveryCode, "Lock recovery path is not canonical");
  }
  const inspected = await inspectOwner(resolved, config.kind);
  const ageMs = nowMs - metadata.mtimeMs;
  let staleReason;
  if (inspected.status === "valid") {
    const owner = inspected.owner;
    if (owner.hostname !== identity.hostname) {
      fail(config.recoveryCode, "Lock owner belongs to a different host and is not proven stale");
    }
    if (owner.bootId !== identity.bootId) staleReason = "previous-boot";
    else {
      let currentProcessStartId;
      try {
        currentProcessStartId = await lookupProcessStartId(owner.pid);
      } catch (error) {
        fail(config.recoveryCode, "Lock owner process identity could not be verified", error);
      }
      if (currentProcessStartId === LIVE_PROCESS_INSTANCE_UNAVAILABLE) {
        fail(config.lockedCode, `A live same-boot ${config.kind} owner may hold the exclusive lock`);
      }
      if (currentProcessStartId === owner.processStartId) {
        fail(config.lockedCode, `A live same-boot ${config.kind} owner holds the exclusive lock`);
      }
      staleReason = currentProcessStartId === undefined ? "process-exited" : "pid-reused";
    }
  } else {
    if (ageMs < minimumAgeMs) {
      fail(config.staleCode, "Incomplete lock metadata has not exceeded the guarded recovery age");
    }
    staleReason = inspected.status === "missing" ? "aged-missing-owner" : "aged-invalid-owner";
  }

  const dryRun = options.dryRun !== false;
  const plan = {
    dryRun,
    action: "quarantine-stale-lock",
    lockPath: resolved,
    kind: config.kind,
    staleReason,
    ownerStatus: inspected.status,
    minimumAgeMs,
    observedAgeMs: Math.max(0, Math.floor(ageMs)),
    ...(inspected.owner ? {
      owner: {
        pid: inspected.owner.pid,
        hostname: inspected.owner.hostname,
        bootId: inspected.owner.bootId,
        processStartId: inspected.owner.processStartId,
        createdAt: inspected.owner.createdAt,
      },
    } : {}),
  };
  if (dryRun) return plan;
  if (options.confirmLockPath !== resolved || options.confirmedAction !== "QUARANTINE_STALE_LOCK") {
    fail(config.recoveryCode, "Apply requires the exact absolute lock path and QUARANTINE_STALE_LOCK confirmation");
  }

  const beforeFingerprint = ownerFingerprint(metadata, inspected);
  const finalMetadata = await lstat(resolved);
  const finalInspected = await inspectOwner(resolved, config.kind);
  if (ownerFingerprint(finalMetadata, finalInspected) !== beforeFingerprint) {
    fail(config.recoveryCode, "Lock metadata changed during recovery inspection");
  }
  const token = options.quarantineToken ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/u.test(token)) fail(config.recoveryCode, "Lock quarantine token is invalid");
  const timestamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const quarantinePath = `${resolved}.quarantine-${timestamp}-${token}`;
  try {
    await rename(resolved, quarantinePath);
  } catch (error) {
    fail(config.recoveryCode, "Lock quarantine rename failed", error);
  }
  return { ...plan, dryRun: false, quarantinePath };
}
