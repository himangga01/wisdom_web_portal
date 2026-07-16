import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { deployRelease, planRelease, rollbackRelease } from "../lib/release.mjs";

const volume = path.parse(process.cwd()).root;
const fixture = Object.freeze({
  sourceRoot: path.join(volume, "source", "wisdom-portal"),
  releaseRoot: path.join(volume, "srv", "wisdom-portal", "releases"),
  currentLink: path.join(volume, "srv", "wisdom-portal", "current"),
  releaseId: "20260716T010203Z-abcdef1",
  canaryPort: 18787,
});

function createAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      acquireOperationLock: async () => async () => undefined,
      preflight: async () => calls.push("preflight"),
      validatePaths: async () => calls.push("paths"),
      exists: async () => false,
      copySource: async () => calls.push("copy"),
      installDependencies: async () => calls.push("npm-ci"),
      build: async () => calls.push("build"),
      migrate: async () => calls.push("migrate"),
      prepareRuntime: async () => calls.push("prune-runtime"),
      writeManifest: async () => calls.push("manifest"),
      verify: async () => calls.push("verify"),
      startCanary: async () => {
        calls.push("start-canary");
        return { id: "canary" };
      },
      checkHealth: async () => calls.push("health"),
      stopCanary: async () => calls.push("stop-canary"),
      readCurrent: async () => {
        calls.push("read-current");
        return path.join(fixture.releaseRoot, "20260714T010203Z-1234567");
      },
      switchCurrent: async () => calls.push("switch"),
      restartServices: async () => calls.push("restart-services"),
      checkActiveHealth: async () => calls.push("active-health"),
      restoreCurrent: async () => calls.push("restore-current"),
      prune: async () => calls.push("prune"),
      removeIncomplete: async () => calls.push("remove-incomplete"),
      ...overrides,
    },
  };
}

test("release planning is dry-run by default and names every guarded phase", async () => {
  const { adapter, calls } = createAdapter();
  const result = await deployRelease(fixture, adapter);

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.steps, [
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
  assert.deepEqual(calls, []);
});

test("successful release switches only after install, migration, health, and verification", async () => {
  const { adapter, calls } = createAdapter();
  const result = await deployRelease({ ...fixture, dryRun: false }, adapter);

  assert.equal(result.releaseId, fixture.releaseId);
  assert.deepEqual(calls, [
    "paths",
    "preflight",
    "copy",
    "npm-ci",
    "build",
    "migrate",
    "prune-runtime",
    "manifest",
    "verify",
    "start-canary",
    "health",
    "stop-canary",
    "read-current",
    "switch",
    "restart-services",
    "active-health",
    "prune",
  ]);
  assert.ok(calls.indexOf("switch") > calls.indexOf("health"));
});

test("failed canary health preserves current and removes only the incomplete release", async () => {
  const { adapter, calls } = createAdapter({
    checkHealth: async () => {
      calls.push("health-failed");
      throw Object.assign(new Error("not ready"), { code: "CANARY_NOT_READY" });
    },
  });

  await assert.rejects(deployRelease({ ...fixture, dryRun: false }, adapter), { code: "CANARY_NOT_READY" });
  assert.deepEqual(calls.slice(-3), ["health-failed", "stop-canary", "remove-incomplete"]);
  assert.ok(!calls.includes("switch"));
  assert.ok(!calls.includes("prune"));
});

test("release rejects traversal, reused IDs, invalid ports, and unchecked pointer paths", async () => {
  assert.throws(() => planRelease({ ...fixture, releaseId: "../active" }), { code: "RELEASE_INPUT_INVALID" });
  assert.throws(() => planRelease({ ...fixture, canaryPort: 8787 }), { code: "RELEASE_INPUT_INVALID" });
  assert.throws(
    () => planRelease({ ...fixture, currentLink: path.join(volume, "other", "current") }),
    { code: "RELEASE_INPUT_INVALID" },
  );
  assert.throws(
    () => planRelease({ ...fixture, sourceRoot: path.dirname(fixture.releaseRoot) }),
    { code: "RELEASE_INPUT_INVALID" },
  );
  assert.throws(
    () => planRelease({ ...fixture, sourceRoot: path.join(fixture.releaseRoot, "source") }),
    { code: "RELEASE_INPUT_INVALID" },
  );

  const { adapter } = createAdapter({ exists: async () => true });
  await assert.rejects(deployRelease({ ...fixture, dryRun: false }, adapter), { code: "RELEASE_ALREADY_EXISTS" });
});

test("rollback validates a retained release and health before atomic switch", async () => {
  const { adapter, calls } = createAdapter({ exists: async () => true });
  const result = await rollbackRelease({
    releaseRoot: fixture.releaseRoot,
    currentLink: fixture.currentLink,
    releaseId: "20260715T010203Z-fedcba9",
    canaryPort: 18788,
    dryRun: false,
  }, adapter);

  assert.equal(result.releaseId, "20260715T010203Z-fedcba9");
  assert.deepEqual(calls, [
    "paths",
    "preflight",
    "verify",
    "start-canary",
    "health",
    "stop-canary",
    "read-current",
    "switch",
    "restart-services",
    "active-health",
  ]);
});

test("post-switch health failure restores the previous pointer and services", async () => {
  const { adapter, calls } = createAdapter({
    checkActiveHealth: async () => {
      calls.push("active-health-failed");
      throw Object.assign(new Error("active unhealthy"), { code: "ACTIVE_NOT_READY" });
    },
  });

  await assert.rejects(deployRelease({ ...fixture, dryRun: false }, adapter), { code: "ACTIVE_NOT_READY" });
  assert.deepEqual(calls.slice(-6), [
    "restart-services",
    "active-health-failed",
    "restore-current",
    "restart-services",
    "active-health-failed",
    "remove-incomplete",
  ]);
});

test("a pointer rename followed by fsync failure is observed and rolled back", async () => {
  const previous = path.join(fixture.releaseRoot, "20260714T010203Z-1234567");
  let active = previous;
  const { adapter, calls } = createAdapter({
    readCurrent: async () => {
      calls.push("read-current");
      return active;
    },
    switchCurrent: async (destination) => {
      calls.push("switch-renamed-then-failed");
      active = destination;
      throw Object.assign(new Error("directory fsync failed"), { code: "POINTER_FSYNC_FAILED" });
    },
    restoreCurrent: async (target) => {
      calls.push("restore-current");
      active = target;
    },
  });

  await assert.rejects(deployRelease({ ...fixture, dryRun: false }, adapter), { code: "POINTER_FSYNC_FAILED" });
  assert.equal(active, previous);
  assert.deepEqual(calls.slice(-5), [
    "read-current",
    "restore-current",
    "restart-services",
    "active-health",
    "remove-incomplete",
  ]);
});

test("prune failure reports a warning and never deletes the active release", async () => {
  const { adapter, calls } = createAdapter({
    prune: async () => {
      calls.push("prune-failed");
      throw Object.assign(new Error("retention failed"), { code: "PRUNE_FAILED" });
    },
  });

  const result = await deployRelease({ ...fixture, dryRun: false }, adapter);
  assert.deepEqual(result.warnings, ["RELEASE_PRUNE_FAILED"]);
  assert.ok(calls.includes("switch"));
  assert.ok(calls.includes("active-health"));
  assert.ok(!calls.includes("remove-incomplete"));
});

test("rollback cannot activate a retired release while deploy retention is pruning", async () => {
  let locked = false;
  let releasePrune;
  const pruneFinished = new Promise((resolve) => { releasePrune = resolve; });
  let signalPrune;
  const pruneStarted = new Promise((resolve) => { signalPrune = resolve; });
  const acquireOperationLock = async () => {
    if (locked) {
      throw Object.assign(new Error("release operation in progress"), { code: "RELEASE_OPERATION_LOCKED" });
    }
    locked = true;
    return async () => { locked = false; };
  };
  const deploy = createAdapter({
    acquireOperationLock,
    prune: async () => {
      signalPrune();
      await pruneFinished;
    },
  });
  const rollback = createAdapter({ acquireOperationLock, exists: async () => true });

  const deployment = deployRelease({ ...fixture, dryRun: false }, deploy.adapter);
  await pruneStarted;
  await assert.rejects(rollbackRelease({
    releaseRoot: fixture.releaseRoot,
    currentLink: fixture.currentLink,
    releaseId: "20260715T010203Z-fedcba9",
    canaryPort: 18788,
    dryRun: false,
  }, rollback.adapter), { code: "RELEASE_OPERATION_LOCKED" });
  releasePrune();
  await deployment;
  assert.equal(locked, false);
});

test("rollback failure never switches the active pointer", async () => {
  const { adapter, calls } = createAdapter({
    exists: async () => true,
    verify: async () => {
      calls.push("verify-failed");
      throw Object.assign(new Error("manifest mismatch"), { code: "RELEASE_MANIFEST_INVALID" });
    },
  });

  await assert.rejects(rollbackRelease({
    releaseRoot: fixture.releaseRoot,
    currentLink: fixture.currentLink,
    releaseId: "20260715T010203Z-fedcba9",
    canaryPort: 18788,
    dryRun: false,
  }, adapter), { code: "RELEASE_MANIFEST_INVALID" });
  assert.ok(!calls.includes("switch"));
});
