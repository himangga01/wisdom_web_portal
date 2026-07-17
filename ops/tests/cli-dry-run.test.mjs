import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
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

function dispatcherArgs() {
  const source = path.join(drive, "fixture", "data", "portal.sqlite");
  const root = path.join(drive, "fixture", "backups");
  const scripts = path.join(drive, "fixture", "current", "ops", "scripts");
  return [
    "--source", source,
    "--root", root,
    "--run-state", path.join(path.dirname(source), "backup-run-state.json"),
    "--",
    process.execPath,
    path.join(scripts, "keychain-exec.mjs"),
    "--account", "wisdom",
    "--config", path.join(drive, "fixture", "shared", "runtime.env"),
    "--secret", "AGE_IDENTITY=com.jihye.portal.age-identity",
    "--",
    process.execPath,
    path.join(scripts, "backup.mjs"),
    "--source", source,
    "--root", root,
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
    "--recipient", "age1fixtureoperator",
    "--automatic",
    "--apply",
  ];
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
  assert.equal(result.automatic, false);
  assert.equal(result.retention.hourly, 24);
  assert.equal(result.retention.daily, 14);
});

test("backup CLI accepts automatic exactly once and exposes only the dry-run mode", async () => {
  const args = [
    "--source", path.join(drive, "fixture", "portal.sqlite"),
    "--root", path.join(drive, "fixture", "backups"),
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
    "--recipient", "age1fixtureoperator",
  ];
  const result = await dryRun("backup.mjs", [...args, "--automatic"]);
  assert.equal(result.automatic, true);
  assert.doesNotMatch(JSON.stringify(result), /AGE_IDENTITY|AGE-SECRET|keychain/iu);

  for (const invalid of [
    [...args, "--automatic", "--automatic"],
    [...args, "--automatic=true"],
    [...args, "--unknown"],
    [...args, "--apply", "--apply"],
  ]) {
    await assert.rejects(execute(process.execPath, [
      path.join(opsRoot, "scripts", "backup.mjs"),
      ...invalid,
    ], {
      cwd: path.dirname(opsRoot),
      env: { PATH: process.env.PATH },
      timeout: 10_000,
      windowsHide: true,
    }), (error) => {
      assert.match(error.stderr, /CLI_USAGE/u);
      return true;
    });
  }
});

test("backup apply refuses a directly supplied age identity outside keychain-exec", async () => {
  await assert.rejects(execute(process.execPath, [
    path.join(opsRoot, "scripts", "backup.mjs"),
    "--source", path.join(drive, "fixture", "portal.sqlite"),
    "--root", path.join(drive, "fixture", "backups"),
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
    "--recipient", "age1fixtureoperator",
    "--automatic",
    "--apply",
  ], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH, AGE_IDENTITY: "AGE-SECRET-KEY-OPERATOR" },
    timeout: 10_000,
    windowsHide: true,
  }), (error) => {
    assert.match(error.stderr, /BACKUP_KEYCHAIN_EXEC_REQUIRED/u);
    assert.doesNotMatch(error.stderr, /AGE-SECRET-KEY/u);
    return true;
  });
});

test("backup dispatcher dry-run validates fixed child argv without SQLite, Keychain, or filesystem access", async () => {
  const args = dispatcherArgs();
  const result = await dryRun("backup-dispatcher.mjs", args);
  assert.deepEqual(result, {
    dryRun: true,
    action: "dispatch-automatic-backup",
    intervalSeconds: 60,
    child: "keychain-exec",
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /AGE_IDENTITY|age-identity|portal\.sqlite|runtime\.env/iu);
  assert.equal(serialized.includes(args[1]), false);
});

test("monitor CLI validates an absolute config without checks, secrets, or sends", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-cli-")));
  const configPath = path.join(root, "monitoring.json");
  await writeFile(configPath, JSON.stringify({
    externalPublic: {
      url: "https://www.example.test/health/live",
      expectedStatus: 200,
      expectedText: "ok",
      source: "outside-mac-and-lan",
    },
    local: {
      backupRoot: path.join(root, "backups"),
      databasePath: path.join(root, "data", "portal.sqlite"),
      diskPath: path.join(root, "data"),
      incidentState: {
        path: path.join(root, "data", "monitor-incident-state.json"),
        cooldownMinutes: 30,
      },
      controlReadyUrl: "http://127.0.0.1:8787/health/ready",
      requiredRunningLaunchdLabels: ["com.jihye.portal.control"],
      thresholds: {
        backupFreshnessMinutes: 90,
        backupResumeGraceMinutes: 10,
        diskFreePercentMinimum: 15,
        queueStallMinutes: 15,
        retentionOverdueMaximum: 0,
        notificationFailureBacklogMaximum: 0,
        translationFailureBacklogMaximum: 0,
        publicationFailureBacklogMaximum: 0,
        indexNowFailureBacklogMaximum: 0,
      },
      timeouts: { overallMs: 15_000, checkMs: 3_000, hermesRequestMs: 2_000 },
      hermes: {
        endpoint: "http://127.0.0.1:8788/monitor",
        keychainService: "com.jihye.portal.monitor-hermes-hmac",
        maximumAttempts: 2,
        retryDelayMs: 50,
      },
    },
  }), { mode: 0o600 });

  const { stdout, stderr } = await execute(process.execPath, [
    path.join(opsRoot, "scripts", "monitor.mjs"),
    "--config", configPath,
    "--validate-only",
  ], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    schemaVersion: 1,
    valid: true,
    externalPublicSeparate: true,
    keychainService: "com.jihye.portal.monitor-hermes-hmac",
  });
  assert.doesNotMatch(stdout, /127\.0\.0\.1|portal\.sqlite|backups|secret/i);
});

test("restore CLI is dry-run unless both apply and exact confirmation are supplied", async () => {
  const backupRoot = path.join(drive, "fixture", "backups");
  const target = path.join(drive, "fixture", "data", "portal.sqlite");
  const args = [
    "--backup-root", backupRoot,
    "--backup", path.join(backupRoot, "hourly-20260716T010203Z.age"),
    "--target", target,
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
  ];
  const result = await dryRun("restore.mjs", [
    ...args,
  ]);
  assert.match(result.steps.join(" "), /assert-services-stopped/);
  assert.deepEqual({
    automaticBackupPolicy: result.automaticBackupPolicy,
    explicitFallback: result.explicitFallback,
    inputRequiredIfCurrentUnreadable: result.inputRequiredIfCurrentUnreadable,
  }, {
    automaticBackupPolicy: "preserve-current",
    explicitFallback: null,
    inputRequiredIfCurrentUnreadable: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /AGE_IDENTITY|AGE-SECRET|keychain/iu);

  await assert.rejects(execute(process.execPath, [
    path.join(opsRoot, "scripts", "restore.mjs"),
    ...args,
    "--apply",
    "--confirm-destroy", `${target}-different`,
  ], {
    cwd: path.dirname(opsRoot),
    env: {
      PATH: process.env.PATH,
      WISDOM_KEYCHAIN_EXEC: "1",
      AGE_IDENTITY: "AGE-SECRET-KEY-OPERATOR",
    },
    timeout: 10_000,
    windowsHide: true,
  }), (error) => {
    assert.match(error.stderr, /RESTORE_CONFIRMATION_MISMATCH/u);
    assert.doesNotMatch(error.stderr, /AGE-SECRET-KEY/u);
    return true;
  });
});

test("restore CLI accepts only one exact automatic-backup fallback value", async () => {
  const backupRoot = path.join(drive, "fixture", "backups");
  const args = [
    "--backup-root", backupRoot,
    "--backup", path.join(backupRoot, "hourly-20260716T010203Z.age"),
    "--target", path.join(drive, "fixture", "data", "portal.sqlite"),
    "--temp-root", path.join(drive, "fixture", "temp"),
    "--age", path.join(drive, "opt", "bin", "age"),
  ];

  for (const mode of ["enabled", "disabled"]) {
    const result = await dryRun("restore.mjs", [
      ...args,
      "--automatic-backup-after-restore", mode,
    ]);
    assert.equal(result.automaticBackupPolicy, "preserve-current");
    assert.equal(result.explicitFallback, mode);
    assert.equal(result.inputRequiredIfCurrentUnreadable, true);
  }

  for (const invalid of [
    [...args, "--automatic-backup-after-restore", "on"],
    [...args, "--automatic-backup-after-restore", "enabled", "--automatic-backup-after-restore", "disabled"],
    [...args, "--automatic-backup-after-restore=enabled"],
    [...args, "--unknown"],
    [...args, "--apply", "--apply", "--confirm-destroy", args[5]],
  ]) {
    await assert.rejects(execute(process.execPath, [
      path.join(opsRoot, "scripts", "restore.mjs"),
      ...invalid,
    ], {
      cwd: path.dirname(opsRoot),
      env: { PATH: process.env.PATH },
      timeout: 10_000,
      windowsHide: true,
    }), (error) => {
      assert.match(error.stderr, /CLI_USAGE/u);
      return true;
    });
  }
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

test("stale lock recovery CLI is dry-run and binds release and database paths exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-lock-cli-"));
  const owner = (kind) => `${JSON.stringify({
    formatVersion: 2,
    kind,
    pid: 4242,
    hostname: os.hostname(),
    bootId: "provably-previous-boot",
    processStartId: "old-process",
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-16T00:00:00.000Z",
  })}\n`;

  const releaseRoot = path.join(root, "releases");
  const releaseLock = path.join(releaseRoot, ".release-operation-lock");
  await mkdir(releaseLock, { recursive: true });
  await writeFile(path.join(releaseLock, "owner.json"), owner("release"));
  const releasePlan = await dryRun("recover-lock.mjs", [
    "--kind", "release",
    "--release-root", releaseRoot,
    "--lock", releaseLock,
  ]);
  assert.equal(releasePlan.lockPath, releaseLock);
  assert.equal(releasePlan.action, "quarantine-stale-lock");

  const database = path.join(root, "data", "portal.sqlite");
  const databaseLock = path.join(path.dirname(database), ".portal.sqlite.maintenance-lock");
  await mkdir(databaseLock, { recursive: true });
  await writeFile(database, "fixture");
  await writeFile(path.join(databaseLock, "owner.json"), owner("backup or restore"));
  const databasePlan = await dryRun("recover-lock.mjs", [
    "--kind", "database",
    "--database", database,
    "--lock", databaseLock,
  ]);
  assert.equal(databasePlan.lockPath, databaseLock);
  assert.equal(databasePlan.kind, "backup or restore");
});

test("stale lock recovery CLI rejects lexical aliases in the lock and confirmation paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-lock-cli-alias-"));
  const releaseRoot = path.join(root, "releases");
  const releaseLock = path.join(releaseRoot, ".release-operation-lock");
  await mkdir(releaseLock, { recursive: true });
  await writeFile(path.join(releaseLock, "owner.json"), `${JSON.stringify({
    formatVersion: 2,
    kind: "release",
    pid: 4242,
    hostname: os.hostname(),
    bootId: "provably-previous-boot",
    processStartId: "old-process",
    token: "00000000-0000-4000-8000-000000000000",
    createdAt: "2026-07-16T00:00:00.000Z",
  })}\n`);
  const aliasedLock = `${releaseRoot}${path.sep}alias${path.sep}..${path.sep}.release-operation-lock`;

  await assert.rejects(execute(process.execPath, [
    path.join(opsRoot, "scripts", "recover-lock.mjs"),
    "--kind", "release",
    "--release-root", releaseRoot,
    "--lock", aliasedLock,
  ], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
    windowsHide: true,
  }), (error) => {
    assert.match(error.stderr, /LOCK_RECOVERY_USAGE/u);
    return true;
  });

  if (process.platform === "win32") {
    const caseAliasedLock = releaseLock.replace(root, root.toUpperCase());
    assert.notEqual(caseAliasedLock, releaseLock);
    await assert.rejects(execute(process.execPath, [
      path.join(opsRoot, "scripts", "recover-lock.mjs"),
      "--kind", "release",
      "--release-root", releaseRoot,
      "--lock", caseAliasedLock,
    ], {
      cwd: path.dirname(opsRoot),
      env: { PATH: process.env.PATH },
      timeout: 10_000,
      windowsHide: true,
    }), (error) => {
      assert.match(error.stderr, /LOCK_RECOVERY_USAGE/u);
      return true;
    });
  }

  await assert.rejects(execute(process.execPath, [
    path.join(opsRoot, "scripts", "recover-lock.mjs"),
    "--kind", "release",
    "--release-root", releaseRoot,
    "--lock", releaseLock,
    "--apply",
    "--confirm-lock", aliasedLock,
    "--confirm-action", "QUARANTINE_STALE_LOCK",
  ], {
    cwd: path.dirname(opsRoot),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
    windowsHide: true,
  }), (error) => {
    assert.match(error.stderr, /LOCK_RECOVERY_USAGE/u);
    return true;
  });
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
