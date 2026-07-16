import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSystemMonitoringAdapters,
  loadMonitoringConfigFile,
  parseMonitoringConfig,
  runLocalMonitor,
} from "../lib/monitoring.mjs";

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
    deliverHermes: async () => assert.fail("healthy monitor must not notify Hermes"),
    ...overrides,
  };
}

test("monitor config strictly separates external uptime from bounded private checks", () => {
  const parsed = parseMonitoringConfig(JSON.stringify(configValue()));
  assert.equal(parsed.externalPublic.source, "outside-mac-and-lan");
  assert.equal(parsed.local.hermes.keychainService, "com.jihye.portal.monitor-hermes-hmac");
  assert.equal(parsed.local.timeouts.overallMs, 15_000);

  const unsafe = [
    configValue({ databasePath: "relative.sqlite" }),
    configValue({ controlReadyUrl: "https://admin.example.test/health/ready" }),
    configValue({ controlReadyUrl: "http://127.0.0.1:8787/health/ready?token=private" }),
    configValue({ hermes: { ...configValue().local.hermes, endpoint: "http://192.168.0.2:8788/monitor" } }),
    configValue({ hermes: { ...configValue().local.hermes, keychainService: "com.example.monitor-hmac" } }),
    configValue({ timeouts: { ...configValue().local.timeouts, overallMs: 60_001 } }),
    configValue({ unexpected: true }),
  ];
  for (const value of unsafe) {
    assert.throws(() => parseMonitoringConfig(JSON.stringify(value)), { code: "MONITOR_CONFIG_INVALID" });
  }
});

test("monitor config file must be an absolute regular non-symlink file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-config-"));
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
  const report = await runLocalMonitor({
    config: parseMonitoringConfig(JSON.stringify(configValue())),
    now: new Date("2026-07-16T01:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000004",
    dryRun: true,
  }, healthyAdapters({
    controlReady: async () => false,
    deliverHermes: async () => sends++,
  }));
  assert.equal(report.ok, false);
  assert.equal(report.handoff, "dry-run-suppressed");
  assert.equal(sends, 0);
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

test("system backlog reader opens only aggregate operational tables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-db-"));
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
