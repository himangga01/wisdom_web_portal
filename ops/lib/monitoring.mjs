import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdir, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertSecureRealDirectory,
  assertSecureRegularFile,
  clearProtectedIncidentState,
  loadProtectedIncidentState,
  readProtectedConfigFile,
  readSecureRegularFile,
  withSecureRealDirectory,
  writeProtectedIncidentState,
} from "./monitor-files.mjs";

const execFile = promisify(execFileCallback);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_MACHINE_REPORT_BYTES = 16 * 1024;
const LABEL = /^[A-Za-z0-9.-]{1,255}$/u;
const MONITOR_KEYCHAIN_SERVICE = "com.jihye.portal.monitor-hermes-hmac";
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_DATABASE_HELPER = fileURLToPath(new URL("../scripts/monitor-db-check.mjs", import.meta.url));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function absolutePath(value) {
  return typeof value === "string" && value.length <= 4_096 && path.isAbsolute(value) &&
    !/[\0\r\n]/u.test(value) && path.normalize(value) === value;
}

function parsedUrl(value, code) {
  try {
    return new URL(value);
  } catch {
    fail(code, "Monitoring URL is invalid");
  }
}

function literalLoopback(url) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(hostname);
  return version === 4
    ? hostname.split(".")[0] === "127"
    : version === 6 && hostname === "::1";
}

function validateConfig(value) {
  if (!exactKeys(value, ["externalPublic", "local"])) fail("MONITOR_CONFIG_INVALID", "Monitoring config keys are invalid");
  const external = value.externalPublic;
  const local = value.local;
  if (!exactKeys(external, ["url", "expectedStatus", "expectedText", "source"]) ||
    !exactKeys(local, [
      "backupRoot", "controlReadyUrl", "databasePath", "diskPath", "hermes",
      "incidentState", "requiredRunningLaunchdLabels", "thresholds", "timeouts",
    ])) fail("MONITOR_CONFIG_INVALID", "Monitoring config shape is invalid");

  const externalUrl = parsedUrl(external.url, "MONITOR_CONFIG_INVALID");
  if (
    externalUrl.protocol !== "https:" || externalUrl.username || externalUrl.password ||
    externalUrl.hash || externalUrl.search || external.source !== "outside-mac-and-lan" ||
    !integer(external.expectedStatus, 100, 599) || typeof external.expectedText !== "string" ||
    external.expectedText.length < 1 || external.expectedText.length > 128 || /[\0\r\n]/u.test(external.expectedText)
  ) fail("MONITOR_CONFIG_INVALID", "External uptime contract is invalid");

  if (![local.backupRoot, local.databasePath, local.diskPath].every(absolutePath)) {
    fail("MONITOR_CONFIG_INVALID", "Local monitoring paths must be normalized absolute paths");
  }
  const incidentState = local.incidentState;
  if (
    !exactKeys(incidentState, ["cooldownMinutes", "path"]) || !absolutePath(incidentState.path) ||
    !integer(incidentState.cooldownMinutes, 1, 1_440) ||
    path.dirname(local.databasePath) !== local.diskPath ||
    path.dirname(incidentState.path) !== local.diskPath ||
    incidentState.path === local.databasePath
  ) fail("MONITOR_CONFIG_INVALID", "Monitor database and incident state must be bounded direct children of the data root");
  const readyUrl = parsedUrl(local.controlReadyUrl, "MONITOR_CONFIG_INVALID");
  if (
    readyUrl.protocol !== "http:" || !literalLoopback(readyUrl) || readyUrl.username || readyUrl.password ||
    readyUrl.pathname !== "/health/ready" || readyUrl.search || readyUrl.hash
  ) fail("MONITOR_CONFIG_INVALID", "Control readiness must use the exact loopback path");

  if (
    !Array.isArray(local.requiredRunningLaunchdLabels) || local.requiredRunningLaunchdLabels.length < 1 ||
    local.requiredRunningLaunchdLabels.length > 16 ||
    local.requiredRunningLaunchdLabels.some((label) => typeof label !== "string" || !LABEL.test(label)) ||
    new Set(local.requiredRunningLaunchdLabels).size !== local.requiredRunningLaunchdLabels.length
  ) fail("MONITOR_CONFIG_INVALID", "Required launchd labels are invalid");

  const thresholds = local.thresholds;
  if (!exactKeys(thresholds, [
    "backupFreshnessMinutes", "dailyBackupFreshnessHours", "diskFreePercentMinimum",
    "indexNowFailureBacklogMaximum", "notificationFailureBacklogMaximum",
    "publicationFailureBacklogMaximum", "queueStallMinutes", "retentionOverdueGraceMinutes",
    "retentionOverdueMaximum", "translationFailureBacklogMaximum",
  ]) ||
    !integer(thresholds.backupFreshnessMinutes, 1, 1_440) ||
    !integer(thresholds.dailyBackupFreshnessHours, 1, 168) ||
    !integer(thresholds.diskFreePercentMinimum, 1, 99) ||
    !integer(thresholds.queueStallMinutes, 1, 1_440) ||
    !integer(thresholds.retentionOverdueGraceMinutes, 0, 1_440) ||
    !integer(thresholds.retentionOverdueMaximum, 0, 1_000_000) ||
    !integer(thresholds.notificationFailureBacklogMaximum, 0, 1_000_000) ||
    !integer(thresholds.translationFailureBacklogMaximum, 0, 1_000_000) ||
    !integer(thresholds.publicationFailureBacklogMaximum, 0, 1_000_000) ||
    !integer(thresholds.indexNowFailureBacklogMaximum, 0, 1_000_000)
  ) fail("MONITOR_CONFIG_INVALID", "Monitoring thresholds are invalid");

  const timeouts = local.timeouts;
  if (!exactKeys(timeouts, ["checkMs", "hermesRequestMs", "overallMs"]) ||
    !integer(timeouts.overallMs, 1_000, 60_000) ||
    !integer(timeouts.checkMs, 100, timeouts.overallMs) ||
    !integer(timeouts.hermesRequestMs, 100, 10_000)
  ) fail("MONITOR_CONFIG_INVALID", "Monitoring timeouts are invalid");

  const hermes = local.hermes;
  if (!exactKeys(hermes, ["endpoint", "keychainService", "maximumAttempts", "retryDelayMs"])) {
    fail("MONITOR_CONFIG_INVALID", "Hermes handoff config shape is invalid");
  }
  const hermesUrl = parsedUrl(hermes.endpoint, "MONITOR_CONFIG_INVALID");
  if (
    hermesUrl.protocol !== "http:" || !literalLoopback(hermesUrl) || hermesUrl.username || hermesUrl.password ||
    hermesUrl.search || hermesUrl.hash || hermes.keychainService !== MONITOR_KEYCHAIN_SERVICE ||
    !integer(hermes.maximumAttempts, 1, 3) ||
    !integer(hermes.retryDelayMs, 0, 5_000)
  ) fail("MONITOR_CONFIG_INVALID", "Hermes handoff must be a bounded loopback target with a monitor key reference");
  return value;
}

export function parseMonitoringConfig(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES || source.includes("\0")) {
    fail("MONITOR_CONFIG_INVALID", "Monitoring config is invalid or too large");
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("MONITOR_CONFIG_INVALID", "Monitoring config must be JSON");
  }
  return validateConfig(value);
}

export async function loadMonitoringConfigFile(configPath) {
  if (!absolutePath(configPath)) fail("MONITOR_CONFIG_PATH_INVALID", "Monitoring config path must be absolute");
  let source;
  try {
    source = await readProtectedConfigFile(configPath, {
      maxBytes: MAX_CONFIG_BYTES,
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    fail("MONITOR_CONFIG_PATH_INVALID", "Monitoring config is unavailable");
  }
  return parseMonitoringConfig(source);
}

export async function loadNewestBackupStatus(backupRoot, {
  signal,
  maxArtifactBytes = MAX_BACKUP_BYTES,
  beforeReadEntries,
  kind = "hourly",
} = {}) {
  if (!absolutePath(backupRoot)) fail("MONITOR_INPUT_INVALID", "Backup root must be absolute");
  if (kind !== "hourly" && kind !== "daily") fail("MONITOR_INPUT_INVALID", "Backup status kind is invalid");
  if (beforeReadEntries !== undefined && typeof beforeReadEntries !== "function") {
    fail("MONITOR_INPUT_INVALID", "Backup directory hook is invalid");
  }
  return withSecureRealDirectory(backupRoot, {
    code: "MONITOR_INPUT_INVALID",
    requireProtected: true,
  }, async ({ canonicalPath: canonicalRoot }) => {
    await beforeReadEntries?.();
    const namePattern = kind === "hourly" ? /^hourly-\d{8}T\d{6}Z\.json$/u : /^daily-\d{8}\.json$/u;
    const names = (await readdir(canonicalRoot))
      .filter((name) => namePattern.test(name))
      .toSorted((left, right) => right.localeCompare(left))
      .slice(0, 48);
    for (const name of names) {
      try {
        const statusPath = path.join(backupRoot, name);
        const statusSource = await readSecureRegularFile(statusPath, {
          code: "MONITOR_BACKUP_INVALID",
          maxBytes: MAX_STATUS_BYTES,
          signal,
          requireProtected: true,
        });
        const value = JSON.parse(statusSource.toString("utf8"));
        const createdAtMs = Date.parse(value.createdAt);
        const timestamp = Number.isFinite(createdAtMs)
          ? new Date(createdAtMs).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")
          : "";
        const artifactPath = path.join(backupRoot, name.replace(/\.json$/u, ".age"));
        if (signal?.aborted) fail("MONITOR_BACKUP_INVALID", "Backup metadata check was interrupted");
        const artifact = await assertSecureRegularFile(artifactPath, {
          code: "MONITOR_BACKUP_INVALID",
          maxBytes: maxArtifactBytes,
          requireProtected: true,
        });
        if (signal?.aborted) fail("MONITOR_BACKUP_INVALID", "Backup metadata check was interrupted");
        const expectedName = kind === "hourly"
          ? `hourly-${timestamp}.json`
          : `daily-${timestamp.slice(0, 8)}.json`;
        if (
          value.verified === true && value.integrity === "ok" && value.kind === kind &&
          name === expectedName &&
          /^[a-f0-9]{64}$/u.test(value.encryptedSha256 ?? "") &&
          value.encryptedBytes === artifact.size
        ) return value;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A malformed or incomplete pair is not a verified successful backup.
      }
    }
    return undefined;
  });
}

export function backupFreshness(status, now, staleAfterMs = 90 * 60 * 1000) {
  if (!status) return { state: "missing", ageMs: undefined };
  const ageMs = now.valueOf() - Date.parse(status.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { state: "invalid", ageMs };
  return { state: ageMs > staleAfterMs ? "stale" : "healthy", ageMs };
}

async function within(timeoutMs, operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("Monitoring check timed out"), { code: "MONITOR_CHECK_TIMEOUT" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function healthy(id, value) {
  return { id, state: "healthy", ...(value === undefined ? {} : { value }) };
}

function failed(id, code, value) {
  return { id, state: "failed", code, ...(value === undefined ? {} : { value }) };
}

async function safeCheck(id, code, timeoutMs, operation, mappedCodes = {}) {
  try {
    return await within(timeoutMs, operation);
  } catch (error) {
    return failed(id, mappedCodes[error?.code] ?? code);
  }
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
}

function safeRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) fail("MONITOR_RUN_ID_INVALID", "Monitor run id is invalid");
  return value;
}

function handoffPayload(report) {
  return {
    schemaVersion: 1,
    eventType: "portal.monitor.unhealthy",
    runId: report.runId,
    observedAt: report.observedAt,
    failures: report.checks.filter(({ state }) => state === "failed").map(({ id, code, value }) => ({
      checkId: id,
      code,
      ...(typeof value === "number" && Number.isFinite(value) ? { value } : {}),
    })),
  };
}

function incidentFingerprint(checks) {
  const canonical = checks
    .filter(({ state }) => state === "failed")
    .map(({ id, code }) => `${id}\0${code}`)
    .toSorted()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validIncidentState(value) {
  if (value === undefined) return true;
  if (!exactKeys(value, ["fingerprint", "formatVersion", "lastSentAt"]) || value.formatVersion !== 1 ||
    typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
    typeof value.lastSentAt !== "string") return false;
  const timestamp = Date.parse(value.lastSentAt);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value.lastSentAt;
}

function boundedReport(report) {
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_MACHINE_REPORT_BYTES) {
    fail("MONITOR_REPORT_TOO_LARGE", "Monitoring report exceeded its fixed bound");
  }
  return report;
}

function operationalFailure(base, code) {
  return boundedReport({
    ...base,
    ok: false,
    checks: [...base.checks, failed("monitor-operations", code)],
    handoff: "failed",
    handoffCode: code,
    exitCode: 3,
  });
}

export async function runLocalMonitor({
  config,
  now = new Date(),
  runId = randomUUID(),
  nonce = randomUUID,
  dryRun = true,
  secret,
}, adapters) {
  validateConfig(config);
  safeRunId(runId);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) fail("MONITOR_TIME_INVALID", "Monitor time is invalid");
  if (!adapters || typeof adapters !== "object") fail("MONITOR_ADAPTER_INVALID", "Monitoring adapters are required");
  const local = config.local;
  const checkMs = local.timeouts.checkMs;
  const observedAt = now.toISOString();
  if (!dryRun && (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 512)) {
    return boundedReport({
      schemaVersion: 1,
      runId,
      observedAt,
      ok: false,
      checks: [failed("monitor-hmac", "MONITOR_HMAC_INVALID")],
      handoff: "failed",
      handoffCode: "MONITOR_HMAC_INVALID",
      exitCode: 3,
    });
  }

  const checks = [
    safeCheck("backup", "BACKUP_CHECK_FAILED", checkMs, async (signal) => {
      const status = await adapters.loadNewestBackupStatus(local.backupRoot, { signal });
      const freshness = backupFreshness(status, now, local.thresholds.backupFreshnessMinutes * 60_000);
      const ageMinutes = freshness.ageMs === undefined ? undefined : Math.floor(freshness.ageMs / 60_000);
      if (freshness.state === "missing") return failed("backup", "BACKUP_VERIFIED_PAIR_MISSING");
      if (freshness.state === "invalid") return failed("backup", "BACKUP_TIMESTAMP_INVALID");
      if (freshness.state === "stale") return failed("backup", "BACKUP_VERIFIED_PAIR_STALE", ageMinutes);
      return healthy("backup", ageMinutes);
    }),
    safeCheck("daily-backup", "BACKUP_CHECK_FAILED", checkMs, async (signal) => {
      const status = await adapters.loadNewestBackupStatus(local.backupRoot, { signal, kind: "daily" });
      const freshness = backupFreshness(status, now, local.thresholds.dailyBackupFreshnessHours * 3_600_000);
      const ageHours = freshness.ageMs === undefined ? undefined : Math.floor(freshness.ageMs / 3_600_000);
      if (freshness.state === "missing") return failed("daily-backup", "BACKUP_DAILY_PAIR_MISSING");
      if (freshness.state === "invalid") return failed("daily-backup", "BACKUP_TIMESTAMP_INVALID");
      if (freshness.state === "stale") return failed("daily-backup", "BACKUP_DAILY_PAIR_STALE", ageHours);
      return healthy("daily-backup", ageHours);
    }),
    safeCheck("disk", "DISK_CHECK_FAILED", checkMs, async (signal) => {
      const value = await adapters.diskFreePercent(local.diskPath, { signal });
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        return failed("disk", "DISK_RESULT_INVALID");
      }
      const rounded = Math.round(value * 10) / 10;
      return rounded < local.thresholds.diskFreePercentMinimum
        ? failed("disk", "DISK_FREE_BELOW_MINIMUM", rounded)
        : healthy("disk", rounded);
    }),
    ...local.requiredRunningLaunchdLabels.map((label) => safeCheck(
      `launchd.${label}`,
      "LAUNCHD_INSPECTION_FAILED",
      checkMs,
      async (signal) => await adapters.launchdRunning(label, { signal, timeoutMs: checkMs })
        ? healthy(`launchd.${label}`)
        : failed(`launchd.${label}`, "LAUNCHD_SERVICE_NOT_RUNNING"),
    )),
    safeCheck("control-ready", "CONTROL_READY_CHECK_FAILED", checkMs, async (signal) =>
      await adapters.controlReady(local.controlReadyUrl, { signal, timeoutMs: checkMs })
        ? healthy("control-ready")
        : failed("control-ready", "CONTROL_NOT_READY")),
    safeCheck("backlogs", "BACKLOG_CHECK_FAILED", checkMs, async (signal) => {
      const nowMs = now.valueOf();
      const values = await adapters.readBacklogs(local.databasePath, {
        signal,
        timeoutMs: checkMs,
        nowMs,
        staleBeforeMs: nowMs - local.thresholds.queueStallMinutes * 60_000,
        retentionOverdueBeforeMs: nowMs - local.thresholds.retentionOverdueGraceMinutes * 60_000,
      });
      const notification = boundedCount(values?.notificationFailures);
      const translation = boundedCount(values?.translationFailures);
      const publication = boundedCount(values?.publicationFailures);
      const indexNow = boundedCount(values?.indexNowFailures);
      const notificationStalled = boundedCount(values?.notificationStalled);
      const translationStalled = boundedCount(values?.translationStalled);
      const indexNowStalled = boundedCount(values?.indexNowStalled);
      const retentionOverdue = boundedCount(values?.retentionOverdue);
      if ([
        notification,
        translation,
        publication,
        indexNow,
        notificationStalled,
        translationStalled,
        indexNowStalled,
        retentionOverdue,
      ].includes(undefined)) return failed("backlogs", "BACKLOG_RESULT_INVALID");
      return [
        notification > local.thresholds.notificationFailureBacklogMaximum
          ? failed("notification-backlog", "NOTIFICATION_FAILURE_BACKLOG", notification)
          : healthy("notification-backlog", notification),
        translation > local.thresholds.translationFailureBacklogMaximum
          ? failed("translation-backlog", "TRANSLATION_FAILURE_BACKLOG", translation)
          : healthy("translation-backlog", translation),
        publication > local.thresholds.publicationFailureBacklogMaximum
          ? failed("publication-backlog", "PUBLICATION_FAILURE_BACKLOG", publication)
          : healthy("publication-backlog", publication),
        indexNow > local.thresholds.indexNowFailureBacklogMaximum
          ? failed("indexnow-backlog", "INDEXNOW_FAILURE_BACKLOG", indexNow)
          : healthy("indexnow-backlog", indexNow),
        notificationStalled > 0
          ? failed("notification-stalled", "NOTIFICATION_QUEUE_STALLED", notificationStalled)
          : healthy("notification-stalled", notificationStalled),
        translationStalled > 0
          ? failed("translation-stalled", "TRANSLATION_QUEUE_STALLED", translationStalled)
          : healthy("translation-stalled", translationStalled),
        indexNowStalled > 0
          ? failed("indexnow-stalled", "INDEXNOW_QUEUE_STALLED", indexNowStalled)
          : healthy("indexnow-stalled", indexNowStalled),
        retentionOverdue > local.thresholds.retentionOverdueMaximum
          ? failed("retention-overdue", "RETENTION_OVERDUE", retentionOverdue)
          : healthy("retention-overdue", retentionOverdue),
      ];
    }, {
      MONITOR_CHECK_TIMEOUT: "DB_TIMEOUT",
      MONITOR_DATABASE_TIMEOUT: "DB_TIMEOUT",
      MONITOR_DATABASE_PATH_CHANGED: "DB_PATH_CHANGED",
    }),
  ];

  const nested = await within(local.timeouts.overallMs, async () => Promise.all(checks));
  const results = nested.flat();
  const ok = results.every(({ state }) => state === "healthy");
  let handoff = ok ? "not-required" : dryRun ? "dry-run-suppressed" : "failed";
  let exitCode = ok ? 0 : 2;
  const base = { schemaVersion: 1, runId, observedAt, ok, checks: results };
  if (dryRun) return boundedReport({ ...base, handoff, exitCode });

  if (ok) {
    try {
      await adapters.clearIncidentState(local.incidentState.path);
    } catch {
      return operationalFailure(base, "INCIDENT_STATE_CLEAR_FAILED");
    }
    return boundedReport({ ...base, handoff, exitCode });
  }

  const fingerprint = incidentFingerprint(results);
  let prior;
  try {
    prior = await adapters.loadIncidentState(local.incidentState.path);
    if (!validIncidentState(prior)) throw new Error("Invalid incident state");
  } catch {
    return operationalFailure(base, "INCIDENT_STATE_READ_FAILED");
  }
  const lastSentAt = prior === undefined ? undefined : Date.parse(prior.lastSentAt);
  const withinCooldown = prior?.fingerprint === fingerprint && lastSentAt <= now.valueOf() &&
    now.valueOf() - lastSentAt < local.incidentState.cooldownMinutes * 60_000;
  if (withinCooldown) {
    return boundedReport({ ...base, handoff: "cooldown-suppressed", exitCode: 2 });
  }

  try {
    await adapters.deliverHermes({
      endpoint: local.hermes.endpoint,
      secret,
      payload: handoffPayload(base),
      deliveryId: runId,
      timestampMs: now.valueOf(),
      nonce,
      timeoutMs: local.timeouts.hermesRequestMs,
      maximumAttempts: local.hermes.maximumAttempts,
      retryDelayMs: local.hermes.retryDelayMs,
    });
    handoff = "delivered";
  } catch {
    return boundedReport({ ...base, handoff: "failed", handoffCode: "HERMES_HANDOFF_FAILED", exitCode: 3 });
  }
  try {
    await adapters.writeIncidentState(local.incidentState.path, {
      formatVersion: 1,
      fingerprint,
      lastSentAt: observedAt,
    });
  } catch {
    return operationalFailure(base, "INCIDENT_STATE_WRITE_FAILED");
  }
  return boundedReport({ ...base, handoff, exitCode });
}

function numericStat(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function createSystemMonitoringAdapters({
  execute = execFile,
  fetchImpl = globalThis.fetch,
  databaseHelper = DEFAULT_DATABASE_HELPER,
  nodeBinary = process.execPath,
  beforeDiskStat,
  userId = process.getuid?.(),
} = {}) {
  return {
    loadNewestBackupStatus,
    diskFreePercent: async (directory) => {
      if (beforeDiskStat !== undefined && typeof beforeDiskStat !== "function") {
        fail("MONITOR_INPUT_INVALID", "Disk operation hook is invalid");
      }
      return withSecureRealDirectory(directory, {
        code: "MONITOR_INPUT_INVALID",
        requireProtected: true,
      }, async ({ canonicalPath }) => {
        await beforeDiskStat?.();
        const value = await statfs(canonicalPath);
        const blocks = numericStat(value.blocks);
        const available = numericStat(value.bavail);
        if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available) || available < 0) {
          fail("MONITOR_DISK_INVALID", "Filesystem statistics are invalid");
        }
        return available / blocks * 100;
      });
    },
    launchdRunning: async (label, { timeoutMs }) => {
      if (!Number.isInteger(userId) || !LABEL.test(label)) fail("MONITOR_LAUNCHD_INVALID", "launchd target is invalid");
      try {
        const { stdout } = await execute("/bin/launchctl", ["print", `gui/${userId}/${label}`], {
          encoding: "utf8",
          maxBuffer: 128 * 1024,
          shell: false,
          timeout: timeoutMs,
          windowsHide: true,
        });
        return /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/u.test(stdout);
      } catch (error) {
        const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr ?? "");
        if (Buffer.byteLength(stderr, "utf8") <= 1_024 && /Could not find service "[A-Za-z0-9.-]+"/u.test(stderr)) return false;
        throw Object.assign(new Error("launchd inspection failed"), { code: "MONITOR_LAUNCHD_FAILED" });
      }
    },
    controlReady: async (value, { signal, timeoutMs }) => {
      const response = await fetchImpl(value, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      response.body?.cancel();
      return response.status === 200;
    },
    readBacklogs: async (databasePath, {
      signal,
      timeoutMs,
      nowMs = Date.now(),
      staleBeforeMs = nowMs - 15 * 60_000,
      retentionOverdueBeforeMs = nowMs,
    }) => {
      await assertSecureRealDirectory(path.dirname(databasePath), {
        code: "MONITOR_DATABASE_INVALID",
        requireProtected: true,
      });
      const { canonicalPath: canonical } = await assertSecureRegularFile(databasePath, {
        code: "MONITOR_DATABASE_INVALID",
        requireProtected: true,
      });
      if (!absolutePath(databaseHelper) || !absolutePath(nodeBinary)) {
        fail("MONITOR_DATABASE_INVALID", "Database aggregate helper inputs are invalid");
      }
      let output;
      try {
        if (
          !integer(nowMs, 0, Number.MAX_SAFE_INTEGER) || !integer(staleBeforeMs, 0, nowMs) ||
          !integer(retentionOverdueBeforeMs, 0, nowMs)
        ) {
          fail("MONITOR_DATABASE_QUERY_FAILED", "Database aggregate time bounds are invalid");
        }
        output = await execute(nodeBinary, [
          databaseHelper,
          "--database",
          canonical,
          "--now-ms",
          String(nowMs),
          "--stale-before-ms",
          String(staleBeforeMs),
          "--retention-overdue-before-ms",
          String(retentionOverdueBeforeMs),
        ], {
          encoding: "utf8",
          env: {
            LANG: "C",
            LC_ALL: "C",
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
            ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
            ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
          },
          killSignal: "SIGKILL",
          maxBuffer: 8 * 1024,
          shell: false,
          signal,
          timeout: Math.max(25, timeoutMs - 25),
          windowsHide: true,
        });
      } catch (error) {
        if (
          signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR" ||
          error?.code === "ETIMEDOUT" || error?.killed === true || error?.signal === "SIGKILL"
        ) fail("MONITOR_DATABASE_TIMEOUT", "Database aggregate check timed out");
        const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr ?? "");
        if (Number(error?.code) === 4 && stderr === "DB_PATH_CHANGED\n") {
          fail("MONITOR_DATABASE_PATH_CHANGED", "Database path identity changed");
        }
        fail("MONITOR_DATABASE_QUERY_FAILED", "Database aggregate check failed");
      }
      const stdout = typeof output?.stdout === "string" ? output.stdout : "";
      const stderr = typeof output?.stderr === "string" ? output.stderr : "";
      if (Buffer.byteLength(stdout, "utf8") > 4 * 1024 || stderr !== "" || !/^\{[^\r\n]+\}\n?$/u.test(stdout)) {
        fail("MONITOR_DATABASE_QUERY_FAILED", "Database aggregate result was invalid");
      }
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        fail("MONITOR_DATABASE_QUERY_FAILED", "Database aggregate result was invalid");
      }
      if (!exactKeys(result, [
        "indexNowFailures",
        "indexNowStalled",
        "notificationFailures",
        "notificationStalled",
        "publicationFailures",
        "retentionOverdue",
        "translationFailures",
        "translationStalled",
      ]) ||
        !Object.values(result).every((value) => boundedCount(value) !== undefined)) {
        fail("MONITOR_DATABASE_QUERY_FAILED", "Database aggregate result was invalid");
      }
      return result;
    },
    loadIncidentState: async (statePath) => loadProtectedIncidentState(statePath),
    writeIncidentState: async (statePath, value) => writeProtectedIncidentState(statePath, value),
    clearIncidentState: async (statePath) => clearProtectedIncidentState(statePath),
    deliverHermes: async ({
      endpoint,
      secret,
      payload,
      deliveryId,
      timestampMs,
      nonce,
      timeoutMs,
      maximumAttempts,
      retryDelayMs,
    }) => {
      const target = parsedUrl(endpoint, "MONITOR_HERMES_INVALID");
      if (!literalLoopback(target) || target.protocol !== "http:" || target.username || target.password || target.search || target.hash) {
        fail("MONITOR_HERMES_INVALID", "Hermes monitor endpoint must be literal loopback");
      }
      if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 512) {
        fail("MONITOR_HERMES_SECRET_INVALID", "Hermes monitor secret is invalid");
      }
      const body = JSON.stringify(payload);
      const timestamp = String(timestampMs);
      const nonceValue = nonce();
      if (!RUN_ID.test(deliveryId) || !RUN_ID.test(nonceValue)) fail("MONITOR_HERMES_INPUT_INVALID", "Hermes delivery metadata is invalid");
      const canonical = ["POST", target.pathname, timestamp, nonceValue, deliveryId, body].join("\n");
      const signature = createHmac("sha256", secret).update(canonical).digest("base64url");
      let lastError;
      for (let attempt = 0; attempt < maximumAttempts; attempt++) {
        try {
          const response = await fetchImpl(target.href, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              "content-type": "application/json",
              "x-wisdom-timestamp": timestamp,
              "x-wisdom-nonce": nonceValue,
              "x-wisdom-delivery-id": deliveryId,
              "x-wisdom-signature": signature,
            },
            body,
          });
          response.body?.cancel();
          if (response.ok) return;
          lastError = Object.assign(new Error("Hermes handoff rejected"), { code: "MONITOR_HERMES_REJECTED" });
        } catch {
          lastError = Object.assign(new Error("Hermes handoff failed"), { code: "MONITOR_HERMES_FAILED" });
        }
        if (attempt + 1 < maximumAttempts && retryDelayMs > 0) await delay(retryDelayMs);
      }
      throw lastError ?? Object.assign(new Error("Hermes handoff failed"), { code: "MONITOR_HERMES_FAILED" });
    },
  };
}
