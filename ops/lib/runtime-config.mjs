import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { loadKeychainEnvironment } from "./keychain.mjs";

const RUNTIME_KEYS = new Set([
  "ADMIN_DUMMY_PASSWORD_HASH",
  "ADMIN_ORIGIN",
  "ANALYTICS_DATABASE_PATH",
  "CODEX_BINARY",
  "CODEX_HOME",
  "CODEX_KEYCHAIN_SERVICE",
  "CODEX_MODEL",
  "CODEX_TEMP_ROOT",
  "CODEX_TIMEOUT_MS",
  "CONTROL_HOST",
  "CONTROL_PORT",
  "DATABASE_PATH",
  "EMAIL_PAYLOAD_MODE",
  "HERMES_ENDPOINT",
  "GIT_BINARY",
  "INDEXNOW_KEYCHAIN_SERVICE",
  "INDEXNOW_KEY_LOCATION",
  "INDEXNOW_TIMEOUT_MS",
  "NODE_BINARY",
  "NODE_ENV",
  "NAVER_SITE_VERIFICATION_FILE",
  "NAVER_SITE_VERIFICATION_META",
  "NPM_BINARY",
  "PII_ACTIVE_KEY_ID",
  "PUBLIC_CURRENT_LINK",
  "PUBLIC_ORIGIN",
  "PUBLIC_RELEASE_ROOT",
  "PUBLICATION_BUILD_TIMEOUT_MS",
  "SITE_SOURCE_ROOT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);
const HOST_ENVIRONMENT_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function parseRuntimeConfig(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 64 * 1024 || source.includes("\0")) {
    fail("RUNTIME_CONFIG_REJECTED", "Runtime config is invalid or too large");
  }
  const result = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = equals > 0 ? line.slice(0, equals) : "";
    const value = equals > 0 ? line.slice(equals + 1) : "";
    if (!RUNTIME_KEYS.has(key) || value.length === 0 || Object.hasOwn(result, key)) {
      fail("RUNTIME_CONFIG_REJECTED", "Runtime config contains an unknown, duplicate, or empty entry");
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      fail("RUNTIME_CONFIG_REJECTED", "Runtime config contains a control character");
    }
    result[key] = value;
  }
  return result;
}

export async function loadRuntimeConfigFile(configPath) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    fail("RUNTIME_CONFIG_PATH_INVALID", "Runtime config path must be absolute");
  }
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("RUNTIME_CONFIG_PATH_INVALID", "Runtime config must be a regular non-symlink file");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) {
    fail("RUNTIME_CONFIG_PATH_INVALID", "Runtime config cannot be group/world writable");
  }
  return parseRuntimeConfig(await readFile(configPath, "utf8"));
}

function allowedHostEnvironment(source) {
  return Object.fromEntries(HOST_ENVIRONMENT_KEYS.flatMap((key) => (
    typeof source[key] === "string" && source[key].length > 0 ? [[key, source[key]]] : []
  )));
}

export async function launchKeychainCommand({
  parsed,
  hostEnvironment,
  runtimeConfig,
  keychainAdapter,
  spawnChild,
  signalSource,
}) {
  const environment = await loadKeychainEnvironment({
    account: parsed.account,
    mappings: parsed.mappings,
    adapter: keychainAdapter,
    baseEnvironment: {
      ...allowedHostEnvironment(hostEnvironment),
      WISDOM_KEYCHAIN_EXEC: "1",
      ...runtimeConfig,
    },
  });

  const child = spawnChild(parsed.command, parsed.args, {
    env: environment,
    shell: false,
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    let stopping = false;
    const relay = (signal) => {
      if (stopping) return;
      stopping = true;
      child.kill(signal);
    };
    const onTerm = () => relay("SIGTERM");
    const onInterrupt = () => relay("SIGINT");
    const cleanup = () => {
      signalSource.off("SIGTERM", onTerm);
      signalSource.off("SIGINT", onInterrupt);
    };
    signalSource.on("SIGTERM", onTerm);
    signalSource.on("SIGINT", onInterrupt);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal && !stopping) {
        const error = new Error(`Child exited from ${signal}`);
        error.code = "CHILD_SIGNAL_EXIT";
        reject(error);
      } else {
        resolve(code ?? (stopping ? 0 : 1));
      }
    });
  });
}
