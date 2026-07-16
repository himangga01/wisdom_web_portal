import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const opsRoot = path.resolve(import.meta.dirname, "..");
const drive = path.parse(process.cwd()).root;

async function dryRun(script, args) {
  const { stdout, stderr } = await execute(process.execPath, [path.join(opsRoot, "scripts", script), ...args], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(stderr, "");
  const value = JSON.parse(stdout);
  assert.equal(value.dryRun, true);
  return value;
}

test("backup CLI dry-run needs no SQLite, age binary, identity, or filesystem writes", async () => {
  const result = await dryRun("backup.mjs", [
    "--source", path.join(drive, "fixture", "portal.sqlite"),
    "--root", path.join(drive, "fixture", "backups"),
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
    "--recipient", "age1fixtureoperator",
  ]);
  assert.equal(result.action, "online-encrypted-backup");
  assert.equal(result.retention.hourly, 24);
  assert.equal(result.retention.daily, 14);
});

test("restore CLI is dry-run unless both apply and exact confirmation are supplied", async () => {
  const backupRoot = path.join(drive, "fixture", "backups");
  const result = await dryRun("restore.mjs", [
    "--backup-root", backupRoot,
    "--backup", path.join(backupRoot, "hourly-20260716T010203Z.age"),
    "--target", path.join(drive, "fixture", "data", "portal.sqlite"),
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
  ]);
  assert.match(result.steps.join(" "), /assert-services-stopped/);
});

test("deploy and rollback CLIs default to plans without invoking macOS tools", async () => {
  const releaseRoot = path.join(drive, "fixture", "portal", "releases");
  const common = [
    "--release-root", releaseRoot,
    "--current", path.join(drive, "fixture", "portal", "current"),
    "--release-id", "20260716T010203Z-abcdef1",
    "--canary-port", "18787",
  ];
  const release = await dryRun("deploy.mjs", ["--source", path.join(drive, "fixture", "source"), ...common]);
  const rollback = await dryRun("rollback.mjs", common);
  assert.match(release.steps.join(" "), /npm-ci-on-arm64-host/);
  assert.match(rollback.steps.join(" "), /verify-release-and-migrations/);
});

test("public bootstrap CLI plans a distinct verified public release", async () => {
  const result = await dryRun("seed-public.mjs", [
    "--source-dist", path.join(drive, "fixture", "app", "apps", "site", "dist"),
    "--public-release-root", path.join(drive, "fixture", "portal", "public-releases"),
    "--public-current", path.join(drive, "fixture", "portal", "public-current"),
    "--release-id", "20260716T010203Z-abcdef1",
  ]);
  assert.equal(result.action, "seed-public-current");
  assert.doesNotMatch(result.destination, /\\current(?:\\|$)/i);
});

test("age identity import dry-run never requires or prints the identity", async () => {
  const result = await dryRun("secret-import.mjs", ["--account", "wisdom"]);
  assert.equal(result.action, "import-age-identity");
  assert.equal(result.service, "com.jihye.portal.age-identity");
  assert.doesNotMatch(JSON.stringify(result), /AGE-SECRET-KEY/);
});

test("Codex API import dry-run exposes only the Keychain reference", async () => {
  const result = await dryRun("secret-import.mjs", [
    "--account", "wisdom",
    "--kind", "codex-api",
    "--service", "com.jihye.portal.codex-api",
  ]);
  assert.equal(result.action, "import-codex-api");
  assert.equal(result.service, "com.jihye.portal.codex-api");
  assert.doesNotMatch(JSON.stringify(result), /CODEX_API_KEY|sk-/u);
});

test("IndexNow ownership key import dry-run exposes only the Keychain reference", async () => {
  const result = await dryRun("secret-import.mjs", [
    "--account", "wisdom",
    "--kind", "indexnow-key",
    "--service", "com.jihye.portal.indexnow",
  ]);
  assert.equal(result.action, "import-indexnow-key");
  assert.equal(result.service, "com.jihye.portal.indexnow");
  assert.doesNotMatch(JSON.stringify(result), /ownership|INDEXNOW_KEY=/u);
});

test("SMTP JSON import dry-run exposes only the Keychain reference", async () => {
  const result = await dryRun("secret-import.mjs", [
    "--account", "wisdom",
    "--kind", "smtp-json",
    "--service", "com.jihye.portal.smtp-owner",
  ]);
  assert.equal(result.action, "import-smtp-json");
  assert.equal(result.service, "com.jihye.portal.smtp-owner");
  assert.doesNotMatch(JSON.stringify(result), /password|owner@/u);
});

test("restore apply refuses a directly supplied age identity outside keychain-exec", async () => {
  const backupRoot = path.join(drive, "fixture", "backups");
  const target = path.join(drive, "fixture", "data", "portal.sqlite");
  await assert.rejects(execute(process.execPath, [
    path.join(opsRoot, "scripts", "restore.mjs"),
    "--backup-root", backupRoot,
    "--backup", path.join(backupRoot, "hourly-20260716T010203Z.age"),
    "--target", target,
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
    "--confirm-destroy", target,
    "--apply",
  ], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH, AGE_IDENTITY: "AGE-SECRET-KEY-OPERATOR" },
    timeout: 10_000,
    windowsHide: true,
  }), (error) => {
    assert.match(error.stderr, /RESTORE_KEYCHAIN_EXEC_REQUIRED/u);
    assert.doesNotMatch(error.stderr, /AGE-SECRET-KEY/u);
    return true;
  });
});
