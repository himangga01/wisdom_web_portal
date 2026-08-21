import { serve } from "@hono/node-server";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createControlApp } from "../../control/src/app.ts";
import {
  activateConsentBundle,
  seedConsentDocuments,
} from "../../control/src/consent/service.ts";
import {
  createStaticKeyProvider,
  encryptPii,
} from "../../control/src/crypto/index.ts";
import {
  closeDatabase,
  openDatabase,
  runMigrations,
} from "../../control/src/db/client.ts";
import { hashAdminPassword } from "../../control/src/auth/password.ts";
import { encryptAdminTotpSecret } from "../../control/src/auth/totp.ts";

const host = "127.0.0.1";
const port = 4175;
const adminOrigin = `http://${host}:${port}`;
const publicOrigin = "https://www.example.test";
const fixedNowMs = 1_768_435_200_000;
const keyProvider = createStaticKeyProvider({
  id: "pii-v1",
  secret: Buffer.alloc(32, 93),
});
const totpSecret = Buffer.alloc(32, 94);
const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-admin-control-"));
const database = openDatabase(path.join(directory, "control.sqlite"));
runMigrations(database);

const bundleId = "bundle-control-e2e";
seedConsentDocuments(database, ["ko", "en", "zh-Hans", "zh-Hant"].flatMap((locale) => [
  {
    bundleId,
    kind: "privacy",
    locale,
    version: "privacy-2026-07-25",
    title: `Privacy ${locale}`,
    bodyMarkdown: `Privacy collection terms for ${locale}.`,
    retentionMonths: 12,
  },
  {
    bundleId,
    kind: "marketing",
    locale,
    version: "marketing-2026-07-25",
    title: `Marketing ${locale}`,
    bodyMarkdown: `Marketing communication terms for ${locale}.`,
    retentionMonths: 24,
  },
]), fixedNowMs - 2);
activateConsentBundle(database, bundleId, fixedNowMs - 1);

const passwordHash = await hashAdminPassword("owner password");
database.sqlite.prepare(`
  INSERT INTO admins (
    id, username, display_name, password_hash, totp_secret_envelope,
    totp_key_id, status, created_at_ms, updated_at_ms
  ) VALUES ('admin-control-e2e', 'owner', 'Owner', ?, ?, 'pii-v1', 'active', ?, ?)
`).run(
  passwordHash,
  encryptAdminTotpSecret(keyProvider, "admin-control-e2e", totpSecret),
  fixedNowMs,
  fixedNowMs,
);

const consultationId = "11111111-1111-4111-8111-111111111111";
const piiEnvelope = encryptPii(keyProvider, consultationId, {
  name: "Control E2E",
  phone: "010-1234-5678",
  email: "control@example.test",
  company: "Wisdom",
  message: "Actual Control administrator integration path.",
});
database.sqlite.prepare(`
  INSERT INTO consultations (
    id, receipt_id, status, locale, category, preferred_contact,
    pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
    blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
    retention_expires_at_ms, row_version
  ) VALUES (?, 'receipt-control-e2e', 'received', 'ko', 'other', 'email',
    ?, 'pii-v1', ?, ?, 'pii-v1', 0, ?, ?, ?, 1)
`).run(
  consultationId,
  piiEnvelope,
  Buffer.alloc(32, 1),
  Buffer.alloc(32, 2),
  fixedNowMs,
  fixedNowMs,
  fixedNowMs + 86_400_000,
);

const app = createControlApp({
  db: database,
  keyProvider,
  allowedOrigins: [publicOrigin],
  enforceOrigin: true,
  now: () => fixedNowMs,
  peerAddress: () => host,
  logger: { write() {} },
  publicOrigin,
  adminOrigin,
  authSecret: Buffer.alloc(32, 91),
  withdrawalSecret: Buffer.alloc(32, 92),
  dummyPasswordHash: await hashAdminPassword("dummy password"),
});
const server = serve({ fetch: app.fetch, hostname: host, port });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  closeDatabase(database);
  await rm(directory, { force: true, recursive: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
