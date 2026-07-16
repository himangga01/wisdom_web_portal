import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function isKnownMissingService(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr ?? "");
  return /^Could not find service "[^"\r\n]+" in domain for user gui: \d+\s*$/u.test(stderr);
}

export function createMacServiceAdapter({
  labels = ["com.jihye.portal.control", "com.jihye.portal.notification-worker", "com.jihye.portal.content-worker"],
  userId = process.getuid?.(),
  execute = execFile,
  fetchImpl = globalThis.fetch,
  readyUrl = `http://127.0.0.1:${process.env.CONTROL_PORT ?? "8787"}/health/ready`,
} = {}) {
  if (!Number.isInteger(userId)) throw Object.assign(new Error("A macOS user id is required"), { code: "SERVICE_ADAPTER_UNAVAILABLE" });
  const domain = `gui/${userId}`;
  const assertRunning = async () => {
    for (const label of labels) {
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
  return {
    assertStopped: async () => {
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
    },
    assertRunning,
    stop: async () => {
      for (const label of labels) {
        try {
          await execute("/bin/launchctl", ["kill", "SIGTERM", `${domain}/${label}`]);
        } catch (error) {
          if (!isKnownMissingService(error)) {
            throw Object.assign(new Error(`Unable to stop ${label}`, { cause: error }), { code: "SERVICE_STOP_FAILED" });
          }
        }
      }
    },
    start: async () => {
      for (const label of labels) await execute("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`]);
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
