import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicSwitchRelease,
  copyReleaseSource,
  createReleaseManifest,
  pruneRetainedReleases,
  removeIncompleteRelease,
  validateReleaseFilesystem,
  verifyReleaseManifest,
} from "../lib/release-system.mjs";

async function releaseFixture() {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "wisdom-release-system-"));
  const sourceRoot = path.join(appRoot, "source");
  const releaseRoot = path.join(appRoot, "deployed", "releases");
  const currentLink = path.join(appRoot, "deployed", "current");
  const releaseId = "20260716T010203Z-abcdef1";
  const destination = path.join(releaseRoot, releaseId);
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(releaseRoot, { recursive: true });
  return { appRoot, sourceRoot, releaseRoot, currentLink, releaseId, destination };
}

const minimalRuntimeFiles = [
  "package.json",
  "package-lock.json",
  "apps/control/package.json",
  "apps/control/dist/server.js",
  "apps/control/dist/notification-worker.js",
  "apps/control/dist/content-worker.js",
  "apps/site/package.json",
  "apps/site/dist/index.html",
  "apps/site/dist/_astro/app.Abc_123.js",
  "packages/shared/package.json",
  "packages/shared/dist/index.js",
  "ops/lib/runtime-config.mjs",
  "ops/scripts/backup.mjs",
  "ops/scripts/deploy.mjs",
  "ops/scripts/keychain-exec.mjs",
  "ops/scripts/preflight.mjs",
  "ops/scripts/restore.mjs",
  "ops/scripts/rollback.mjs",
  "ops/scripts/secret-import.mjs",
  "ops/scripts/seed-public.mjs",
];

async function populateRelease(destination, releaseId) {
  for (const relative of minimalRuntimeFiles) {
    const absolute = path.join(destination, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, relative);
  }
  await createReleaseManifest(destination, releaseId, new Date("2026-07-16T01:02:03.000Z"));
}

test("release filesystem validation rejects symlink roots and realpath overlap", async (t) => {
  const fixture = await releaseFixture();
  await assert.rejects(validateReleaseFilesystem({
    ...fixture,
    sourceRoot: path.dirname(fixture.releaseRoot),
  }), { code: "RELEASE_PATH_UNSAFE" });

  const sourceLink = path.join(fixture.appRoot, "source-link");
  try {
    await symlink(fixture.sourceRoot, sourceLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  await assert.rejects(validateReleaseFilesystem({ ...fixture, sourceRoot: sourceLink }), { code: "RELEASE_PATH_UNSAFE" });
});

test("source copy excludes native installs, VCS, local data, secrets, and worktrees", async () => {
  const fixture = await releaseFixture();
  for (const relative of [
    "package.json",
    "apps/site/src/page.txt",
    "node_modules/native.node",
    ".git/config",
    ".worktrees/other/file",
    "data/portal.sqlite",
    ".env",
    ".env.production",
    ".superpowers/progress.md",
    "research/private-notes.md",
    "prototypes/demo/index.html",
    "docs/internal.md",
    "ops/tests/private-fixture.test.mjs",
    "ops/runbooks/operator-only.md",
    "ops/caddy/Caddyfile.template",
    "ops/lib/runtime.mjs",
    "ops/scripts/deploy.mjs",
  ]) {
    const absolute = path.join(fixture.sourceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, relative);
  }

  await copyReleaseSource(fixture.sourceRoot, fixture.destination);
  assert.equal(await readFile(path.join(fixture.destination, "package.json"), "utf8"), "package.json");
  assert.equal(await readFile(path.join(fixture.destination, "apps/site/src/page.txt"), "utf8"), "apps/site/src/page.txt");
  const copied = await readdir(fixture.destination);
  assert.ok(!copied.includes("node_modules"));
  assert.ok(!copied.includes(".git"));
  assert.ok(!copied.includes(".worktrees"));
  assert.ok(!copied.includes("data"));
  assert.ok(!copied.some((name) => name.startsWith(".env")));
  assert.ok(!copied.includes(".superpowers"));
  assert.ok(!copied.includes("research"));
  assert.ok(!copied.includes("prototypes"));
  assert.ok(!copied.includes("docs"));
  assert.equal(await readFile(path.join(fixture.destination, "ops", "lib", "runtime.mjs"), "utf8"), "ops/lib/runtime.mjs");
  assert.equal(await readFile(path.join(fixture.destination, "ops", "scripts", "deploy.mjs"), "utf8"), "ops/scripts/deploy.mjs");
  assert.deepEqual((await readdir(path.join(fixture.destination, "ops"))).sort(), ["lib", "scripts"]);
});

test("source copy rejects any included symlink before creating a release", async (t) => {
  const fixture = await releaseFixture();
  const external = path.join(fixture.appRoot, "external-secret.txt");
  const link = path.join(fixture.sourceRoot, "apps", "control", "external-link.txt");
  await writeFile(external, "must-never-enter-release");
  await mkdir(path.dirname(link), { recursive: true });
  try {
    await symlink(external, link, "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }

  await assert.rejects(copyReleaseSource(fixture.sourceRoot, fixture.destination), { code: "RELEASE_PATH_UNSAFE" });
  await assert.rejects(readdir(fixture.destination), { code: "ENOENT" });
});

test("release manifest binds the required built artifacts and detects tampering", async () => {
  const fixture = await releaseFixture();
  await populateRelease(fixture.destination, fixture.releaseId);
  await verifyReleaseManifest(fixture.destination, fixture.releaseId);
  await writeFile(path.join(fixture.destination, "apps/control/dist/notification-worker.js"), "tampered");
  await assert.rejects(verifyReleaseManifest(fixture.destination, fixture.releaseId), { code: "RELEASE_MANIFEST_INVALID" });
});

test("atomic pointer switch creates a sibling symlink then renames it", async () => {
  const calls = [];
  const root = path.parse(process.cwd()).root;
  const destination = path.join(root, "srv", "portal", "releases", "20260716T010203Z-abcdef1");
  const currentLink = path.join(root, "srv", "portal", "current");
  const fileSystem = {
    symlink: async (target, link, type) => calls.push(["symlink", target, link, type]),
    rename: async (from, to) => calls.push(["rename", from, to]),
    rm: async (target) => calls.push(["rm", target]),
    syncDirectory: async (directory) => calls.push(["sync", directory]),
  };

  await atomicSwitchRelease(destination, currentLink, { fileSystem, temporaryName: ".current-next-fixture" });
  assert.deepEqual(calls, [
    ["symlink", destination, path.join(path.dirname(currentLink), ".current-next-fixture"), "dir"],
    ["rename", path.join(path.dirname(currentLink), ".current-next-fixture"), currentLink],
    ["sync", path.dirname(currentLink)],
  ]);
});

test("retention removes only old validated release directories and never active", async () => {
  const fixture = await releaseFixture();
  const releases = [
    "20260713T010203Z-1111111",
    "20260714T010203Z-2222222",
    "20260715T010203Z-3333333",
    "20260716T010203Z-4444444",
  ];
  for (const release of releases) await populateRelease(path.join(fixture.releaseRoot, release), release);
  const invalidRelease = "20260712T010203Z-0000000";
  await mkdir(path.join(fixture.releaseRoot, invalidRelease));
  await mkdir(path.join(fixture.releaseRoot, "operator-notes"));

  const result = await pruneRetainedReleases(fixture.releaseRoot, {
    active: path.join(fixture.releaseRoot, releases[3]),
    keepRetired: 2,
  });
  const names = await readdir(fixture.releaseRoot);
  assert.deepEqual(result.deleted, [releases[0]]);
  assert.deepEqual(result.skippedInvalid, [invalidRelease]);
  assert.ok(names.includes(releases[3]));
  assert.ok(names.includes(releases[2]));
  assert.ok(names.includes(releases[1]));
  assert.ok(names.includes("operator-notes"));
  assert.ok(names.includes(invalidRelease));
});

test("incomplete cleanup refuses the active pointer target", async (t) => {
  const fixture = await releaseFixture();
  await mkdir(fixture.destination);
  try {
    await symlink(fixture.destination, fixture.currentLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  await assert.rejects(removeIncompleteRelease(fixture.releaseRoot, fixture.destination, fixture.currentLink), {
    code: "RELEASE_PATH_UNSAFE",
  });
});
