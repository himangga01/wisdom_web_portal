#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as configInstaller from "../lib/config-installer.mjs";

const VALIDATOR_TIMEOUT_MS = 10_000;
const MAX_VALIDATOR_OUTPUT_BYTES = 4 * 1024;
const MAX_STAGED_SOURCE_BYTES = 64 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function inputInvalid() {
  fail("CONFIG_INPUT_INVALID", "Configuration installer arguments are invalid");
}

function validationFailed() {
  const error = new Error("Production configuration validation failed");
  error.code = "CONFIG_VALIDATION_FAILED";
  return error;
}

function canonicalPosixAbsolute(value) {
  return typeof value === "string" && path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value && !value.includes("//");
}

export function parseConfigInstallArguments(argv) {
  if (!Array.isArray(argv) || !argv.every((value) => typeof value === "string")) inputInvalid();

  const valueFlags = new Map([
    ["--values", "valuesPath"],
    ["--scope", "scope"],
    ["--confirm-app-root", "confirmAppRoot"],
    ["--confirm-user-home", "confirmUserHome"],
    ["--confirm-system-target", "confirmSystemTarget"],
  ]);
  const parsed = { apply: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      if (seen.has(flag)) inputInvalid();
      seen.add(flag);
      parsed.apply = true;
      continue;
    }
    const property = valueFlags.get(flag);
    if (!property || seen.has(flag)) inputInvalid();
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) inputInvalid();
    seen.add(flag);
    parsed[property] = value;
    index += 1;
  }

  if (!seen.has("--values") || !seen.has("--scope") ||
    !path.isAbsolute(parsed.valuesPath) || path.normalize(parsed.valuesPath) !== parsed.valuesPath ||
    !["user", "system"].includes(parsed.scope)) inputInvalid();

  const hasUserConfirmations = seen.has("--confirm-app-root") || seen.has("--confirm-user-home");
  const hasSystemConfirmation = seen.has("--confirm-system-target");
  if (!parsed.apply && (hasUserConfirmations || hasSystemConfirmation)) inputInvalid();

  if (parsed.apply && parsed.scope === "user") {
    if (!seen.has("--confirm-app-root") || !seen.has("--confirm-user-home") || hasSystemConfirmation ||
      !canonicalPosixAbsolute(parsed.confirmAppRoot) || !canonicalPosixAbsolute(parsed.confirmUserHome)) {
      inputInvalid();
    }
  }
  if (parsed.apply && parsed.scope === "system") {
    if (!hasSystemConfirmation || hasUserConfirmations ||
      !canonicalPosixAbsolute(parsed.confirmSystemTarget)) inputInvalid();
  }

  const result = {
    valuesPath: parsed.valuesPath,
    scope: parsed.scope,
    apply: parsed.apply,
    ...(parsed.confirmAppRoot ? { confirmAppRoot: parsed.confirmAppRoot } : {}),
    ...(parsed.confirmUserHome ? { confirmUserHome: parsed.confirmUserHome } : {}),
    ...(parsed.confirmSystemTarget ? { confirmSystemTarget: parsed.confirmSystemTarget } : {}),
  };
  return Object.freeze(result);
}

function validatorCommand(kind, stagedPath, values) {
  if (kind === "plist") return ["/usr/bin/plutil", ["-lint", stagedPath]];
  if (kind === "caddy" && canonicalPosixAbsolute(values?.CADDY_BINARY)) {
    return [values.CADDY_BINARY, ["validate", "--config", stagedPath, "--adapter", "caddyfile"]];
  }
  if (kind === "cloudflared" && canonicalPosixAbsolute(values?.CLOUDFLARED_BINARY)) {
    return [values.CLOUDFLARED_BINARY, ["--config", stagedPath, "tunnel", "ingress", "validate"]];
  }
  if (kind === "newsyslog") return ["/usr/sbin/newsyslog", ["-n", "-f", stagedPath]];
  throw validationFailed();
}

function stagedFilename(kind) {
  if (kind === "plist") return "artifact.plist";
  if (kind === "caddy") return "Caddyfile";
  if (kind === "cloudflared") return "config.yml";
  if (kind === "newsyslog") return "newsyslog.conf";
  throw validationFailed();
}

function runValidator(command, args, {
  spawnChild,
  scheduleTimer,
  cancelTimer,
  timeoutMs,
  cwd,
}) {
  let child;
  try {
    child = spawnChild(command, args, {
      cwd,
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return Promise.reject(validationFailed());
  }

  return new Promise((resolve, reject) => {
    if (!child?.stdout || !child?.stderr || typeof child.once !== "function" ||
      typeof child.kill !== "function") {
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // Preserve the sanitized validator failure.
      }
      reject(validationFailed());
      return;
    }

    let settled = false;
    let outputBytes = 0;
    let timeout;
    const cleanup = () => cancelTimer(timeout);
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      action(value);
    };
    const terminate = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Preserve the sanitized validator failure.
      }
      settle(reject, validationFailed());
    };
    const collect = (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_VALIDATOR_OUTPUT_BYTES) terminate();
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => settle(reject, validationFailed()));
    child.once("close", (code) => {
      if (code === 0) settle(resolve);
      else settle(reject, validationFailed());
    });
    timeout = scheduleTimer(terminate, timeoutMs);
    timeout?.unref?.();
  });
}

export function createMacConfigurationAdapters(values, {
  platform = process.platform,
  getuid = () => process.getuid?.(),
  spawnChild = spawn,
  temporaryRoot = os.tmpdir(),
  createTemporaryDirectory = mkdtemp,
  setMode = chmod,
  writeStagedFile = writeFile,
  removeTemporaryDirectory = rm,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
  timeoutMs = VALIDATOR_TIMEOUT_MS,
} = {}) {
  if (typeof spawnChild !== "function" || typeof createTemporaryDirectory !== "function" ||
    typeof setMode !== "function" || typeof writeStagedFile !== "function" ||
    typeof removeTemporaryDirectory !== "function" || typeof scheduleTimer !== "function" ||
    typeof cancelTimer !== "function" || timeoutMs !== VALIDATOR_TIMEOUT_MS ||
    typeof temporaryRoot !== "string" || !path.isAbsolute(temporaryRoot)) inputInvalid();

  return Object.freeze({
    platform,
    getuid,
    async validateExternal({ id, kind, source }) {
      if (!/^[a-z0-9-]{1,64}$/u.test(id) || !["plist", "caddy", "cloudflared", "newsyslog"].includes(kind) ||
        (typeof source !== "string" && !Buffer.isBuffer(source)) ||
        Buffer.byteLength(source) > MAX_STAGED_SOURCE_BYTES) throw validationFailed();

      let stagingDirectory;
      try {
        stagingDirectory = await createTemporaryDirectory(path.join(temporaryRoot, "wisdom-config-validate-"));
        await setMode(stagingDirectory, 0o700);
        const stagedPath = path.join(stagingDirectory, stagedFilename(kind));
        await writeStagedFile(stagedPath, source, { flag: "wx", mode: 0o600 });
        await setMode(stagedPath, 0o600);
        const [command, args] = validatorCommand(kind, stagedPath, values);
        await runValidator(command, args, {
          spawnChild,
          scheduleTimer,
          cancelTimer,
          timeoutMs,
          cwd: stagingDirectory,
        });
      } catch (error) {
        if (error?.code === "CONFIG_VALIDATION_FAILED") throw error;
        throw validationFailed();
      } finally {
        if (stagingDirectory !== undefined) {
          await removeTemporaryDirectory(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  });
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseConfigInstallArguments(argv);
  const readValues = dependencies.readProductionValuesFile ?? configInstaller.readProductionValuesFile;
  const install = dependencies.installConfiguration ?? configInstaller.installConfiguration;
  const createAdapters = dependencies.createMacConfigurationAdapters ?? createMacConfigurationAdapters;
  if (typeof readValues !== "function" || typeof install !== "function" || typeof createAdapters !== "function") {
    inputInvalid();
  }

  const values = await readValues(parsed.valuesPath, {
    platform: dependencies.platform ?? process.platform,
  });
  const adapters = createAdapters(values, dependencies);
  const result = await install({
    opsRoot: dependencies.opsRoot ?? path.resolve(import.meta.dirname, ".."),
    values,
    scope: parsed.scope,
    apply: parsed.apply,
    ...(parsed.confirmAppRoot ? { confirmAppRoot: parsed.confirmAppRoot } : {}),
    ...(parsed.confirmUserHome ? { confirmUserHome: parsed.confirmUserHome } : {}),
    ...(parsed.confirmSystemTarget ? { confirmSystemTarget: parsed.confirmSystemTarget } : {}),
  }, adapters);
  (dependencies.printJson ?? printJson)(result);
  return result;
}

const isExecuted = process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isExecuted) {
  main().catch((error) => {
    process.stderr.write(`Configuration install failed: ${error?.code ?? "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
