import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSystemMonitoringAdapters,
  loadNewestBackupStatus,
  loadMonitoringConfigFile,
  parseMonitoringConfig,
  runLocalMonitor,
} from "../lib/monitoring.mjs";
import { queryDatabaseAggregates } from "../scripts/monitor-db-check.mjs";

function absoluteFixture(name) {
  return path.join(path.parse(process.cwd()).root, "wisdom-monitor-fixture", name);
}

function configValue(overrides = {}) {
  return {
    externalPublic: {
      url: "https://www.example.test/health/live",
      expectedStatus: 200,
      expectedText: "ok",
      source: "outside-mac-and-lan",
    },
    local: {
      backupRoot: absoluteFixture("backups"),
      databasePath: absoluteFixture("data/portal.sqlite"),
      diskPath: absoluteFixture("data"),
      incidentState: {
        path: absoluteFixture("data/monitor-incident-state.json"),
        cooldownMinutes: 30,
      },
      controlReadyUrl: "http://127.0.0.1:8787/health/ready",
      requiredRunningLaunchdLabels: [
        "com.jihye.portal.caddy",
        "com.jihye.portal.cloudflared",
        "com.jihye.portal.control",
        "com.jihye.portal.notification-worker",
        "com.jihye.portal.content-worker",
      ],
      thresholds: {
        backupFreshnessMinutes: 90,
        diskFreePercentMinimum: 15,
        notificationFailureBacklogMaximum: 0,
        publicationFailureBacklogMaximum: 0,
        indexNowFailureBacklogMaximum: 0,
      },
      timeouts: {
        overallMs: 15_000,
        checkMs: 3_000,
        hermesRequestMs: 2_000,
      },
      hermes: {
        endpoint: "http://127.0.0.1:8788/monitor",
        keychainService: "com.jihye.portal.monitor-hermes-hmac",
        maximumAttempts: 2,
        retryDelayMs: 50,
      },
      ...overrides,
    },
  };
}

function healthyAdapters(overrides = {}) {
  return {
    loadNewestBackupStatus: async () => ({
      verified: true,
      createdAt: "2026-07-16T00:30:00.000Z",
    }),
    diskFreePercent: async () => 80,
    launchdRunning: async () => true,
    controlReady: async () => true,
    readBacklogs: async () => ({
      notificationFailures: 0,
      publicationFailures: 0,
      indexNowFailures: 0,
    }),
    loadIncidentState: async () => undefined,
    writeIncidentState: async () => {},
    clearIncidentState: async () => {},
    deliverHermes: async () => assert.fail("healthy monitor must not notify Hermes"),
    ...overrides,
  };
}

test("monitor config strictly separates external uptime from bounded private checks", () => {
  const parsed = parseMonitoringConfig(JSON.stringify(configValue()));
  assert.equal(parsed.externalPublic.source, "outside-mac-and-lan");
  assert.equal(parsed.local.hermes.keychainService, "com.jihye.portal.monitor-hermes-hmac");
  assert.equal(parsed.local.timeouts.overallMs, 15_000);
  assert.equal(parsed.local.incidentState.cooldownMinutes, 30);

  const unsafe = [
    configValue({ databasePath: "relative.sqlite" }),
    configValue({ controlReadyUrl: "https://admin.example.test/health/ready" }),
    configValue({ controlReadyUrl: "http://127.0.0.1:8787/health/ready?token=private" }),
    configValue({ hermes: { ...configValue().local.hermes, endpoint: "http://192.168.0.2:8788/monitor" } }),
    configValue({ hermes: { ...configValue().local.hermes, keychainService: "com.example.monitor-hmac" } }),
    configValue({ timeouts: { ...configValue().local.timeouts, overallMs: 60_001 } }),
    configValue({ incidentState: { ...configValue().local.incidentState, path: absoluteFixture("outside/incident.json") } }),
    configValue({ incidentState: { ...configValue().local.incidentState, cooldownMinutes: 0 } }),
    configValue({ unexpected: true }),
  ];
  for (const value of unsafe) {
    assert.throws(() => parseMonitoringConfig(JSON.stringify(value)), { code: "MONITOR_CONFIG_INVALID" });
  }
});

test("monitor config file must be an absolute regular non-symlink file", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-config-")));
  const configPath = path.join(root, "monitoring.json");
  await writeFile(configPath, JSON.stringify(configValue()), { mode: 0o600 });
  assert.equal((await loadMonitoringConfigFile(configPath)).local.thresholds.backupFreshnessMinutes, 90);
  await assert.rejects(loadMonitoringConfigFile("monitoring.json"), { code: "MONITOR_CONFIG_PATH_INVALID" });
});

test("a healthy local run is bounded, machine-readable, and sends no handoff", async () => {
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(configValue())),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000001",
    dryRun: false,
    secret: Buffer.alloc(32, 7),
  }, healthyAdapters());

  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.handoff, "not-required");
  assert.ok(report.checks.every(({ state }) => state === "healthy"));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16 * 1024);
});

test("apply mode validates the independent HMAC secret before any health or state operation", async () => {
  for (const secret of [undefined, Buffer.alloc(31, 1), Buffer.alloc(513, 1)]) {
    const calls = [];
    const adapters = Object.fromEntries([
      "loadNewestBackupStatus", "diskFreePercent", "launchdRunning", "controlReady", "readBacklogs",
      "loadIncidentState", "writeIncidentState", "clearIncidentState", "deliverHermes",
    ].map((name) => [name, async () => calls.push(name)]));
    const report = await runLocalMonitor({
      config: parseMonitoringConfig(JSON.stringify(configValue())),
      now: new Date("2026-07-16T01:00:00.000Z"),
      runId: "00000000-0000-4000-8000-000000000099",
      dryRun: false,
      secret,
    }, adapters);

    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 3);
    assert.equal(report.handoff, "failed");
    assert.equal(report.handoffCode, "MONITOR_HMAC_INVALID");
    assert.deepEqual(report.checks, [{ id: "monitor-hmac", state: "failed", code: "MONITOR_HMAC_INVALID" }]);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(report), /secret|keychain|credential/i);
  }
});

test("an injected failure produces exactly one signed sanitized Hermes handoff", async (t) => {
  const secret = Buffer.alloc(32, 11);
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body, url: request.url });
    response.writeHead(204).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/monitor`;
  const config = configValue({
    hermes: { ...configValue().local.hermes, endpoint },
  });
  const system = createSystemMonitoringAdapters();
  const adapters = healthyAdapters({
    diskFreePercent: async () => 4,
    deliverHermes: system.deliverHermes,
  });
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(config)),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000002",
    nonce: () => "00000000-0000-4000-8000-000000000003",
    dryRun: false,
    secret,
  }, adapters);

  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.handoff, "delivered");
  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.deepEqual(JSON.parse(body), {
    schemaVersion: 1,
    eventType: "portal.monitor.unhealthy",
    runId: "00000000-0000-4000-8000-000000000002",
    observedAt: "2026-07-16T01:00:00.000Z",
    failures: [{ checkId: "disk", code: "DISK_FREE_BELOW_MINIMUM", value: 4 }],
  });
  assert.doesNotMatch(body, /name|phone|email|message|consultation|token|secret|credential|response|url|path/i);
  const canonical = [
    "POST",
    "/monitor",
    String(Date.parse("2026-07-16T01:00:00.000Z")),
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000002",
    body,
  ].join("\n");
  assert.equal(
    requests[0].headers["x-wisdom-signature"],
    createHmac("sha256", secret).update(canonical).digest("base64url"),
  );
  assert.equal(requests[0].headers["x-wisdom-delivery-id"], "00000000-0000-4000-8000-000000000002");
});

test("dry-run reports failures without requiring or sending a secret", async () => {
  let sends = 0;
  let stateOperations = 0;
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(configValue())),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000004",
    dryRun: true,
  }, healthyAdapters({
    controlReady: async () => false,
    deliverHermes: async () => sends++,
    loadIncidentState: async () => stateOperations++,
    writeIncidentState: async () => stateOperations++,
    clearIncidentState: async () => stateOperations++,
  }));
  assert.equal(report.ok, false);
  assert.equal(report.handoff, "dry-run-suppressed");
  assert.equal(sends, 0);
  assert.equal(stateOperations, 0);
});

test("incident fingerprint suppresses unchanged alerts, changes re-alert, failed delivery is not recorded, and health clears state", async () => {
  let state;
  let sends = 0;
  let writes = 0;
  let clears = 0;
  let failDelivery = false;
  const adapters = healthyAdapters({
    diskFreePercent: async () => 4,
    loadIncidentState: async () => state,
    writeIncidentState: async (_statePath, next) => {
      writes++;
      state = structuredClone(next);
    },
    clearIncidentState: async () => {
      clears++;
      state = undefined;
    },
    deliverHermes: async () => {
      sends++;
      if (failDelivery) throw Object.assign(new Error("private upstream response"), { code: "PRIVATE" });
    },
  });
  const parsed = parseMonitoringConfig(JSON.stringify(configValue()));
  const invoke = (runId, now) => runLocalMonitor({
    config: parsed,
    now: new Date(now),
    runId,
    dryRun: false,
    secret: Buffer.alloc(32, 5),
  }, adapters);

  const first = await invoke("00000000-0000-4000-8000-000000000101", "2026-07-16T01:00:00.000Z");
  assert.equal(first.handoff, "delivered");
  assert.equal(sends, 1);
  assert.equal(writes, 1);
  assert.match(state.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(state.lastSentAt, "2026-07-16T01:00:00.000Z");

  const repeated = await invoke("00000000-0000-4000-8000-000000000102", "2026-07-16T01:05:00.000Z");
  assert.equal(repeated.ok, false);
  assert.equal(repeated.exitCode, 2);
  assert.equal(repeated.handoff, "cooldown-suppressed");
  assert.equal(sends, 1);
  assert.equal(writes, 1);

  adapters.controlReady = async () => false;
  const changed = await invoke("00000000-0000-4000-8000-000000000103", "2026-07-16T01:10:00.000Z");
  assert.equal(changed.handoff, "delivered");
  assert.equal(sends, 2);
  assert.equal(writes, 2);

  state = undefined;
  failDelivery = true;
  const failed = await invoke("00000000-0000-4000-8000-000000000104", "2026-07-16T01:15:00.000Z");
  assert.equal(failed.handoff, "failed");
  assert.equal(failed.exitCode, 3);
  assert.equal(state, undefined);
  assert.equal(writes, 2);
  assert.doesNotMatch(JSON.stringify(failed), /private|upstream|response/i);

  failDelivery = false;
  adapters.diskFreePercent = async () => 80;
  adapters.controlReady = async () => true;
  state = { formatVersion: 1, fingerprint: "a".repeat(64), lastSentAt: "2026-07-16T01:00:00.000Z" };
  const recovered = await invoke("00000000-0000-4000-8000-000000000105", "2026-07-16T01:20:00.000Z");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.handoff, "not-required");
  assert.equal(clears, 1);
  assert.equal(state, undefined);
  assert.equal(sends, 3);
});

test("protected incident state survives independent monitor runs and is removed without a resolution alert", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-incident-")));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const statePath = path.join(root, "monitor-incident-state.json");
  const parsed = parseMonitoringConfig(JSON.stringify(configValue({
    databasePath: path.join(root, "portal.sqlite"),
    diskPath: root,
    incidentState: { path: statePath, cooldownMinutes: 30 },
  })));
  let sends = 0;
  const stateSystem = createSystemMonitoringAdapters();
  const stateMethods = {
    loadIncidentState: stateSystem.loadIncidentState,
    writeIncidentState: stateSystem.writeIncidentState,
    clearIncidentState: stateSystem.clearIncidentState,
  };
  const invoke = (runId, now, diskFreePercent) => runLocalMonitor({
    config: parsed,
    runId,
    now: new Date(now),
    dryRun: false,
    secret: Buffer.alloc(32, 8),
  }, healthyAdapters({
    ...stateMethods,
    diskFreePercent,
    deliverHermes: async () => sends++,
  }));

  assert.equal((await invoke(
    "00000000-0000-4000-8000-000000000111",
    "2026-07-16T01:00:00.000Z",
    async () => 4,
  )).handoff, "delivered");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.match(persisted.fingerprint, /^[a-f0-9]{64}$/u);

  assert.equal((await invoke(
    "00000000-0000-4000-8000-000000000112",
    "2026-07-16T01:05:00.000Z",
    async () => 4,
  )).handoff, "cooldown-suppressed");
  assert.equal(sends, 1);

  const recovered = await invoke(
    "00000000-0000-4000-8000-000000000113",
    "2026-07-16T01:10:00.000Z",
    async () => 80,
  );
  assert.equal(recovered.ok, true);
  assert.equal(recovered.handoff, "not-required");
  assert.equal(sends, 1);
  await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
});

test("system launchd inspection uses an absolute executable, no shell, and bounded output", async () => {
  const invocations = [];
  const adapters = createSystemMonitoringAdapters({
    userId: 501,
    execute: async (executable, args, options) => {
      invocations.push({ executable, args, options });
      return { stdout: "state = running\n" };
    },
  });
  assert.equal(await adapters.launchdRunning("com.jihye.portal.control", { timeoutMs: 1_000 }), true);
  assert.deepEqual(invocations[0].args, ["print", "gui/501/com.jihye.portal.control"]);
  assert.equal(invocations[0].executable, "/bin/launchctl");
  assert.equal(invocations[0].options.shell, false);
  assert.ok(invocations[0].options.maxBuffer <= 128 * 1024);
  assert.equal(invocations[0].options.timeout, 1_000);
});

test("backup and disk checks reject directory replacement after validation", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-dir-swap-")));
  t.after(async () => rm(root, { force: true, recursive: true }));

  const backupRoot = path.join(root, "backups");
  const backupReplacement = path.join(root, "backups-replacement");
  await mkdir(backupRoot, { mode: 0o700 });
  await mkdir(backupReplacement, { mode: 0o700 });
  await assert.rejects(loadNewestBackupStatus(backupRoot, {
    beforeReadEntries: async () => {
      await rename(backupRoot, path.join(root, "backups-original"));
      await rename(backupReplacement, backupRoot);
    },
  }), { code: "MONITOR_INPUT_INVALID" });

  const diskRoot = path.join(root, "data");
  const diskReplacement = path.join(root, "data-replacement");
  await mkdir(diskRoot, { mode: 0o700 });
  await mkdir(diskReplacement, { mode: 0o700 });
  const adapters = createSystemMonitoringAdapters({
    beforeDiskStat: async () => {
      await rename(diskRoot, path.join(root, "data-original"));
      await rename(diskReplacement, diskRoot);
    },
  });
  await assert.rejects(adapters.diskFreePercent(diskRoot), { code: "MONITOR_INPUT_INVALID" });
});

test("system backlog reader opens only aggregate operational tables", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-")));
  const databasePath = path.join(root, "portal.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE notification_outbox (state TEXT NOT NULL);
    CREATE TABLE publication_outbox (state TEXT NOT NULL);
    CREATE TABLE release_activations (state TEXT NOT NULL);
    CREATE TABLE releases (state TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    INSERT INTO notification_outbox VALUES ('failed'), ('sent');
    INSERT INTO publication_outbox VALUES ('failed'), ('sent');
    INSERT INTO release_activations VALUES ('prepared'), ('committed');
    INSERT INTO releases VALUES ('active', 100), ('failed', 90), ('failed', 110);
  `);
  database.close();

  const result = await createSystemMonitoringAdapters().readBacklogs(databasePath, { timeoutMs: 1_000 });
  assert.deepEqual(result, {
    notificationFailures: 1,
    publicationFailures: 2,
    indexNowFailures: 1,
  });
});

test("hung database helper is hard-killed within the bound and Hermes receives only DB_TIMEOUT", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-timeout-")));
  const databasePath = path.join(root, "portal.sqlite");
  const helperPath = path.join(root, "hang-helper.mjs");
  await writeFile(databasePath, "not customer records", { mode: 0o600 });
  await writeFile(helperPath, "process.stderr.write('raw customer PII and sqlite details\\n'); setInterval(() => {}, 1_000);", { mode: 0o600 });
  const system = createSystemMonitoringAdapters({ databaseHelper: helperPath, nodeBinary: process.execPath });
  const deliveries = [];
  const config = configValue({
    databasePath,
    diskPath: root,
    incidentState: { path: path.join(root, "monitor-incident-state.json"), cooldownMinutes: 30 },
    timeouts: { overallMs: 1_000, checkMs: 150, hermesRequestMs: 100 },
  });
  const started = performance.now();
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(config)),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000106",
    dryRun: false,
    secret: Buffer.alloc(32, 6),
  }, healthyAdapters({
    readBacklogs: system.readBacklogs,
    deliverHermes: async (request) => deliveries.push(request.payload),
  }));
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 2_000, `monitor exceeded hard bound: ${elapsed}ms`);
  assert.equal(report.exitCode, 2);
  assert.equal(report.handoff, "delivered");
  assert.ok(report.checks.some(({ id, code }) => id === "backlogs" && code === "DB_TIMEOUT"));
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].failures, [{ checkId: "backlogs", code: "DB_TIMEOUT" }]);
  assert.doesNotMatch(JSON.stringify({ report, deliveries }), /customer|sqlite|details|PII/i);
});

test("database path replacement uses a fixed sanitized DB_PATH_CHANGED handoff code", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-path-change-")));
  const databasePath = path.join(root, "portal.sqlite");
  const helperPath = path.join(root, "path-change-helper.mjs");
  await writeFile(databasePath, "bounded fixture", { mode: 0o600 });
  await writeFile(helperPath, "process.stderr.write('DB_PATH_CHANGED\\n'); process.exitCode = 4;", { mode: 0o600 });
  const system = createSystemMonitoringAdapters({ databaseHelper: helperPath, nodeBinary: process.execPath });
  const deliveries = [];
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(configValue({
      databasePath,
      diskPath: root,
      incidentState: { path: path.join(root, "monitor-incident-state.json"), cooldownMinutes: 30 },
    }))),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000107",
    dryRun: false,
    secret: Buffer.alloc(32, 9),
  }, healthyAdapters({
    readBacklogs: system.readBacklogs,
    deliverHermes: async ({ payload }) => deliveries.push(payload),
  }));

  assert.ok(report.checks.some(({ id, code }) => id === "backlogs" && code === "DB_PATH_CHANGED"));
  assert.deepEqual(deliveries[0].failures, [{ checkId: "backlogs", code: "DB_PATH_CHANGED" }]);
  assert.doesNotMatch(JSON.stringify({ report, deliveries }), /portal\.sqlite|path-change-helper|bounded fixture/i);
});

test("corrupt database errors are sanitized and bounded by the child protocol", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-corrupt-")));
  const databasePath = path.join(root, "portal.sqlite");
  await writeFile(databasePath, "customer@example.test private record", { mode: 0o600 });
  const started = performance.now();
  await assert.rejects(
    createSystemMonitoringAdapters().readBacklogs(databasePath, { timeoutMs: 500 }),
    (error) => {
      assert.equal(error.code, "MONITOR_DATABASE_QUERY_FAILED");
      assert.doesNotMatch(error.message, /customer|example|private|sqlite|record/i);
      return true;
    },
  );
  assert.ok(performance.now() - started < 2_000);
});

test("database helper rejects a final file swap after SQLite opens the verified path", {
  skip: process.platform === "win32" ? "Windows does not permit this open-file rename fixture" : false,
}, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-swap-")));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const databasePath = path.join(root, "portal.sqlite");
  const replacementPath = path.join(root, "replacement.sqlite");
  const movedPath = path.join(root, "portal-original.sqlite");
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE notification_outbox (state TEXT NOT NULL);
    CREATE TABLE publication_outbox (state TEXT NOT NULL);
    CREATE TABLE release_activations (state TEXT NOT NULL);
    CREATE TABLE releases (state TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
  `);
  database.close();
  await writeFile(replacementPath, "unverified replacement", { mode: 0o600 });

  await assert.rejects(queryDatabaseAggregates(databasePath, {
    afterSqliteOpen: async () => {
      await rename(databasePath, movedPath);
      await rename(replacementPath, databasePath);
    },
  }), { code: "MONITOR_DATABASE_QUERY_FAILED" });
});

test("Hermes handoff retries are bounded and discard private response bodies", async () => {
  const calls = [];
  const adapter = createSystemMonitoringAdapters({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response("private token and customer message must be discarded", { status: 503 });
    },
  });
  await assert.rejects(adapter.deliverHermes({
    endpoint: "http://127.0.0.1:8788/monitor",
    secret: Buffer.alloc(32, 19),
    payload: {
      schemaVersion: 1,
      eventType: "portal.monitor.unhealthy",
      runId: "00000000-0000-4000-8000-000000000010",
      observedAt: "2026-07-16T01:00:00.000Z",
      failures: [{ checkId: "disk", code: "DISK_FREE_BELOW_MINIMUM", value: 4 }],
    },
    deliveryId: "00000000-0000-4000-8000-000000000010",
    timestampMs: 1_768_435_200_000,
    nonce: () => "00000000-0000-4000-8000-000000000011",
    timeoutMs: 100,
    maximumAttempts: 2,
    retryDelayMs: 1,
  }), (error) => {
    assert.equal(error.code, "MONITOR_HERMES_REJECTED");
    assert.doesNotMatch(error.message, /private|token|customer|message/i);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url }) => url === "http://127.0.0.1:8788/monitor"));
  assert.ok(calls.every(({ init }) => !String(init.body).includes("customer")));
});
