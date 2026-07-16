import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { acquireDatabaseMaintenanceLock } from "./database-maintenance-lock.mjs";
import { hashSecureRegularFile, readSecureRegularFile } from "./monitor-files.mjs";
import { assertNoSymlinkPath, ensureRealDirectory } from "./safe-paths.mjs";

const MAX_BACKUP_STATUS_BYTES = 16 * 1024;
const MAX_BACKUP_ARTIFACT_BYTES = 64 * 1024 * 1024 * 1024;
const BACKUP_RETENTION_HARD_LIMITS = Object.freeze({
  maxDirectoryEntries: 4_096,
  maxCandidates: 512,
  maxDeletions: 8,
  maxHashBytes: 128 * 1024 * 1024 * 1024,
});

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

function validateConfig(config) {
  for (const [name, candidate] of Object.entries({
    sourceDb: config.sourceDb,
    backupRoot: config.backupRoot,
    tempRoot: config.tempRoot,
  })) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      fail("BACKUP_INPUT_INVALID", `${name} must be absolute`);
    }
  }
  if (
    normalized(config.sourceDb) === normalized(config.backupRoot) ||
    isInside(config.backupRoot, config.sourceDb) ||
    isInside(config.tempRoot, config.sourceDb) ||
    isInside(config.backupRoot, config.tempRoot) ||
    isInside(config.tempRoot, config.backupRoot) ||
    normalized(config.backupRoot) === normalized(config.tempRoot)
  ) {
    fail("BACKUP_INPUT_INVALID", "Database, encrypted backup root, and plaintext temp root must be isolated");
  }
  if (typeof config.ageRecipient !== "string" || !config.ageRecipient.startsWith("age1")) {
    fail("BACKUP_INPUT_INVALID", "An age recipient is required");
  }
  if (typeof config.ageIdentity !== "string" || config.ageIdentity.length < 16) {
    fail("BACKUP_INPUT_INVALID", "An age verification identity is required");
  }
  if (!(config.now instanceof Date) || Number.isNaN(config.now.valueOf())) {
    fail("BACKUP_INPUT_INVALID", "A valid backup timestamp is required");
  }
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
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

async function hashBackupFile(filePath, code) {
  return hashSecureRegularFile(filePath, {
    code,
    maxBytes: MAX_BACKUP_ARTIFACT_BYTES,
    requireProtected: true,
  });
}

async function readBackupStatus(filePath, code) {
  return JSON.parse((await readSecureRegularFile(filePath, {
    code,
    maxBytes: MAX_BACKUP_STATUS_BYTES,
    requireProtected: true,
  })).toString("utf8"));
}

function retentionWorkLimits(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    fail("BACKUP_RETENTION_INVALID", "Retention work limits are invalid");
  }
  const unknown = Object.keys(overrides).find((key) => !Object.hasOwn(BACKUP_RETENTION_HARD_LIMITS, key));
  if (unknown !== undefined) fail("BACKUP_RETENTION_INVALID", "Retention work limits are invalid");
  const limits = { ...BACKUP_RETENTION_HARD_LIMITS, ...overrides };
  for (const [name, hardMaximum] of Object.entries(BACKUP_RETENTION_HARD_LIMITS)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > hardMaximum) {
      fail("BACKUP_RETENTION_INVALID", "Retention work limits are invalid");
    }
  }
  return limits;
}

async function boundedDirectoryNames(directoryPath, maximum) {
  const names = [];
  const directory = await opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (names.length >= maximum) {
        fail("BACKUP_RETENTION_LIMIT_EXCEEDED", "Backup retention directory exceeds its bounded inventory");
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close().catch((error) => {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return names;
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

async function atomicJson(filePath, value) {
  const pending = `${filePath}.pending-${randomUUID()}`;
  try {
    await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await syncFile(pending);
    await rename(pending, filePath);
  } finally {
    await rm(pending, { force: true });
  }
}

function statusFor(kind, config, inspection, encryptedSha256, encryptedBytes) {
  return {
    formatVersion: 1,
    kind,
    createdAt: config.now.toISOString(),
    sourceDatabase: path.basename(config.sourceDb),
    schemaVersion: inspection.schemaVersion,
    sqliteVersion: inspection.sqliteVersion,
    encryptedSha256,
    encryptedBytes,
    integrity: "ok",
    verified: true,
  };
}

async function verifiedPair(artifactPath, statusPath, kind) {
  try {
    const artifact = await lstat(artifactPath);
    const statusFile = await lstat(statusPath);
    if (
      !artifact.isFile() || artifact.isSymbolicLink() ||
      !statusFile.isFile() || statusFile.isSymbolicLink()
    ) return false;
    const status = await readBackupStatus(statusPath, "BACKUP_DAILY_INCONSISTENT");
    const artifactHash = await hashBackupFile(artifactPath, "BACKUP_DAILY_INCONSISTENT");
    return status.verified === true &&
      status.kind === kind &&
      status.encryptedBytes === artifact.size &&
      status.encryptedBytes === artifactHash.size &&
      status.encryptedSha256 === artifactHash.sha256;
  } catch {
    return false;
  }
}

export async function createOnlineBackup(config, adapters) {
  validateConfig(config);
  await assertNoSymlinkPath(config.sourceDb, "BACKUP_PATH_UNSAFE");
  const sourceMetadata = await lstat(config.sourceDb);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) fail("BACKUP_PATH_UNSAFE", "Source database must be a regular non-symlink file");
  await ensureRealDirectory(config.backupRoot, "BACKUP_PATH_UNSAFE");
  await ensureRealDirectory(config.tempRoot, "BACKUP_PATH_UNSAFE");
  await chmod(config.backupRoot, 0o700);
  await chmod(config.tempRoot, 0o700);

  const releaseMaintenanceLock = await acquireDatabaseMaintenanceLock(config.sourceDb);
  try {
    return await createOnlineBackupLocked(config, adapters);
  } finally {
    await releaseMaintenanceLock();
  }
}

async function createOnlineBackupLocked(config, adapters) {
  const hourlyBase = `hourly-${timestamp(config.now)}`;
  const hourlyArtifact = path.join(config.backupRoot, `${hourlyBase}.age`);
  const hourlyStatus = path.join(config.backupRoot, `${hourlyBase}.json`);
  if (await exists(hourlyArtifact) || await exists(hourlyStatus)) {
    fail("BACKUP_ALREADY_EXISTS", "A backup for this timestamp already exists");
  }

  const work = await mkdtemp(path.join(config.tempRoot, ".backup-work-"));
  await chmod(work, 0o700);
  const snapshot = path.join(work, "snapshot.sqlite");
  const verifiedSnapshot = path.join(work, "verified.sqlite");
  const pendingArtifact = path.join(config.backupRoot, `.pending-${randomUUID()}.age`);
  try {
    await adapters.sqlite.checkpoint(config.sourceDb, "PASSIVE");
    await adapters.sqlite.onlineBackup(config.sourceDb, snapshot);
    await chmod(snapshot, 0o600);
    const inspection = await adapters.sqlite.inspect(snapshot);
    if (inspection.integrity !== "ok") fail("BACKUP_INTEGRITY_FAILED", "SQLite snapshot integrity check failed");

    await adapters.age.encrypt({ input: snapshot, output: pendingArtifact, recipient: config.ageRecipient });
    await chmod(pendingArtifact, 0o600);
    await syncFile(pendingArtifact);
    await adapters.age.decrypt({ input: pendingArtifact, output: verifiedSnapshot, identity: config.ageIdentity });
    await chmod(verifiedSnapshot, 0o600);
    const verifiedInspection = await adapters.sqlite.inspect(verifiedSnapshot);
    if (
      verifiedInspection.integrity !== "ok" ||
      verifiedInspection.schemaVersion !== inspection.schemaVersion ||
      (await hashBackupFile(verifiedSnapshot, "BACKUP_VERIFICATION_FAILED")).sha256 !==
        (await hashBackupFile(snapshot, "BACKUP_VERIFICATION_FAILED")).sha256
    ) {
      fail("BACKUP_VERIFICATION_FAILED", "Encrypted backup verification failed");
    }

    const encryptedArtifact = await hashBackupFile(pendingArtifact, "BACKUP_VERIFICATION_FAILED");
    const encryptedSha256 = encryptedArtifact.sha256;
    const encryptedBytes = encryptedArtifact.size;
    const hourlyMetadata = statusFor("hourly", config, inspection, encryptedSha256, encryptedBytes);
    const writeStatus = adapters.storage?.writeStatus ?? atomicJson;
    let hourlyPublished = false;
    try {
      await rename(pendingArtifact, hourlyArtifact);
      hourlyPublished = true;
      await syncDirectory(config.backupRoot);
      await writeStatus(hourlyStatus, hourlyMetadata);
      await syncDirectory(config.backupRoot);
    } catch (error) {
      if (hourlyPublished) await rm(hourlyArtifact, { force: true });
      await rm(hourlyStatus, { force: true });
      await syncDirectory(config.backupRoot);
      throw error;
    }

    const dailyBase = `daily-${config.now.toISOString().slice(0, 10).replaceAll("-", "")}`;
    const dailyArtifact = path.join(config.backupRoot, `${dailyBase}.age`);
    const dailyStatus = path.join(config.backupRoot, `${dailyBase}.json`);
    let publishedDaily;
    if (!(await exists(dailyArtifact)) && !(await exists(dailyStatus))) {
      const dailyPending = `${dailyArtifact}.pending-${randomUUID()}`;
      await copyFile(hourlyArtifact, dailyPending, 0);
      await chmod(dailyPending, 0o600);
      await syncFile(dailyPending);
      let dailyPublished = false;
      try {
        await rename(dailyPending, dailyArtifact);
        dailyPublished = true;
        await syncDirectory(config.backupRoot);
        await writeStatus(dailyStatus, { ...hourlyMetadata, kind: "daily" });
        await syncDirectory(config.backupRoot);
        publishedDaily = dailyArtifact;
      } catch (error) {
        await rm(dailyPending, { force: true });
        if (dailyPublished) await rm(dailyArtifact, { force: true });
        await rm(dailyStatus, { force: true });
        await syncDirectory(config.backupRoot);
        throw error;
      }
    } else if ((await exists(dailyArtifact)) && (await exists(dailyStatus))) {
      if (!(await verifiedPair(dailyArtifact, dailyStatus, "daily"))) {
        fail("BACKUP_DAILY_INCONSISTENT", "Existing daily backup failed its recorded hash or size");
      }
      publishedDaily = dailyArtifact;
    } else {
      fail("BACKUP_DAILY_INCONSISTENT", "Daily backup artifact and status are inconsistent");
    }

    await applyBackupRetention(config.backupRoot, { hourly: 24, daily: 14 });
    return {
      verified: true,
      hourlyArtifact,
      hourlyStatus,
      dailyArtifact: publishedDaily,
      encryptedSha256,
      encryptedBytes,
    };
  } finally {
    await rm(pendingArtifact, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}

export async function applyBackupRetention(backupRoot, limits, workLimitOverrides = {}) {
  if (!path.isAbsolute(backupRoot) || !Number.isInteger(limits.hourly) || limits.hourly < 1 || !Number.isInteger(limits.daily) || limits.daily < 1) {
    fail("BACKUP_RETENTION_INVALID", "Retention root and limits are invalid");
  }
  const rootMetadata = await lstat(backupRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("BACKUP_RETENTION_INVALID", "Retention root must be a real directory");
  }
  const workLimits = retentionWorkLimits(workLimitOverrides);
  const names = await boundedDirectoryNames(backupRoot, workLimits.maxDirectoryEntries);
  const candidateNames = names.filter((name) => /^(?:hourly-\d{8}T\d{6}Z|daily-\d{8})\.json$/u.test(name));
  if (candidateNames.length > workLimits.maxCandidates) {
    fail("BACKUP_RETENTION_LIMIT_EXCEEDED", "Backup retention candidates exceed the bounded work limit");
  }
  const records = { hourly: [], daily: [] };
  for (const name of candidateNames) {
    const match = /^(hourly-\d{8}T\d{6}Z|daily-\d{8})\.json$/u.exec(name);
    if (!match) continue;
    const statusPath = path.join(backupRoot, name);
    const metadata = await lstat(statusPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail("BACKUP_RETENTION_INVALID", "Backup status cannot be a symlink");
    let status;
    try {
      status = await readBackupStatus(statusPath, "BACKUP_RETENTION_INVALID");
    } catch {
      continue;
    }
    if (!status.verified || !["hourly", "daily"].includes(status.kind) || Number.isNaN(Date.parse(status.createdAt))) continue;
    const artifactPath = statusPath.replace(/\.json$/u, ".age");
    if (!(await exists(artifactPath))) continue;
    const artifactMetadata = await lstat(artifactPath);
    if (!artifactMetadata.isFile() || artifactMetadata.isSymbolicLink()) fail("BACKUP_RETENTION_INVALID", "Backup artifact cannot be a symlink");
    if (
      artifactMetadata.size !== status.encryptedBytes ||
      !Number.isSafeInteger(status.encryptedBytes) || status.encryptedBytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(status.encryptedSha256 ?? "")
    ) continue;
    records[status.kind].push({
      statusPath,
      artifactPath,
      artifactBytes: artifactMetadata.size,
      encryptedSha256: status.encryptedSha256,
      createdAt: Date.parse(status.createdAt),
    });
  }

  let deletedArtifacts = 0;
  const deletionCandidates = [];
  for (const kind of ["hourly", "daily"]) {
    records[kind].sort((left, right) => right.createdAt - left.createdAt);
    deletionCandidates.push(...records[kind].slice(limits[kind]).toReversed());
  }
  const boundedCandidates = deletionCandidates.slice(0, workLimits.maxDeletions);
  let deferredArtifacts = deletionCandidates.length - boundedCandidates.length;
  let hashedBytes = 0;
  for (let index = 0; index < boundedCandidates.length; index += 1) {
    const record = boundedCandidates[index];
    if (hashedBytes + record.artifactBytes > workLimits.maxHashBytes) {
      deferredArtifacts += boundedCandidates.length - index;
      break;
    }
    if (!isInside(backupRoot, record.artifactPath) || !isInside(backupRoot, record.statusPath)) {
      fail("BACKUP_RETENTION_INVALID", "Retention target escaped the backup root");
    }
    hashedBytes += record.artifactBytes;
    let artifactHash;
    try {
      artifactHash = await hashBackupFile(record.artifactPath, "BACKUP_RETENTION_INVALID");
    } catch {
      continue;
    }
    if (artifactHash.size !== record.artifactBytes || artifactHash.sha256 !== record.encryptedSha256) continue;
    await rm(record.artifactPath);
    await rm(record.statusPath);
    deletedArtifacts++;
  }
  return { deletedArtifacts, deferredArtifacts, hashedBytes };
}
