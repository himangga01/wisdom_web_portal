import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createMacServiceAdapter } from "./mac-services.mjs";
import { acquireReleaseOperationLock } from "./release-operation-lock.mjs";
import {
  atomicSwitchRelease,
  copyReleaseSource,
  createReleaseManifest,
  pruneRetainedReleases,
  readCurrentRelease,
  removeReleasePointer,
  removeIncompleteRelease,
  validateReleaseFilesystem,
  verifyReleaseManifest,
} from "./release-system.mjs";

const SECRET_MAPPINGS = [
  "ADMIN_SESSION_SECRET=com.jihye.portal.admin-session",
  "CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac",
  "HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac",
  "PII_ENCRYPTION_KEY=com.jihye.portal.pii-key",
  "WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token",
];
const DEFAULT_OPS_ROOT = path.resolve(import.meta.dirname, "..");
const execFile = promisify(execFileCallback);

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, shell: false, stdio: options.stdio ?? "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(Object.assign(new Error("Command failed"), { code: "RELEASE_COMMAND_FAILED", exitCode: code, signal })));
  });
}

function preflightReportInvalid() {
  throw Object.assign(new Error("Mac release preflight report is invalid"), {
    code: "RELEASE_PREFLIGHT_REPORT_INVALID",
  });
}

export function parseMacPreflightReport(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 128 * 1024) preflightReportInvalid();
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    preflightReportInvalid();
  }
  if (
    !report || typeof report !== "object" || Array.isArray(report) || report.ok !== true ||
    report.monitoringConfigValidated !== true
  ) {
    preflightReportInvalid();
  }
  const publicSite = report.publicSite;
  if (!publicSite || typeof publicSite !== "object" || publicSite.manifestVerified !== true || publicSite.indexVerified !== true) {
    preflightReportInvalid();
  }
  if (publicSite.format === "ops-bootstrap") {
    if (report.tunnelReady !== false || report.tunnelDisabledVerified !== true) preflightReportInvalid();
  } else if (publicSite.format === "wisdom") {
    if (
      report.tunnelReady !== true || publicSite.consentBundleVerified !== true ||
      typeof publicSite.consentBundleId !== "string" || publicSite.consentBundleId.trim().length === 0
    ) preflightReportInvalid();
  } else preflightReportInvalid();
  return report;
}

async function runMacPreflight(executable, args) {
  let stdout;
  try {
    ({ stdout } = await execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: 128 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw Object.assign(new Error("Mac release preflight command failed", { cause: error }), {
      code: "RELEASE_COMMAND_FAILED",
    });
  }
  return parseMacPreflightReport(stdout);
}

export function resolveMacReleaseScripts({ opsRoot = DEFAULT_OPS_ROOT, destination }) {
  if (!path.isAbsolute(opsRoot) || !path.isAbsolute(destination)) {
    throw Object.assign(new Error("Absolute ops and release paths are required"), { code: "RELEASE_PATH_UNSAFE" });
  }
  return {
    preflight: path.join(opsRoot, "scripts", "preflight.mjs"),
    keychainExec: path.join(destination, "ops", "scripts", "keychain-exec.mjs"),
  };
}

export function buildMacPreflightArguments(options) {
  const opsRoot = options.opsRoot ?? DEFAULT_OPS_ROOT;
  if (!path.isAbsolute(opsRoot) || !path.isAbsolute(options.monitoringConfig ?? "")) {
    throw Object.assign(new Error("opsRoot and monitoring config must be absolute"), { code: "RELEASE_PATH_UNSAFE" });
  }
  return [
    path.join(opsRoot, "scripts", "preflight.mjs"),
    "--release-root", options.releaseRoot,
    "--current", options.currentLink,
    "--data-root", options.dataRoot,
    "--caddy", options.caddyBinary,
    "--cloudflared", options.cloudflaredBinary,
    "--age", options.ageBinary,
    "--public-release-root", options.publicReleaseRoot,
    "--public-current", options.publicCurrentLink,
    "--monitor-config", options.monitoringConfig,
    "--allow-bootstrap-local-staging",
  ];
}

function keychainArguments(options, destination, configPath, command, args) {
  return [
    resolveMacReleaseScripts({ opsRoot: options.opsRoot, destination }).keychainExec,
    "--account", options.keychainAccount,
    "--config", configPath,
    ...SECRET_MAPPINGS.flatMap((mapping) => ["--secret", mapping]),
    "--", command, ...args,
  ];
}

export function buildMacMigrationArguments(options, destination) {
  const opsRoot = options.opsRoot ?? DEFAULT_OPS_ROOT;
  return keychainArguments(
    { ...options, opsRoot },
    destination,
    options.runtimeConfig,
    options.npmBinary,
    [
      "run",
      "db:migrate",
      "--workspace",
      "@wisdom/control",
      "--",
      "--require-rollback-compatible",
    ],
  );
}

export function buildMacRuntimePruneArguments() {
  return [
    "prune",
    "--omit=dev",
    "--workspaces",
    "--include-workspace-root",
    "--ignore-scripts",
    "--audit=false",
    "--fund=false",
  ];
}

export async function stopCanaryProcess(child, { graceMs = 5_000, killWaitMs = 2_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!Number.isInteger(graceMs) || graceMs < 1 || !Number.isInteger(killWaitMs) || killWaitMs < 1) {
    throw Object.assign(new Error("Canary shutdown bounds are invalid"), { code: "CANARY_STOP_INVALID" });
  }
  await new Promise((resolve, reject) => {
    let forceTimer;
    let failureTimer;
    let settled = false;
    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      child.off?.("exit", onExit);
      child.off?.("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onExit = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    child.once("exit", onExit);
    child.once("error", onError);
    forceTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      if (settled) return;
      failureTimer = setTimeout(() => finish(
        reject,
        Object.assign(new Error("Canary did not exit after SIGKILL"), { code: "CANARY_STOP_TIMEOUT" }),
      ), killWaitMs);
      failureTimer.unref?.();
    }, graceMs);
    forceTimer.unref?.();
    child.kill("SIGTERM");
  });
}

async function checkUrl(url, expectedText) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) {
        if (expectedText === undefined || (await response.text()).includes(expectedText)) return;
        lastError = Object.assign(new Error("Health response body mismatch"), { code: "RELEASE_HEALTH_BODY_MISMATCH" });
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Object.assign(new Error("Health check failed", { cause: lastError }), { code: "RELEASE_HEALTH_FAILED" });
}

export function createMacReleaseAdapter(options) {
  const serviceAdapter = createMacServiceAdapter();
  const opsRoot = options.opsRoot ?? DEFAULT_OPS_ROOT;
  if (!path.isAbsolute(opsRoot)) throw Object.assign(new Error("opsRoot must be absolute"), { code: "RELEASE_PATH_UNSAFE" });
  return {
    acquireOperationLock: acquireReleaseOperationLock,
    validatePaths: (input) => validateReleaseFilesystem(input),
    exists: async (candidate) => {
      try { await realpath(candidate); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    preflight: async () => runMacPreflight(
      options.nodeBinary,
      buildMacPreflightArguments({ ...options, opsRoot }),
    ),
    copySource: copyReleaseSource,
    installDependencies: (destination) => run(options.npmBinary, ["ci"], { cwd: destination }),
    build: (destination) => run(options.npmBinary, ["run", "build"], { cwd: destination }),
    migrate: (destination) => run(
      options.nodeBinary,
      buildMacMigrationArguments({ ...options, opsRoot }, destination),
      { cwd: destination },
    ),
    prepareRuntime: (destination) => run(options.npmBinary, buildMacRuntimePruneArguments(), { cwd: destination }),
    writeManifest: (destination, { releaseId }) => createReleaseManifest(destination, releaseId),
    verify: (destination, { releaseId }) => verifyReleaseManifest(destination, releaseId),
    startCanary: async (destination, port) => {
      const runtime = await readFile(options.runtimeConfig, "utf8");
      if (!/^CONTROL_PORT=\d+$/mu.test(runtime)) throw Object.assign(new Error("CONTROL_PORT missing"), { code: "CANARY_CONFIG_INVALID" });
      const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "wisdom-canary-"));
      const configPath = path.join(tempDirectory, "runtime.env");
      await writeFile(configPath, runtime.replace(/^CONTROL_PORT=\d+$/mu, `CONTROL_PORT=${port}`), { mode: 0o600, flag: "wx" });
      const child = spawn(options.nodeBinary, keychainArguments(
        { ...options, opsRoot },
        destination,
        configPath,
        options.nodeBinary,
        [path.join(destination, "apps", "control", "dist", "server.js")],
      ), { cwd: destination, shell: false, stdio: "inherit" });
      return { child, tempDirectory };
    },
    checkHealth: async (origin) => {
      await checkUrl(`${origin}/health/live`);
      await checkUrl(`${origin}/health/ready`);
    },
    stopCanary: async ({ child, tempDirectory }) => {
      try {
        await stopCanaryProcess(child);
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
    readCurrent: (currentLink) => readCurrentRelease(options.releaseRoot, currentLink),
    switchCurrent: async (destination, currentLink) => {
      await verifyReleaseManifest(destination, path.basename(destination));
      await atomicSwitchRelease(destination, currentLink);
    },
    restartServices: serviceAdapter.start,
    checkActiveHealth: async () => {
      await serviceAdapter.checkReady();
      await checkUrl(options.publicLiveUrl, '"status":"ok"');
    },
    restoreCurrent: async (previous, currentLink) => {
      if (previous) {
        await verifyReleaseManifest(previous, path.basename(previous));
        await atomicSwitchRelease(previous, currentLink);
      }
      else await removeReleasePointer(currentLink);
    },
    prune: pruneRetainedReleases,
    removeIncomplete: (destination) => removeIncompleteRelease(options.releaseRoot, destination, options.currentLink),
  };
}
