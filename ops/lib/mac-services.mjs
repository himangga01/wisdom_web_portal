import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_LAUNCHCTL_MISSING_ERROR_BYTES = 1_024;
const LAUNCHCTL_MISSING_SERVICE = /^(?:Bad request\.(?:\r\n|\n))?Could not find service "[A-Za-z0-9.-]{1,255}" in domain for user gui: [0-9]{1,10}(?:(?:\r\n|\n))?$/u;

function isKnownMissingService(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr ?? "");
  return Buffer.byteLength(stderr, "utf8") <= MAX_LAUNCHCTL_MISSING_ERROR_BYTES &&
    LAUNCHCTL_MISSING_SERVICE.test(stderr);
}

export function createMacServiceAdapter({
  labels = [
    "com.jihye.portal.control",
    "com.jihye.portal.notification-worker",
    "com.jihye.portal.content-worker",
    "com.jihye.portal.retention",
  ],
  scheduledLabels = labels.includes("com.jihye.portal.retention")
    ? ["com.jihye.portal.retention"]
    : [],
  userId = process.getuid?.(),
  execute = execFile,
  fetchImpl = globalThis.fetch,
  readyUrl = "http://127.0.0.1:8787/health/ready",
  launchAgentRoot = path.join(os.homedir(), "Library", "LaunchAgents"),
  stopAttempts = 20,
  stopDelayMs = 250,
  delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
} = {}) {
  if (!Number.isInteger(userId)) throw Object.assign(new Error("A macOS user id is required"), { code: "SERVICE_ADAPTER_UNAVAILABLE" });
  if (
    !Array.isArray(labels) || labels.length === 0 ||
    labels.some((label) => typeof label !== "string" || !/^[A-Za-z0-9.-]+$/u.test(label)) ||
    !Array.isArray(scheduledLabels) ||
    scheduledLabels.some((label) => !labels.includes(label)) ||
    typeof launchAgentRoot !== "string" || !path.isAbsolute(launchAgentRoot) || /[\0\r\n]/u.test(launchAgentRoot)
  ) {
    throw Object.assign(new Error("Launch agent configuration is invalid"), { code: "SERVICE_ADAPTER_UNAVAILABLE" });
  }
  const readyMatch = typeof readyUrl === "string"
    ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/health\/ready$/u.exec(readyUrl)
    : null;
  if (!readyMatch || Number(readyMatch[1]) > 65_535) {
    throw Object.assign(new Error("Control readiness URL is invalid"), { code: "SERVICE_ADAPTER_UNAVAILABLE" });
  }
  if (!Number.isInteger(stopAttempts) || stopAttempts < 1 || !Number.isInteger(stopDelayMs) || stopDelayMs < 0) {
    throw Object.assign(new Error("Service stop bounds are invalid"), { code: "SERVICE_ADAPTER_UNAVAILABLE" });
  }
  const scheduled = new Set(scheduledLabels);
  const persistentLabels = labels.filter((label) => !scheduled.has(label));
  const domain = `gui/${userId}`;
  const assertRunning = async () => {
    for (const label of persistentLabels) {
      let stdout;
      try {
        ({ stdout } = await execute("/bin/launchctl", ["print", `${domain}/${label}`], { encoding: "utf8", maxBuffer: 128 * 1024 }));
      } catch (error) {
        if (isKnownMissingService(error)) {
          throw Object.assign(new Error(`${label} is not loaded`), { code: "SERVICE_NOT_RUNNING" });
        }
        throw Object.assign(new Error(`Unable to inspect ${label}`, { cause: error }), { code: "SERVICE_INSPECTION_FAILED" });
      }
      if (!/\bstate\s*=\s*running\b/u.test(stdout)) {
        throw Object.assign(new Error(`${label} did not remain running`), { code: "SERVICE_NOT_RUNNING" });
      }
    }
  };
  const assertStopped = async () => {
    for (const label of labels) {
      try {
        const { stdout } = await execute("/bin/launchctl", ["print", `${domain}/${label}`], { encoding: "utf8", maxBuffer: 128 * 1024 });
        if (/\bstate\s*=\s*running\b/u.test(stdout)) {
          throw Object.assign(new Error(`${label} is running`), { code: "SERVICES_RUNNING" });
        }
      } catch (error) {
        if (error.code === "SERVICES_RUNNING") throw error;
        if (!isKnownMissingService(error)) {
          throw Object.assign(new Error(`Unable to inspect ${label}`, { cause: error }), { code: "SERVICE_INSPECTION_FAILED" });
        }
      }
    }
  };
  const assertUnloaded = async () => {
    for (const label of labels) {
      try {
        await execute("/bin/launchctl", ["print", `${domain}/${label}`], { encoding: "utf8", maxBuffer: 128 * 1024 });
        throw Object.assign(new Error(`${label} remains loaded`), { code: "SERVICE_STILL_LOADED" });
      } catch (error) {
        if (error.code === "SERVICE_STILL_LOADED") throw error;
        if (!isKnownMissingService(error)) {
          throw Object.assign(new Error(`Unable to prove ${label} is unloaded`, { cause: error }), {
            code: "SERVICE_INSPECTION_FAILED",
          });
        }
      }
    }
  };
  return {
    assertStopped,
    assertUnloaded,
    assertRunning,
    stop: async () => {
      for (const label of labels) {
        const service = `${domain}/${label}`;
        try {
          await execute("/bin/launchctl", ["print", service], { encoding: "utf8", maxBuffer: 128 * 1024 });
        } catch (error) {
          if (isKnownMissingService(error)) continue;
          throw Object.assign(new Error(`Unable to inspect ${label}`, { cause: error }), { code: "SERVICE_INSPECTION_FAILED" });
        }
        try {
          await execute("/bin/launchctl", ["bootout", service]);
        } catch (error) {
          if (!isKnownMissingService(error)) {
            throw Object.assign(new Error(`Unable to stop ${label}`, { cause: error }), { code: "SERVICE_STOP_FAILED" });
          }
        }
      }
      let lastError;
      for (let attempt = 0; attempt < stopAttempts; attempt++) {
        try {
          await assertStopped();
          return;
        } catch (error) {
          if (error.code !== "SERVICES_RUNNING") throw error;
          lastError = error;
        }
        if (attempt + 1 < stopAttempts) await delay(stopDelayMs);
      }
      throw Object.assign(new Error("Services did not stop within the bounded wait", { cause: lastError }), {
        code: "SERVICE_STOP_TIMEOUT",
      });
    },
    start: async () => {
      for (const label of labels) {
        const service = `${domain}/${label}`;
        let loaded = true;
        try {
          await execute("/bin/launchctl", ["print", service], { encoding: "utf8", maxBuffer: 128 * 1024 });
        } catch (error) {
          if (isKnownMissingService(error)) loaded = false;
          else throw Object.assign(new Error(`Unable to inspect ${label}`, { cause: error }), { code: "SERVICE_INSPECTION_FAILED" });
        }
        try {
          if (!loaded) {
            await execute("/bin/launchctl", ["bootstrap", domain, path.join(launchAgentRoot, `${label}.plist`)]);
          }
          if (!scheduled.has(label)) {
            await execute("/bin/launchctl", ["kickstart", "-k", service]);
          }
        } catch (error) {
          throw Object.assign(new Error(`Unable to start ${label}`, { cause: error }), { code: "SERVICE_START_FAILED" });
        }
      }
    },
    checkReady: async () => {
      await assertRunning();
      let lastError;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const response = await fetchImpl(readyUrl, { signal: AbortSignal.timeout(2_000), redirect: "error" });
          if (response.status === 200) return;
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw Object.assign(new Error("Control readiness did not recover", { cause: lastError }), { code: "CONTROL_NOT_READY" });
    },
  };
}
