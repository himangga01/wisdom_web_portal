import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { parseMonitoringConfig } from "./monitoring.mjs";
import { parseRuntimeConfig } from "./runtime-config.mjs";
import { assertNoSymlinkPath } from "./safe-paths.mjs";
import { renderTemplate } from "./templates.mjs";

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

const sharedTarget = (name) => (values) => path.posix.join(values.APP_ROOT, "shared", name);
const launchdTarget = (label) => (values) => path.posix.join(
  path.posix.dirname(values.APP_ROOT),
  "Library",
  "LaunchAgents",
  `com.jihye.portal.${label}.plist`,
);

export const CONFIG_TEMPLATE_DESCRIPTORS = Object.freeze([
  { id: "runtime", source: "config/runtime.env.template", scope: "user", mode: 0o600, validator: "runtime", target: sharedTarget("runtime.env") },
  { id: "monitoring", source: "monitoring/checks.json.template", scope: "user", mode: 0o600, validator: "monitoring", target: sharedTarget("monitoring.json") },
  { id: "caddy", source: "caddy/Caddyfile.template", scope: "user", mode: 0o600, validator: "caddy", target: sharedTarget("Caddyfile") },
  { id: "cloudflared", source: "cloudflared/config.yml.template", scope: "user", mode: 0o600, validator: "cloudflared", target: sharedTarget("cloudflared.yml") },
  ...launchdLabels.map((label) => Object.freeze({
    id: `launchd-${label}`,
    source: `launchd/com.jihye.portal.${label}.plist.template`,
    scope: "user",
    mode: 0o600,
    validator: "plist",
    target: launchdTarget(label),
  })),
  {
    id: "newsyslog",
    source: "newsyslog/wisdom-portal.conf.template",
    scope: "system",
    mode: 0o644,
    validator: "newsyslog",
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
  return value.length <= 4_096 && value !== "/" && !value.endsWith("/") &&
    path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.includes("//");
}

function validHostname(value) {
  return value.length <= 253 && isIP(value) === 0 && value === value.toLowerCase() && !value.endsWith(".") &&
    value.split(".").length >= 2 && value.split(".").every((label) => (
      /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    ));
}

function validPort(value) {
  return /^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u.test(value);
}

function sameOrNested(left, right) {
  const leftToRight = path.posix.relative(left, right);
  const rightToLeft = path.posix.relative(right, left);
  const nested = (relative) => relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
  return nested(leftToRight) || nested(rightToLeft);
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const high = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if (((high >>> index) & 1) !== 0) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function validAgeRecipient(value) {
  if (value.length !== 62 || !value.startsWith("age1")) return false;
  const encoded = [...value.slice(4)].map((character) => BECH32_CHARSET.indexOf(character));
  if (encoded.some((entry) => entry < 0) || encoded.length !== 58) return false;
  const humanReadable = [..."age"];
  const expanded = [
    ...humanReadable.map((character) => character.charCodeAt(0) >>> 5),
    0,
    ...humanReadable.map((character) => character.charCodeAt(0) & 31),
  ];
  const data = encoded.slice(0, -6);
  return data.length === 52 && (data.at(-1) & 0b1111) === 0 &&
    bech32Polymod([...expanded, ...encoded]) === 1;
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
    !validAgeRecipient(values.AGE_RECIPIENT) ||
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
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 || bytes.byteLength > 64 * 1024 ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      (platform !== "win32" && (after.mode & 0o077) !== 0)) {
      fail("CONFIG_INPUT_INVALID", "Production values file changed during inspection");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseProductionValues(source);
  } catch (error) {
    if (error?.code === "CONFIG_VALUES_INVALID" || error?.code === "CONFIG_INPUT_INVALID") throw error;
    fail("CONFIG_INPUT_INVALID", "Production values file is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

async function defaultReadExistingTarget(target, { expectedUid } = {}) {
  return inspectTarget(target, expectedUid);
}

function validatedValues(values) {
  try {
    return parseProductionValues(JSON.stringify({ schemaVersion: 1, values }));
  } catch (error) {
    if (error?.code === "CONFIG_VALUES_INVALID") throw error;
    fail("CONFIG_VALUES_INVALID", "Production values are invalid");
  }
}

async function collectTemplateSources(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await collectTemplateSources(path.join(directory, entry.name), relative));
    else if (entry.name.endsWith(".template")) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Template inventory contains an unsafe entry");
      result.push(relative);
    }
  }
  return result.sort();
}

async function readProtectedTemplate(filePath) {
  let handle;
  try {
    await assertNoSymlinkPath(filePath, "CONFIG_VALIDATION_FAILED");
    const lexical = await lstat(filePath);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size > 64 * 1024) {
      throw new Error("Template is not a bounded regular file");
    }
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || bytes.byteLength > 64 * 1024 || !identityMatches(lexical, before) ||
      !identityMatches(before, after)) throw new Error("Template changed during inspection");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeExistingTarget(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Object.freeze({ bytes: Buffer.from(value), mode: undefined, uid: undefined });
  }
  if (value === null || typeof value !== "object" ||
    (!Buffer.isBuffer(value.bytes) && !(value.bytes instanceof Uint8Array)) ||
    (value.mode !== undefined && (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777)) ||
    (value.uid !== undefined && (!Number.isInteger(value.uid) || value.uid < 0))) {
    throw new Error("Existing target reader returned invalid data");
  }
  return Object.freeze({ ...value, bytes: Buffer.from(value.bytes) });
}

async function prepareConfiguration({ opsRoot, values, scope, platform }, adapters = {}) {
  if (typeof opsRoot !== "string" || !path.isAbsolute(opsRoot) || path.normalize(opsRoot) !== opsRoot ||
    !["user", "system"].includes(scope)) {
    fail("CONFIG_INPUT_INVALID", "Configuration plan input is invalid");
  }
  const parsedValues = validatedValues(values);
  const readTemplate = adapters.readTemplate ?? readProtectedTemplate;
  const readExistingTarget = adapters.readExistingTarget ?? defaultReadExistingTarget;
  const effectivePlatform = platform ?? adapters.platform ?? process.platform;
  const resolveTarget = adapters.resolveTarget ?? ((target, { id }) => (
    effectivePlatform === "darwin" && id === "newsyslog"
      ? "/private/etc/newsyslog.d/wisdom-portal.conf"
      : target
  ));
  if (typeof readTemplate !== "function" || typeof readExistingTarget !== "function" ||
    typeof resolveTarget !== "function") {
    fail("CONFIG_INPUT_INVALID", "Configuration adapters are invalid");
  }

  const prepared = [];
  try {
    await assertNoSymlinkPath(opsRoot, "CONFIG_VALIDATION_FAILED");
    const actualTemplates = await collectTemplateSources(opsRoot);
    const expectedTemplates = CONFIG_TEMPLATE_DESCRIPTORS.map(({ source }) => source).sort();
    if (actualTemplates.join("\n") !== expectedTemplates.join("\n")) {
      throw new Error("Template inventory does not match the fixed manifest");
    }
    for (const descriptor of CONFIG_TEMPLATE_DESCRIPTORS.filter((entry) => entry.scope === scope)) {
      const templatePath = path.resolve(opsRoot, descriptor.source);
      const template = await readTemplate(templatePath);
      if (typeof template !== "string" || Buffer.byteLength(template, "utf8") > 64 * 1024) {
        throw new Error("Template is invalid or too large");
      }
      const source = renderTemplate(template, parsedValues);
      if (Buffer.byteLength(source, "utf8") > 64 * 1024) throw new Error("Rendered configuration is too large");

      if (descriptor.validator === "runtime") parseRuntimeConfig(source);
      else if (descriptor.validator === "monitoring") parseMonitoringConfig(source, { pathApi: path.posix });
      else {
        if (typeof adapters.validateExternal !== "function") throw new Error("External validator is unavailable");
        await adapters.validateExternal({ id: descriptor.id, kind: descriptor.validator, source });
      }

      const logicalTarget = descriptor.target(parsedValues);
      const target = resolveTarget(logicalTarget, { id: descriptor.id, scope });
      const hostAbsolute = typeof target === "string" && path.isAbsolute(target) && path.normalize(target) === target;
      const posixAbsolute = typeof target === "string" && path.posix.isAbsolute(target) &&
        path.posix.normalize(target) === target;
      if (!hostAbsolute && !posixAbsolute) {
        throw new Error("Resolved target is invalid");
      }
      const bytes = Buffer.from(source, "utf8");
      const desiredUid = scope === "system" ? 0 : (adapters.getuid ?? process.getuid)?.();
      const existing = normalizeExistingTarget(await readExistingTarget(target, {
        id: descriptor.id,
        scope,
        expectedUid: desiredUid,
      }));
      if (existing?.uid !== undefined && Number.isInteger(desiredUid) && existing.uid !== desiredUid) targetFailure();
      prepared.push(Object.freeze({
        id: descriptor.id,
        logicalTarget,
        target,
        mode: descriptor.mode,
        source: bytes,
        sha256: sha256(bytes),
        changed: existing === undefined || !bytes.equals(existing.bytes) ||
          (existing.mode !== undefined && existing.mode !== descriptor.mode),
      }));
    }
  } catch (error) {
    if (["CONFIG_INPUT_INVALID", "CONFIG_VALUES_INVALID", "CONFIG_TARGET_INVALID"].includes(error?.code)) throw error;
    fail("CONFIG_VALIDATION_FAILED", "Production configuration validation failed");
  }

  return Object.freeze({ scope, prepared: Object.freeze(prepared) });
}

export async function buildConfigurationPlan(input, adapters = {}) {
  const { scope, prepared } = await prepareConfiguration(input, adapters);
  return Object.freeze({
    schemaVersion: 1,
    scope,
    applied: false,
    artifacts: Object.freeze(prepared.map(({ id, sha256: digest, changed }) => Object.freeze({
      id,
      sha256: digest,
      changed,
    }))),
  });
}

function reportFor(scope, prepared, applied) {
  return Object.freeze({
    schemaVersion: 1,
    scope,
    applied,
    artifacts: Object.freeze(prepared.map(({ id, sha256: digest, changed }) => Object.freeze({
      id,
      sha256: digest,
      changed,
    }))),
  });
}

function targetFailure() {
  return fail("CONFIG_TARGET_INVALID", "Production configuration target is invalid");
}

function identityMatches(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
}

async function inspectParent(parent, expectedUid, enforcePosixMetadata) {
  try {
    await assertNoSymlinkPath(parent, "CONFIG_TARGET_INVALID");
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (enforcePosixMetadata && (metadata.mode & 0o022) !== 0) ||
      metadata.uid !== expectedUid) targetFailure();
    return metadata;
  } catch (error) {
    if (error?.code === "CONFIG_TARGET_INVALID") throw error;
    targetFailure();
  }
}

async function inspectTarget(target, expectedUid) {
  let handle;
  try {
    if (path.isAbsolute(target)) {
      await assertNoSymlinkPath(target, "CONFIG_TARGET_INVALID", { allowMissing: true });
    }
    const lexical = await lstat(target);
    if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.size > 64 * 1024 ||
      (expectedUid !== undefined && lexical.uid !== expectedUid)) targetFailure();
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 || bytes.byteLength > 64 * 1024 ||
      !identityMatches(lexical, before) || !identityMatches(before, after)) targetFailure();
    return Object.freeze({
      bytes,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      mode: after.mode & 0o777,
      uid: after.uid,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error?.code === "CONFIG_TARGET_INVALID") throw error;
    targetFailure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function parentStillCurrent(parent, snapshot, expectedUid, enforcePosixMetadata) {
  try {
    await assertNoSymlinkPath(parent, "CONFIG_TARGET_INVALID");
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== snapshot.dev ||
      metadata.ino !== snapshot.ino || metadata.uid !== expectedUid ||
      (enforcePosixMetadata && (metadata.mode & 0o022) !== 0)) targetFailure();
  } catch (error) {
    if (error?.code === "CONFIG_TARGET_INVALID") throw error;
    targetFailure();
  }
}

async function snapshotStillCurrent(target, snapshot) {
  try {
    const metadata = await lstat(target);
    if (snapshot === undefined || !metadata.isFile() || metadata.isSymbolicLink() ||
      !identityMatches(metadata, snapshot)) targetFailure();
  } catch (error) {
    if (error?.code === "ENOENT" && snapshot === undefined) return;
    if (error?.code === "CONFIG_TARGET_INVALID") throw error;
    targetFailure();
  }
}

function temporarySibling(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.wisdom-config-${randomUUID()}.tmp`);
}

async function writeSiblingTemporary(target, bytes, mode) {
  const temporary = temporarySibling(target);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    return temporary;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function defaultSyncParent(parent) {
  if (process.platform === "win32") return;
  const handle = await open(parent, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyInstalled(artifact, expectedUid, enforcePosixMetadata) {
  await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
  const snapshot = await inspectTarget(artifact.target, expectedUid);
  if (snapshot === undefined || (enforcePosixMetadata && snapshot.mode !== artifact.mode) ||
    snapshot.size !== artifact.source.byteLength ||
    sha256(snapshot.bytes) !== artifact.sha256) targetFailure();
}

function validateApplyGate(input, values, adapters) {
  const platform = input.platform ?? adapters.platform ?? process.platform;
  if (platform !== "darwin") targetFailure();
  if (input.scope === "user") {
    const userHome = path.posix.dirname(values.APP_ROOT);
    if (input.confirmAppRoot !== values.APP_ROOT || input.confirmUserHome !== userHome ||
      input.confirmSystemTarget !== undefined) targetFailure();
  } else {
    const getuid = adapters.getuid ?? process.getuid;
    if (typeof getuid !== "function" || getuid() !== 0 ||
      input.confirmSystemTarget !== "/etc/newsyslog.d/wisdom-portal.conf" ||
      input.confirmAppRoot !== undefined || input.confirmUserHome !== undefined) targetFailure();
  }
}

async function rollbackPublished(published, adapters, expectedUid, enforcePosixMetadata) {
  const syncParent = adapters.syncParent ?? defaultSyncParent;
  for (const artifact of [...published].reverse()) {
    await adapters.beforeRollback?.({ id: artifact.id, target: artifact.target });
    await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
    await verifyInstalled(artifact, expectedUid, enforcePosixMetadata);
    if (artifact.previous === undefined) {
      await unlink(artifact.target);
    } else {
      const temporary = await writeSiblingTemporary(artifact.target, artifact.previous.bytes, artifact.previous.mode);
      try {
        await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
        await rename(temporary, artifact.target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
    await syncParent(path.dirname(artifact.target));
  }
}

export async function installConfiguration(input, adapters = {}) {
  if (input?.apply !== true) return buildConfigurationPlan(input, adapters);
  if (input === null || typeof input !== "object") fail("CONFIG_INPUT_INVALID", "Configuration input is invalid");
  const values = validatedValues(input.values);
  validateApplyGate(input, values, adapters);
  const { scope, prepared: initiallyPrepared } = await prepareConfiguration(input, adapters);
  const getuid = adapters.getuid ?? process.getuid;
  const expectedUid = scope === "system" ? 0 : getuid?.();
  if (!Number.isInteger(expectedUid) || expectedUid < 0) targetFailure();
  const enforcePosixMetadata = adapters.enforcePosixMetadata ?? process.platform !== "win32";

  const staged = [];
  const published = [];
  let mutationStarted = false;
  let prepared;
  try {
    prepared = [];
    for (const artifact of initiallyPrepared) {
      const parent = path.dirname(artifact.target);
      const parentSnapshot = await inspectParent(parent, expectedUid, enforcePosixMetadata);
      const previous = await inspectTarget(artifact.target, expectedUid);
      const changed = previous === undefined || (enforcePosixMetadata && previous.mode !== artifact.mode) ||
        !previous.bytes.equals(artifact.source);
      const entry = { ...artifact, parent, parentSnapshot, previous, changed, temporary: undefined };
      if (changed) staged.push(entry);
      prepared.push(entry);
    }


    for (const artifact of staged) {
      await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
      await adapters.beforeStage?.({ id: artifact.id, target: artifact.target });
      artifact.temporary = await writeSiblingTemporary(artifact.target, artifact.source, artifact.mode);
    }

    for (let index = 0; index < staged.length; index += 1) {
      const artifact = staged[index];
      await adapters.beforePublish?.({ id: artifact.id, index, target: artifact.target });
      await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
      await snapshotStillCurrent(artifact.target, artifact.previous);
      mutationStarted = true;
      await rename(artifact.temporary, artifact.target);
      artifact.temporary = undefined;
      published.push(artifact);
      await parentStillCurrent(artifact.parent, artifact.parentSnapshot, expectedUid, enforcePosixMetadata);
      await (adapters.syncParent ?? defaultSyncParent)(path.dirname(artifact.target));
    }

    for (const artifact of prepared) {
      await adapters.beforeVerify?.({ id: artifact.id, target: artifact.target });
      await verifyInstalled(artifact, expectedUid, enforcePosixMetadata);
    }
    return reportFor(scope, prepared, true);
  } catch (error) {
    if (!mutationStarted) {
      if (error?.code === "CONFIG_TARGET_INVALID") throw error;
      fail("CONFIG_INSTALL_FAILED", "Production configuration installation failed");
    }
    try {
      await rollbackPublished(published, adapters, expectedUid, enforcePosixMetadata);
    } catch {
      fail("CONFIG_ROLLBACK_FAILED", "Production configuration rollback failed");
    }
    fail("CONFIG_INSTALL_FAILED", "Production configuration installation failed");
  } finally {
    await Promise.allSettled(staged.flatMap(({ temporary, parent, parentSnapshot }) => temporary ? [
      parentStillCurrent(parent, parentSnapshot, expectedUid, enforcePosixMetadata)
        .then(() => unlink(temporary))
        .catch(() => undefined),
    ] : []));
  }
}
