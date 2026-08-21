import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_MONITOR_CONFIG_BYTES = 64 * 1024;
export const MAX_MONITOR_INCIDENT_STATE_BYTES = 4 * 1024;

const MAX_PATH_BYTES = 4_096;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isBoundedSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function noFollowFlag() {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

function privateMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o077n) === 0n;
}

function protectedMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o022n) === 0n;
}

function ownerOnlyFileMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o777n) === 0o600n;
}

function ownerOnlyDirectoryMode(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o777n) === 0o700n;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertSameWalk(before, after, code) {
  if (before.components.length !== after.components.length) {
    fail(code, "Filesystem path identity changed during validation");
  }
  for (let index = 0; index < before.components.length; index += 1) {
    const left = before.components[index];
    const right = after.components[index];
    if (left.path !== right.path || !sameIdentity(left.metadata, right.metadata)) {
      fail(code, "Filesystem path identity changed during validation");
    }
  }
}

export function assertNormalizedAbsolutePath(candidate, code = "MONITOR_PATH_INVALID") {
  if (
    typeof candidate !== "string" || candidate.length === 0 ||
    Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES ||
    !path.isAbsolute(candidate) || /[\0\r\n]/u.test(candidate) ||
    path.normalize(candidate) !== candidate || path.resolve(candidate) !== candidate
  ) fail(code, "Path must be normalized and absolute");
  return candidate;
}

async function walkNoLinks(candidate, code, { allowMissingFinal = false } = {}) {
  assertNormalizedAbsolutePath(candidate, code);
  const parsed = path.parse(candidate);
  const segments = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const components = [];

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let metadata;
    try {
      metadata = await lstat(current, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingFinal && index === segments.length - 1) {
        return { components, finalMetadata: undefined, missing: true };
      }
      fail(code, "Filesystem path is unavailable");
    }
    if (metadata.isSymbolicLink()) fail(code, "Symbolic links are forbidden");
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      fail(code, "Path parent must be a real directory");
    }
    components.push({ path: current, metadata });
  }

  return {
    components,
    finalMetadata: components.at(-1)?.metadata,
    missing: false,
  };
}

async function canonicalPath(candidate, code) {
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    fail(code, "Filesystem path cannot be canonicalized");
  }
  if (canonical !== candidate) fail(code, "Filesystem path is not canonical");
  return canonical;
}

async function withSecureRegularFile(candidate, {
  code,
  maxBytes,
  requireOwnerOnly = false,
  requirePrivate = false,
  requireProtected = false,
}, operation) {
  if (!isBoundedSize(maxBytes)) fail(code, "File size bound is invalid");
  const initialWalk = await walkNoLinks(candidate, code);
  if (!initialWalk.finalMetadata?.isFile()) fail(code, "Expected a regular file");

  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | noFollowFlag());
  } catch {
    fail(code, "Regular file cannot be opened safely");
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(initialWalk.finalMetadata, before)) {
      fail(code, "Regular file identity is invalid");
    }
    if (before.size > BigInt(maxBytes)) fail(code, "Regular file exceeds its size bound");
    if (requireOwnerOnly && !ownerOnlyFileMode(before)) fail(code, "Regular file permissions are not owner-only");
    if (requirePrivate && !privateMode(before)) fail(code, "Regular file permissions are not private");
    if (requireProtected && !protectedMode(before)) fail(code, "Regular file permissions are not protected");

    const canonical = await canonicalPath(candidate, code);
    const preOperationWalk = await walkNoLinks(candidate, code);
    assertSameWalk(initialWalk, preOperationWalk, code);
    if (!sameIdentity(preOperationWalk.finalMetadata, before)) {
      fail(code, "Regular file changed during validation");
    }

    const result = await operation(handle, before, canonical);
    const after = await handle.stat({ bigint: true });
    const finalWalk = await walkNoLinks(candidate, code);
    assertSameWalk(initialWalk, finalWalk, code);
    if (!sameFileSnapshot(before, after) || !sameIdentity(finalWalk.finalMetadata, after)) {
      fail(code, "Regular file changed during access");
    }
    await canonicalPath(candidate, code);
    return result;
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code, "Secure regular file access failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBounded(handle, maximumBytes, signal, code) {
  const chunks = [];
  let total = 0;
  while (true) {
    if (signal?.aborted) fail(code, "Bounded file read was interrupted");
    const remaining = maximumBytes - total;
    const requested = remaining >= 64 * 1024 ? 64 * 1024 : remaining + 1;
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) fail(code, "Regular file exceeds its size bound");
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

export async function assertSecureRealDirectory(candidate, {
  code = "MONITOR_DIRECTORY_INVALID",
  requireOwnerOnly = false,
  requireProtected = false,
} = {}) {
  return withSecureRealDirectory(candidate, {
    code,
    requireOwnerOnly,
    requireProtected,
  }, async ({ canonicalPath }) => canonicalPath);
}

export async function withSecureRealDirectory(candidate, {
  code = "MONITOR_DIRECTORY_INVALID",
  requireOwnerOnly = false,
  requireProtected = false,
} = {}, operation) {
  if (typeof operation !== "function") fail(code, "Directory operation is required");
  const initialWalk = await walkNoLinks(candidate, code);
  const metadata = initialWalk.finalMetadata;
  if (!metadata?.isDirectory()) fail(code, "Expected a real directory");
  if (requireOwnerOnly && !ownerOnlyDirectoryMode(metadata)) fail(code, "Directory permissions are not owner-only");
  if (requireProtected && !protectedMode(metadata)) fail(code, "Directory permissions are not protected");
  const canonical = await canonicalPath(candidate, code);
  let handle;
  try {
    if (process.platform !== "win32") {
      handle = await open(candidate, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollowFlag());
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || !sameIdentity(metadata, opened)) {
        fail(code, "Directory identity changed before access");
      }
    }
    const preOperationWalk = await walkNoLinks(candidate, code);
    assertSameWalk(initialWalk, preOperationWalk, code);
    const result = await operation({ canonicalPath: canonical, handle });
    if (handle) {
      const after = await handle.stat({ bigint: true });
      if (!after.isDirectory() || !sameIdentity(metadata, after)) {
        fail(code, "Directory identity changed during access");
      }
    }
    const finalWalk = await walkNoLinks(candidate, code);
    assertSameWalk(initialWalk, finalWalk, code);
    await canonicalPath(candidate, code);
    return result;
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code, "Directory operation failed safely");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function assertSecureRegularFile(candidate, {
  code = "MONITOR_FILE_INVALID",
  maxBytes = Number.MAX_SAFE_INTEGER,
  requireOwnerOnly = false,
  requirePrivate = false,
  requireProtected = false,
} = {}) {
  return withSecureRegularFile(candidate, {
    code,
    maxBytes,
    requireOwnerOnly,
    requirePrivate,
    requireProtected,
  }, async (_handle, metadata, canonical) => ({
    canonicalPath: canonical,
    size: Number(metadata.size),
  }));
}

export async function readSecureRegularFile(candidate, {
  code = "MONITOR_FILE_INVALID",
  maxBytes,
  signal,
  requireOwnerOnly = false,
  requirePrivate = false,
  requireProtected = false,
} = {}) {
  return withSecureRegularFile(candidate, {
    code,
    maxBytes,
    requireOwnerOnly,
    requirePrivate,
    requireProtected,
  }, async (handle) => readBounded(handle, maxBytes, signal, code));
}

export async function hashSecureRegularFile(candidate, {
  code = "MONITOR_FILE_INVALID",
  maxBytes,
  signal,
  requireOwnerOnly = false,
  requirePrivate = false,
  requireProtected = false,
} = {}) {
  return withSecureRegularFile(candidate, {
    code,
    maxBytes,
    requireOwnerOnly,
    requirePrivate,
    requireProtected,
  }, async (handle) => {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      if (signal?.aborted) fail(code, "Secure file hash was interrupted");
      const remaining = maxBytes - size;
      const requested = remaining >= chunk.length ? chunk.length : remaining + 1;
      const { bytesRead } = await handle.read(chunk, 0, requested, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) fail(code, "Regular file exceeds its size bound");
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), size };
  });
}

export async function readProtectedConfigFile(configPath, {
  maxBytes = MAX_MONITOR_CONFIG_BYTES,
  signal,
} = {}) {
  return (await readSecureRegularFile(configPath, {
    code: "MONITOR_CONFIG_PATH_INVALID",
    maxBytes,
    signal,
    requireProtected: true,
  })).toString("utf8");
}

async function protectedStateParent(statePath, code) {
  assertNormalizedAbsolutePath(statePath, code);
  const parent = path.dirname(statePath);
  const initialWalk = await walkNoLinks(parent, code);
  if (!initialWalk.finalMetadata?.isDirectory() || !protectedMode(initialWalk.finalMetadata)) {
    fail(code, "Incident state parent must be a protected real directory");
  }
  await canonicalPath(parent, code);
  const finalWalk = await walkNoLinks(parent, code);
  assertSameWalk(initialWalk, finalWalk, code);
  return { parent, walk: finalWalk };
}

function encodeIncidentState(value, maximumBytes, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "Incident state must be an object");
  }
  let source;
  try {
    source = `${JSON.stringify(value)}\n`;
  } catch {
    fail(code, "Incident state cannot be encoded");
  }
  if (Buffer.byteLength(source, "utf8") > maximumBytes || source.includes("\0")) {
    fail(code, "Incident state exceeds its size bound");
  }
  return source;
}

export async function loadProtectedIncidentState(statePath, {
  maxBytes = MAX_MONITOR_INCIDENT_STATE_BYTES,
  beforeRead,
} = {}) {
  const code = "MONITOR_INCIDENT_STATE_INVALID";
  if (!isBoundedSize(maxBytes)) fail(code, "Incident state size bound is invalid");
  assertNormalizedAbsolutePath(statePath, code);
  if (beforeRead !== undefined && typeof beforeRead !== "function") fail(code, "Incident read hook is invalid");
  const parent = path.dirname(statePath);
  return withSecureRealDirectory(parent, { code, requireProtected: true }, async () => {
    await beforeRead?.();
    const stateWalk = await walkNoLinks(statePath, code, { allowMissingFinal: true });
    if (stateWalk.missing) return undefined;
    const source = (await readSecureRegularFile(statePath, {
      code,
      maxBytes,
      requirePrivate: true,
    })).toString("utf8");
    let value;
    try {
      value = JSON.parse(source);
    } catch {
      fail(code, "Incident state is not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(code, "Incident state must be a JSON object");
    }
    return value;
  });
}

export async function writeProtectedIncidentState(statePath, value, {
  maxBytes = MAX_MONITOR_INCIDENT_STATE_BYTES,
} = {}) {
  const code = "MONITOR_INCIDENT_STATE_INVALID";
  if (!isBoundedSize(maxBytes)) fail(code, "Incident state size bound is invalid");
  const source = encodeIncidentState(value, maxBytes, code);
  const parent = await protectedStateParent(statePath, code);
  const existing = await walkNoLinks(statePath, code, { allowMissingFinal: true });
  if (!existing.missing) {
    await assertSecureRegularFile(statePath, { code, maxBytes, requirePrivate: true });
  }

  const temporaryPath = path.join(
    parent.parent,
    `.${path.basename(statePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    const initialTemp = await handle.stat({ bigint: true });
    if (!initialTemp.isFile() || !privateMode(initialTemp)) {
      fail(code, "Atomic incident state file is not protected");
    }
    await handle.writeFile(source, "utf8");
    await handle.sync();
    const writtenTemp = await handle.stat({ bigint: true });
    if (
      !sameIdentity(initialTemp, writtenTemp) ||
      writtenTemp.size !== BigInt(Buffer.byteLength(source, "utf8"))
    ) fail(code, "Atomic incident state write is incomplete");
    const tempWalk = await walkNoLinks(temporaryPath, code);
    if (!sameIdentity(tempWalk.finalMetadata, writtenTemp)) {
      fail(code, "Atomic incident state identity changed");
    }
    await handle.close();
    handle = undefined;

    const parentBeforeRename = await walkNoLinks(parent.parent, code);
    assertSameWalk(parent.walk, parentBeforeRename, code);
    const targetBeforeRename = await walkNoLinks(statePath, code, { allowMissingFinal: true });
    if (existing.missing !== targetBeforeRename.missing) {
      fail(code, "Incident state target changed before replacement");
    }
    if (!existing.missing) assertSameWalk(existing, targetBeforeRename, code);
    await rename(temporaryPath, statePath);
    renamed = true;

    await assertSecureRegularFile(statePath, { code, maxBytes, requirePrivate: true });
    const parentAfterRename = await walkNoLinks(parent.parent, code);
    assertSameWalk(parent.walk, parentAfterRename, code);
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code, "Incident state could not be written safely");
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function clearProtectedIncidentState(statePath) {
  const code = "MONITOR_INCIDENT_STATE_INVALID";
  const parent = await protectedStateParent(statePath, code);
  const initialState = await walkNoLinks(statePath, code, { allowMissingFinal: true });
  if (initialState.missing) return false;
  await assertSecureRegularFile(statePath, {
    code,
    maxBytes: MAX_MONITOR_INCIDENT_STATE_BYTES,
    requirePrivate: true,
  });
  const stateBeforeUnlink = await walkNoLinks(statePath, code);
  assertSameWalk(initialState, stateBeforeUnlink, code);
  const parentBeforeUnlink = await walkNoLinks(parent.parent, code);
  assertSameWalk(parent.walk, parentBeforeUnlink, code);
  try {
    await unlink(statePath);
  } catch {
    fail(code, "Incident state could not be cleared safely");
  }
  const stateAfterUnlink = await walkNoLinks(statePath, code, { allowMissingFinal: true });
  if (!stateAfterUnlink.missing) fail(code, "Incident state remained after clearing");
  const parentAfterUnlink = await walkNoLinks(parent.parent, code);
  assertSameWalk(parent.walk, parentAfterUnlink, code);
  return true;
}
