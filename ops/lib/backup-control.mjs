import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { backupRunStateSchema } from "@wisdom/shared";

import {
  assertNormalizedAbsolutePath,
  assertSecureRegularFile,
  readSecureRegularFile,
  withSecureRealDirectory,
} from "./monitor-files.mjs";

export const AUTOMATIC_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_BACKUP_RUN_STATE_BYTES = 4 * 1024;
const MAX_BACKUP_CHILD_OUTPUT_BYTES = 4 * 1024;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function invalidBackupControl() {
  return Object.assign(new Error("Backup control state is invalid"), {
    code: "BACKUP_CONTROL_INVALID",
  });
}

function invalidBackupRunState() {
  return Object.assign(new Error("Backup run state is invalid"), {
    code: "BACKUP_RUN_STATE_INVALID",
  });
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function privateMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o777) === 0o600;
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function optionalMetadata(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validatedRunState(value) {
  try {
    return backupRunStateSchema.parse(value);
  } catch {
    throw invalidBackupRunState();
  }
}

function encodeRunState(value) {
  const parsed = validatedRunState(value);
  let source;
  try {
    source = `${JSON.stringify(parsed)}\n`;
  } catch {
    throw invalidBackupRunState();
  }
  if (Buffer.byteLength(source, "utf8") > MAX_BACKUP_RUN_STATE_BYTES || source.includes("\0")) {
    throw invalidBackupRunState();
  }
  return { parsed, source };
}

function noFollowWriteFlags() {
  if (process.platform === "win32") return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  if (typeof constants.O_NOFOLLOW !== "number") throw invalidBackupRunState();
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
}

export async function loadBackupRunState(statePath) {
  const code = "BACKUP_RUN_STATE_INVALID";
  try {
    assertNormalizedAbsolutePath(statePath, code);
    return await withSecureRealDirectory(path.dirname(statePath), {
      code,
      requireProtected: true,
    }, async () => {
      const metadata = await optionalMetadata(statePath);
      if (metadata === undefined) return undefined;
      if (!metadata.isFile() || metadata.isSymbolicLink() || !privateMode(metadata)) {
        throw invalidBackupRunState();
      }
      const bytes = await readSecureRegularFile(statePath, {
        code,
        maxBytes: MAX_BACKUP_RUN_STATE_BYTES,
        requirePrivate: true,
      });
      let source;
      let value;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = JSON.parse(source);
      } catch {
        throw invalidBackupRunState();
      }
      return validatedRunState(value);
    });
  } catch (error) {
    if (error?.code === code) throw invalidBackupRunState();
    throw invalidBackupRunState();
  }
}

export async function writeBackupRunState(statePath, value) {
  const code = "BACKUP_RUN_STATE_INVALID";
  let temporaryPath;
  let handle;
  let renamed = false;
  try {
    assertNormalizedAbsolutePath(statePath, code);
    const { parsed, source } = encodeRunState(value);
    const parentPath = path.dirname(statePath);
    await withSecureRealDirectory(parentPath, {
      code,
      requireProtected: true,
    }, async ({ handle: directoryHandle }) => {
      const initialTarget = await optionalMetadata(statePath);
      if (initialTarget !== undefined) {
        if (!initialTarget.isFile() || initialTarget.isSymbolicLink() || !privateMode(initialTarget)) {
          throw invalidBackupRunState();
        }
        await assertSecureRegularFile(statePath, {
          code,
          maxBytes: MAX_BACKUP_RUN_STATE_BYTES,
          requirePrivate: true,
        });
      }

      temporaryPath = path.join(
        parentPath,
        `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      handle = await open(temporaryPath, noFollowWriteFlags(), 0o600);
      if (process.platform !== "win32") await handle.chmod(0o600);
      const initialTemp = await handle.stat();
      if (!initialTemp.isFile() || !privateMode(initialTemp)) throw invalidBackupRunState();
      await handle.writeFile(source, "utf8");
      await handle.sync();
      const writtenTemp = await handle.stat();
      if (
        initialTemp.dev !== writtenTemp.dev || initialTemp.ino !== writtenTemp.ino ||
        writtenTemp.size !== Buffer.byteLength(source, "utf8") || !privateMode(writtenTemp)
      ) throw invalidBackupRunState();
      await handle.close();
      handle = undefined;
      await assertSecureRegularFile(temporaryPath, {
        code,
        maxBytes: MAX_BACKUP_RUN_STATE_BYTES,
        requirePrivate: true,
      });

      const finalTarget = await optionalMetadata(statePath);
      if (
        (initialTarget === undefined) !== (finalTarget === undefined) ||
        (initialTarget !== undefined && !sameSnapshot(initialTarget, finalTarget))
      ) throw invalidBackupRunState();
      await rename(temporaryPath, statePath);
      renamed = true;
      const published = await lstat(statePath);
      if (!published.isFile() || published.isSymbolicLink() || !privateMode(published)) {
        throw invalidBackupRunState();
      }
      await assertSecureRegularFile(statePath, {
        code,
        maxBytes: MAX_BACKUP_RUN_STATE_BYTES,
        requirePrivate: true,
      });
      if (process.platform !== "win32") {
        if (!directoryHandle || typeof directoryHandle.sync !== "function") throw invalidBackupRunState();
        await directoryHandle.sync();
      }
    });
    return parsed;
  } catch {
    throw invalidBackupRunState();
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed && temporaryPath) await unlink(temporaryPath).catch(() => undefined);
  }
}

export function validateBackupControlRows(rows) {
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
  if (
    !row || typeof row !== "object" || Array.isArray(row) ||
    row.singleton !== 1 ||
    (row.automatic_enabled !== 0 && row.automatic_enabled !== 1) ||
    !Number.isSafeInteger(row.row_version) || row.row_version <= 0 ||
    !Number.isSafeInteger(row.updated_at_ms) || row.updated_at_ms < 0
  ) {
    throw invalidBackupControl();
  }
  return {
    automaticEnabled: row.automatic_enabled === 1,
    rowVersion: row.row_version,
    updatedAtMs: row.updated_at_ms,
  };
}

function validateControl(control) {
  return validateBackupControlRows([{
    singleton: 1,
    automatic_enabled: control?.automaticEnabled === true
      ? 1
      : control?.automaticEnabled === false ? 0 : control?.automaticEnabled,
    row_version: control?.rowVersion,
    updated_at_ms: control?.updatedAtMs,
  }]);
}

export function automaticBackupDecision({ control, newestVerified, now }) {
  const nowMs = now.valueOf();
  if (!control.automaticEnabled) return "admin-disabled";
  if (!newestVerified) return "run";
  const verifiedAtMs = Date.parse(newestVerified.createdAt);
  if (
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    !Number.isFinite(verifiedAtMs) || verifiedAtMs > nowMs
  ) {
    throw Object.assign(new Error("Automatic backup timing is invalid"), {
      code: "BACKUP_CONTROL_INVALID",
    });
  }
  if (verifiedAtMs < control.updatedAtMs) return "run";
  return nowMs - verifiedAtMs >= AUTOMATIC_BACKUP_INTERVAL_MS ? "run" : "not-due";
}

function observationFromVerified(newestVerified) {
  if (newestVerified === undefined) {
    return { lastVerifiedAt: null, lastVerifiedArtifact: null, verifiedAtMs: undefined };
  }
  if (typeof newestVerified?.createdAt !== "string") {
    fail("BACKUP_OPERATION_FAILED", "Verified backup observation is invalid");
  }
  const verifiedAtMs = Date.parse(newestVerified.createdAt);
  if (!Number.isFinite(verifiedAtMs) || verifiedAtMs < 0) {
    fail("BACKUP_OPERATION_FAILED", "Verified backup observation is invalid");
  }
  const lastVerifiedAt = new Date(verifiedAtMs).toISOString();
  const compact = lastVerifiedAt.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return {
    lastVerifiedAt,
    lastVerifiedArtifact: `hourly-${compact}.age`,
    verifiedAtMs,
  };
}

function observationFromPrior(prior) {
  return prior === undefined
    ? { lastVerifiedAt: null, lastVerifiedArtifact: null }
    : {
        lastVerifiedAt: prior.lastVerifiedAt,
        lastVerifiedArtifact: prior.lastVerifiedArtifact,
      };
}

function makeRunState({ runId, timestamp, outcome, controlRevision, observation, errorCode }) {
  return validatedRunState({
    formatVersion: 1,
    runId,
    startedAt: timestamp,
    finishedAt: outcome === "running" ? null : timestamp,
    outcome,
    controlRevision,
    lastVerifiedAt: observation.lastVerifiedAt,
    lastVerifiedArtifact: observation.lastVerifiedArtifact,
    errorCode,
  });
}

function parseChildResult(result) {
  if (
    !result || result.exitCode !== 0 || typeof result.stdout !== "string" ||
    Buffer.byteLength(result.stdout, "utf8") > MAX_BACKUP_CHILD_OUTPUT_BYTES ||
    (result.stderr !== undefined && (
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stderr, "utf8") > MAX_BACKUP_CHILD_OUTPUT_BYTES
    ))
  ) fail("BACKUP_OPERATION_FAILED", "Automatic backup child failed");

  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail("BACKUP_OPERATION_FAILED", "Automatic backup child output is invalid");
  }
  if (
    exactKeys(value, ["artifact", "dryRun", "encryptedBytes", "encryptedSha256", "verified"]) &&
    value.dryRun === false && value.verified === true &&
    /^hourly-\d{8}T\d{6}Z\.age$/u.test(value.artifact) &&
    /^[a-f0-9]{64}$/u.test(value.encryptedSha256) &&
    Number.isSafeInteger(value.encryptedBytes) && value.encryptedBytes >= 0
  ) return { outcome: "verified" };
  if (
    exactKeys(value, ["controlRevision", "dryRun", "outcome", "verified"]) &&
    value.dryRun === false && value.verified === false && value.outcome === "admin-disabled" &&
    Number.isSafeInteger(value.controlRevision) && value.controlRevision > 0
  ) return { outcome: "admin-disabled", controlRevision: value.controlRevision };
  fail("BACKUP_OPERATION_FAILED", "Automatic backup child output is invalid");
}

export async function runBackupDispatcher(input, adapters) {
  if (
    !input || typeof input !== "object" ||
    !(input.now instanceof Date) || !Number.isSafeInteger(input.now.valueOf()) || input.now.valueOf() < 0 ||
    typeof adapters?.readBackupControl !== "function" ||
    typeof adapters?.randomUUID !== "undefined" && typeof adapters.randomUUID !== "function"
  ) fail("BACKUP_CONTROL_INVALID", "Automatic backup dispatcher input is invalid");

  const timestamp = input.now.toISOString();
  const runId = (adapters.randomUUID ?? randomUUID)();
  const emptyObservation = { lastVerifiedAt: null, lastVerifiedArtifact: null };
  const persist = async (value) => {
    await writeBackupRunState(input.statePath, value);
    return value;
  };
  const failed = async ({ code, controlRevision, observation = emptyObservation }) => persist(makeRunState({
    runId,
    timestamp,
    outcome: "failed",
    controlRevision,
    observation,
    errorCode: code,
  }));

  let control;
  try {
    control = validateControl(await adapters.readBackupControl(input.sourceDb));
  } catch {
    return failed({ code: "BACKUP_CONTROL_INVALID", controlRevision: null });
  }

  if (!control.automaticEnabled) {
    let observation;
    try {
      observation = observationFromPrior(await loadBackupRunState(input.statePath));
    } catch {
      return failed({ code: "BACKUP_OPERATION_FAILED", controlRevision: control.rowVersion });
    }
    return persist(makeRunState({
      runId,
      timestamp,
      outcome: "admin-disabled",
      controlRevision: control.rowVersion,
      observation,
      errorCode: null,
    }));
  }

  let newestVerified;
  let observation;
  let decision;
  try {
    if (typeof adapters.loadNewestBackupStatus !== "function") {
      fail("BACKUP_OPERATION_FAILED", "Verified backup reader is unavailable");
    }
    newestVerified = await adapters.loadNewestBackupStatus(input.backupRoot);
    observation = observationFromVerified(newestVerified);
    decision = automaticBackupDecision({ control, newestVerified, now: input.now });
  } catch (error) {
    if (error?.code === "BACKUP_CONTROL_INVALID") {
      return failed({ code: "BACKUP_CONTROL_INVALID", controlRevision: null });
    }
    return failed({ code: "BACKUP_OPERATION_FAILED", controlRevision: control.rowVersion });
  }

  if (decision === "not-due") {
    return persist(makeRunState({
      runId,
      timestamp,
      outcome: "not-due",
      controlRevision: control.rowVersion,
      observation,
      errorCode: null,
    }));
  }

  await persist(makeRunState({
    runId,
    timestamp,
    outcome: "running",
    controlRevision: control.rowVersion,
    observation,
    errorCode: null,
  }));

  try {
    if (typeof adapters.runChild !== "function") fail("BACKUP_OPERATION_FAILED", "Backup child is unavailable");
    const child = parseChildResult(await adapters.runChild());
    if (child.outcome === "admin-disabled") {
      return persist(makeRunState({
        runId,
        timestamp,
        outcome: "admin-disabled",
        controlRevision: child.controlRevision,
        observation,
        errorCode: null,
      }));
    }

    const after = observationFromVerified(await adapters.loadNewestBackupStatus(input.backupRoot));
    if (after.verifiedAtMs === undefined || after.verifiedAtMs < input.now.valueOf()) {
      fail("BACKUP_OPERATION_FAILED", "Automatic backup did not publish a new verified pair");
    }
    return persist(makeRunState({
      runId,
      timestamp,
      outcome: "verified",
      controlRevision: control.rowVersion,
      observation: after,
      errorCode: null,
    }));
  } catch {
    return failed({
      code: "BACKUP_OPERATION_FAILED",
      controlRevision: control.rowVersion,
      observation,
    });
  }
}
