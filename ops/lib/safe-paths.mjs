import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export async function assertNoSymlinkPath(candidate, code, { allowMissing = false } = {}) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) fail(code, "Path must be absolute");
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) fail(code, "Symlink path components are forbidden");
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

export async function ensureRealDirectory(candidate, code) {
  await assertNoSymlinkPath(candidate, code, { allowMissing: true });
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(candidate, code);
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory()) fail(code, "Expected a directory");
  return realpath(candidate);
}

function isNestedPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export async function assertCanonicalDirectoryIsolation(candidates, code) {
  if (
    !Array.isArray(candidates) ||
    candidates.length < 2 ||
    candidates.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate))
  ) {
    fail(code, "Canonical directory isolation input is invalid");
  }
  const identities = [];
  for (const candidate of candidates) {
    await assertNoSymlinkPath(candidate, code);
    const canonicalPath = await realpath(candidate);
    const metadata = await lstat(canonicalPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(code, "Canonical isolation paths must be real directories");
    }
    identities.push({
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
    });
  }
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const a = identities[left];
      const b = identities[right];
      if (
        (a.device === b.device && a.inode === b.inode) ||
        isNestedPath(a.canonicalPath, b.canonicalPath) ||
        isNestedPath(b.canonicalPath, a.canonicalPath)
      ) {
        fail(code, "Canonical directories must be distinct and non-overlapping");
      }
    }
  }
  return identities;
}
