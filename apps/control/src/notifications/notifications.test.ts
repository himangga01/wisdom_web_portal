import { createHmac } from "node:crypto";

import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { closeDatabase, openDatabase, runMigrations } from "../db/client.js";
import { createStaticKeyProvider, decryptPii, encryptPii } from "../crypto/index.js";
import * as controlModule from "../index.js";

const control = controlModule as unknown as Record<string, unknown>;
let testDatabase: TestDatabase | undefined;
const publicSmtpLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function requiredFunction<T>(name: string): T {
  expect(control[name], `${name} must be exported`).toBeTypeOf("function");
  return control[name] as T;
}

function seedConsultation(database: TestDatabase["db"]): void {
  database.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
      marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('consultation-1', 'receipt-1', 'received', 'ko', 'procurement', 'phone',
      'opaque-envelope', 'pii-v1', ?, 'pii-v1', 0, 0, 0, 10000000, 1)
  `).run(Buffer.alloc(32, 1));
}

function enqueue(database: TestDatabase["db"], id = "delivery-1", eventType = "consultation.received"): void {
  database.sqlite.prepare(`
    INSERT INTO notification_outbox (
      id, consultation_id, channel, event_type, payload_json, state,
      attempt_count, available_at_ms, purpose, delivery_cycle,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'consultation-1', 'email', ?, '{"receiptId":"receipt-1"}',
      'pending', 0, 0, 'transactional', 1, 0, 0)
  `).run(id, eventType);
}

interface Claim {
  id: string;
  deliveryId: string;
  deliveryCycle: number;
  attemptNo: number;
  workerId: string;
  attemptId: string;
}

type ClaimNotification = (
  db: TestDatabase["db"],
  input: { workerId: string; nowMs: number; attemptId?: () => string },
) => Claim | undefined;

describe("notification outbox delivery", () => {
  it("claims once, recovers a two-minute lease, applies exact backoff, and fails after five attempts", () => {
    const claim = requiredFunction<ClaimNotification>("claimNotification");
    const fail = requiredFunction<(
      db: TestDatabase["db"], claimed: Claim, nowMs: number, outcomeCode: string,
    ) => void>("finalizeNotificationFailure");
    const requeue = requiredFunction<(
      db: TestDatabase["db"], id: string, nowMs: number,
    ) => boolean>("requeueFailedNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enqueue(testDatabase.db);
    let attemptSequence = 0;
    const nextAttempt = () => `attempt-${++attemptSequence}`;

    const first = claim(testDatabase.db, { workerId: "worker-a", nowMs: 0, attemptId: nextAttempt });
    expect(first).toMatchObject({
      id: "delivery-1", deliveryId: "delivery-1", deliveryCycle: 1, attemptNo: 1,
    });
    const competing = openDatabase(testDatabase.path);
    runMigrations(competing);
    expect(claim(competing, { workerId: "worker-b", nowMs: 119_999, attemptId: nextAttempt })).toBeUndefined();
    const second = claim(competing, { workerId: "worker-b", nowMs: 120_000, attemptId: nextAttempt });
    expect(second).toMatchObject({ deliveryId: "delivery-1", deliveryCycle: 1, attemptNo: 2 });
    expect(competing.sqlite.prepare(`
      SELECT outcome_code, finished_at_ms FROM notification_delivery_attempts
      WHERE id = 'attempt-1'
    `).get()).toEqual({ outcome_code: "LEASE_EXPIRED", finished_at_ms: 120_000 });

    fail(competing, second!, 120_000, "SMTP_TEMPORARY");
    expect(competing.sqlite.prepare(`
      SELECT state, attempt_count, available_at_ms FROM notification_outbox WHERE id = 'delivery-1'
    `).get()).toEqual({ state: "pending", attempt_count: 2, available_at_ms: 420_000 });
    let due = 420_000;
    for (const [attemptNo, delay] of [[3, 15 * 60_000], [4, 60 * 60_000]] as const) {
      const current = claim(competing, { workerId: "worker-b", nowMs: due, attemptId: nextAttempt })!;
      expect(current.attemptNo).toBe(attemptNo);
      fail(competing, current, due, "PROVIDER_TEMPORARY");
      due += delay;
      expect(competing.sqlite.prepare(
        "SELECT available_at_ms FROM notification_outbox WHERE id = 'delivery-1'",
      ).get()).toEqual({ available_at_ms: due });
    }
    const fifth = claim(competing, { workerId: "worker-b", nowMs: due, attemptId: nextAttempt })!;
    expect(fifth.attemptNo).toBe(5);
    fail(competing, fifth, due, "PROVIDER_FAILURE");
    expect(competing.sqlite.prepare(`
      SELECT state, attempt_count, last_error_code FROM notification_outbox WHERE id = 'delivery-1'
    `).get()).toEqual({ state: "failed", attempt_count: 5, last_error_code: "PROVIDER_FAILURE" });

    expect(requeue(competing, "delivery-1", due + 1)).toBe(true);
    expect(competing.sqlite.prepare(`
      SELECT state, attempt_count, delivery_cycle, available_at_ms FROM notification_outbox
      WHERE id = 'delivery-1'
    `).get()).toEqual({ state: "pending", attempt_count: 0, delivery_cycle: 2, available_at_ms: due + 1 });
    expect(competing.sqlite.prepare(
      "SELECT count(*) count FROM notification_delivery_attempts WHERE outbox_id = 'delivery-1'",
    ).get()).toEqual({ count: 5 });
    expect(claim(competing, {
      workerId: "worker-b", nowMs: due + 1, attemptId: nextAttempt,
    })).toMatchObject({ deliveryId: "delivery-1", deliveryCycle: 2, attemptNo: 1 });
    closeDatabase(competing);
  });

  it("uses 1, 5, 15, and 60 minute retry delays before terminal attempt five", () => {
    const claim = requiredFunction<ClaimNotification>("claimNotification");
    const fail = requiredFunction<(
      db: TestDatabase["db"], claimed: Claim, nowMs: number, outcomeCode: string,
    ) => void>("finalizeNotificationFailure");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enqueue(testDatabase.db, "delivery-backoff", "consultation.backoff-test");
    let due = 1_000;
    const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
    for (let index = 0; index < delays.length; index += 1) {
      const current = claim(testDatabase.db, {
        workerId: "worker-backoff",
        nowMs: due,
        attemptId: () => `backoff-attempt-${index + 1}`,
      })!;
      expect(current.attemptNo).toBe(index + 1);
      fail(testDatabase.db, current, due, "TEMPORARY");
      const nextDue = due + delays[index]!;
      expect(testDatabase.db.sqlite.prepare(`
        SELECT state, available_at_ms FROM notification_outbox WHERE id = 'delivery-backoff'
      `).get()).toEqual({ state: "pending", available_at_ms: nextDue });
      expect(claim(testDatabase.db, {
        workerId: "worker-backoff", nowMs: nextDue - 1,
      })).toBeUndefined();
      due = nextDue;
    }
    const fifth = claim(testDatabase.db, {
      workerId: "worker-backoff", nowMs: due, attemptId: () => "backoff-attempt-5",
    })!;
    expect(fifth.attemptNo).toBe(5);
    fail(testDatabase.db, fifth, due, "PERMANENT");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, attempt_count, last_error_code FROM notification_outbox
      WHERE id = 'delivery-backoff'
    `).get()).toEqual({ state: "failed", attempt_count: 5, last_error_code: "PERMANENT" });
  });

  it("finalizes only the worker-owned claim and preserves the stable provider delivery ID", () => {
    const claim = requiredFunction<ClaimNotification>("claimNotification");
    const succeed = requiredFunction<(
      db: TestDatabase["db"], claimed: Claim, nowMs: number, providerMessageId: string,
    ) => void>("finalizeNotificationSuccess");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enqueue(testDatabase.db);
    const claimed = claim(testDatabase.db, {
      workerId: "worker-a", nowMs: 0, attemptId: () => "attempt-success",
    })!;
    expect(() => succeed(
      testDatabase!.db, { ...claimed, workerId: "worker-b" }, 1, "provider-1",
    )).toThrow(/claim|worker/i);
    succeed(testDatabase.db, claimed, 1, "provider-1");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, provider_message_id, sent_at_ms FROM notification_outbox WHERE id = 'delivery-1'
    `).get()).toEqual({ state: "sent", provider_message_id: "provider-1", sent_at_ms: 1 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT outcome_code, provider_message_id FROM notification_delivery_attempts
      WHERE id = 'attempt-success'
    `).get()).toEqual({ outcome_code: "SENT", provider_message_id: "provider-1" });
  });

  it("fences expiry, stale workers, and mismatched delivery-attempt identities", () => {
    const claim = requiredFunction<ClaimNotification>("claimNotification");
    const succeed = requiredFunction<(
      db: TestDatabase["db"], claimed: Claim, nowMs: number, providerMessageId: string,
    ) => void>("finalizeNotificationSuccess");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enqueue(testDatabase.db, "delivery-fenced", "consultation.fenced-test");
    const first = claim(testDatabase.db, {
      workerId: "worker-old", nowMs: 0, attemptId: () => "attempt-old",
    })!;
    expect(() => succeed(testDatabase!.db, first, 120_000, "late-provider-id")).toThrow(/lease|claim/i);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, locked_by FROM notification_outbox WHERE id = 'delivery-fenced'
    `).get()).toEqual({ state: "processing", locked_by: "worker-old" });

    const replacement = claim(testDatabase.db, {
      workerId: "worker-new", nowMs: 120_000, attemptId: () => "attempt-new",
    })!;
    expect(replacement).toMatchObject({ attemptNo: 2, workerId: "worker-new" });
    expect(() => succeed(testDatabase!.db, first, 120_001, "stale-provider-id")).toThrow(/claim|worker/i);
    expect(() => succeed(testDatabase!.db, {
      ...replacement,
      attemptId: "attempt-does-not-exist",
    }, 120_001, "wrong-attempt-provider-id")).toThrow(/attempt|claim/i);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, provider_message_id, locked_by FROM notification_outbox WHERE id = 'delivery-fenced'
    `).get()).toEqual({ state: "processing", provider_message_id: null, locked_by: "worker-new" });
    succeed(testDatabase.db, replacement, 120_001, "provider-ok");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, provider_message_id FROM notification_outbox WHERE id = 'delivery-fenced'
    `).get()).toEqual({ state: "sent", provider_message_id: "provider-ok" });
  });
});

describe("notification adapters", () => {
  const metadata = {
    deliveryId: "delivery-1",
    consultationId: "consultation-1",
    purpose: "transactional" as const,
    eventType: "consultation.received",
    receiptId: "receipt-1",
    category: "procurement",
    locale: "ko",
    status: "received",
    receivedAt: "2026-07-16T00:00:00.000Z",
    adminUrl: "https://admin.example.test/admin/consultations/consultation-1",
    piiEnvelope: "opaque-envelope",
  };

  it("keeps receipt-only SMTP at zero decrypt and gates escaped full-inquiry rendering", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: typeof metadata): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const decryptPii = vi.fn((_consultationId: string, _envelope: string) => ({
      name: "<script>alert(1)</script>",
      phone: "010-0000-0000",
      email: "victim@example.test",
      message: "<img src=x onerror=alert(1)>",
    }));
    const sent: Array<Record<string, unknown>> = [];
    const base = {
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        from: "office@example.test",
        to: "owner@example.test",
      },
      decryptPii,
      lookup: publicSmtpLookup,
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: "smtp-provider-id" };
      },
    };
    const receiptOnly = createAdapter({ ...base, payloadMode: "receipt-only" });
    await expect(receiptOnly.deliver(metadata)).resolves.toEqual({ providerMessageId: "smtp-provider-id" });
    expect(decryptPii).not.toHaveBeenCalled();
    expect(JSON.stringify(sent[0])).not.toContain("opaque-envelope");

    const blocked = createAdapter({ ...base, payloadMode: "full-inquiry", fullInquiryApproved: false });
    await expect(blocked.deliver(metadata)).rejects.toThrow(/approved|gate/i);
    expect(decryptPii).not.toHaveBeenCalled();
    const insecure = createAdapter({
      ...base,
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      smtp: { ...base.smtp, secure: false },
    });
    await expect(insecure.deliver(metadata)).rejects.toThrow(/TLS|secure/i);

    const full = createAdapter({ ...base, payloadMode: "full-inquiry", fullInquiryApproved: true });
    await full.deliver(metadata);
    expect(decryptPii).toHaveBeenCalledWith("consultation-1", "opaque-envelope");
    const rendered = JSON.stringify(sent.at(-1));
    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rendered).not.toContain("<script>");
    expect(sent.at(-1)).toMatchObject({
      from: "office@example.test",
      to: "owner@example.test",
      messageId: "<delivery-1@wisdom.local>",
    });
    expect(String(sent.at(-1)?.subject)).not.toContain("victim@example.test");
  });

  it("keeps purpose=test structurally zero-decrypt even when full-inquiry mode is enabled", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: Omit<typeof metadata, "purpose"> & {
        purpose: "transactional" | "marketing" | "test";
      }): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const decryptPii = vi.fn(() => ({
      name: "Private Customer",
      phone: "010-9999-9999",
      email: "private@example.test",
      message: "private inquiry",
    }));
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createAdapter({
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii,
      lookup: publicSmtpLookup,
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: "test-provider-id" };
      },
    });

    await adapter.deliver({ ...metadata, purpose: "test", piiEnvelope: "private-envelope" });
    expect(decryptPii).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).not.toMatch(/Private Customer|private@example|private inquiry|private-envelope/);
  });

  it("signs exact loopback Hermes bytes and sends only allowlisted metadata", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: typeof metadata): Promise<{ providerMessageId: string }>;
    }>("createHermesNotificationAdapter");
    const secret = Buffer.alloc(32, 23);
    let captured: { url: string; init: RequestInit } | undefined;
    const adapter = createAdapter({
      endpoint: new URL("http://127.0.0.1:8788/notify"),
      secret,
      now: () => 1_700_000_000_000,
      nonce: () => "nonce-1",
      fetch: async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ providerMessageId: "telegram-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(adapter.deliver(metadata)).resolves.toEqual({ providerMessageId: "telegram-1" });
    expect(captured?.url).toBe("http://127.0.0.1:8788/notify");
    const body = String(captured?.init.body);
    expect(JSON.parse(body)).toEqual({
      eventType: metadata.eventType,
      receiptId: metadata.receiptId,
      category: metadata.category,
      locale: metadata.locale,
      status: metadata.status,
      receivedAt: metadata.receivedAt,
      adminUrl: metadata.adminUrl,
    });
    expect(body).not.toMatch(/opaque|phone|email|name|message/i);
    const headers = new Headers(captured?.init.headers);
    const canonical = [
      "POST",
      "/notify",
      "1700000000000",
      "nonce-1",
      "delivery-1",
      body,
    ].join("\n");
    expect(headers.get("x-wisdom-signature")).toBe(
      createHmac("sha256", secret).update(canonical).digest("base64url"),
    );
    expect(headers.get("x-wisdom-delivery-id")).toBe("delivery-1");
  });

  it("sends customer marketing mail to the decrypted address with an ephemeral withdrawal link", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: Omit<typeof metadata, "purpose"> & {
        purpose: "marketing";
        withdrawalUrl: string;
      }): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const sent: Array<Record<string, unknown>> = [];
    const decryptPii = vi.fn(() => ({
      name: "Customer",
      phone: "010-0000-0000",
      email: "customer@example.test",
      message: "Private inquiry text must not enter this marketing email.",
    }));
    const adapter = createAdapter({
      payloadMode: "receipt-only",
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii,
      lookup: publicSmtpLookup,
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: "customer-provider-id" };
      },
    });
    const withdrawalUrl = "https://www.example.test/marketing/withdraw/ephemeral-token";
    await adapter.deliver({ ...metadata, purpose: "marketing", withdrawalUrl });
    expect(decryptPii).toHaveBeenCalledWith("consultation-1", "opaque-envelope");
    expect(sent[0]).toMatchObject({ to: "customer@example.test" });
    expect(String(sent[0]?.text)).toContain(withdrawalUrl);
    expect(String(sent[0]?.html)).toContain(withdrawalUrl);
    expect(JSON.stringify(sent[0])).not.toContain("Private inquiry text");
    expect(String(sent[0]?.subject)).not.toContain("customer@example.test");
  });

  it.each([
    ["ko", "마케팅 정보 수신 동의 안내", "수신 동의 철회"],
    ["en", "Marketing communication consent", "Withdraw consent"],
    ["zh-Hans", "营销信息接收同意通知", "撤回同意"],
    ["zh-Hant", "行銷資訊接收同意通知", "撤回同意"],
  ] as const)("localizes customer marketing copy for %s", async (locale, subjectCopy, withdrawalCopy) => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: Omit<typeof metadata, "purpose"> & {
        purpose: "transactional" | "marketing" | "test";
        withdrawalUrl: string;
      }): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createAdapter({
      payloadMode: "receipt-only",
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii: () => ({
        name: "Customer", phone: "010-0000-0000", email: "customer@example.test", message: "Private",
      }),
      lookup: publicSmtpLookup,
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: `localized-${locale}` };
      },
    });
    await adapter.deliver({
      ...metadata,
      purpose: "marketing",
      locale,
      withdrawalUrl: "https://www.example.test/marketing/withdraw/ephemeral-token",
    });
    expect(String(sent[0]?.subject)).toContain(subjectCopy);
    expect(String(sent[0]?.text)).toContain(withdrawalCopy);
  });

  it("resolves on every delivery, rejects mixed/private answers, and pins transport while preserving TLS SNI", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: typeof metadata): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const lookup = vi.fn(publicSmtpLookup);
    const transports: Array<Record<string, unknown>> = [];
    const createTransport = vi.spyOn(nodemailer, "createTransport").mockImplementation(((settings: unknown) => {
      transports.push(settings as Record<string, unknown>);
      return {
        sendMail: async () => ({ messageId: "pinned-provider-id" }),
        close: () => undefined,
      };
    }) as unknown as typeof nodemailer.createTransport);
    try {
      const adapter = createAdapter({
        payloadMode: "receipt-only",
        smtp: {
          host: "smtp.example.com", port: 465, secure: true,
          from: "office@example.test", to: "owner@example.test",
        },
        decryptPii: vi.fn(() => ({})),
        lookup,
      });
      await adapter.deliver(metadata);
      await adapter.deliver({ ...metadata, deliveryId: "delivery-2" });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenNthCalledWith(1, "smtp.example.com", { all: true, verbatim: true });
      expect(transports).toHaveLength(2);
      expect(transports[0]).toMatchObject({
        host: "93.184.216.34",
        port: 465,
        secure: true,
        tls: { servername: "smtp.example.com" },
      });
    } finally {
      createTransport.mockRestore();
    }

    for (const addresses of [
      [{ address: "10.0.0.1", family: 4 as const }],
      [
        { address: "93.184.216.34", family: 4 as const },
        { address: "fd00::1", family: 6 as const },
      ],
    ]) {
      const sendMail = vi.fn(async () => ({ messageId: "must-not-send" }));
      const decryptPii = vi.fn(() => ({ name: "must-not-decrypt" }));
      const adapter = createAdapter({
        payloadMode: "full-inquiry",
        fullInquiryApproved: true,
        smtp: {
          host: "smtp.example.com", port: 465, secure: true,
          from: "office@example.test", to: "owner@example.test",
        },
        decryptPii,
        sendMail,
        lookup: async () => addresses,
      });
      await expect(adapter.deliver(metadata)).rejects.toThrow(/public/i);
      expect(sendMail).not.toHaveBeenCalled();
      expect(decryptPii).not.toHaveBeenCalled();
    }
  });

  it("times out stalled SMTP I/O and configures every transport timeout below the lease", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: typeof metadata): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    const timeoutMs = 10;
    expect(() => createAdapter({
      payloadMode: "receipt-only",
      providerTimeoutMs: 2 * 60 * 1_000,
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii: () => ({}),
    })).toThrow(/timeout|lease/i);
    let capturedSettings: Record<string, unknown> | undefined;
    let closed = false;
    const createTransport = vi.spyOn(nodemailer, "createTransport").mockImplementation(((settings: unknown) => {
      capturedSettings = settings as Record<string, unknown>;
      return {
        sendMail: async () => await new Promise<never>(() => undefined),
        close: () => { closed = true; },
      };
    }) as unknown as typeof nodemailer.createTransport);
    try {
      const adapter = createAdapter({
        payloadMode: "receipt-only",
        providerTimeoutMs: timeoutMs,
        smtp: {
          host: "smtp.example.com", port: 465, secure: true,
          from: "office@example.test", to: "owner@example.test",
        },
        decryptPii: () => ({}),
        lookup: publicSmtpLookup,
      });
      const outcome = await Promise.race([
        adapter.deliver(metadata).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "test-deadline" }>((resolve) => {
          setTimeout(() => resolve({ kind: "test-deadline" }), 100);
        }),
      ]);
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") expect(String(outcome.error)).toMatch(/timeout/i);
      expect(capturedSettings).toMatchObject({
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      expect(timeoutMs).toBeLessThan(2 * 60 * 1_000);
      expect(closed).toBe(true);
    } finally {
      createTransport.mockRestore();
    }
  });

  it("aborts stalled Hermes I/O before the two-minute lease expires", async () => {
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: typeof metadata): Promise<{ providerMessageId: string }>;
    }>("createHermesNotificationAdapter");
    const timeoutMs = 10;
    let capturedSignal: AbortSignal | undefined;
    const adapter = createAdapter({
      endpoint: new URL("http://127.0.0.1:8788/notify"),
      secret: Buffer.alloc(32, 23),
      providerTimeoutMs: timeoutMs,
      fetch: async (_url: string, init: RequestInit) => {
        capturedSignal = init.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => reject(capturedSignal?.reason), { once: true });
        });
      },
    });
    const outcome = await Promise.race([
      adapter.deliver(metadata).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "test-deadline" }>((resolve) => {
        setTimeout(() => resolve({ kind: "test-deadline" }), 100);
      }),
    ]);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(String(outcome.error)).toMatch(/abort|timeout/i);
    expect(capturedSignal?.aborted).toBe(true);
    expect(timeoutMs).toBeLessThan(2 * 60 * 1_000);
  });
});

describe("notification worker privacy rechecks", () => {
  type ProcessNext = (options: {
    db: TestDatabase["db"];
    workerId: string;
    adminOrigin: string;
    now: () => number;
    attemptId?: () => string;
    adapters: Partial<Record<"email" | "hermes-telegram", {
      deliver(input: Record<string, unknown>): Promise<{ providerMessageId: string }>;
    }>>;
    withdrawalSecret?: Uint8Array;
    publicOrigin?: string;
  }) => Promise<{ kind: string; outcomeCode?: string }>;

  function enableEmail(database: TestDatabase["db"], payloadMode = "receipt-only"): void {
    database.sqlite.prepare(`
      INSERT INTO notification_settings (
        channel, enabled, provider, payload_mode, config_json, updated_at_ms
      ) VALUES ('email', 1, 'smtp', ?, '{}', 0)
    `).run(payloadMode);
  }

  it("cancels without provider I/O when PII is purged or marketing was withdrawn", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    const deliver = vi.fn(async () => ({ providerMessageId: "must-not-send" }));
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    enqueue(testDatabase.db, "delivery-purged", "consultation.purged-test");
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET pii_envelope = NULL, pii_key_id = NULL,
        phone_blind_index = NULL, email_blind_index = NULL,
        blind_index_key_id = NULL, purged_at_ms = 1
      WHERE id = 'consultation-1'
    `).run();
    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-privacy",
      adminOrigin: "https://admin.example.test",
      now: () => 2,
      attemptId: () => "attempt-purged",
      adapters: { email: { deliver } },
    })).resolves.toEqual({ kind: "cancelled", outcomeCode: "CONSULTATION_PURGED" });
    expect(deliver).not.toHaveBeenCalled();
    testDatabase.close();
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    enqueue(testDatabase.db, "delivery-withdrawn", "consultation.marketing-test");
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET marketing_accepted = 1, marketing_withdrawn_at_ms = 1
      WHERE id = 'consultation-1'
    `).run();
    testDatabase.db.sqlite.prepare(`
      UPDATE notification_outbox SET purpose = 'marketing'
      WHERE id = 'delivery-withdrawn'
    `).run();
    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-privacy",
      adminOrigin: "https://admin.example.test",
      now: () => 2,
      attemptId: () => "attempt-withdrawn",
      adapters: { email: { deliver } },
    })).resolves.toEqual({ kind: "cancelled", outcomeCode: "MARKETING_WITHDRAWN" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("decrypts an actual full-inquiry envelope only in the adapter immediately before send", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: Record<string, unknown>): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db, "full-inquiry");
    enqueue(testDatabase.db, "delivery-full", "consultation.full-test");
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 71) });
    const envelope = encryptPii(provider, "consultation-1", {
      name: "Stored <script> canary",
      phone: "010-0000-0000",
      email: "customer@example.test",
      message: "Sensitive consultation message with enough text.",
    });
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET pii_envelope = ?, pii_key_id = 'pii-v1'
      WHERE id = 'consultation-1'
    `).run(envelope);
    const decrypt = vi.fn((consultationId: string, serialized: string) =>
      decryptPii(provider, consultationId, serialized));
    const sent: Array<Record<string, unknown>> = [];
    const adapter = createAdapter({
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii: decrypt,
      lookup: publicSmtpLookup,
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return { messageId: "smtp-full-id" };
      },
    });

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-full",
      adminOrigin: "https://admin.example.test",
      now: () => 10,
      attemptId: () => "attempt-full",
      adapters: { email: adapter },
    })).resolves.toEqual({ kind: "sent", outcomeCode: "SENT" });
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(String(sent[0]?.html)).toContain("Stored &lt;script&gt; canary");
    expect(JSON.stringify(sent[0])).not.toContain("opaque-envelope");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, provider_message_id FROM notification_outbox WHERE id = 'delivery-full'
    `).get()).toEqual({ state: "sent", provider_message_id: "smtp-full-id" });
  });

  it("turns a non-public SMTP DNS answer into a channel-local retry without network or PII access", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    const createAdapter = requiredFunction<(options: Record<string, unknown>) => {
      deliver(input: Record<string, unknown>): Promise<{ providerMessageId: string }>;
    }>("createSmtpNotificationAdapter");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db, "full-inquiry");
    enqueue(testDatabase.db, "delivery-ssrf", "consultation.ssrf-test");
    const sendMail = vi.fn(async () => ({ messageId: "must-not-send" }));
    const decryptPii = vi.fn(() => ({ name: "must-not-decrypt" }));
    const adapter = createAdapter({
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      smtp: {
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      },
      decryptPii,
      sendMail,
      lookup: async () => [{ address: "169.254.169.254", family: 4 as const }],
    });

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-ssrf",
      adminOrigin: "https://admin.example.test",
      now: () => 10,
      attemptId: () => "attempt-ssrf",
      adapters: { email: adapter },
    })).resolves.toEqual({ kind: "retrying", outcomeCode: "PROVIDER_ERROR" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(decryptPii).not.toHaveBeenCalled();
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, attempt_count, available_at_ms, last_error_code
      FROM notification_outbox WHERE id = 'delivery-ssrf'
    `).get()).toEqual({
      state: "pending", attempt_count: 1, available_at_ms: 60_010, last_error_code: "PROVIDER_ERROR",
    });
  });

  it("replaces real consultation metadata with a synthetic non-PII envelope for test deliveries", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db, "full-inquiry");
    enqueue(testDatabase.db, "delivery-test", "notification.test.random");
    testDatabase.db.sqlite.prepare(`
      UPDATE notification_outbox SET purpose = 'test', payload_json = '{"test":true}'
      WHERE id = 'delivery-test'
    `).run();
    const captured: Array<Record<string, unknown>> = [];

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-test",
      adminOrigin: "https://admin.example.test",
      now: () => 10,
      attemptId: () => "attempt-test",
      adapters: { email: { deliver: async (input) => {
        captured.push(input);
        return { providerMessageId: "test-sent" };
      } } },
    })).resolves.toEqual({ kind: "sent", outcomeCode: "SENT" });
    expect(captured).toEqual([expect.objectContaining({
      purpose: "test",
      receiptId: "TEST",
      category: "system",
      locale: "en",
      status: "test",
      piiEnvelope: "notification-test-no-pii",
      adminUrl: "https://admin.example.test/admin/notifications",
    })]);
    expect(JSON.stringify(captured)).not.toContain("receipt-1");
    expect(JSON.stringify(captured)).not.toContain("opaque-envelope");
  });

  it("mints a fresh hash-only withdrawal capability for every customer-email attempt", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET marketing_accepted = 1 WHERE id = 'consultation-1'
    `).run();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, effective_at_ms, created_at_ms
      ) VALUES ('marketing-document', 'bundle', 'marketing', 'ko', 'marketing-v1',
        'Marketing', 'Terms', ?, 24, 'active', 0, 0)
    `).run(Buffer.alloc(32, 31));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('marketing-accepted', 'consultation-1', 'marketing-document',
        'marketing', 'accepted', 1, 'marketing-v1', ?, 'visitor', 'request', 0)
    `).run(Buffer.alloc(32, 31));
    enqueue(testDatabase.db, "delivery-marketing", "marketing.confirmation");
    testDatabase.db.sqlite.prepare(`
      UPDATE notification_outbox SET purpose = 'marketing' WHERE id = 'delivery-marketing'
    `).run();
    const captured: Array<Record<string, unknown>> = [];
    const adapter = {
      async deliver(input: Record<string, unknown>) {
        captured.push(input);
        if (captured.length === 1) throw new Error("temporary provider failure");
        return { providerMessageId: "customer-sent" };
      },
    };
    let now = 10;
    const options = {
      db: testDatabase.db,
      workerId: "worker-marketing",
      adminOrigin: "https://admin.example.test",
      now: () => now,
      adapters: { email: adapter },
      withdrawalSecret: Buffer.alloc(32, 32),
      publicOrigin: "https://www.example.test",
    };
    await expect(processNext({ ...options, attemptId: () => "marketing-attempt-1" })).resolves.toEqual({
      kind: "retrying", outcomeCode: "PROVIDER_ERROR",
    });
    now += 60_000;
    await expect(processNext({ ...options, attemptId: () => "marketing-attempt-2" })).resolves.toEqual({
      kind: "sent", outcomeCode: "SENT",
    });
    const urls = captured.map((input) => String(input.withdrawalUrl));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^https:\/\/www\.example\.test\/marketing\/withdraw\/[A-Za-z0-9_-]{43}$/);
    expect(urls[1]).not.toBe(urls[0]);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM marketing_withdrawal_capabilities
    `).get()).toEqual({ count: 2 });
    const databaseBytes = testDatabase.db.sqlite.serialize();
    for (const url of urls) {
      const token = url.split("/").at(-1)!;
      expect(databaseBytes.indexOf(Buffer.from(token, "utf8"))).toBe(-1);
    }
    expect(testDatabase.db.sqlite.prepare(`
      SELECT payload_json FROM notification_outbox WHERE id = 'delivery-marketing'
    `).get()).toEqual({ payload_json: '{"receiptId":"receipt-1"}' });
  });

  it("cancels an overdue consultation before provider I/O or capability minting", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    enqueue(testDatabase.db, "delivery-expired", "consultation.expired-test");
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET retention_expires_at_ms = 100 WHERE id = 'consultation-1'
    `).run();
    const deliver = vi.fn(async () => ({ providerMessageId: "must-not-send" }));
    const clock = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValue(100);

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-expired",
      adminOrigin: "https://admin.example.test",
      now: clock,
      attemptId: () => "attempt-expired",
      adapters: { email: { deliver } },
    })).resolves.toEqual({ kind: "cancelled", outcomeCode: "RETENTION_EXPIRED" });
    expect(deliver).not.toHaveBeenCalled();
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, last_error_code, locked_by FROM notification_outbox
      WHERE id = 'delivery-expired'
    `).get()).toEqual({ state: "cancelled", last_error_code: "RETENTION_EXPIRED", locked_by: null });
  });

  it("finalizes capability-mint failures instead of stranding a processing lease", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET marketing_accepted = 1 WHERE id = 'consultation-1'
    `).run();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, effective_at_ms, created_at_ms
      ) VALUES ('marketing-document-error', 'bundle', 'marketing', 'ko', 'marketing-v1',
        'Marketing', 'Terms', ?, 24, 'active', 0, 0)
    `).run(Buffer.alloc(32, 32));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('marketing-accepted-error', 'consultation-1', 'marketing-document-error',
        'marketing', 'accepted', 1, 'marketing-v1', ?, 'visitor', 'request', 0)
    `).run(Buffer.alloc(32, 32));
    enqueue(testDatabase.db, "delivery-mint-error", "marketing.confirmation");
    testDatabase.db.sqlite.prepare(`
      UPDATE notification_outbox SET purpose = 'marketing' WHERE id = 'delivery-mint-error'
    `).run();
    testDatabase.db.sqlite.exec(`
      CREATE TRIGGER fail_capability_mint
      BEFORE INSERT ON marketing_withdrawal_capabilities
      BEGIN
        SELECT RAISE(ABORT, 'simulated capability store failure');
      END
    `);
    const deliver = vi.fn(async () => ({ providerMessageId: "must-not-send" }));

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-mint-error",
      adminOrigin: "https://admin.example.test",
      now: () => 10,
      attemptId: () => "attempt-mint-error",
      adapters: { email: { deliver } },
      withdrawalSecret: Buffer.alloc(32, 33),
      publicOrigin: "https://www.example.test",
    })).resolves.toEqual({ kind: "retrying", outcomeCode: "WITHDRAWAL_CAPABILITY_ERROR" });
    expect(deliver).not.toHaveBeenCalled();
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, last_error_code, locked_by FROM notification_outbox
      WHERE id = 'delivery-mint-error'
    `).get()).toEqual({ state: "pending", last_error_code: "WITHDRAWAL_CAPABILITY_ERROR", locked_by: null });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT outcome_code, finished_at_ms FROM notification_delivery_attempts
      WHERE id = 'attempt-mint-error'
    `).get()).toEqual({ outcome_code: "WITHDRAWAL_CAPABILITY_ERROR", finished_at_ms: 10 });
  });

  it("records at-least-once retry semantics when provider succeeds before final DB commit fails", async () => {
    const processNext = requiredFunction<ProcessNext>("processNextNotification");
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db);
    enableEmail(testDatabase.db);
    enqueue(testDatabase.db, "delivery-finalize-error", "consultation.finalize-error");
    testDatabase.db.sqlite.exec(`
      CREATE TRIGGER fail_sent_finalize
      BEFORE UPDATE OF state ON notification_outbox
      WHEN NEW.id = 'delivery-finalize-error' AND NEW.state = 'sent'
      BEGIN
        SELECT RAISE(ABORT, 'simulated final commit failure');
      END
    `);
    const deliver = vi.fn(async () => ({ providerMessageId: "provider-already-accepted" }));

    await expect(processNext({
      db: testDatabase.db,
      workerId: "worker-finalize-error",
      adminOrigin: "https://admin.example.test",
      now: () => 10,
      attemptId: () => "attempt-finalize-error",
      adapters: { email: { deliver } },
    })).resolves.toEqual({ kind: "retrying", outcomeCode: "DELIVERY_FINALIZE_ERROR" });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state, last_error_code, provider_message_id, locked_by
      FROM notification_outbox WHERE id = 'delivery-finalize-error'
    `).get()).toEqual({
      state: "pending",
      last_error_code: "DELIVERY_FINALIZE_ERROR",
      provider_message_id: null,
      locked_by: null,
    });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT outcome_code, provider_message_id FROM notification_delivery_attempts
      WHERE id = 'attempt-finalize-error'
    `).get()).toEqual({ outcome_code: "DELIVERY_FINALIZE_ERROR", provider_message_id: null });
  });
});
