import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_MACHINE_REPORT_BYTES = 16 * 1024;
const LABEL = /^[A-Za-z0-9.-]{1,255}$/u;
const MONITOR_KEYCHAIN_SERVICE = "com.jihye.portal.monitor-hermes-hmac";
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
      "requiredRunningLaunchdLabels", "thresholds", "timeouts",
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
    "backupFreshnessMinutes", "diskFreePercentMinimum", "indexNowFailureBacklogMaximum",
    "notificationFailureBacklogMaximum", "publicationFailureBacklogMaximum",
  ]) ||
    !integer(thresholds.backupFreshnessMinutes, 1, 1_440) ||
    !integer(thresholds.diskFreePercentMinimum, 1, 99) ||
    !integer(thresholds.notificationFailureBacklogMaximum, 0, 1_000_000) ||
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
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch {
    fail("MONITOR_CONFIG_PATH_INVALID", "Monitoring config is unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.platform !== "win32" && (metadata.mode & 0o022) !== 0)) {
    fail("MONITOR_CONFIG_PATH_INVALID", "Monitoring config must be a protected regular file");
  }
  return parseMonitoringConfig(await readFile(configPath, { encoding: "utf8", signal: AbortSignal.timeout(3_000) }));
}

async function hashFile(filePath, signal) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function loadNewestBackupStatus(backupRoot, { signal, maxArtifactBytes = MAX_BACKUP_BYTES } = {}) {
  if (!absolutePath(backupRoot)) fail("MONITOR_INPUT_INVALID", "Backup root must be absolute");
  const root = await lstat(backupRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("MONITOR_INPUT_INVALID", "Backup root must be a real directory");
  const names = (await readdir(backupRoot))
    .filter((name) => /^hourly-\d{8}T\d{6}Z\.json$/u.test(name))
    .toSorted((left, right) => right.localeCompare(left))
    .slice(0, 48);
  for (const name of names) {
    try {
      const statusPath = path.join(backupRoot, name);
      const statusMetadata = await lstat(statusPath);
      if (!statusMetadata.isFile() || statusMetadata.isSymbolicLink() || statusMetadata.size > MAX_STATUS_BYTES) continue;
      const value = JSON.parse(await readFile(statusPath, { encoding: "utf8", signal }));
      const createdAtMs = Date.parse(value.createdAt);
      const timestamp = Number.isFinite(createdAtMs)
        ? new Date(createdAtMs).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")
        : "";
      const artifactPath = path.join(backupRoot, name.replace(/\.json$/u, ".age"));
      const artifact = await lstat(artifactPath);
      if (!artifact.isFile() || artifact.isSymbolicLink() || artifact.size > maxArtifactBytes) continue;
      const hash = await hashFile(artifactPath, signal);
      if (
        value.verified === true && value.integrity === "ok" && value.kind === "hourly" &&
        name === `hourly-${timestamp}.json` &&
        /^[a-f0-9]{64}$/u.test(value.encryptedSha256 ?? "") &&
        value.encryptedBytes === artifact.size && value.encryptedSha256 === hash
      ) return value;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A malformed or incomplete pair is not a verified successful backup.
    }
  }
  return undefined;
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

async function safeCheck(id, code, timeoutMs, operation) {
  try {
    return await within(timeoutMs, operation);
  } catch {
    return failed(id, code);
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
      const values = await adapters.readBacklogs(local.databasePath, { signal, timeoutMs: checkMs });
      const notification = boundedCount(values?.notificationFailures);
      const publication = boundedCount(values?.publicationFailures);
      const indexNow = boundedCount(values?.indexNowFailures);
      if ([notification, publication, indexNow].includes(undefined)) return failed("backlogs", "BACKLOG_RESULT_INVALID");
      return [
        notification > local.thresholds.notificationFailureBacklogMaximum
          ? failed("notification-backlog", "NOTIFICATION_FAILURE_BACKLOG", notification)
          : healthy("notification-backlog", notification),
        publication > local.thresholds.publicationFailureBacklogMaximum
          ? failed("publication-backlog", "PUBLICATION_FAILURE_BACKLOG", publication)
          : healthy("publication-backlog", publication),
        indexNow > local.thresholds.indexNowFailureBacklogMaximum
          ? failed("indexnow-backlog", "INDEXNOW_FAILURE_BACKLOG", indexNow)
          : healthy("indexnow-backlog", indexNow),
      ];
    }),
  ];

  const nested = await within(local.timeouts.overallMs, async () => Promise.all(checks));
  const results = nested.flat();
  const observedAt = now.toISOString();
  const ok = results.every(({ state }) => state === "healthy");
  let handoff = ok ? "not-required" : dryRun ? "dry-run-suppressed" : "failed";
  let exitCode = ok ? 0 : 2;
  const base = { schemaVersion: 1, runId, observedAt, ok, checks: results };
  if (!ok && !dryRun) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
      handoff = "failed";
      exitCode = 3;
    } else {
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
        handoff = "failed";
        exitCode = 3;
      }
    }
  }
  const report = { ...base, handoff, ...(handoff === "failed" ? { handoffCode: "HERMES_HANDOFF_FAILED" } : {}), exitCode };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_MACHINE_REPORT_BYTES) {
    fail("MONITOR_REPORT_TOO_LARGE", "Monitoring report exceeded its fixed bound");
  }
  return report;
}

function numericStat(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

async function realDirectory(directory) {
  if (!absolutePath(directory)) fail("MONITOR_INPUT_INVALID", "Monitoring directory path is invalid");
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("MONITOR_INPUT_INVALID", "Monitoring directory must be real");
  return realpath(directory);
}

function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function createSystemMonitoringAdapters({
  execute = execFile,
  fetchImpl = globalThis.fetch,
  loadDatabase = async () => (await import("better-sqlite3")).default,
  userId = process.getuid?.(),
} = {}) {
  return {
    loadNewestBackupStatus,
    diskFreePercent: async (directory) => {
      const canonical = await realDirectory(directory);
      const value = await statfs(canonical);
      const blocks = numericStat(value.blocks);
      const available = numericStat(value.bavail);
      if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available) || available < 0) {
        fail("MONITOR_DISK_INVALID", "Filesystem statistics are invalid");
      }
      return available / blocks * 100;
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
    readBacklogs: async (databasePath) => {
      if (!absolutePath(databasePath)) fail("MONITOR_DATABASE_INVALID", "Database path is invalid");
      const metadata = await lstat(databasePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail("MONITOR_DATABASE_INVALID", "Database must be a real file");
      const Database = await loadDatabase();
      const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
      try {
        database.pragma("query_only = ON");
        const count = (sql) => Number(database.prepare(sql).get().count);
        const notificationFailures = count("SELECT count(*) count FROM notification_outbox WHERE state = 'failed'");
        const indexNowFailures = count("SELECT count(*) count FROM publication_outbox WHERE state = 'failed'");
        const publicationFailures = count(`
          SELECT
            (SELECT count(*) FROM release_activations WHERE state IN ('prepared','switched')) +
            (SELECT count(*) FROM releases
              WHERE state = 'failed'
                AND created_at_ms >= COALESCE(
                  (SELECT max(created_at_ms) FROM releases WHERE state = 'active'), 0
                )) AS count
        `);
        return { notificationFailures, publicationFailures, indexNowFailures };
      } finally {
        database.close();
      }
    },
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
      if (!(secret instanceof Uint8Array) || secret.byteLength < 32) fail("MONITOR_HERMES_SECRET_INVALID", "Hermes monitor secret is invalid");
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
