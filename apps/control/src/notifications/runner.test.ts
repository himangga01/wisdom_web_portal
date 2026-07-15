import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import * as controlModule from "../index.js";

const control = controlModule as unknown as Record<string, unknown>;
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function requiredFunction<T>(name: string): T {
  expect(control[name], `${name} must be exported`).toBeTypeOf("function");
  return control[name] as T;
}

describe("launchable notification worker", () => {
  it("reloads enabled provider settings and resolves only secret references on every cycle", () => {
    const loadAdapters = requiredFunction<(options: Record<string, unknown>) => Record<string, unknown>>(
      "loadConfiguredNotificationAdapters",
    );
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO notification_settings (
        channel, enabled, provider, payload_mode, secret_ref, config_json, updated_at_ms
      ) VALUES
        ('email', 1, 'smtp', 'receipt-only', 'keychain:smtp', ?, 0),
        ('hermes-telegram', 1, 'hermes', NULL, NULL, '{}', 0)
    `).run(JSON.stringify({
      host: "smtp-one.example.com", port: 465, secure: true,
      from: "office@example.test", to: "owner@example.test",
    }));
    const smtpOptions: Array<Record<string, unknown>> = [];
    const hermesOptions: Array<Record<string, unknown>> = [];
    const secretResolver = vi.fn(() => ({ user: "smtp-user", password: "smtp-password" }));
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 61) });
    const options = {
      db: testDatabase.db,
      keyProvider: provider,
      hermesEndpoint: new URL("http://127.0.0.1:8788/notify"),
      hermesSecret: Buffer.alloc(32, 62),
      secretResolver,
      smtpFactory: (value: Record<string, unknown>) => {
        smtpOptions.push(value);
        return { deliver: async () => ({ providerMessageId: "smtp" }) };
      },
      hermesFactory: (value: Record<string, unknown>) => {
        hermesOptions.push(value);
        return { deliver: async () => ({ providerMessageId: "hermes" }) };
      },
    };
    expect(loadAdapters(options)).toEqual({
      email: expect.objectContaining({ deliver: expect.any(Function) }),
      "hermes-telegram": expect.objectContaining({ deliver: expect.any(Function) }),
    });
    expect(secretResolver).toHaveBeenCalledWith("keychain:smtp");
    expect(smtpOptions[0]).toMatchObject({
      payloadMode: "receipt-only",
      smtp: { host: "smtp-one.example.com", user: "smtp-user", password: "smtp-password" },
    });
    expect(hermesOptions[0]).toMatchObject({
      endpoint: new URL("http://127.0.0.1:8788/notify"),
    });

    testDatabase.db.sqlite.prepare(`
      UPDATE notification_settings SET payload_mode = 'full-inquiry', config_json = ?, updated_at_ms = 1
      WHERE channel = 'email'
    `).run(JSON.stringify({
      host: "smtp-two.example.com", port: 465, secure: true,
      from: "office@example.test", to: "owner@example.test",
    }));
    loadAdapters(options);
    expect(smtpOptions[1]).toMatchObject({
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      smtp: { host: "smtp-two.example.com" },
    });
    expect(secretResolver).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(smtpOptions)).not.toContain("opaque-envelope");
  });

  it.each([
    ["mail.local", 465],
    ["smtp.example.com", 587],
  ])("rejects unsafe persisted SMTP endpoint %s:%i before secret or provider access", async (host, port) => {
    const loadAdapters = requiredFunction<(options: Record<string, unknown>) => Record<string, {
      deliver(input: Record<string, unknown>): Promise<{ providerMessageId: string }>;
    }>>("loadConfiguredNotificationAdapters");
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO notification_settings (
        channel, enabled, provider, payload_mode, secret_ref, config_json, updated_at_ms
      ) VALUES ('email', 1, 'smtp', 'receipt-only', 'keychain:smtp', ?, 0)
    `).run(JSON.stringify({
      host, port, secure: true,
      from: "office@example.test", to: "owner@example.test",
    }));
    const secretResolver = vi.fn(() => ({ user: "must-not-read", password: "must-not-read" }));
    const smtpFactory = vi.fn(() => ({ deliver: async () => ({ providerMessageId: "must-not-send" }) }));
    const adapters = loadAdapters({
      db: testDatabase.db,
      keyProvider: createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 63) }),
      hermesEndpoint: new URL("http://127.0.0.1:8788/notify"),
      hermesSecret: Buffer.alloc(32, 64),
      secretResolver,
      smtpFactory,
    });
    await expect(adapters.email!.deliver({})).rejects.toThrow(
      "Notification channel configuration unavailable",
    );
    expect(secretResolver).not.toHaveBeenCalled();
    expect(smtpFactory).not.toHaveBeenCalled();
  });

  it("isolates one invalid channel configuration so other enabled channels keep processing", async () => {
    const loadAdapters = requiredFunction<(options: Record<string, unknown>) => Record<string, {
      deliver(input: Record<string, unknown>): Promise<{ providerMessageId: string }>;
    }>>("loadConfiguredNotificationAdapters");
    testDatabase = createTestDatabase();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO notification_settings (
        channel, enabled, provider, payload_mode, secret_ref, config_json, updated_at_ms
      ) VALUES
        ('email', 1, 'smtp', 'receipt-only', 'keychain:broken', ?, 0),
        ('hermes-telegram', 1, 'hermes', NULL, NULL, '{}', 0)
    `).run(JSON.stringify({
      host: "smtp.example.com", port: 465, secure: true,
      from: "office@example.test", to: "owner@example.test",
    }));
    const hermesDeliver = vi.fn(async () => ({ providerMessageId: "hermes-ok" }));
    const adapters = loadAdapters({
      db: testDatabase.db,
      keyProvider: createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 63) }),
      hermesEndpoint: new URL("http://127.0.0.1:8788/notify"),
      hermesSecret: Buffer.alloc(32, 64),
      secretResolver: () => { throw new Error("private Keychain diagnostic"); },
      smtpFactory: () => { throw new Error("must not construct SMTP"); },
      hermesFactory: () => ({ deliver: hermesDeliver }),
    });
    expect(adapters.email).toBeDefined();
    expect(adapters["hermes-telegram"]).toBeDefined();
    await expect(adapters.email!.deliver({})).rejects.toThrow("Notification channel configuration unavailable");
    await expect(adapters["hermes-telegram"]!.deliver({})).resolves.toEqual({ providerMessageId: "hermes-ok" });
    expect(hermesDeliver).toHaveBeenCalledTimes(1);
  });

  it("backs off while idle, reloads adapters per run, and stops gracefully during in-flight work", async () => {
    const createRunner = requiredFunction<(options: Record<string, unknown>) => {
      start(): void;
      stop(): Promise<void>;
      runOnce(): Promise<{ kind: string }>;
    }>("createNotificationWorkerRunner");
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const cancelled: unknown[] = [];
    const adapterLoader = vi.fn(() => ({}));
    const processResults = [{ kind: "idle" }, { kind: "sent" }];
    const process = vi.fn(async () => processResults.shift() ?? { kind: "idle" });
    const runner = createRunner({
      loadAdapters: adapterLoader,
      processNext: process,
      schedule(callback: () => void, delay: number) {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      cancel(handle: unknown) { cancelled.push(handle); },
      idleDelayMs: 1_000,
      activeDelayMs: 25,
      errorDelayMs: 5_000,
    });
    await expect(runner.runOnce()).resolves.toEqual({ kind: "idle" });
    await expect(runner.runOnce()).resolves.toEqual({ kind: "sent" });
    expect(adapterLoader).toHaveBeenCalledTimes(2);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    process.mockImplementationOnce(async () => {
      await blocked;
      return { kind: "idle" };
    });
    runner.start();
    expect(scheduled.at(-1)?.delay).toBe(0);
    scheduled.at(-1)!.callback();
    await Promise.resolve();
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it("emits only fixed PII-safe fields when a worker cycle fails", async () => {
    const createRunner = requiredFunction<(options: Record<string, unknown>) => {
      runOnce(): Promise<{ kind: string }>;
    }>("createNotificationWorkerRunner");
    const logs: unknown[] = [];
    const runner = createRunner({
      loadAdapters: () => { throw new Error("customer@example.test secret body"); },
      processNext: async () => ({ kind: "idle" }),
      logger: { write: (event: unknown) => logs.push(event) },
    });
    await expect(runner.runOnce()).resolves.toEqual({ kind: "error" });
    expect(logs).toEqual([{ event: "notification.worker.error", code: "WORKER_CYCLE_FAILED" }]);
    expect(JSON.stringify(logs)).not.toContain("customer@example.test");
  });
});
