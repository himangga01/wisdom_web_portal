import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createControlApp, type RedactedLogEvent } from "../app.js";
import {
  encryptAdminTotpSecret,
  hashAdminPassword,
  mintMarketingWithdrawalCapability,
  totpCode,
} from "../index.js";
import { activateConsentBundle, seedConsentDocuments } from "../consent/service.js";
import { createStaticKeyProvider, encryptPii } from "../crypto/index.js";

const PUBLIC_ORIGIN = "https://www.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const authSecret = Buffer.alloc(32, 91);
const withdrawalSecret = Buffer.alloc(32, 92);
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 93) });
const totpSecret = Buffer.alloc(32, 94);
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  app: ReturnType<typeof createControlApp>;
  database: TestDatabase;
  logs: RedactedLogEvent[];
  now: number;
  dummyPasswordHash: string;
}

async function fixture(peer = "127.0.0.1"): Promise<Fixture> {
  const database = createTestDatabase();
  cleanups.push(() => database.close());
  seedConsentDocuments(database.db, consentBundle(), 1);
  activateConsentBundle(database.db, "bundle-2026-07-16", 2);
  const passwordHash = await hashAdminPassword("owner password");
  const dummyPasswordHash = await hashAdminPassword("dummy password");
  database.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, totp_secret_envelope,
      totp_key_id, status, created_at_ms, updated_at_ms
    ) VALUES ('admin-1', 'owner', 'Owner', ?, ?, 'pii-v1', 'active', 0, 0)
  `).run(passwordHash, encryptAdminTotpSecret(keyProvider, "admin-1", totpSecret));
  const piiEnvelope = encryptPii(keyProvider, "consultation-1", {
    name: "<script>stored-name</script>",
    phone: "010-1234-5678",
    email: "stored@example.test",
    company: "<img src=x onerror=stored-company>",
    message: "<svg onload=stored-message>Long consultation message content.</svg>",
  });
  database.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('consultation-1', 'receipt-1', 'received', 'ko', 'procurement', 'email',
      ?, 'pii-v1', ?, ?, 'pii-v1', 1, 100, 100, 10000000, 1)
  `).run(piiEnvelope, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  const marketingDocument = database.db.sqlite.prepare(`
    SELECT id, version, content_sha256 FROM consent_documents
    WHERE kind = 'marketing' AND locale = 'ko' AND state = 'active'
  `).get() as { id: string; version: string; content_sha256: Buffer };
  database.db.sqlite.prepare(`
    INSERT INTO consent_events (
      id, consultation_id, document_id, kind, decision, sequence,
      document_version, document_sha256, actor_type, request_id, occurred_at_ms
    ) VALUES ('marketing-accepted', 'consultation-1', ?, 'marketing', 'accepted', 1,
      ?, ?, 'visitor', 'request-intake', 100)
  `).run(marketingDocument.id, marketingDocument.version, marketingDocument.content_sha256);
  const logs: RedactedLogEvent[] = [];
  const state = { now: 30_000 };
  const dependencies = {
    db: database.db,
    keyProvider,
    allowedOrigins: [PUBLIC_ORIGIN],
    enforceOrigin: true,
    publicOrigin: PUBLIC_ORIGIN,
    adminOrigin: ADMIN_ORIGIN,
    authSecret,
    withdrawalSecret,
    dummyPasswordHash,
    now: () => state.now,
    peerAddress: () => peer,
    logger: { write: (event: RedactedLogEvent) => logs.push(event) },
  };
  return {
    app: createControlApp(dependencies),
    database,
    logs,
    get now() { return state.now; },
    set now(value: number) { state.now = value; },
    dummyPasswordHash,
  };
}

function sensitiveHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("strict-transport-security")).toBeNull();
}

function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

async function login(current: Fixture): Promise<{ cookie: string; csrf: string }> {
  const password = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
    method: "POST",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "owner password" }),
  });
  expect(password.status).toBe(303);
  sensitiveHeaders(password);
  const preauth = cookiePair(password);
  const [, preauthValue = ""] = preauth.split("=");
  const [, preauthCsrf = ""] = preauthValue.split(".");
  const mfa = await current.app.request(`${ADMIN_ORIGIN}/admin/mfa`, {
    method: "POST",
    headers: {
      origin: ADMIN_ORIGIN,
      cookie: preauth,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "owner",
      method: "totp",
      code: totpCode(totpSecret, current.now),
      csrf: preauthCsrf,
    }),
  });
  expect(mfa.status).toBe(303);
  const sessionCookie = cookiePair(mfa);
  const [, value = ""] = sessionCookie.split("=");
  const [, csrf = ""] = value.split(".");
  return { cookie: sessionCookie, csrf };
}

describe("separate host and administrator browser boundary", () => {
  it("rejects unknown/public admin hosts and trusts forwarded routing only from loopback", async () => {
    const external = await fixture("203.0.113.10");
    const publicAdmin = await external.app.request(`${PUBLIC_ORIGIN}/admin/login`);
    expect(publicAdmin.status).toBe(404);
    sensitiveHeaders(publicAdmin);
    expect((await external.app.request("https://unknown.example.test/admin/login")).status).toBe(421);
    expect((await external.app.request(`${PUBLIC_ORIGIN}/admin/login`, {
      headers: {
        "x-forwarded-host": "admin.example.test",
        "x-forwarded-proto": "https",
      },
    })).status).toBe(404);

    const loopback = await fixture("127.0.0.1");
    const forwarded = await loopback.app.request("http://127.0.0.1:8787/admin/login", {
      headers: {
        "x-forwarded-host": "admin.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(forwarded.status).toBe(200);
    sensitiveHeaders(forwarded);
    expect((await loopback.app.request("http://127.0.0.1:8787/admin/login", {
      headers: {
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    })).status).toBe(421);
  });

  it("uses generic password failures, strict login Origin, and no session before MFA", async () => {
    const current = await fixture();
    const page = await current.app.request(`${ADMIN_ORIGIN}/admin/login`);
    expect(page.status).toBe(200);
    sensitiveHeaders(page);
    const unknown = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "missing", password: "wrong" }),
    });
    const wrong = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "wrong" }),
    });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    const genericFailureBody = await unknown.text();
    expect(genericFailureBody).toBe(await wrong.text());
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect((await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner password" }),
    })).status).toBe(403);

    const passwordOnly = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner password" }),
    });
    expect(passwordOnly.status).toBe(303);
    const preauth = cookiePair(passwordOnly);
    const [, preauthValue = ""] = preauth.split("=");
    const [, preauthCsrf = ""] = preauthValue.split(".");
    const badMfa = await current.app.request(`${ADMIN_ORIGIN}/admin/mfa`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: preauth,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "owner", method: "recovery", code: "invalid-recovery-code", csrf: preauthCsrf,
      }),
    });
    expect(badMfa.status).toBe(401);
    expect(await badMfa.text()).toBe(genericFailureBody);

    const authenticated = await login(current);
    expect(authenticated.cookie).toMatch(/^__Host-wisdom-admin=/);
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 1 });
  });

  it("rejects unsupported, oversized, duplicate, and overlong login forms before password KDF", async () => {
    const current = await fixture();
    const request = (body: BodyInit, contentType = "application/x-www-form-urlencoded") =>
      current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
        method: "POST",
        headers: { origin: ADMIN_ORIGIN, "content-type": contentType },
        body,
      });
    const unsupported = await request(JSON.stringify({ username: "owner", password: "owner password" }), "application/json");
    const oversized = await request(`username=owner&password=${"a".repeat(17_000)}`);
    const duplicate = await request("username=owner&username=other&password=owner+password");
    const overlong = await request(new URLSearchParams({ username: "owner", password: "a".repeat(1_025) }));
    expect([
      unsupported.status, oversized.status, duplicate.status, overlong.status,
    ]).toEqual([415, 413, 400, 400]);
    for (const response of [unsupported, oversized, duplicate, overlong]) sensitiveHeaders(response);
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_login_buckets
    `).get()).toEqual({ count: 0 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_pre_auth_challenges
    `).get()).toEqual({ count: 0 });
  });

  it("renders all required protected SSR pages, escapes stored PII, and enforces CSRF/CAS/logout", async () => {
    const current = await fixture();
    const session = await login(current);
    for (const path of [
      "/admin",
      "/admin/consultations",
      "/admin/notifications",
      "/admin/consents",
      "/admin/failures",
      "/admin/health",
    ]) {
      const response = await current.app.request(`${ADMIN_ORIGIN}${path}`, {
        headers: { cookie: session.cookie },
      });
      expect(response.status, path).toBe(200);
      sensitiveHeaders(response);
    }
    const detail = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/consultation-1`, {
      headers: { cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("&lt;script&gt;stored-name&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=stored-company&gt;");
    expect(html).not.toContain("<script>stored-name</script>");
    expect(html).toMatch(/<title>Consultation detail<\/title>/);
    const detailCsrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(detailCsrf).toBe(session.csrf);

    const missingCsrf = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status: "acknowledged", rowVersion: "1" }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    const changed = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          status: "acknowledged", rowVersion: "1", csrf: detailCsrf!,
        }),
      },
    );
    expect(changed.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT status, row_version FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ status: "acknowledged", row_version: 2 });
    const stale = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status: "closed", rowVersion: "1", csrf: detailCsrf! }),
      },
    );
    expect(stale.status).toBe(409);

    expect((await current.app.request(`${ADMIN_ORIGIN}/admin/logout`, {
      method: "GET", headers: { cookie: session.cookie },
    })).status).toBe(404);
    current.now += 29 * 60 * 1_000;
    const refreshedDashboard = await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    });
    expect(refreshedDashboard.status).toBe(200);
    const dashboardHtml = await refreshedDashboard.text();
    const logoutCsrf = /action="\/admin\/logout"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
    expect(logoutCsrf).toBe(session.csrf);
    expect(current.database.db.sqlite.prepare(`
      SELECT idle_expires_at_ms FROM admin_sessions WHERE revoked_at_ms IS NULL
    `).get()).toEqual({ idle_expires_at_ms: current.now + 30 * 60 * 1_000 });
    const logout = await current.app.request(`${ADMIN_ORIGIN}/admin/logout`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: logoutCsrf! }),
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    })).status).toBe(303);
  });

  it("persists gated notification settings/tests, paginates consultations, requeues failed history, and reports degraded health", async () => {
    const current = await fixture();
    const session = await login(current);
    const insert = current.database.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 0, ?, ?, 10000000, 1)
    `);
    for (let index = 2; index <= 22; index += 1) {
      insert.run(`consultation-${index}`, `receipt-${index}`, Buffer.alloc(32, index), index * 100, index * 100);
    }
    const dashboard = await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    });
    expect(await dashboard.text()).toContain("received: 22");
    const firstPage = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations?page=1`, {
      headers: { cookie: session.cookie },
    });
    expect(await firstPage.text()).toContain("receipt-22");
    const secondPage = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations?page=2`, {
      headers: { cookie: session.cookie },
    });
    expect(await secondPage.text()).toContain("receipt-1");
    const consents = await current.app.request(`${ADMIN_ORIGIN}/admin/consents`, {
      headers: { cookie: session.cookie },
    });
    expect(await consents.text()).toContain("bundle-2026-07-16");

    const notificationPage = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications`, {
      headers: { cookie: session.cookie },
    });
    const notificationHtml = await notificationPage.text();
    for (const field of ["smtpHost", "smtpPort", "smtpFrom", "smtpTo", "smtpTlsMode", "smtpSecretRef"]) {
      expect(notificationHtml).toContain(`name="${field}"`);
    }
    expect(notificationHtml).not.toMatch(/name="(?:smtp)?password"/i);
    const notificationCsrf = /action="\/admin\/notifications"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(notificationHtml)?.[1];
    expect(notificationCsrf).toBe(session.csrf);
    const postSettings = (values: Record<string, string>) => current.app.request(
      `${ADMIN_ORIGIN}/admin/notifications`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: notificationCsrf!, channel: "email", ...values }),
      },
    );
    expect((await postSettings({ enabled: "1", payloadMode: "not-a-mode" })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "full-inquiry", fullInquiryApproved: "yes",
    })).status).toBe(422);
    const smtpValues = {
      smtpHost: "smtp.example.com",
      smtpPort: "465",
      smtpFrom: "office@example.test",
      smtpTo: "owner@example.test",
      smtpTlsMode: "implicit-tls",
      smtpSecretRef: "keychain:smtp",
    };
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpTlsMode: "plaintext",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpSecretRef: "raw-password",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpPassword: "must-never-be-accepted",
    })).status).toBe(422);
    for (const smtpHost of [
      "127.0.0.1",
      "10.0.0.1",
      "localhost",
      "mail.local",
      "mail.internal",
      "smtp.example.test",
    ]) {
      expect((await postSettings({
        enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpHost,
      })).status, smtpHost).toBe(422);
    }
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpPort: "587",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "full-inquiry", ...smtpValues,
    })).status).toBe(422);
    expect(current.database.db.sqlite.prepare(
      "SELECT count(*) count FROM notification_settings",
    ).get()).toEqual({ count: 0 });
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues,
    })).status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual({
      enabled: 1,
      provider: "smtp",
      payload_mode: "receipt-only",
      config_json: JSON.stringify({
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      }),
      secret_ref: "keychain:smtp",
    });
    expect(current.database.db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events
      WHERE action = 'notification.settings.updated' ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      action: "notification.settings.updated",
      metadata_json: JSON.stringify({
        enabled: true, payloadMode: "receipt-only", smtpConfigured: true,
      }),
    });
    expect(JSON.stringify(current.logs)).not.toMatch(/smtp\.example|office@example|owner@example|keychain:smtp/);
    expect((await postSettings({
      enabled: "1", payloadMode: "full-inquiry", fullInquiryApproved: "yes", ...smtpValues,
    })).status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT payload_mode, config_json, secret_ref FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual({
      payload_mode: "full-inquiry",
      config_json: JSON.stringify({
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      }),
      secret_ref: "keychain:smtp",
    });
    const savedNotificationHtml = await (await current.app.request(
      `${ADMIN_ORIGIN}/admin/notifications`,
      { headers: { cookie: session.cookie } },
    )).text();
    expect(savedNotificationHtml).toContain('name="enabled" value="1" checked');
    expect(savedNotificationHtml).toContain('value="full-inquiry" selected');
    const testEnqueue = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications/test`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: notificationCsrf!, channel: "email" }),
    });
    expect(testEnqueue.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT channel, purpose, state, payload_json FROM notification_outbox WHERE purpose = 'test'
    `).get()).toEqual({
      channel: "email", purpose: "test", state: "pending", payload_json: '{"test":true}',
    });
    const emailBeforeHermes = current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get();
    const hermesSettings = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: notificationCsrf!,
        channel: "hermes-telegram",
        enabled: "1",
        payloadMode: "receipt-only",
        smtpHost: "",
        smtpPort: "",
        smtpFrom: "",
        smtpTo: "",
        smtpTlsMode: "implicit-tls",
        smtpSecretRef: "",
      }),
    });
    expect(hermesSettings.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'hermes-telegram'
    `).get()).toEqual({
      enabled: 1, provider: "hermes", payload_mode: null, config_json: "{}", secret_ref: null,
    });
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual(emailBeforeHermes);

    current.database.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, state, attempt_count,
        available_at_ms, purpose, delivery_cycle, last_error_code,
        created_at_ms, updated_at_ms
      ) VALUES ('failed-delivery', 'consultation-1', 'email', 'notification.failed-test',
        'failed', 5, 0, 'test', 1, 'PROVIDER_ERROR', 0, 0)
    `).run();
    current.database.db.sqlite.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, delivery_cycle, attempt_no, worker_id,
        outcome_code, started_at_ms, finished_at_ms
      ) VALUES ('failed-attempt', 'failed-delivery', 1, 5, 'worker',
        'PROVIDER_ERROR', 0, 1)
    `).run();
    const failures = await current.app.request(`${ADMIN_ORIGIN}/admin/failures`, {
      headers: { cookie: session.cookie },
    });
    const failuresHtml = await failures.text();
    expect(failuresHtml).toContain("failed-delivery");
    const failureCsrf = /failed-delivery\/requeue"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(failuresHtml)?.[1];
    expect(failureCsrf).toBe(session.csrf);
    const requeued = await current.app.request(`${ADMIN_ORIGIN}/admin/failures/failed-delivery/requeue`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: failureCsrf! }),
    });
    expect(requeued.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT state, attempt_count, delivery_cycle FROM notification_outbox WHERE id = 'failed-delivery'
    `).get()).toEqual({ state: "pending", attempt_count: 0, delivery_cycle: 2 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_delivery_attempts WHERE outbox_id = 'failed-delivery'
    `).get()).toEqual({ count: 1 });

    current.database.db.sqlite.exec("DROP INDEX notification_outbox_lease_idx");
    const degraded = await current.app.request(`${ADMIN_ORIGIN}/admin/health`, {
      headers: { cookie: session.cookie },
    });
    expect(degraded.status).toBe(503);
    expect(await degraded.text()).toContain("not ready");
  });
});

describe("marketing withdrawal HTTP ceremony", () => {
  it("never renders or logs the raw capability and mutates only on strict-Origin POST", async () => {
    const current = await fixture();
    const minted = mintMarketingWithdrawalCapability(
      current.database.db,
      withdrawalSecret,
      {
        consultationId: "consultation-1",
        publicOrigin: PUBLIC_ORIGIN,
        nowMs: current.now,
        expiresAtMs: current.now + 1_000_000,
        randomBytes: () => Buffer.alloc(32, 101),
      },
    );
    const landing = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${minted.token}`);
    expect(landing.status).toBe(303);
    sensitiveHeaders(landing);
    expect(landing.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/marketing/withdraw`);
    expect(landing.headers.get("location")).not.toContain(minted.token);
    const landingCookie = cookiePair(landing);
    expect(landingCookie).not.toContain(minted.token);
    const beforeConfirmation = current.database.db.sqlite.serialize();
    const confirmation = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw`, {
      headers: { cookie: landingCookie },
    });
    expect(confirmation.status).toBe(200);
    sensitiveHeaders(confirmation);
    const html = await confirmation.text();
    expect(html).not.toContain(minted.token);
    expect(html).toContain('action="/marketing/withdraw"');
    expect(current.database.db.sqlite.serialize()).toEqual(beforeConfirmation);
    const confirmationValue = /name="confirmation" value="([^"]+)"/.exec(html)?.[1];
    expect(confirmationValue).toBeTruthy();
    const duplicate = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `confirmation=${encodeURIComponent(confirmationValue!)}&confirmation=${encodeURIComponent(confirmationValue!)}`,
    });
    expect(duplicate.status).toBe(400);
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM consent_events WHERE kind = 'marketing' AND decision = 'withdrawn'
    `).get()).toEqual({ count: 0 });
    expect((await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw`, {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    })).status).toBe(403);
    const withdrawn = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.text()).not.toContain(minted.token);
    expect(JSON.stringify(current.logs)).not.toContain(minted.token);
    expect((await current.app.request(`${ADMIN_ORIGIN}/marketing/withdraw/${minted.token}`)).status).toBe(404);
  });

  it("redacts raw-token route labels even when storage throws", async () => {
    const current = await fixture();
    const token = Buffer.alloc(32, 111).toString("base64url");
    current.database.db.sqlite.close();
    const response = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${token}`);
    expect(response.status).toBe(503);
    sensitiveHeaders(response);
    expect(JSON.stringify(current.logs)).not.toContain(token);
    expect(current.logs.at(-1)?.route).toBe("/marketing/withdraw/:token");
  });

  it.each([
    ["ko", "/marketing/withdraw", "마케팅 수신 동의 철회", "동의 철회가 완료되었습니다"],
    ["en", "/en/marketing/withdraw", "Withdraw marketing consent", "Marketing consent withdrawn"],
    ["zh-Hans", "/zh-hans/marketing/withdraw", "撤回营销信息接收同意", "营销信息接收同意已撤回"],
    ["zh-Hant", "/zh-hant/marketing/withdraw", "撤回行銷資訊接收同意", "行銷資訊接收同意已撤回"],
  ] as const)("renders localized withdrawal confirmation and success for %s", async (
    locale, route, confirmationCopy, successCopy,
  ) => {
    const current = await fixture();
    current.database.db.sqlite.prepare(`
      UPDATE consultations SET locale = ? WHERE id = 'consultation-1'
    `).run(locale);
    const minted = mintMarketingWithdrawalCapability(
      current.database.db,
      withdrawalSecret,
      {
        consultationId: "consultation-1",
        publicOrigin: PUBLIC_ORIGIN,
        nowMs: current.now,
        expiresAtMs: current.now + 1_000_000,
      },
    );
    const landing = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${minted.token}`);
    expect(landing.headers.get("location")).toBe(`${PUBLIC_ORIGIN}${route}`);
    const landingCookie = cookiePair(landing);
    const confirmation = await current.app.request(`${PUBLIC_ORIGIN}${route}`, {
      headers: { cookie: landingCookie },
    });
    const confirmationHtml = await confirmation.text();
    expect(confirmationHtml).toContain(`lang="${locale}"`);
    expect(confirmationHtml).toContain(confirmationCopy);
    const confirmationValue = /name="confirmation" value="([^"]+)"/.exec(confirmationHtml)?.[1];
    const success = await current.app.request(`${PUBLIC_ORIGIN}${route}`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    });
    const successHtml = await success.text();
    expect(successHtml).toContain(`lang="${locale}"`);
    expect(successHtml).toContain(successCopy);
  });
});
