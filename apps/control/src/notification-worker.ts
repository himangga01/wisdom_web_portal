import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { closeDatabase } from "./db/client.js";
import { loadConfiguredNotificationAdapters } from "./notifications/configured.js";
import { createNotificationWorkerRunner } from "./notifications/runner.js";
import { processNextNotification } from "./notifications/worker.js";
import { createControlRuntime, loadLocalEnvironment } from "./runtime.js";

function resolveKeychainSmtpCredentials(reference: string): { user: string; password: string } {
  if (!reference.startsWith("keychain:")) throw new Error("SMTP secret reference must use Keychain");
  const service = reference.slice("keychain:".length);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(service)) throw new Error("SMTP Keychain service reference is invalid");
  const serialized = execFileSync("/usr/bin/security", [
    "find-generic-password",
    "-s",
    service,
    "-w",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const parsed = JSON.parse(serialized) as { user?: unknown; password?: unknown };
  if (typeof parsed.user !== "string" || typeof parsed.password !== "string") {
    throw new Error("SMTP Keychain value must contain user and password JSON fields");
  }
  return { user: parsed.user, password: parsed.password };
}

loadLocalEnvironment();
const runtime = createControlRuntime();
const workerId = `notification-worker-${randomUUID()}`;
const runner = createNotificationWorkerRunner({
  loadAdapters: () => loadConfiguredNotificationAdapters({
    db: runtime.db,
    keyProvider: runtime.config.keyProvider,
    hermesEndpoint: runtime.config.hermesEndpoint,
    hermesSecret: runtime.config.hermesHmacSecret,
    secretResolver: resolveKeychainSmtpCredentials,
  }),
  processNext: async (adapters) => processNextNotification({
    db: runtime.db,
    workerId,
    adminOrigin: runtime.config.adminOrigin ?? "http://127.0.0.1:8787",
    now: Date.now,
    adapters: adapters as ReturnType<typeof loadConfiguredNotificationAdapters>,
    withdrawalSecret: runtime.config.withdrawalSecret,
    ...(runtime.config.publicOrigin ? { publicOrigin: runtime.config.publicOrigin } : {}),
    logger: { write: (event) => console.log(JSON.stringify(event)) },
  }),
  logger: { write: (event) => console.error(JSON.stringify(event)) },
});

runner.start();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await runner.stop();
  closeDatabase(runtime.db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
