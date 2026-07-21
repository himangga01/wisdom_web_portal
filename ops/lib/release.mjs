import path from "node:path";

const RELEASE_ID = /^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/u;
const DEPLOY_STEPS = Object.freeze([
  "preflight",
  "copy-source-without-node_modules",
  "npm-ci-on-arm64-host",
  "build",
  "migrate",
  "prune-to-production-runtime",
  "start-loopback-canary",
  "check-live-and-ready",
  "verify-release",
  "atomic-switch",
  "restart-launchd-services",
  "check-active-public-and-control",
  "retain-active-plus-two-retired",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function rollbackFailure(operation, cause, recoveryCause) {
  const error = new Error(
    `${operation} failed after the release pointer changed and the previous release could not be recovered`,
    { cause },
  );
  error.code = "RELEASE_ROLLBACK_FAILED";
  error.recoveryCause = recoveryCause;
  return error;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateCommon(input) {
  for (const [name, candidate] of Object.entries({
    releaseRoot: input.releaseRoot,
    currentLink: input.currentLink,
  })) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      fail("RELEASE_INPUT_INVALID", `${name} must be absolute`);
    }
  }
  if (!RELEASE_ID.test(input.releaseId ?? "")) {
    fail("RELEASE_INPUT_INVALID", "Release ID must be a timestamp plus lowercase git hash");
  }
  if (!Number.isInteger(input.canaryPort) || input.canaryPort < 10_000 || input.canaryPort > 65_535) {
    fail("RELEASE_INPUT_INVALID", "Canary port must be an unprivileged dedicated port");
  }
  if (
    path.basename(input.currentLink) !== "current" ||
    !samePath(path.dirname(input.currentLink), path.dirname(input.releaseRoot)) ||
    path.basename(input.releaseRoot) !== "releases"
  ) {
    fail("RELEASE_INPUT_INVALID", "Current pointer must be the sibling of the releases directory");
  }
  const destination = path.join(input.releaseRoot, input.releaseId);
  const relative = path.relative(path.resolve(input.releaseRoot), path.resolve(destination));
  if (relative !== input.releaseId || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("RELEASE_INPUT_INVALID", "Release destination escapes its configured root");
  }
  return destination;
}

export function planRelease(input) {
  if (typeof input.sourceRoot !== "string" || !path.isAbsolute(input.sourceRoot)) {
    fail("RELEASE_INPUT_INVALID", "Source root must be absolute");
  }
  const destination = validateCommon(input);
  if (samePath(input.sourceRoot, input.releaseRoot) || isInside(input.sourceRoot, input.releaseRoot) || isInside(input.releaseRoot, input.sourceRoot)) {
    fail("RELEASE_INPUT_INVALID", "Source root must remain outside the release root");
  }
  return {
    dryRun: input.dryRun !== false,
    releaseId: input.releaseId,
    destination,
    currentLink: path.resolve(input.currentLink),
    canaryOrigin: `http://127.0.0.1:${input.canaryPort}`,
    steps: [...DEPLOY_STEPS],
  };
}

export async function deployRelease(input, adapter) {
  const plan = planRelease(input);
  if (plan.dryRun) return plan;
  await adapter.validatePaths({ ...input, destination: plan.destination });
  const releaseOperationLock = await adapter.acquireOperationLock(input.releaseRoot);
  try {
    return await deployReleaseLocked(input, adapter, plan);
  } finally {
    await releaseOperationLock();
  }
}

async function deployReleaseLocked(input, adapter, plan) {
  if (await adapter.exists(plan.destination)) {
    fail("RELEASE_ALREADY_EXISTS", "Release destination already exists");
  }

  let destinationCreated = false;
  let canary;
  let switched = false;
  let previous;
  try {
    await adapter.preflight({ ...input, plan });
    await adapter.copySource(input.sourceRoot, plan.destination);
    destinationCreated = true;
    await adapter.installDependencies(plan.destination);
    await adapter.build(plan.destination);
    await adapter.migrate(plan.destination);
    await adapter.prepareRuntime(plan.destination);
    await adapter.writeManifest(plan.destination, { releaseId: input.releaseId });
    await adapter.verify(plan.destination, { releaseId: input.releaseId });
    canary = await adapter.startCanary(plan.destination, input.canaryPort);
    await adapter.checkHealth(plan.canaryOrigin, canary);
    await adapter.stopCanary(canary);
    canary = undefined;
    previous = await adapter.readCurrent(plan.currentLink);
    try {
      await adapter.switchCurrent(plan.destination, plan.currentLink);
      switched = true;
    } catch (error) {
      try {
        const observed = await adapter.readCurrent(plan.currentLink);
        switched = typeof observed === "string" && samePath(observed, plan.destination);
      } catch {
        // A failed observation remains fail-closed; active cleanup rechecks the pointer.
      }
      throw error;
    }
    await adapter.restartServices();
    await adapter.checkActiveHealth();
    try {
      await adapter.prune(input.releaseRoot, { active: plan.destination, keepRetired: 2 });
      return { ...plan, dryRun: false, warnings: [] };
    } catch {
      return { ...plan, dryRun: false, warnings: ["RELEASE_PRUNE_FAILED"] };
    }
  } catch (error) {
    if (canary !== undefined) {
      try {
        await adapter.stopCanary(canary);
      } catch {
        // Preserve the original deployment error; the operator receives its code.
      }
    }
    let pointerRestored = !switched;
    let recoveryCause;
    if (switched) {
      try {
        await adapter.restoreCurrent(previous, plan.currentLink);
        pointerRestored = true;
        await adapter.restartServices();
        await adapter.checkActiveHealth();
      } catch (recoveryError) {
        recoveryCause = recoveryError;
      }
    }
    if (destinationCreated && pointerRestored) {
      try {
        await adapter.removeIncomplete(plan.destination);
      } catch {
        // Preserve the deployment failure; cleanup is fail-closed against an active pointer.
      }
    }
    if (recoveryCause !== undefined) {
      throw rollbackFailure("Deployment", error, recoveryCause);
    }
    throw error;
  }
}

export async function rollbackRelease(input, adapter) {
  const destination = validateCommon(input);
  const plan = {
    dryRun: input.dryRun !== false,
    releaseId: input.releaseId,
    destination,
    currentLink: path.resolve(input.currentLink),
    canaryOrigin: `http://127.0.0.1:${input.canaryPort}`,
    steps: ["preflight", "verify-release-and-migrations", "start-loopback-canary", "check-live-and-ready", "atomic-switch", "restart-launchd-services", "check-active-public-and-control"],
  };
  if (plan.dryRun) return plan;
  await adapter.validatePaths({ ...input, destination, rollback: true });
  const releaseOperationLock = await adapter.acquireOperationLock(input.releaseRoot);
  try {
    return await rollbackReleaseLocked(input, adapter, plan, destination);
  } finally {
    await releaseOperationLock();
  }
}

async function rollbackReleaseLocked(input, adapter, plan, destination) {
  if (!(await adapter.exists(destination))) {
    fail("RELEASE_NOT_RETAINED", "Rollback release is not retained");
  }

  await adapter.preflight({ ...input, plan, rollback: true });
  await adapter.verify(destination, { releaseId: input.releaseId, rollback: true });
  let canary;
  let switched = false;
  let previous;
  try {
    canary = await adapter.startCanary(destination, input.canaryPort);
    await adapter.checkHealth(plan.canaryOrigin, canary);
    await adapter.stopCanary(canary);
    canary = undefined;
    previous = await adapter.readCurrent(plan.currentLink);
    try {
      await adapter.switchCurrent(destination, plan.currentLink);
      switched = true;
    } catch (error) {
      try {
        const observed = await adapter.readCurrent(plan.currentLink);
        switched = typeof observed === "string" && samePath(observed, destination);
      } catch {
        // A failed observation remains fail-closed and the retained releases are preserved.
      }
      throw error;
    }
    await adapter.restartServices();
    await adapter.checkActiveHealth();
    return { ...plan, dryRun: false };
  } catch (error) {
    if (canary !== undefined) {
      try {
        await adapter.stopCanary(canary);
      } catch {
        // Preserve the original rollback error.
      }
    }
    let recoveryCause;
    if (switched) {
      try {
        await adapter.restoreCurrent(previous, plan.currentLink);
        await adapter.restartServices();
        await adapter.checkActiveHealth();
      } catch (recoveryError) {
        recoveryCause = recoveryError;
      }
    }
    if (recoveryCause !== undefined) {
      throw rollbackFailure("Rollback", error, recoveryCause);
    }
    throw error;
  }
}
