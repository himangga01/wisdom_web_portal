import path from "node:path";

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

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version ?? "");
  if (!match) fail("INVALID_RUNTIME_VERSION", `Invalid runtime version: ${version ?? "missing"}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function validatePaths(config) {
  const roots = [config.releaseRoot, config.dataRoot, config.publicReleaseRoot, config.publicCurrentLink];
  if (roots.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate))) {
    fail("PREFLIGHT_PATH_INVALID", "Release and data roots must be absolute");
  }
  if (
    normalized(config.releaseRoot) === normalized(config.dataRoot) ||
    inside(config.releaseRoot, config.dataRoot) ||
    inside(config.dataRoot, config.releaseRoot)
  ) {
    fail("PREFLIGHT_PATH_INVALID", "Release and data roots must not overlap");
  }
  if (
    normalized(config.publicReleaseRoot) === normalized(config.releaseRoot) ||
    inside(config.publicReleaseRoot, config.releaseRoot) ||
    inside(config.releaseRoot, config.publicReleaseRoot) ||
    normalized(config.publicCurrentLink) === normalized(config.releaseRoot)
  ) {
    fail("PREFLIGHT_PATH_INVALID", "Application and public release paths must remain isolated");
  }
  for (const [name, binary] of Object.entries(config.binaries ?? {})) {
    if (!path.isAbsolute(binary)) fail("PREFLIGHT_PATH_INVALID", `${name} executable must be absolute`);
  }
  if (!config.binaries?.caddy || !config.binaries?.cloudflared || !config.binaries?.age) {
    fail("PREFLIGHT_PATH_INVALID", "Caddy, cloudflared, and age executables are required");
  }
}

export async function runPreflight(config, adapter) {
  validatePaths(config);
  if (adapter.platform !== "darwin" || adapter.arch !== "arm64") {
    fail("UNSUPPORTED_ARCHITECTURE", "Deployment requires an Apple-silicon macOS host");
  }
  if (parseVersion(adapter.nodeVersion)[0] !== 24) {
    fail("UNSUPPORTED_NODE_VERSION", "Deployment requires Node.js major version 24");
  }

  await adapter.ensureWritable(config.releaseRoot);
  await adapter.ensureWritable(config.dataRoot);
  await adapter.loadNativeModule("better-sqlite3");

  const checkedBinaries = [];
  for (const [name, binary] of Object.entries(config.binaries).sort(([a], [b]) => a.localeCompare(b))) {
    await adapter.inspectBinary(name, binary);
    checkedBinaries.push(name);
  }

  const sqliteVersion = await adapter.sqliteVersion();
  const sqliteMinimum = config.sqliteMinimum ?? "3.51.3";
  if (compareVersions(sqliteVersion, sqliteMinimum) < 0) {
    fail("UNSAFE_SQLITE_VERSION", `SQLite ${sqliteMinimum} or newer is required`);
  }
  const publicSite = await adapter.verifyPublicCurrent({
    publicReleaseRoot: config.publicReleaseRoot,
    publicCurrentLink: config.publicCurrentLink,
  });

  return {
    ok: true,
    architecture: adapter.arch,
    nodeVersion: adapter.nodeVersion,
    sqliteVersion,
    checkedBinaries,
    publicSite,
  };
}
