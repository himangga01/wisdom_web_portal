import { readFileSync } from "node:fs";

import { consultationRequestSchema } from "@wisdom/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../test/helpers.js";
import { createControlApp, type RedactedLogEvent } from "./app.js";
import { activateConsentBundle, seedConsentDocuments } from "./consent/service.js";
import type { IntakeFaultPoint } from "./consultations/service.js";
import { createStaticKeyProvider } from "./crypto/index.js";
import { closeDatabase, openDatabase } from "./db/client.js";

const ALLOWED_ORIGIN = "https://www.example.test";
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 9) });
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  vi.restoreAllMocks();
});

const INTAKE_FAULT_POINTS = [
  "after-rate-limits",
  "after-consultation",
  "after-consent-events",
  "after-outbox",
  "after-audit",
  "after-idempotency",
] as const satisfies readonly IntakeFaultPoint[];

interface Fixture {
  app: ReturnType<typeof createControlApp>;
  database: TestDatabase;
  logs: RedactedLogEvent[];
  get now(): number;
  set now(value: number);
}

function fixture(options: {
  activeConsent?: boolean;
  faultInjector?: (point: IntakeFaultPoint) => void;
  peerAddress?: string;
  useDefaultLogger?: boolean;
  indexNowKey?: string;
  indexNowKeyProvider?: () => string | undefined;
} = {}): Fixture {
  const database = createTestDatabase();
  cleanup.push(() => database.close());
  if (options.activeConsent !== false) {
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
  }
  let now = Date.UTC(2026, 6, 16, 2, 0, 0);
  const logs: RedactedLogEvent[] = [];
  const app = createControlApp({
    db: database.db,
    keyProvider,
    allowedOrigins: [ALLOWED_ORIGIN],
    enforceOrigin: true,
    now: () => now,
    peerAddress: () => options.peerAddress ?? "203.0.113.10",
    ...(options.useDefaultLogger ? {} : { logger: { write: (event: RedactedLogEvent) => logs.push(event) } }),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
    ...(options.indexNowKey ? { indexNowKey: options.indexNowKey } : {}),
    ...(options.indexNowKeyProvider ? { indexNowKeyProvider: options.indexNowKeyProvider } : {}),
  });
  return {
    app,
    database,
    logs,
    get now() { return now; },
    set now(value: number) { now = value; },
  };
}

async function consentConfiguration(app: Fixture["app"], locale = "en") {
  const response = await app.request(`http://localhost/api/v1/consent-documents?locale=${locale}`);
  expect(response.status).toBe(200);
  return await response.json() as {
    locale: "en";
    documents: {
      privacy: { version: string; contentSha256: string };
      marketing: { version: string; contentSha256: string };
    };
    formToken: string;
  };
}

function submission(configuration: Awaited<ReturnType<typeof consentConfiguration>>, overrides: Record<string, unknown> = {}) {
  const consultation = consultationRequestSchema.parse({
    locale: "en",
    category: "procurement",
    name: "Hong Gildong",
    phone: "+82 (10) 1234-5678",
    email: "client@example.com",
    company: "Wisdom Co.",
    preferredContact: "phone",
    message: "Please review our public procurement registration plan.",
    privacyConsent: { version: configuration.documents.privacy.version, accepted: true },
    marketingConsent: { version: configuration.documents.marketing.version, accepted: false },
    ...overrides,
  });
  return {
    consultation,
    antiAbuse: { formToken: configuration.formToken, website: "" },
  };
}

function post(app: Fixture["app"], body: string, idempotencyKey: string, origin = ALLOWED_ORIGIN) {
  return app.request("http://localhost/api/v1/consultations", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      Origin: origin,
    },
    body,
  });
}

function expectNoRequestCanaries(output: string, body: string, idempotencyKey: string): void {
  for (const canary of [
    idempotencyKey,
    body,
    "Hong Gildong",
    "+821012345678",
    "client@example.com",
    "Wisdom Co.",
    "public procurement registration plan",
  ]) {
    expect(output).not.toContain(canary);
  }
}

describe("public control API", () => {
  it("serves adapter-compatible consent metadata, round-trips it through shared parsing, and fails health closed", async () => {
    const ready = fixture();
    const consentResponse = await ready.app.request(
      "http://localhost/api/v1/consent-documents?locale=en",
    );
    expect(consentResponse.status).toBe(200);
    expect(consentResponse.headers.get("cache-control")).toBe("no-store");
    expect(consentResponse.headers.get("x-request-id")).toBeTruthy();
    const configuration = await consentResponse.json() as Awaited<ReturnType<typeof consentConfiguration>>;
    expect(configuration).toMatchObject({
      locale: "en",
      documents: {
        privacy: { version: "privacy-2026-07-16", required: true },
        marketing: { version: "marketing-2026-07-16", required: false },
      },
      formToken: expect.any(String),
    });
    ready.now += 2_000;
    const roundTrip = submission(configuration);
    expect(consultationRequestSchema.parse(roundTrip.consultation)).toEqual(roundTrip.consultation);
    expect((await post(
      ready.app,
      JSON.stringify(roundTrip),
      "consent-roundtrip-key-0001",
    )).status).toBe(201);
    expect((await ready.app.request("http://localhost/health/live")).status).toBe(200);
    expect((await ready.app.request("http://localhost/health/ready")).status).toBe(200);

    const notReady = fixture({ activeConsent: false });
    expect((await notReady.app.request("http://localhost/health/live")).status).toBe(200);
    expect((await notReady.app.request("http://localhost/health/ready")).status).toBe(503);
    expect((await notReady.app.request("http://localhost/api/v1/consent-documents?locale=en")).status).toBe(503);
  });

  it("serves the configured public IndexNow ownership key as exact noindex text", async () => {
    const key = "abcdef12-ABCDEF34";
    const configured = fixture({ indexNowKey: key });
    const response = await configured.app.request("http://localhost/indexnow-key.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(key);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");

    const absent = fixture();
    expect((await absent.app.request("http://localhost/indexnow-key.txt")).status).toBe(404);
  });

  it("exposes a recovered IndexNow key without restarting consultation intake", async () => {
    let key: string | undefined;
    const current = fixture({ indexNowKeyProvider: () => key });

    expect((await current.app.request("http://localhost/indexnow-key.txt")).status).toBe(404);
    key = "abcdef12-RECOVERED34";
    const recovered = await current.app.request("http://localhost/indexnow-key.txt");
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(key);
    expect((await current.app.request("http://localhost/health/live")).status).toBe(200);
  });

  it("atomically stores encrypted intake and exactly replays an idempotent receipt", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent));
    const key = "00000000-0000-4000-8000-000000000001";

    const first = await post(current.app, body, key);
    const firstBody = await first.text();
    const replay = await post(current.app, body, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(firstBody);

    const conflicting = JSON.stringify(submission(consent, {
      message: "This is a different request using the same idempotency key.",
    }));
    expect((await post(current.app, conflicting, key)).status).toBe(409);

    for (const [table, count] of [
      ["consultations", 1],
      ["consent_events", 2],
      ["notification_outbox", 2],
      ["audit_events", 1],
      ["idempotency_keys", 1],
    ] as const) {
      expect(current.database.db.sqlite.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count });
    }
    const stored = current.database.db.sqlite.prepare(
      "SELECT pii_envelope, pii_key_id, phone_blind_index, email_blind_index FROM consultations",
    ).get() as Record<string, unknown>;
    expect(stored.pii_key_id).toBe("pii-v1");
    expect(String(stored.pii_envelope)).not.toContain("Hong Gildong");
    expect(stored.phone_blind_index).toBeInstanceOf(Buffer);
    expect(stored.email_blind_index).toBeInstanceOf(Buffer);

    const outbox = JSON.stringify(current.database.db.sqlite.prepare(
      "SELECT payload_json FROM notification_outbox ORDER BY channel",
    ).all());
    expect(outbox).toContain("receiptId");
    for (const secret of ["Hong Gildong", "+821012345678", "client@example.com", "procurement registration"]) {
      expect(outbox).not.toContain(secret);
      expect(JSON.stringify(current.logs)).not.toContain(secret);
    }
  });

  it("queues a distinct hash-only customer marketing email when optional consent is accepted", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent, {
      marketingConsent: { version: consent.documents.marketing.version, accepted: true },
    }));
    const response = await post(current.app, body, "marketing-confirmation-key-0001");
    expect(response.status).toBe(201);
    expect(current.database.db.sqlite.prepare(`
      SELECT channel, event_type, purpose, payload_json
      FROM notification_outbox ORDER BY purpose, channel
    `).all()).toEqual([
      {
        channel: "email",
        event_type: "marketing.confirmation",
        purpose: "marketing",
        payload_json: expect.stringContaining("receiptId"),
      },
      {
        channel: "email",
        event_type: "consultation.received",
        purpose: "transactional",
        payload_json: expect.stringContaining("receiptId"),
      },
      {
        channel: "hermes-telegram",
        event_type: "consultation.received",
        purpose: "transactional",
        payload_json: expect.stringContaining("receiptId"),
      },
    ]);
    const persisted = current.database.db.sqlite.serialize();
    for (const secret of ["client@example.com", "Hong Gildong", "/marketing/withdraw/"]) {
      expect(persisted.includes(Buffer.from(secret))).toBe(false);
    }
    expect(current.database.db.sqlite.prepare(
      "SELECT count(*) count FROM marketing_withdrawal_capabilities",
    ).get()).toEqual({ count: 0 });
  });

  it("serializes the same key across two file-backed connections", async () => {
    const current = fixture();
    const secondDb = openDatabase(current.database.path);
    cleanup.push(() => closeDatabase(secondDb));
    const secondApp = createControlApp({
      db: secondDb,
      keyProvider,
      allowedOrigins: [ALLOWED_ORIGIN],
      enforceOrigin: true,
      now: () => current.now,
      peerAddress: () => "203.0.113.10",
    });
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent));
    const key = "00000000-0000-4000-8000-000000000002";

    const responses = await Promise.all([
      post(current.app, body, key),
      post(secondApp, body, key),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses.filter((response) => response.headers.get("idempotent-replayed") === "true")).toHaveLength(1);
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM consultations").get()).toEqual({ count: 1 });
  });

  it.each(INTAKE_FAULT_POINTS)("rolls back every intake table at fault point %s", async (faultPoint) => {
    const current = fixture({
      faultInjector: (point) => {
        if (point === faultPoint) throw new Error("injected write fault");
      },
    });
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const response = await post(
      current.app,
      JSON.stringify(submission(consent)),
      "00000000-0000-4000-8000-000000000003",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    for (const table of [
      "consultations",
      "consent_events",
      "notification_outbox",
      "audit_events",
      "idempotency_keys",
      "abuse_buckets",
    ]) {
      expect(current.database.db.sqlite.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(current.logs).toEqual([
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE", route: "/api/v1/consultations" }),
    ]);
    expect(Object.keys(current.logs[0] ?? {}).sort()).toEqual([
      "code",
      "method",
      "requestId",
      "route",
    ]);
  });

  it("enforces media, origin, validation and exact streamed 32 KiB boundaries", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const validBody = JSON.stringify(submission(consent));

    const media = await current.app.request("http://localhost/api/v1/consultations", {
      method: "POST",
      headers: { "content-type": "text/plain", "idempotency-key": "00000000-0000-4000-8000-000000000004", origin: ALLOWED_ORIGIN },
      body: validBody,
    });
    expect(media.status).toBe(415);
    expect((await media.json()).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect((await post(current.app, validBody, "00000000-0000-4000-8000-000000000005", "https://evil.test")).status).toBe(403);

    const invalid = JSON.stringify({ ...submission(consent), consultation: { ...submission(consent).consultation, message: "short" } });
    const invalidResponse = await post(current.app, invalid, "00000000-0000-4000-8000-000000000006");
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: { message: expect.any(Array) },
    });

    const exact = validBody + " ".repeat(32_768 - Buffer.byteLength(validBody));
    expect(Buffer.byteLength(exact)).toBe(32_768);
    expect((await post(current.app, exact, "00000000-0000-4000-8000-000000000007")).status).toBe(201);
    const tooLarge = `${exact} `;
    const tooLargeResponse = await post(current.app, tooLarge, "00000000-0000-4000-8000-000000000008");
    expect(tooLargeResponse.status).toBe(413);
    expect((await tooLargeResponse.json()).code).toBe("PAYLOAD_TOO_LARGE");

    const malformed = await post(current.app, "{", "00000000-0000-4000-8000-000000000009");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe("INVALID_JSON");
  });

  it("requires a printable bounded idempotency key and accepts JSON charset", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent));
    const withoutKey = await current.app.request("http://localhost/api/v1/consultations", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ALLOWED_ORIGIN },
      body,
    });
    expect(withoutKey.status).toBe(428);
    expect((await withoutKey.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    for (const key of ["too-short", "x".repeat(129), `valid-prefix-${String.fromCharCode(31)}-bad`]) {
      const response = await post(current.app, body, key);
      expect(response.status, key.length.toString()).toBe(400);
      expect((await response.json()).code).toBe("INVALID_IDEMPOTENCY_KEY");
    }

    const charset = await current.app.request("http://localhost/api/v1/consultations", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "idempotency-key": "charset-json-key-0001",
        origin: ALLOWED_ORIGIN,
      },
      body,
    });
    expect(charset.status).toBe(201);
  });

  it("replays after close/reopen and atomically replaces an expired key", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent));
    const key = "restart-expiry-key-0001";
    const first = await post(current.app, body, key);
    const firstBody = await first.text();
    expect(first.status).toBe(201);

    closeDatabase(current.database.db);
    const reopened = openDatabase(current.database.path);
    cleanup.push(() => closeDatabase(reopened));
    const reopenedApp = createControlApp({
      db: reopened,
      keyProvider,
      allowedOrigins: [ALLOWED_ORIGIN],
      enforceOrigin: true,
      now: () => current.now,
      peerAddress: () => "203.0.113.10",
    });
    const replay = await post(reopenedApp, body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(firstBody);

    current.now += 24 * 60 * 60 * 1_000;
    const refreshedResponse = await reopenedApp.request("http://localhost/api/v1/consent-documents?locale=en");
    const refreshed = await refreshedResponse.json() as Awaited<ReturnType<typeof consentConfiguration>>;
    current.now += 2_000;
    const replacementBody = JSON.stringify(submission(refreshed, {
      message: "A later consultation may atomically reuse an expired idempotency key.",
    }));
    const replacement = await post(reopenedApp, replacementBody, key);
    expect(replacement.status).toBe(201);
    expect(replacement.headers.get("idempotent-replayed")).toBeNull();
    expect(reopened.sqlite.prepare("SELECT count(*) count FROM consultations").get()).toEqual({ count: 2 });
    expect(reopened.sqlite.prepare("SELECT count(*) count FROM idempotency_keys").get()).toEqual({ count: 1 });
  });

  it("enforces token timing, honeypot and active consent versions", async () => {
    const current = fixture();
    const oldConsent = await consentConfiguration(current.app);
    const body = JSON.stringify(submission(oldConsent));
    expect((await post(current.app, body, "00000000-0000-4000-8000-000000000010")).status).toBe(400);

    current.now += 2_000;
    expect((await post(current.app, body, "00000000-0000-4000-8000-000000000011")).status).toBe(201);

    const honeypot = JSON.stringify({
      ...submission(oldConsent),
      antiAbuse: { formToken: oldConsent.formToken, website: "filled" },
    });
    expect((await post(current.app, honeypot, "00000000-0000-4000-8000-000000000012")).status).toBe(400);

    seedConsentDocuments(current.database.db, consentBundle("bundle-new", "new"), current.now);
    activateConsentBundle(current.database.db, "bundle-new", current.now);
    const replayAfterRotation = await post(
      current.app,
      body,
      "00000000-0000-4000-8000-000000000011",
    );
    expect(replayAfterRotation.status).toBe(201);
    expect(replayAfterRotation.headers.get("idempotent-replayed")).toBe("true");
    expect((await post(current.app, body, "00000000-0000-4000-8000-000000000013")).status).toBe(409);

    current.now += 2 * 60 * 60 * 1_000;
    const replayAfterTokenExpiry = await post(
      current.app,
      body,
      "00000000-0000-4000-8000-000000000011",
    );
    expect(replayAfterTokenExpiry.status).toBe(201);
    expect(replayAfterTokenExpiry.headers.get("idempotent-replayed")).toBe("true");
  });

  it("applies exact contact and IP ten-minute limits after replay checks", async () => {
    const contactLimited = fixture();
    const consent = await consentConfiguration(contactLimited.app);
    contactLimited.now += 2_000;
    const body = JSON.stringify(submission(consent));
    for (let index = 0; index < 3; index += 1) {
      expect((await post(contactLimited.app, body, `contact-limit-key-${index}`)).status).toBe(201);
    }
    expect((await post(contactLimited.app, body, "contact-limit-key-3")).status).toBe(429);
    const replay = await post(contactLimited.app, body, "contact-limit-key-0");
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const ipLimited = fixture();
    const ipConsent = await consentConfiguration(ipLimited.app);
    ipLimited.now += 2_000;
    for (let index = 0; index < 5; index += 1) {
      const uniqueBody = JSON.stringify(submission(ipConsent, {
        phone: `01000000${String(index).padStart(2, "0")}`,
        email: "",
      }));
      expect((await post(ipLimited.app, uniqueBody, `ip-rate-limit-key-${index}`)).status).toBe(201);
    }
    const sixth = JSON.stringify(submission(ipConsent, { phone: "0100000005", email: "" }));
    const response = await post(ipLimited.app, sixth, "ip-rate-limit-key-5");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("does not persist raw consultation PII in SQLite, WAL or logs", async () => {
    const current = fixture();
    const consent = await consentConfiguration(current.app);
    current.now += 2_000;
    const body = JSON.stringify(submission(consent));
    expect((await post(current.app, body, "00000000-0000-4000-8000-000000000014")).status).toBe(201);
    current.database.db.sqlite.pragma("wal_checkpoint(FULL)");

    const bytes = [current.database.path, `${current.database.path}-wal`, `${current.database.path}-shm`]
      .flatMap((path) => {
        try { return [readFileSync(path)]; } catch { return []; }
      });
    for (const secret of ["Hong Gildong", "+821012345678", "client@example.com", "Wisdom Co.", "public procurement registration plan"]) {
      expect(bytes.some((buffer) => buffer.includes(Buffer.from(secret)))).toBe(false);
      expect(JSON.stringify(current.logs)).not.toContain(secret);
    }
  });

  it.each(["success", "validation", "injected-storage"] as const)(
    "keeps raw request canaries out of the injected logger on %s",
    async (mode) => {
      const current = fixture({
        ...(mode === "injected-storage"
          ? { faultInjector: () => { throw new Error("injected storage failure"); } }
          : {}),
      });
      const consent = await consentConfiguration(current.app);
      current.now += 2_000;
      const valid = submission(consent);
      const body = JSON.stringify(mode === "validation"
        ? { ...valid, consultation: { ...valid.consultation, message: "short" } }
        : valid);
      const idempotencyKey = `injected-log-${mode}-key-0001`;

      const response = await post(current.app, body, idempotencyKey);
      expect(response.status).toBe(mode === "success" ? 201 : mode === "validation" ? 422 : 503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/i);
      expectNoRequestCanaries(JSON.stringify(current.logs), body, idempotencyKey);
    },
  );

  it("keeps raw request canaries out of default logger stdout and stderr on every outcome", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => stdout.push(values.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => stderr.push(values.map(String).join(" ")));
    const canaries: Array<{ body: string; idempotencyKey: string }> = [];

    for (const mode of ["success", "validation", "injected-storage"] as const) {
      const current = fixture({
        useDefaultLogger: true,
        ...(mode === "injected-storage"
          ? { faultInjector: () => { throw new Error("injected storage failure"); } }
          : {}),
      });
      const consent = await consentConfiguration(current.app);
      current.now += 2_000;
      const valid = submission(consent);
      const body = JSON.stringify(mode === "validation"
        ? { ...valid, consultation: { ...valid.consultation, message: "short" } }
        : valid);
      const idempotencyKey = `default-log-${mode}-key-0001`;
      canaries.push({ body, idempotencyKey });

      const response = await post(current.app, body, idempotencyKey);
      expect(response.status).toBe(mode === "success" ? 201 : mode === "validation" ? 422 : 503);
    }

    const output = JSON.stringify({ stdout, stderr });
    for (const canary of canaries) {
      expectNoRequestCanaries(output, canary.body, canary.idempotencyKey);
    }
  });
});
