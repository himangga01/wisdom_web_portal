import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertNoSymlinkPath } from "./safe-paths.mjs";

const OPS_MANIFEST = ".ops-public-release.json";
const WISDOM_MANIFEST = ".wisdom-release-manifest.json";
const MAX_WISDOM_MANIFEST_BYTES = 2 * 1_048_576;
const MAX_WISDOM_FILE_BYTES = 16 * 1_048_576;
const MAX_WISDOM_RELEASE_BYTES = 256 * 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
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

async function inventory(root, { exclude = new Set(), enforceWisdomLimits = false } = {}, relative = "") {
  const directory = path.join(root, relative);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("PUBLIC_RELEASE_INVALID", "Public release directories cannot be symlinks");
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (relative === "" && exclude.has(entry.name)) continue;
    const child = path.join(root, ...childRelative.split("/"));
    const childMetadata = await lstat(child);
    if (childMetadata.isSymbolicLink()) fail("PUBLIC_RELEASE_INVALID", "Public release cannot contain symlinks");
    if (childMetadata.isDirectory()) files.push(...await inventory(root, { exclude, enforceWisdomLimits }, childRelative));
    else if (childMetadata.isFile()) {
      if (enforceWisdomLimits && childMetadata.size > MAX_WISDOM_FILE_BYTES) {
        fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release contains an oversized file");
      }
      files.push({ path: childRelative, size: childMetadata.size });
    } else fail("PUBLIC_RELEASE_INVALID", "Public release contains a non-regular entry");
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

async function readManifestFile(manifestPath, maximumBytes) {
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    fail("PUBLIC_CURRENT_NOT_READY", "Public release manifest is unsafe");
  }
  const bytes = await readFile(manifestPath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("PUBLIC_CURRENT_NOT_READY", "Public release manifest is unreadable");
  }
  return { bytes, value };
}

export async function writePublicReleaseManifest(releaseDirectory, releaseId, now = new Date()) {
  if (await exists(path.join(releaseDirectory, WISDOM_MANIFEST))) {
    fail("PUBLIC_RELEASE_INVALID", "A sealed Wisdom release cannot also be marked as bootstrap");
  }
  const files = {};
  for (const entry of await inventory(releaseDirectory, { exclude: new Set([OPS_MANIFEST]) })) {
    files[entry.path] = await sha256(path.join(releaseDirectory, ...entry.path.split("/")));
  }
  if (!Object.hasOwn(files, "index.html")) fail("PUBLIC_RELEASE_INVALID", "Public release requires index.html");
  const manifest = { formatVersion: 1, kind: "bootstrap", releaseId, createdAt: now.toISOString(), files };
  await writeFile(path.join(releaseDirectory, OPS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return manifest;
}

async function verifyBootstrapReleaseDirectory(releaseDirectory) {
  const { value: manifest } = await readManifestFile(path.join(releaseDirectory, OPS_MANIFEST), MAX_WISDOM_MANIFEST_BYTES);
  const currentFiles = await inventory(releaseDirectory, { exclude: new Set([OPS_MANIFEST]) });
  const paths = currentFiles.map((entry) => entry.path);
  if (
    !exactKeys(manifest, ["formatVersion", "kind", "releaseId", "createdAt", "files"]) ||
    manifest.formatVersion !== 1 ||
    manifest.kind !== "bootstrap" ||
    typeof manifest.releaseId !== "string" || !manifest.releaseId ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !exactKeys(manifest.files, Object.keys(manifest.files ?? {})) ||
    paths.join("\n") !== Object.keys(manifest.files ?? {}).sort((left, right) => left.localeCompare(right)).join("\n") ||
    !paths.includes("index.html")
  ) fail("PUBLIC_CURRENT_NOT_READY", "Bootstrap public release manifest contract failed");
  for (const entry of currentFiles) {
    if (!SHA256.test(manifest.files[entry.path] ?? "") || await sha256(path.join(releaseDirectory, ...entry.path.split("/"))) !== manifest.files[entry.path]) {
      fail("PUBLIC_CURRENT_NOT_READY", "Bootstrap public release file hash mismatch");
    }
  }
  return { manifestVerified: true, indexVerified: true, format: "ops-bootstrap", releaseId: manifest.releaseId };
}

async function verifyWisdomReleaseDirectory(releaseDirectory) {
  const manifestPath = path.join(releaseDirectory, WISDOM_MANIFEST);
  const { bytes, value: manifest } = await readManifestFile(manifestPath, MAX_WISDOM_MANIFEST_BYTES);
  if (bytes.toString("utf8") !== `${JSON.stringify(manifest, null, 2)}\n`) {
    fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release manifest is not canonical JSON");
  }
  if (
    !exactKeys(manifest, ["schemaVersion", "snapshotManifestSha256", "files"]) ||
    manifest.schemaVersion !== 1 ||
    !SHA256.test(manifest.snapshotManifestSha256 ?? "") ||
    !Array.isArray(manifest.files)
  ) fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release manifest schema is invalid");

  let previous = "";
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !exactKeys(file, ["path", "sha256", "size"]) ||
      typeof file.path !== "string" || file.path.length < 1 || file.path.startsWith("/") || file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      file.path === WISDOM_MANIFEST ||
      !SHA256.test(file.sha256 ?? "") ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_WISDOM_FILE_BYTES ||
      seen.has(file.path) || (previous && previous.localeCompare(file.path) >= 0)
    ) fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release manifest inventory is invalid");
    seen.add(file.path);
    previous = file.path;
  }

  const actualFiles = await inventory(releaseDirectory, {
    exclude: new Set([WISDOM_MANIFEST]),
    enforceWisdomLimits: true,
  });
  if (actualFiles.reduce((total, file) => total + file.size, 0) > MAX_WISDOM_RELEASE_BYTES || actualFiles.length !== manifest.files.length) {
    fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release inventory does not match its manifest");
  }
  for (let index = 0; index < actualFiles.length; index++) {
    const actual = actualFiles[index];
    const expected = manifest.files[index];
    if (actual.path !== expected.path || actual.size !== expected.size) {
      fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release inventory does not match its manifest");
    }
    if (await sha256(path.join(releaseDirectory, ...actual.path.split("/"))) !== expected.sha256) {
      fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release file hash mismatch");
    }
  }
  if (!actualFiles.some(({ path: relative }) => relative === "index.html")) {
    fail("PUBLIC_CURRENT_NOT_READY", "Wisdom release requires index.html");
  }
  return {
    manifestVerified: true,
    indexVerified: true,
    format: "wisdom",
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function verifyPublicReleaseDirectory(releaseDirectory, { allowBootstrap = false } = {}) {
  if (await exists(path.join(releaseDirectory, WISDOM_MANIFEST))) return verifyWisdomReleaseDirectory(releaseDirectory);
  if (allowBootstrap && await exists(path.join(releaseDirectory, OPS_MANIFEST))) return verifyBootstrapReleaseDirectory(releaseDirectory);
  fail("PUBLIC_CURRENT_NOT_READY", "A sealed Wisdom release is required");
}

async function rootContainsWisdomRelease(publicReleaseRoot) {
  for (const entry of await readdir(publicReleaseRoot, { withFileTypes: true })) {
    const candidate = path.join(publicReleaseRoot, entry.name);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) fail("PUBLIC_CURRENT_NOT_READY", "Public release root cannot contain symlinks");
    if (metadata.isDirectory() && await exists(path.join(candidate, WISDOM_MANIFEST))) return true;
  }
  return false;
}

export async function verifyPublicCurrent({ publicReleaseRoot, publicCurrentLink }) {
  await assertNoSymlinkPath(publicReleaseRoot, "PUBLIC_CURRENT_NOT_READY");
  await assertNoSymlinkPath(path.dirname(publicCurrentLink), "PUBLIC_CURRENT_NOT_READY");
  const rootMetadata = await lstat(publicReleaseRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("PUBLIC_CURRENT_NOT_READY", "Public release root must be a real directory");
  }
  const root = await realpath(publicReleaseRoot);
  if (path.resolve(await realpath(path.dirname(publicCurrentLink))) !== path.resolve(path.dirname(root))) {
    fail("PUBLIC_CURRENT_NOT_READY", "Public current pointer must be a sibling of its release root");
  }
  const pointer = await lstat(publicCurrentLink);
  if (!pointer.isSymbolicLink()) fail("PUBLIC_CURRENT_NOT_READY", "Public current pointer must be a symlink");
  const target = await realpath(publicCurrentLink);
  const relative = path.relative(root, target);
  if (
    relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ||
    path.resolve(path.dirname(target)) !== path.resolve(root)
  ) {
    fail("PUBLIC_CURRENT_NOT_READY", "Public current pointer escapes its release root");
  }
  if (await exists(path.join(target, WISDOM_MANIFEST))) return verifyWisdomReleaseDirectory(target);
  if (await rootContainsWisdomRelease(root)) {
    fail("PUBLIC_CURRENT_NOT_READY", "Bootstrap public release is forbidden after the first Wisdom publication");
  }
  return verifyPublicReleaseDirectory(target, { allowBootstrap: true });
}

export async function copyPublicDist(sourceDist, destination) {
  try {
    await cp(sourceDist, destination, { recursive: true, errorOnExist: true, force: false });
    await inventory(destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
