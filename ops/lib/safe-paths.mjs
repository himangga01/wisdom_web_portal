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
