import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { assertNoSymlinkPath } from "./safe-paths.mjs";

const launchdLabels = [
  "backup",
  "caddy",
  "cloudflared",
  "content-worker",
  "control",
  "monitor",
  "notification-worker",
  "retention",
];

const sharedTarget = (name) => (values) => path.join(values.APP_ROOT, "shared", name);
const launchdTarget = (label) => (values) => path.join(
  path.dirname(values.APP_ROOT),
  "Library",
  "LaunchAgents",
  `com.jihye.portal.${label}.plist`,
);

export const CONFIG_TEMPLATE_DESCRIPTORS = Object.freeze([
  { id: "runtime", source: "config/runtime.env.template", scope: "user", mode: 0o600, target: sharedTarget("runtime.env") },
  { id: "monitoring", source: "monitoring/checks.json.template", scope: "user", mode: 0o600, target: sharedTarget("monitoring.json") },
  { id: "caddy", source: "caddy/Caddyfile.template", scope: "user", mode: 0o600, target: sharedTarget("Caddyfile") },
  { id: "cloudflared", source: "cloudflared/config.yml.template", scope: "user", mode: 0o600, target: sharedTarget("cloudflared.yml") },
  ...launchdLabels.map((label) => Object.freeze({
    id: `launchd-${label}`,
    source: `launchd/com.jihye.portal.${label}.plist.template`,
    scope: "user",
    mode: 0o600,
    target: launchdTarget(label),
  })),
  {
    id: "newsyslog",
    source: "newsyslog/wisdom-portal.conf.template",
    scope: "system",
    mode: 0o644,
    target: () => "/etc/newsyslog.d/wisdom-portal.conf",
  },
].map(Object.freeze));

export const CONFIG_TOKEN_NAMES = Object.freeze([
  "ADMIN_DUMMY_PASSWORD_HASH",
  "ADMIN_HOST",
  "AGE_BINARY",
  "AGE_RECIPIENT",
  "APEX_HOST",
  "APP_ROOT",
  "BACKUP_ROOT",
  "BACKUP_TEMP_ROOT",
  "CADDY_ADMIN_PORT",
  "CADDY_BINARY",
  "CADDY_BIND",
  "CADDY_CONFIG",
  "CADDY_PORT",
  "CLOUDFLARED_BINARY",
  "CLOUDFLARED_CONFIG",
  "CLOUDFLARED_CREDENTIALS_FILE",
  "CODEX_BINARY",
  "CODEX_HOME",
  "CODEX_KEYCHAIN_SERVICE",
  "CODEX_MODEL",
  "CODEX_TEMP_ROOT",
  "CONTROL_HOST",
  "CONTROL_PORT",
  "CURRENT_RELEASE",
  "DATA_ROOT",
  "GIT_BINARY",
  "INDEXNOW_KEYCHAIN_SERVICE",
  "LOG_ROOT",
  "NODE_BINARY",
  "NPM_BINARY",
  "PUBLIC_CURRENT_RELEASE",
  "PUBLIC_HOST",
  "PUBLIC_RELEASE_ROOT",
  "TUNNEL_ID",
  "USER_NAME",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

const absolutePathNames = Object.freeze([
  "AGE_BINARY", "APP_ROOT", "BACKUP_ROOT", "BACKUP_TEMP_ROOT", "CADDY_BINARY", "CADDY_CONFIG",
  "CLOUDFLARED_BINARY", "CLOUDFLARED_CONFIG", "CLOUDFLARED_CREDENTIALS_FILE", "CODEX_BINARY",
  "CODEX_HOME", "CODEX_TEMP_ROOT", "CURRENT_RELEASE", "DATA_ROOT", "GIT_BINARY", "LOG_ROOT",
  "NODE_BINARY", "NPM_BINARY", "PUBLIC_CURRENT_RELEASE", "PUBLIC_RELEASE_ROOT",
]);

function normalizedPosixAbsolute(value) {
  return value.length <= 4_096 && path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
    !value.includes("//");
}

function validHostname(value) {
  return value.length <= 253 && value === value.toLowerCase() && !value.endsWith(".") &&
    value.split(".").length >= 2 && value.split(".").every((label) => (
      /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ));
}

function validPort(value) {
  return /^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u.test(value);
}

function sameOrNested(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateProductionValueContracts(values) {
  if (values.CONTROL_HOST !== "127.0.0.1" || values.CADDY_BIND !== "127.0.0.1") {
    fail("CONFIG_VALUES_INVALID", "Production listeners must be loopback only");
  }
  const hosts = [values.APEX_HOST, values.PUBLIC_HOST, values.ADMIN_HOST];
  if (!hosts.every(validHostname) || new Set(hosts).size !== hosts.length) {
    fail("CONFIG_VALUES_INVALID", "Production hosts are invalid");
  }
  const ports = [values.CONTROL_PORT, values.CADDY_PORT, values.CADDY_ADMIN_PORT];
  if (!ports.every(validPort) || new Set(ports).size !== ports.length) {
    fail("CONFIG_VALUES_INVALID", "Production ports are invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(values.TUNNEL_ID) ||
    !/^age1[a-z0-9]{20,100}$/u.test(values.AGE_RECIPIENT) ||
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(values.USER_NAME)) {
    fail("CONFIG_VALUES_INVALID", "Production identity reference is invalid");
  }
  if (!absolutePathNames.every((name) => normalizedPosixAbsolute(values[name]))) {
    fail("CONFIG_VALUES_INVALID", "Production paths must be canonical absolute POSIX paths");
  }

  const userHome = `/Users/${values.USER_NAME}`;
  const expectedAppRoot = `${userHome}/portal`;
  if (values.APP_ROOT !== expectedAppRoot ||
    values.CADDY_CONFIG !== `${expectedAppRoot}/shared/Caddyfile` ||
    values.CLOUDFLARED_CONFIG !== `${expectedAppRoot}/shared/cloudflared.yml` ||
    values.CURRENT_RELEASE !== `${expectedAppRoot}/current` ||
    values.PUBLIC_CURRENT_RELEASE !== `${expectedAppRoot}/public-current` ||
    values.PUBLIC_RELEASE_ROOT !== `${expectedAppRoot}/public-releases`) {
    fail("CONFIG_VALUES_INVALID", "Production layout does not match the canonical Mac layout");
  }

  const externalRoots = [
    values.DATA_ROOT,
    values.BACKUP_ROOT,
    values.BACKUP_TEMP_ROOT,
    values.LOG_ROOT,
    values.CODEX_HOME,
    values.CODEX_TEMP_ROOT,
  ];
  if (externalRoots.some((root) => sameOrNested(root, values.APP_ROOT))) {
    fail("CONFIG_VALUES_INVALID", "Mutable roots cannot overlap the application root");
  }
  for (let index = 0; index < externalRoots.length; index += 1) {
    for (let other = index + 1; other < externalRoots.length; other += 1) {
      if (sameOrNested(externalRoots[index], externalRoots[other])) {
        fail("CONFIG_VALUES_INVALID", "Mutable roots cannot overlap each other");
      }
    }
  }
}

export function parseProductionValues(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 64 * 1024 || source.includes("\0")) {
    fail("CONFIG_VALUES_INVALID", "Production values are invalid or too large");
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    fail("CONFIG_VALUES_INVALID", "Production values must be JSON");
  }
  if (!exactKeys(document, ["schemaVersion", "values"]) || document.schemaVersion !== 1 ||
    !exactKeys(document.values, CONFIG_TOKEN_NAMES)) {
    fail("CONFIG_VALUES_INVALID", "Production values shape is invalid");
  }
  for (const name of CONFIG_TOKEN_NAMES) {
    const value = document.values[name];
    if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
      fail("CONFIG_VALUES_INVALID", "Production value is invalid");
    }
  }
  validateProductionValueContracts(document.values);
  return Object.freeze({ ...document.values });
}

export async function readProductionValuesFile(filePath, { platform = process.platform } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    fail("CONFIG_INPUT_INVALID", "Production values path is invalid");
  }
  let handle;
  try {
    await assertNoSymlinkPath(filePath, "CONFIG_INPUT_INVALID");
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 ||
      (platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      fail("CONFIG_INPUT_INVALID", "Production values file is not protected");
    }
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const source = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 || Buffer.byteLength(source, "utf8") > 64 * 1024 ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      (platform !== "win32" && (after.mode & 0o077) !== 0)) {
      fail("CONFIG_INPUT_INVALID", "Production values file changed during inspection");
    }
    return parseProductionValues(source);
  } catch (error) {
    if (error?.code === "CONFIG_VALUES_INVALID" || error?.code === "CONFIG_INPUT_INVALID") throw error;
    fail("CONFIG_INPUT_INVALID", "Production values file is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
