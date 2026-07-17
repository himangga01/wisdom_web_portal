#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runBackupDispatcher } from "../lib/backup-control.mjs";
import { printJson } from "../lib/cli-options.mjs";
import { parseKeychainExecArgs } from "../lib/keychain.mjs";
import { assertNormalizedAbsolutePath } from "../lib/monitor-files.mjs";
import { loadNewestBackupStatus } from "../lib/monitoring.mjs";
import { createSqliteAdapter } from "../lib/system-adapters.mjs";

export const BACKUP_CHILD_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const BACKUP_CHILD_TERMINATION_GRACE_MS = 5_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024;
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_SINGLE_ARG_BYTES = 4 * 1024;

function usage(message) {
  throw Object.assign(new Error(message), { code: "CLI_USAGE" });
}

function operationFailed() {
  return Object.assign(new Error("Automatic backup child failed"), {
    code: "BACKUP_OPERATION_FAILED",
  });
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARG_COUNT) usage("Dispatcher argv is invalid");
  let total = 0;
  for (const value of argv) {
    if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) usage("Dispatcher argv is invalid");
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_SINGLE_ARG_BYTES) usage("Dispatcher argv is invalid");
    total += bytes;
    if (total > MAX_ARG_BYTES) usage("Dispatcher argv is invalid");
  }
}

function absolute(candidate) {
  try {
    return assertNormalizedAbsolutePath(candidate, "CLI_USAGE");
  } catch {
    usage("Dispatcher paths must be normalized and absolute");
  }
}

function parseTopLevel(options) {
  const valueFlags = new Set(["--source", "--root", "--run-state"]);
  const values = new Map();
  let apply = false;
  for (let index = 0; index < options.length; index += 1) {
    const flag = options[index];
    if (flag === "--apply") {
      if (apply) usage("Duplicate --apply");
      apply = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) usage(`Unknown or duplicate option ${flag}`);
    const value = options[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of valueFlags) {
    if (!values.has(flag)) usage(`Missing ${flag}`);
  }
  const sourceDb = absolute(values.get("--source"));
  const backupRoot = absolute(values.get("--root"));
  const statePath = absolute(values.get("--run-state"));
  if (statePath !== path.join(path.dirname(sourceDb), "backup-run-state.json")) {
    usage("Run state must use the fixed database-directory path");
  }
  return { apply, sourceDb, backupRoot, statePath };
}

function parseBackupChildArgs(argv) {
  const valueFlags = new Set(["--source", "--root", "--temp-root", "--age", "--recipient"]);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--automatic" || flag === "--apply") {
      if (booleans.has(flag)) usage(`Duplicate ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) usage(`Unknown or duplicate backup option ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of valueFlags) {
    if (!values.has(flag)) usage(`Missing backup option ${flag}`);
  }
  if (!booleans.has("--automatic") || !booleans.has("--apply")) {
    usage("The fixed backup child requires --automatic --apply");
  }
  return {
    sourceDb: absolute(values.get("--source")),
    backupRoot: absolute(values.get("--root")),
    tempRoot: absolute(values.get("--temp-root")),
    ageExecutable: absolute(values.get("--age")),
    recipient: values.get("--recipient"),
  };
}

function parseFixedChild(parts, topLevel) {
  if (parts.length < 3) usage("A fixed Keychain child command is required");
  const command = absolute(parts[0]);
  const keychainScript = absolute(parts[1]);
  if (path.basename(keychainScript) !== "keychain-exec.mjs") usage("The first child must be keychain-exec.mjs");

  let keychain;
  try {
    keychain = parseKeychainExecArgs(parts.slice(2));
  } catch {
    usage("Keychain child argv is invalid");
  }
  absolute(keychain.configPath);
  if (
    keychain.mappings.length !== 1 ||
    keychain.mappings[0].environment !== "AGE_IDENTITY" ||
    keychain.mappings[0].service !== "com.jihye.portal.age-identity" ||
    absolute(keychain.command) !== command ||
    keychain.args.length < 1
  ) usage("Keychain child is not the fixed automatic backup command");

  const backupScript = absolute(keychain.args[0]);
  if (
    path.basename(backupScript) !== "backup.mjs" ||
    path.dirname(backupScript) !== path.dirname(keychainScript)
  ) usage("Backup child script is invalid");
  const backup = parseBackupChildArgs(keychain.args.slice(1));
  if (backup.sourceDb !== topLevel.sourceDb || backup.backupRoot !== topLevel.backupRoot) {
    usage("Backup child source and root must match the dispatcher check");
  }
  if (typeof backup.recipient !== "string" || !backup.recipient.startsWith("age1")) {
    usage("Backup recipient is invalid");
  }
  return { command, args: parts.slice(1) };
}

export function parseBackupDispatcherArgs(argv) {
  try {
    validateArgv(argv);
    const separator = argv.indexOf("--");
    if (separator < 0 || separator === argv.length - 1) usage("A child command is required after --");
    const topLevel = parseTopLevel(argv.slice(0, separator));
    const childParts = argv.slice(separator + 1);
    validateArgv(childParts);
    return {
      ...topLevel,
      child: parseFixedChild(childParts, topLevel),
    };
  } catch (error) {
    if (error?.code === "CLI_USAGE") throw error;
    usage("Dispatcher arguments are invalid");
  }
}

export function signalBackupProcessGroup(child, signal, {
  platform = process.platform,
  killProcess = process.kill,
} = {}) {
  if (platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the injected/runtime process has no group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

export function runBackupChild(childCommand, {
  spawnChild = spawn,
  signalSource = process,
  timeoutMs = BACKUP_CHILD_TIMEOUT_MS,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
  signalChild = signalBackupProcessGroup,
} = {}) {
  if (
    !childCommand || typeof childCommand.command !== "string" || !Array.isArray(childCommand.args) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 60 * 60 * 1000 ||
    typeof scheduleTimer !== "function" || typeof cancelTimer !== "function" ||
    typeof signalChild !== "function"
  ) return Promise.reject(operationFailed());

  let child;
  try {
    child = spawnChild(childCommand.command, childCommand.args, {
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return Promise.reject(operationFailed());
  }

  return new Promise((resolve, reject) => {
    if (!child?.stdout || !child?.stderr || typeof child.on !== "function") {
      try {
        signalChild(child ?? {}, "SIGTERM");
        signalChild(child ?? {}, "SIGKILL");
      } catch {
        // The invalid child cannot be observed further; preserve the sanitized failure.
      }
      reject(operationFailed());
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError;
    let settled = false;
    let killTimer;

    const cleanup = () => {
      cancelTimer(timeoutTimer);
      cancelTimer(killTimer);
      signalSource?.off?.("SIGINT", relaySignal);
      signalSource?.off?.("SIGTERM", relaySignal);
    };
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      action(value);
    };
    const sendSignal = (signal) => {
      try {
        signalChild(child, signal);
      } catch {
        // Escalation remains bounded even if signaling itself fails.
      }
    };
    const forceTerminate = () => {
      sendSignal("SIGKILL");
      settle(reject, pendingError ?? operationFailed());
    };
    const terminate = () => {
      sendSignal("SIGTERM");
      killTimer = scheduleTimer(forceTerminate, BACKUP_CHILD_TERMINATION_GRACE_MS);
    };
    const failAndTerminate = () => {
      if (settled || pendingError) return;
      pendingError = operationFailed();
      terminate();
    };
    const collect = (target, chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES || stderrBytes > MAX_CHILD_OUTPUT_BYTES) {
        failAndTerminate();
        return;
      }
      target.push(bytes);
    };
    const relaySignal = () => failAndTerminate();
    const timeoutTimer = scheduleTimer(failAndTerminate, timeoutMs);
    timeoutTimer.unref?.();
    signalSource?.on?.("SIGINT", relaySignal);
    signalSource?.on?.("SIGTERM", relaySignal);
    child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));
    child.once("error", failAndTerminate);
    child.once("close", (code) => {
      if (pendingError) {
        forceTerminate();
        return;
      }
      let decodedStdout;
      let decodedStderr;
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        decodedStdout = decoder.decode(Buffer.concat(stdout));
        decodedStderr = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
      } catch {
        settle(reject, operationFailed());
        return;
      }
      settle(resolve, {
        exitCode: Number.isInteger(code) ? code : 1,
        stdout: decodedStdout,
        stderr: decodedStderr,
      });
    });
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseBackupDispatcherArgs(argv);
  const writeJson = dependencies.printJson ?? printJson;
  if (!parsed.apply) {
    const plan = {
      dryRun: true,
      action: "dispatch-automatic-backup",
      intervalSeconds: 60,
      child: "keychain-exec",
    };
    writeJson(plan);
    return plan;
  }

  const sqlite = dependencies.sqlite ?? createSqliteAdapter();
  const dispatch = dependencies.runBackupDispatcher ?? runBackupDispatcher;
  const result = await dispatch({
    sourceDb: parsed.sourceDb,
    backupRoot: parsed.backupRoot,
    statePath: parsed.statePath,
    now: dependencies.now ?? new Date(),
  }, {
    readBackupControl: (databasePath) => sqlite.readBackupControl(databasePath),
    loadNewestBackupStatus: dependencies.loadNewestBackupStatus ?? loadNewestBackupStatus,
    runChild: () => runBackupChild(parsed.child, {
      spawnChild: dependencies.spawnChild ?? spawn,
      signalSource: dependencies.signalSource ?? process,
      timeoutMs: dependencies.timeoutMs ?? BACKUP_CHILD_TIMEOUT_MS,
    }),
    ...(dependencies.randomUUID ? { randomUUID: dependencies.randomUUID } : {}),
  });
  writeJson(result);
  return result;
}

const isExecuted = process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isExecuted) {
  main().catch((error) => {
    process.stderr.write(`Backup dispatcher failed: ${error?.code ?? "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
