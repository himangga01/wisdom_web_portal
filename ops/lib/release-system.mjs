import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const RELEASE_ID = /^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/u;
const MANIFEST_FILE = ".ops-release.json";
const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "apps/control/package.json",
  "apps/site/package.json",
  "packages/shared/package.json",
];
const ROOT_RUNTIME_FILES = ["package.json", "package-lock.json"];
const RUNTIME_DIRECTORIES = [
  "apps/control",
  "apps/site",
  "packages/shared",
  "ops/lib",
  "ops/scripts",
  "node_modules",
];
const MAX_RUNTIME_FILES = 100_000;
const MAX_RUNTIME_SYMLINKS = 20_000;
const MAX_RUNTIME_FILE_BYTES = 256 * 1_048_576;
const MAX_RUNTIME_TOTAL_BYTES = 2 * 1_073_741_824;
const MAX_RELEASE_MANIFEST_BYTES = 32 * 1_048_576;
const REQUIRED_ARTIFACTS = [
  "apps/control/dist/server.js",
  "apps/control/dist/notification-worker.js",
  "apps/control/dist/content-worker.js",
  "apps/control/dist/admin/cli.js",
  "apps/control/dist/cli/migrate.js",
  "apps/control/dist/cli/consent-seed.js",
  "apps/control/dist/cli/consent-activate.js",
  "apps/control/dist/cli/purge.js",
  "apps/site/dist/index.html",
  "ops/lib/monitor-files.mjs",
  "ops/lib/monitoring.mjs",
  "ops/scripts/backup.mjs",
  "ops/scripts/deploy.mjs",
  "ops/scripts/keychain-exec.mjs",
  "ops/scripts/monitor-db-check.mjs",
  "ops/scripts/monitor.mjs",
  "ops/scripts/preflight.mjs",
  "ops/scripts/recover-lock.mjs",
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

async function verifyCurrentPointer(releaseRoot, currentLink) {
  const metadata = await lstat(currentLink);
  if (!metadata.isSymbolicLink()) fail("RELEASE_PATH_UNSAFE", "Current pointer must be a symlink");
  const target = await realpath(currentLink);
  assertDirectRelease(releaseRoot, target);
  const targetReal = await realDirectory(target, "current release");
  if (normalized(path.dirname(targetReal)) !== normalized(releaseRoot)) {
    fail("RELEASE_PATH_UNSAFE", "Current release escapes releaseRoot");
  }
  await verifyReleaseManifest(targetReal, path.basename(targetReal));
  return targetReal;
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
    await verifyCurrentPointer(releaseReal, currentLink);
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

export async function readCurrentRelease(releaseRoot, currentLink) {
  try {
    const releaseReal = await realDirectory(releaseRoot, "releaseRoot");
    return await verifyCurrentPointer(releaseReal, currentLink);
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

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function collectRuntimeInventory(destination) {
  const releaseReal = await realDirectory(destination, "release destination");
  const allowedRoots = RUNTIME_DIRECTORIES.map((relative) => path.resolve(releaseReal, ...relative.split("/")));
  const fileEntries = [];
  const symlinkEntries = [];
  const seen = new Set();
  let totalBytes = 0;
  const addFile = async (relative) => {
    if (seen.has(relative)) return;
    const absolute = path.join(releaseReal, ...relative.split("/"));
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RUNTIME_FILE_BYTES) {
      fail("RELEASE_MANIFEST_INVALID", "Runtime inventory contains an invalid or oversized file");
    }
    totalBytes += metadata.size;
    if (fileEntries.length + 1 > MAX_RUNTIME_FILES || totalBytes > MAX_RUNTIME_TOTAL_BYTES) {
      fail("RELEASE_MANIFEST_INVALID", "Runtime inventory exceeds its bounded file or byte limit");
    }
    seen.add(relative);
    fileEntries.push({
      path: relative,
      size: metadata.size,
      sha256: await hashFile(absolute),
    });
  };
  const walk = async (relativeDirectory) => {
    const absoluteDirectory = path.join(releaseReal, ...relativeDirectory.split("/"));
    const metadata = await lstat(absoluteDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("RELEASE_MANIFEST_INVALID", "Runtime directory must be a real directory");
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => lexicalCompare(left.name, right.name));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
      if (seen.has(relative)) fail("RELEASE_MANIFEST_INVALID", "Runtime inventory path is duplicated");
      const absolute = path.join(releaseReal, ...relative.split("/"));
      const child = await lstat(absolute);
      if (child.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (
          typeof target !== "string" || target.length < 1 || target.length > 4_096 ||
          /[\0\r\n]/u.test(target) || path.isAbsolute(target) || path.posix.isAbsolute(target)
        ) fail("RELEASE_MANIFEST_INVALID", "Runtime symlink target must be a bounded relative path");
        const lexicalTarget = path.resolve(path.dirname(absolute), target);
        let realTarget;
        try {
          realTarget = await realpath(absolute);
        } catch (error) {
          fail("RELEASE_MANIFEST_INVALID", "Runtime symlink target is unavailable", error);
        }
        const targetAllowed = allowedRoots.some((root) => (
          normalized(lexicalTarget) === normalized(root) || inside(root, lexicalTarget)
        )) && allowedRoots.some((root) => (
          normalized(realTarget) === normalized(root) || inside(root, realTarget)
        ));
        if (!targetAllowed) fail("RELEASE_MANIFEST_INVALID", "Runtime symlink escapes the sealed runtime roots");
        if (symlinkEntries.length + 1 > MAX_RUNTIME_SYMLINKS) {
          fail("RELEASE_MANIFEST_INVALID", "Runtime symlink inventory exceeds its bounded limit");
        }
        seen.add(relative);
        symlinkEntries.push({ path: relative, target });
      } else if (child.isDirectory()) await walk(relative);
      else if (child.isFile()) await addFile(relative);
      else fail("RELEASE_MANIFEST_INVALID", "Runtime inventory contains a non-regular entry");
    }
  };
  for (const relative of ROOT_RUNTIME_FILES) await addFile(relative);
  for (const directory of RUNTIME_DIRECTORIES) await walk(directory);
  fileEntries.sort((left, right) => lexicalCompare(left.path, right.path));
  symlinkEntries.sort((left, right) => lexicalCompare(left.path, right.path));
  const files = Object.fromEntries(fileEntries.map(({ path: relative, ...record }) => [relative, record]));
  const symlinks = Object.fromEntries(symlinkEntries.map(({ path: relative, target }) => [relative, target]));
  for (const required of REQUIRED_ARTIFACTS) {
    if (!Object.hasOwn(files, required)) fail("RELEASE_MANIFEST_INVALID", `Missing required runtime artifact ${required}`);
  }
  for (const required of REQUIRED_FILES) {
    if (!Object.hasOwn(files, required)) fail("RELEASE_MANIFEST_INVALID", `Missing required runtime file ${required}`);
  }
  return { files, symlinks };
}

export async function createReleaseManifest(destination, releaseId, now = new Date()) {
  if (!RELEASE_ID.test(releaseId) || path.basename(destination) !== releaseId) fail("RELEASE_MANIFEST_INVALID", "Release identity mismatch");
  const { files, symlinks } = await collectRuntimeInventory(destination);
  const manifest = {
    formatVersion: 2,
    releaseId,
    createdAt: now.toISOString(),
    files,
    symlinks,
  };
  const manifestPath = path.join(destination, MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

export async function verifyReleaseManifest(destination, releaseId) {
  let manifest;
  try {
    const manifestPath = path.join(destination, MANIFEST_FILE);
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RELEASE_MANIFEST_BYTES) throw new Error("unsafe manifest");
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw);
    if (raw !== `${JSON.stringify(manifest, null, 2)}\n`) throw new Error("non-canonical manifest");
  } catch {
    fail("RELEASE_MANIFEST_INVALID", "Release manifest is unreadable");
  }
  const expectedKeys = ["createdAt", "files", "formatVersion", "releaseId", "symlinks"];
  if (
    !exactObject(manifest) || Object.keys(manifest).sort(lexicalCompare).join("\n") !== expectedKeys.join("\n") ||
    manifest.formatVersion !== 2 ||
    manifest.releaseId !== releaseId ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !exactObject(manifest.files) || !exactObject(manifest.symlinks)
  ) {
    fail("RELEASE_MANIFEST_INVALID", "Release manifest contract is invalid");
  }
  for (const [relative, record] of Object.entries(manifest.files)) {
    if (
      typeof relative !== "string" || relative.length < 1 || relative.startsWith("/") || relative.includes("\\") ||
      relative.split("/").some((part) => !part || part === "." || part === "..") ||
      !exactObject(record) || Object.keys(record).sort(lexicalCompare).join("\n") !== "sha256\nsize" ||
      typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256) ||
      !Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_RUNTIME_FILE_BYTES
    ) fail("RELEASE_MANIFEST_INVALID", "Release file record is invalid");
  }
  for (const [relative, target] of Object.entries(manifest.symlinks)) {
    if (
      typeof relative !== "string" || relative.length < 1 || relative.startsWith("/") || relative.includes("\\") ||
      relative.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof target !== "string" || target.length < 1 || target.length > 4_096 || /[\0\r\n]/u.test(target)
    ) fail("RELEASE_MANIFEST_INVALID", "Release symlink record is invalid");
  }
  const actual = await collectRuntimeInventory(destination);
  if (
    JSON.stringify(manifest.files) !== JSON.stringify(actual.files) ||
    JSON.stringify(manifest.symlinks) !== JSON.stringify(actual.symlinks)
  ) {
    fail("RELEASE_MANIFEST_INVALID", "Release runtime inventory changed");
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
  const verifiedRetired = [];
  const skippedInvalid = [];
  for (const releaseId of retired) {
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
    verifiedRetired.push(releaseId);
  }
  const deleted = [];
  for (const releaseId of verifiedRetired.slice(keepRetired)) {
    const candidate = path.join(rootReal, releaseId);
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
