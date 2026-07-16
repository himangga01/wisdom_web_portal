import path from "node:path";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalized(candidate, platform = process.platform) {
  const resolved = path.resolve(candidate);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function inside(parent, child, platform) {
  const relative = path.relative(normalized(parent, platform), normalized(child, platform));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function overlaps(left, right, platform) {
  return normalized(left, platform) === normalized(right, platform) ||
    inside(left, right, platform) || inside(right, left, platform);
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

function binaryInspectionText(inspection) {
  if (typeof inspection === "string") return inspection;
  if (Buffer.isBuffer(inspection)) return inspection.toString("utf8");
  if (inspection && typeof inspection === "object") {
    const stdout = Buffer.isBuffer(inspection.stdout)
      ? inspection.stdout.toString("utf8")
      : String(inspection.stdout ?? "");
    const stderr = Buffer.isBuffer(inspection.stderr)
      ? inspection.stderr.toString("utf8")
      : String(inspection.stderr ?? "");
    return `${stdout}\n${stderr}`;
  }
  return "";
}

function parseAgeVersion(inspection) {
  const match = /(?:^|\s)(?:age\s+)?v?(\d+\.\d+\.\d+)(?=$|\s)/imu.exec(binaryInspectionText(inspection));
  if (!match) fail("INVALID_AGE_VERSION", "The age binary did not report a valid semantic version");
  return match[1];
}

function expectedAgeVersion(configured) {
  const value = String(configured ?? "");
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    fail("INVALID_AGE_VERSION", "An exact age semantic version pin is required");
  }
  return value;
}

function validatePaths(config, platform) {
  const roots = [
    config.releaseRoot,
    config.currentLink,
    config.dataRoot,
    config.publicReleaseRoot,
    config.publicCurrentLink,
  ];
  if (roots.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate))) {
    fail("PREFLIGHT_PATH_INVALID", "Release, current-pointer, and data paths must be absolute");
  }
  if (overlaps(config.releaseRoot, config.dataRoot, platform)) {
    fail("PREFLIGHT_PATH_INVALID", "Release and data roots must not overlap");
  }
  const deploymentPaths = [
    config.releaseRoot,
    config.currentLink,
    config.dataRoot,
    config.publicReleaseRoot,
    config.publicCurrentLink,
  ];
  for (let left = 0; left < deploymentPaths.length; left++) {
    for (let right = left + 1; right < deploymentPaths.length; right++) {
      if (overlaps(deploymentPaths[left], deploymentPaths[right], platform)) {
        fail("PREFLIGHT_PATH_INVALID", "Application, data, and public deployment paths must remain isolated");
      }
    }
  }
  for (const [name, binary] of Object.entries(config.binaries ?? {})) {
    if (!path.isAbsolute(binary)) fail("PREFLIGHT_PATH_INVALID", `${name} executable must be absolute`);
  }
  if (!config.binaries?.caddy || !config.binaries?.cloudflared || !config.binaries?.age) {
    fail("PREFLIGHT_PATH_INVALID", "Caddy, cloudflared, and age executables are required");
  }
}

export async function runPreflight(config, adapter) {
  validatePaths(config, adapter.platform);
  const requiredAgeVersion = expectedAgeVersion(config.ageVersion);
  if (adapter.platform !== "darwin" || adapter.arch !== "arm64") {
    fail("UNSUPPORTED_ARCHITECTURE", "Deployment requires an Apple-silicon macOS host");
  }
  if (parseVersion(adapter.nodeVersion)[0] !== 24) {
    fail("UNSUPPORTED_NODE_VERSION", "Deployment requires Node.js major version 24");
  }

  await adapter.ensureWritable(config.releaseRoot);
  await adapter.ensureWritable(config.dataRoot);
  if (typeof adapter.canonicalDeploymentPaths !== "function") {
    fail("PREFLIGHT_PATH_INVALID", "Canonical deployment path verification is required");
  }
  const canonicalPaths = await adapter.canonicalDeploymentPaths({
    releaseRoot: config.releaseRoot,
    currentLink: config.currentLink,
    dataRoot: config.dataRoot,
    publicReleaseRoot: config.publicReleaseRoot,
    publicCurrentLink: config.publicCurrentLink,
  });
  validatePaths({ ...config, ...canonicalPaths }, adapter.platform);
  await adapter.loadNativeModule("better-sqlite3");

  const checkedBinaries = [];
  let ageVersion;
  for (const [name, binary] of Object.entries(config.binaries).sort(([a], [b]) => a.localeCompare(b))) {
    const inspection = await adapter.inspectBinary(name, binary);
    if (name === "age") {
      ageVersion = parseAgeVersion(inspection);
      if (ageVersion !== requiredAgeVersion) {
        fail(
          "UNSUPPORTED_AGE_VERSION",
          `age ${requiredAgeVersion} is required; found ${ageVersion}`,
        );
      }
    }
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
    ageVersion,
    checkedBinaries,
    publicSite,
  };
}
