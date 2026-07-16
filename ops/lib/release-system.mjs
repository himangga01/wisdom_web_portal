import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const RELEASE_ID = /^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/u;
const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "apps/control/package.json",
  "apps/site/package.json",
  "packages/shared/package.json",
];
const RUNTIME_DIRECTORIES = ["apps/control/dist", "apps/site/dist", "packages/shared/dist", "ops/lib", "ops/scripts"];
const REQUIRED_ARTIFACTS = [
  "apps/control/dist/server.js",
  "apps/control/dist/notification-worker.js",
  "apps/control/dist/content-worker.js",
  "apps/site/dist/index.html",
  "ops/scripts/backup.mjs",
  "ops/scripts/deploy.mjs",
  "ops/scripts/keychain-exec.mjs",
  "ops/scripts/preflight.mjs",
  "ops/scripts/restore.mjs",
  "ops/scripts/rollback.mjs",
  "ops/scripts/secret-import.mjs",
  "ops/scripts/seed-public.mjs",
];
const COPY_EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".worktrees", "data", ".superpowers", "research", "prototypes", "docs"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalized(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(parent, child) {
  const relative = path.relative(normalized(parent), normalized(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function realDirectory(candidate, label) {
  const metadata = await lstat(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", `${label} must be a real directory`);
  return realpath(candidate);
}

function assertDirectRelease(releaseRoot, destination) {
  if (
    !RELEASE_ID.test(path.basename(destination)) ||
    normalized(path.dirname(destination)) !== normalized(releaseRoot)
  ) {
    fail("RELEASE_PATH_UNSAFE", "Release target must be a direct validated child of releaseRoot");
  }
}

export async function validateReleaseFilesystem({ sourceRoot, releaseRoot, currentLink, destination, rollback = false }) {
  const releaseReal = await realDirectory(releaseRoot, "releaseRoot");
  let sourceReal;
  if (!rollback) {
    sourceReal = await realDirectory(sourceRoot, "sourceRoot");
    if (
      normalized(sourceReal) === normalized(releaseReal) ||
      inside(sourceReal, releaseReal) ||
      inside(releaseReal, sourceReal)
    ) {
      fail("RELEASE_PATH_UNSAFE", "Source and release roots overlap after realpath resolution");
    }
  }
  if (normalized(await realpath(path.dirname(currentLink))) !== normalized(path.dirname(releaseReal))) {
    fail("RELEASE_PATH_UNSAFE", "Current pointer parent must match the release root parent");
  }
  if (await exists(currentLink)) {
    const currentMetadata = await lstat(currentLink);
    if (!currentMetadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Current pointer must be a symlink");
  }
  assertDirectRelease(releaseReal, destination);
  if (rollback) {
    const destinationReal = await realDirectory(destination, "rollback destination");
    if (!inside(releaseReal, destinationReal)) fail("RELEASE_PATH_UNSAFE", "Rollback destination escapes releaseRoot");
  } else if (await exists(destination)) {
    fail("RELEASE_PATH_UNSAFE", "New release destination must not exist");
  }
  return { ...(sourceReal ? { sourceReal } : {}), releaseReal };
}

export async function readCurrentRelease(currentLink) {
  try {
    const metadata = await lstat(currentLink);
    if (!metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Current pointer must be a symlink");
    return realpath(currentLink);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function copyReleaseSource(sourceRoot, destination) {
  if (await exists(destination)) fail("RELEASE_PATH_UNSAFE", "Copy destination must not exist");
  const root = path.resolve(sourceRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Source root must be a real directory");
  const excluded = (relative) => relative.split(path.sep).some((segment) => (
    COPY_EXCLUDED_SEGMENTS.has(segment) ||
    segment.startsWith(".codex") ||
    segment === ".env" ||
    segment.startsWith(".env.")
  )) || (() => {
    const segments = relative.split(path.sep).filter(Boolean);
    return segments[0] === "ops" && segments.length > 1 && segments[1] !== "lib" && segments[1] !== "scripts";
  })();
  const scan = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (excluded(relative)) continue;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Included source tree cannot contain symlinks");
      if (metadata.isDirectory()) await scan(absolute);
      else if (!metadata.isFile()) fail("RELEASE_PATH_UNSAFE", "Included source tree contains a non-regular entry");
    }
  };
  await scan(root);
  try {
    await cp(root, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        if (relative === "") return true;
        return !excluded(relative);
      },
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function hashFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail("RELEASE_MANIFEST_INVALID", "Release artifact must be a regular file");
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function collectRuntimeInventory(destination) {
  const relativeFiles = [...REQUIRED_FILES];
  const walk = async (relativeDirectory) => {
    const absoluteDirectory = path.join(destination, relativeDirectory);
    const metadata = await lstat(absoluteDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELEASE_MANIFEST_INVALID", "Runtime directory must be a real directory");
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
      const absolute = path.join(destination, ...relative.split("/"));
      const child = await lstat(absolute);
      if (child.isSymbolicLink()) fail("RELEASE_MANIFEST_INVALID", "Runtime inventory cannot contain symlinks");
      if (child.isDirectory()) await walk(relative);
      else if (child.isFile()) relativeFiles.push(relative);
      else fail("RELEASE_MANIFEST_INVALID", "Runtime inventory contains a non-regular entry");
    }
  };
  for (const directory of RUNTIME_DIRECTORIES) await walk(directory);
  const sorted = [...new Set(relativeFiles)].sort();
  for (const required of REQUIRED_ARTIFACTS) {
    if (!sorted.includes(required)) fail("RELEASE_MANIFEST_INVALID", `Missing required runtime artifact ${required}`);
  }
  return sorted;
}

export async function createReleaseManifest(destination, releaseId, now = new Date()) {
  if (!RELEASE_ID.test(releaseId) || path.basename(destination) !== releaseId) fail("RELEASE_MANIFEST_INVALID", "Release identity mismatch");
  const files = {};
  for (const relative of await collectRuntimeInventory(destination)) files[relative] = await hashFile(path.join(destination, ...relative.split("/")));
  const manifest = {
    formatVersion: 1,
    releaseId,
    createdAt: now.toISOString(),
    files,
  };
  const manifestPath = path.join(destination, ".ops-release.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export async function verifyReleaseManifest(destination, releaseId) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(destination, ".ops-release.json"), "utf8"));
  } catch {
    fail("RELEASE_MANIFEST_INVALID", "Release manifest is unreadable");
  }
  if (
    manifest.formatVersion !== 1 ||
    manifest.releaseId !== releaseId ||
    Object.keys(manifest.files ?? {}).sort().join("\n") !== (await collectRuntimeInventory(destination)).join("\n")
  ) {
    fail("RELEASE_MANIFEST_INVALID", "Release manifest contract is invalid");
  }
  for (const relative of Object.keys(manifest.files).sort()) {
    if (await hashFile(path.join(destination, ...relative.split("/"))) !== manifest.files[relative]) {
      fail("RELEASE_MANIFEST_INVALID", "Release artifact hash mismatch");
    }
  }
  return manifest;
}

async function defaultSyncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicSwitchRelease(destination, currentLink, options = {}) {
  const fileSystem = options.fileSystem ?? { symlink, rename, rm, syncDirectory: defaultSyncDirectory };
  const temporary = path.join(path.dirname(currentLink), options.temporaryName ?? `.current-next-${randomUUID()}`);
  try {
    await fileSystem.symlink(destination, temporary, "dir");
    await fileSystem.rename(temporary, currentLink);
    await fileSystem.syncDirectory(path.dirname(currentLink));
  } catch (error) {
    await fileSystem.rm(temporary, { force: true });
    throw error;
  }
}

export async function removeReleasePointer(currentLink) {
  try {
    const metadata = await lstat(currentLink);
    if (!metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Current pointer must be a symlink");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await rm(currentLink);
  await defaultSyncDirectory(path.dirname(currentLink));
}

export async function pruneRetainedReleases(releaseRoot, { active, keepRetired }) {
  const rootReal = await realDirectory(releaseRoot, "releaseRoot");
  if (!Number.isInteger(keepRetired) || keepRetired < 0) fail("RELEASE_PATH_UNSAFE", "keepRetired is invalid");
  assertDirectRelease(rootReal, active);
  const activeReal = await realDirectory(active, "active release");
  if (!inside(rootReal, activeReal)) fail("RELEASE_PATH_UNSAFE", "Active release escapes releaseRoot");

  const retired = [];
  for (const entry of await readdir(rootReal, { withFileTypes: true })) {
    if (!RELEASE_ID.test(entry.name) || normalized(path.join(rootReal, entry.name)) === normalized(activeReal)) continue;
    const candidate = path.join(rootReal, entry.name);
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Retained release cannot be a symlink");
    retired.push(entry.name);
  }
  retired.sort().reverse();
  const deleted = [];
  const skippedInvalid = [];
  for (const releaseId of retired.slice(keepRetired)) {
    const candidate = path.join(rootReal, releaseId);
    assertDirectRelease(rootReal, candidate);
    try {
      await verifyReleaseManifest(candidate, releaseId);
    } catch (error) {
      if (error.code === "RELEASE_MANIFEST_INVALID") {
        skippedInvalid.push(releaseId);
        continue;
      }
      throw error;
    }
    await rm(candidate, { recursive: true });
    deleted.push(releaseId);
  }
  return { deleted, skippedInvalid };
}

export async function removeIncompleteRelease(releaseRoot, destination, currentLink) {
  const rootReal = await realDirectory(releaseRoot, "releaseRoot");
  assertDirectRelease(rootReal, destination);
  if (await exists(currentLink)) {
    const metadata = await lstat(currentLink);
    if (!metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Current pointer must be a symlink");
    if (normalized(await realpath(currentLink)) === normalized(await realpath(destination))) {
      fail("RELEASE_PATH_UNSAFE", "Active release cannot be removed as incomplete");
    }
  }
  const destinationMetadata = await lstat(destination);
  if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Incomplete release must be a real directory");
  await rm(destination, { recursive: true });
}
