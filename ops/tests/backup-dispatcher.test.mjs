import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as backupControl from "../lib/backup-control.mjs";

const FIXED_RUN_ID = "00000000-0000-4000-8000-000000000703";
const FIXED_RUN_ID_2 = "00000000-0000-4000-8000-000000000704";
const SHA256 = "a".repeat(64);

function dispatcherCliArgs() {
  const root = path.parse(process.cwd()).root;
  const source = path.join(root, "Users", "wisdom", "data", "portal.sqlite");
  const backupRoot = path.join(root, "Users", "wisdom", "Backups", "portal");
  const node = path.join(root, "opt", "bin", "node");
  const scripts = path.join(root, "Users", "wisdom", "portal", "current", "ops", "scripts");
  return [
    "--source", source,
    "--root", backupRoot,
    "--run-state", path.join(path.dirname(source), "backup-run-state.json"),
    "--apply",
    "--",
    node,
    path.join(scripts, "keychain-exec.mjs"),
    "--account", "wisdom",
    "--config", path.join(root, "Users", "wisdom", "portal", "shared", "runtime.env"),
    "--secret", "AGE_IDENTITY=com.jihye.portal.age-identity",
    "--",
    node,
    path.join(scripts, "backup.mjs"),
    "--source", source,
    "--root", backupRoot,
    "--temp-root", path.join(root, "Users", "wisdom", "Library", "Caches", "WisdomPortalBackup"),
    "--age", path.join(root, "opt", "bin", "age"),
    "--recipient", "age1fixtureoperator",
    "--automatic",
    "--apply",
  ];
}

function verifiedStatus(date) {
  return {
    formatVersion: 1,
    kind: "hourly",
    createdAt: date.toISOString(),
    sourceDatabase: "portal.sqlite",
    schemaVersion: 7,
    sqliteVersion: "3.50.0",
    encryptedSha256: SHA256,
    encryptedBytes: 128,
    integrity: "ok",
    verified: true,
  };
}

function artifactFor(date) {
  return `hourly-${date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}.age`;
}

function runState(overrides = {}) {
  return {
    formatVersion: 1,
    runId: FIXED_RUN_ID,
    startedAt: "2026-07-17T04:00:00.000Z",
    finishedAt: "2026-07-17T04:00:01.000Z",
    outcome: "verified",
    controlRevision: 2,
    lastVerifiedAt: "2026-07-17T04:00:00.000Z",
    lastVerifiedArtifact: "hourly-20260717T040000Z.age",
    errorCode: null,
    ...overrides,
  };
}

function verifiedChildOutput(date) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      dryRun: false,
      verified: true,
      artifact: artifactFor(date),
      encryptedSha256: SHA256,
      encryptedBytes: 128,
    }),
    stderr: "",
  };
}

async function dispatcherFixture({
  control = { automaticEnabled: true, rowVersion: 3, updatedAtMs: 0 },
  now = new Date("2026-07-17T05:00:00.000Z"),
  statuses = [],
  childResult = verifiedChildOutput(now),
} = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-backup-dispatcher-")));
  await chmod(directory, 0o700);
  const input = {
    sourceDb: path.join(directory, "portal.sqlite"),
    backupRoot: path.join(directory, "backups-must-not-be-opened-when-off"),
    statePath: path.join(directory, "backup-run-state.json"),
    now,
  };
  const calls = { readBackupControl: 0, loadNewestBackupStatus: 0, runChild: 0 };
  const queuedStatuses = [...statuses];
  const adapters = {
    randomUUID: () => FIXED_RUN_ID,
    readBackupControl: async () => {
      calls.readBackupControl += 1;
      return control;
    },
    loadNewestBackupStatus: async () => {
      calls.loadNewestBackupStatus += 1;
      return queuedStatuses.shift();
    },
    runChild: async () => {
      calls.runChild += 1;
      return childResult;
    },
  };
  return { adapters, calls, directory, input };
}

test("automatic backup decision pins the exact hourly and re-enable boundaries", () => {
  const nowMs = Date.parse("2026-07-17T05:00:00.000Z");
  const transitionMs = nowMs - 2 * 60 * 60 * 1000;
  const control = { automaticEnabled: true, rowVersion: 2, updatedAtMs: transitionMs };

  assert.equal(backupControl.automaticBackupDecision({
    control,
    newestVerified: { createdAt: new Date(nowMs - 3_599_999).toISOString() },
    now: new Date(nowMs),
  }), "not-due");
  assert.equal(backupControl.automaticBackupDecision({
    control,
    newestVerified: { createdAt: new Date(nowMs - 3_600_000).toISOString() },
    now: new Date(nowMs),
  }), "run");
  assert.equal(backupControl.automaticBackupDecision({ control, newestVerified: undefined, now: new Date(nowMs) }), "run");
  assert.equal(backupControl.automaticBackupDecision({
    control: { ...control, updatedAtMs: nowMs - 60_000 },
    newestVerified: { createdAt: new Date(nowMs - 120_000).toISOString() },
    now: new Date(nowMs),
  }), "run");
  assert.equal(backupControl.automaticBackupDecision({
    control: { ...control, updatedAtMs: nowMs - 120_000 },
    newestVerified: { createdAt: new Date(nowMs - 60_000).toISOString() },
    now: new Date(nowMs),
  }), "not-due");
  assert.equal(backupControl.automaticBackupDecision({
    control: { ...control, automaticEnabled: false },
    newestVerified: undefined,
    now: new Date(nowMs),
  }), "admin-disabled");
});

test("OFF reads policy first, carries only verified observation fields, and never scans backups or runs a child", async () => {
  const fixture = await dispatcherFixture({
    control: { automaticEnabled: false, rowVersion: 3, updatedAtMs: 1 },
  });
  const previous = runState();
  await writeFile(fixture.input.statePath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });

  const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

  assert.deepEqual(fixture.calls, { readBackupControl: 1, loadNewestBackupStatus: 0, runChild: 0 });
  assert.deepEqual(result, {
    formatVersion: 1,
    runId: FIXED_RUN_ID,
    startedAt: fixture.input.now.toISOString(),
    finishedAt: fixture.input.now.toISOString(),
    outcome: "admin-disabled",
    controlRevision: 3,
    lastVerifiedAt: previous.lastVerifiedAt,
    lastVerifiedArtifact: previous.lastVerifiedArtifact,
    errorCode: null,
  });
  assert.deepEqual(await backupControl.loadBackupRunState(fixture.input.statePath), result);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /(?:AGE-SECRET|identity|stderr|portal\.sqlite|backups-must-not)/iu);
  assert.equal(serialized.includes(fixture.directory), false);
});

test("a post-enable verified pair avoids duplicate child execution and records not-due", async () => {
  const now = new Date("2026-07-17T05:00:00.000Z");
  const newest = verifiedStatus(new Date("2026-07-17T04:30:00.000Z"));
  const fixture = await dispatcherFixture({
    now,
    control: { automaticEnabled: true, rowVersion: 4, updatedAtMs: Date.parse("2026-07-17T04:00:00.000Z") },
    statuses: [newest],
  });

  const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

  assert.deepEqual(fixture.calls, { readBackupControl: 1, loadNewestBackupStatus: 1, runChild: 0 });
  assert.deepEqual(result, {
    formatVersion: 1,
    runId: FIXED_RUN_ID,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    outcome: "not-due",
    controlRevision: 4,
    lastVerifiedAt: newest.createdAt,
    lastVerifiedArtifact: artifactFor(new Date(newest.createdAt)),
    errorCode: null,
  });
});

test("missing and pre-enable verified pairs run the child only after recording running", async (t) => {
  const now = new Date("2026-07-17T05:00:00.000Z");
  for (const [name, initial] of [
    ["missing pair", undefined],
    ["pair older than transition", verifiedStatus(new Date("2026-07-17T04:58:00.000Z"))],
  ]) {
    await t.test(name, async () => {
      const newest = verifiedStatus(now);
      const fixture = await dispatcherFixture({
        now,
        control: { automaticEnabled: true, rowVersion: 5, updatedAtMs: Date.parse("2026-07-17T04:59:00.000Z") },
        statuses: [initial, newest],
      });
      fixture.adapters.runChild = async () => {
        fixture.calls.runChild += 1;
        assert.equal((await backupControl.loadBackupRunState(fixture.input.statePath)).outcome, "running");
        return verifiedChildOutput(now);
      };

      const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

      assert.deepEqual(fixture.calls, { readBackupControl: 1, loadNewestBackupStatus: 2, runChild: 1 });
      assert.equal(result.outcome, "verified");
      assert.equal(result.controlRevision, 5);
      assert.equal(result.lastVerifiedAt, newest.createdAt);
      assert.equal(result.lastVerifiedArtifact, artifactFor(now));
      assert.deepEqual(await backupControl.loadBackupRunState(fixture.input.statePath), result);
    });
  }
});

test("a locked child policy skip becomes an administrator-disabled observation", async () => {
  const fixture = await dispatcherFixture({
    statuses: [undefined],
    childResult: {
      exitCode: 0,
      stdout: JSON.stringify({
        dryRun: false,
        verified: false,
        outcome: "admin-disabled",
        controlRevision: 4,
      }),
      stderr: "",
    },
  });

  const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

  assert.deepEqual(fixture.calls, { readBackupControl: 1, loadNewestBackupStatus: 1, runChild: 1 });
  assert.equal(result.outcome, "admin-disabled");
  assert.equal(result.controlRevision, 4);
  assert.equal(result.lastVerifiedAt, null);
  assert.equal(result.lastVerifiedArtifact, null);
  assert.equal(result.errorCode, null);
});

test("policy read failure records only a sanitized control error and never scans or starts the child", async () => {
  const fixture = await dispatcherFixture();
  fixture.adapters.readBackupControl = async () => {
    fixture.calls.readBackupControl += 1;
    throw new Error(`SQLite failed at ${fixture.input.sourceDb} with AGE-SECRET-KEY-RAW`);
  };

  const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

  assert.deepEqual(fixture.calls, { readBackupControl: 1, loadNewestBackupStatus: 0, runChild: 0 });
  assert.equal(result.outcome, "failed");
  assert.equal(result.controlRevision, null);
  assert.equal(result.errorCode, "BACKUP_CONTROL_INVALID");
  const serialized = `${JSON.stringify(result)}\n${await readFile(fixture.input.statePath, "utf8")}`;
  assert.equal(serialized.includes(fixture.directory), false);
  assert.doesNotMatch(serialized, /AGE-SECRET|SQLite failed/iu);
});

test("bad child exits, oversized output, and non-contract JSON record only BACKUP_OPERATION_FAILED", async (t) => {
  const cases = [
    ["bad exit", { exitCode: 9, stdout: "", stderr: "RAW STDERR AGE-SECRET /private/operator" }],
    ["oversized stdout", { exitCode: 0, stdout: "가".repeat(2_049), stderr: "" }],
    ["bad JSON", { exitCode: 0, stdout: "{not-json:/private/operator:AGE-SECRET}", stderr: "" }],
    ["extra sensitive JSON", {
      exitCode: 0,
      stdout: JSON.stringify({
        dryRun: false,
        verified: true,
        artifact: "hourly-20260717T050000Z.age",
        encryptedSha256: SHA256,
        encryptedBytes: 128,
        identity: "AGE-SECRET-KEY-RAW",
      }),
      stderr: "",
    }],
  ];

  for (const [name, childResult] of cases) {
    await t.test(name, async () => {
      const fixture = await dispatcherFixture({ statuses: [undefined], childResult });

      const result = await backupControl.runBackupDispatcher(fixture.input, fixture.adapters);

      assert.equal(result.outcome, "failed");
      assert.equal(result.controlRevision, 3);
      assert.equal(result.errorCode, "BACKUP_OPERATION_FAILED");
      const serialized = `${JSON.stringify(result)}\n${await readFile(fixture.input.statePath, "utf8")}`;
      assert.equal(serialized.includes(fixture.directory), false);
      assert.doesNotMatch(serialized, /AGE-SECRET|RAW STDERR|private\/operator|identity|not-json/iu);
    });
  }
});

test("run-state IO enforces its strict schema, 4 KiB bound, 0600 mode, and atomic replacement", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-backup-state-")));
  await chmod(directory, 0o700);
  const statePath = path.join(directory, "backup-run-state.json");
  const initial = runState();
  const replacement = runState({ runId: FIXED_RUN_ID_2, outcome: "not-due" });

  await backupControl.writeBackupRunState(statePath, initial);
  assert.deepEqual(await backupControl.loadBackupRunState(statePath), initial);
  if (process.platform !== "win32") assert.equal((await stat(statePath)).mode & 0o777, 0o600);

  await backupControl.writeBackupRunState(statePath, replacement);
  assert.deepEqual(await backupControl.loadBackupRunState(statePath), replacement);
  assert.deepEqual(await readdir(directory), ["backup-run-state.json"]);

  const canonical = JSON.stringify(replacement);
  const exactLimit = `${canonical}${" ".repeat(backupControl.MAX_BACKUP_RUN_STATE_BYTES - Buffer.byteLength(canonical))}`;
  assert.equal(Buffer.byteLength(exactLimit), 4 * 1024);
  await writeFile(statePath, exactLimit, { mode: 0o600 });
  assert.deepEqual(await backupControl.loadBackupRunState(statePath), replacement);
  await writeFile(statePath, `${exactLimit}x`, { mode: 0o600 });
  await assert.rejects(backupControl.loadBackupRunState(statePath), { code: "BACKUP_RUN_STATE_INVALID" });

  await assert.rejects(backupControl.writeBackupRunState(statePath, { ...replacement, absolutePath: directory }), {
    code: "BACKUP_RUN_STATE_INVALID",
  });
});

test("run-state IO rejects final symlinks and linked parent directories", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-backup-state-links-")));
  await chmod(directory, 0o700);
  const realParent = path.join(directory, "real");
  const linkedParent = path.join(directory, "linked");
  await mkdir(realParent, { mode: 0o700 });
  const target = path.join(realParent, "target.json");
  await writeFile(target, `${JSON.stringify(runState())}\n`, { mode: 0o600 });

  try {
    await symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("junction creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  const linkedState = path.join(linkedParent, "target.json");
  await assert.rejects(backupControl.loadBackupRunState(linkedState), { code: "BACKUP_RUN_STATE_INVALID" });
  await assert.rejects(backupControl.writeBackupRunState(linkedState, runState()), { code: "BACKUP_RUN_STATE_INVALID" });

  if (process.platform !== "win32") {
    const finalLink = path.join(realParent, "final-link.json");
    await symlink(target, finalLink, "file");
    await assert.rejects(backupControl.loadBackupRunState(finalLink), { code: "BACKUP_RUN_STATE_INVALID" });
    await assert.rejects(backupControl.writeBackupRunState(finalLink, runState()), { code: "BACKUP_RUN_STATE_INVALID" });
  }
});

test("dispatcher CLI accepts only a bounded fixed Keychain child bound to the checked source and root", async () => {
  const dispatcher = await import("../scripts/backup-dispatcher.mjs");
  const args = dispatcherCliArgs();
  const parsed = dispatcher.parseBackupDispatcherArgs(args);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.child.command, args[args.indexOf("--") + 1]);
  assert.equal(parsed.child.args.includes("AGE-SECRET-KEY-RAW"), false);
  assert.equal(parsed.child.args.filter((value) => value === "--automatic").length, 1);
  assert.equal(parsed.child.args.filter((value) => value === "--apply").length, 1);
  assert.ok(dispatcher.BACKUP_CHILD_TIMEOUT_MS > 60 * 60 * 1000);

  const nestedSourceIndex = args.lastIndexOf("--source") + 1;
  const invalid = [
    args.with(nestedSourceIndex, path.join(path.parse(process.cwd()).root, "other", "portal.sqlite")),
    args.filter((value) => value !== "--automatic"),
    [...args, "AGE-SECRET-KEY-RAW"],
    ["--source", "relative.sqlite", ...args.slice(2)],
    [...args.slice(0, args.indexOf("--") + 1), ...Array.from({ length: 70 }, () => "x")],
  ];
  for (const candidate of invalid) {
    assert.throws(() => dispatcher.parseBackupDispatcherArgs(candidate), { code: "CLI_USAGE" });
  }
});

test("dispatcher child execution is shell-free, output-bounded, and never places an identity value in argv", async () => {
  const dispatcher = await import("../scripts/backup-dispatcher.mjs");
  const args = dispatcherCliArgs();
  const parsed = dispatcher.parseBackupDispatcherArgs(args);
  const spawnCalls = [];

  const successful = await dispatcher.runBackupChild(parsed.child, {
    spawnChild: (command, childArgs, options) => {
      spawnCalls.push({ command, childArgs, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 987_654_321;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ dryRun: false, verified: false, outcome: "admin-disabled", controlRevision: 4 }));
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
    signalSource: new EventEmitter(),
  });
  assert.equal(successful.exitCode, 0);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.doesNotMatch(JSON.stringify(spawnCalls[0].childArgs), /AGE-SECRET-KEY|private\/operator/iu);

  const kills = [];
  await assert.rejects(dispatcher.runBackupChild(parsed.child, {
    spawnChild: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 987_654_322;
      child.kill = (signal) => {
        kills.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      queueMicrotask(() => child.stdout.write(Buffer.alloc(4 * 1024 + 1, 0x78)));
      return child;
    },
    signalSource: new EventEmitter(),
  }), { code: "BACKUP_OPERATION_FAILED" });
  assert.ok(kills.includes("SIGTERM"));
  assert.ok(kills.includes("SIGKILL"));
});

test("dispatcher terminates a detached child group after post-spawn errors and timeouts", async () => {
  const dispatcher = await import("../scripts/backup-dispatcher.mjs");
  const parsed = dispatcher.parseBackupDispatcherArgs(dispatcherCliArgs());

  const postSpawnSignals = [];
  await assert.rejects(dispatcher.runBackupChild(parsed.child, {
    spawnChild: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 987_654_323;
      child.kill = (signal) => {
        postSpawnSignals.push(signal);
        if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      queueMicrotask(() => child.emit("error", new Error("post-spawn pipe failure")));
      return child;
    },
    signalSource: new EventEmitter(),
  }), { code: "BACKUP_OPERATION_FAILED" });
  assert.deepEqual(postSpawnSignals, ["SIGTERM", "SIGKILL"]);

  const timeoutSignals = [];
  const scheduleTimer = (callback) => {
    const handle = { cancelled: false, unref() {} };
    queueMicrotask(() => {
      if (!handle.cancelled) callback();
    });
    return handle;
  };
  const cancelTimer = (handle) => {
    if (handle) handle.cancelled = true;
  };
  await assert.rejects(dispatcher.runBackupChild(parsed.child, {
    spawnChild: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 987_654_324;
      child.kill = () => true;
      setImmediate(() => child.emit("close", 0, null));
      return child;
    },
    signalSource: new EventEmitter(),
    scheduleTimer,
    cancelTimer,
    signalChild: (child, signal) => {
      timeoutSignals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", null, signal));
    },
  }), { code: "BACKUP_OPERATION_FAILED" });
  assert.deepEqual(timeoutSignals, ["SIGTERM", "SIGKILL"]);

  const groupSignals = [];
  const directSignals = [];
  dispatcher.signalBackupProcessGroup({
    pid: 4_321,
    kill: (signal) => directSignals.push(signal),
  }, "SIGKILL", {
    platform: "darwin",
    killProcess: (pid, signal) => groupSignals.push([pid, signal]),
  });
  assert.deepEqual(groupSignals, [[-4_321, "SIGKILL"]]);
  assert.deepEqual(directSignals, []);
});
