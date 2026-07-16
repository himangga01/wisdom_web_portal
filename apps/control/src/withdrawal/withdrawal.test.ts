import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { closeDatabase, openDatabase, runMigrations } from "../db/client.js";
import { purgeExpiredConsultations } from "../retention/purge.js";
import * as controlModule from "../index.js";

const control = controlModule as unknown as Record<string, unknown>;
const withdrawalSecret = Buffer.alloc(32, 83);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function requiredFunction<T>(name: string): T {
  expect(control[name], `${name} must be exported`).toBeTypeOf("function");
  return control[name] as T;
}

function seedMarketingConsultation(
  database: TestDatabase["db"],
  marketingAccepted = 1,
  options: { receivedAtMs?: number; retentionExpiresAtMs?: number } = {},
): void {
  const receivedAtMs = options.receivedAtMs ?? 0;
  const retentionExpiresAtMs = options.retentionExpiresAtMs ?? 10_000_000;
  database.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
      marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('consultation-1', 'receipt-1', 'received', 'ko', 'procurement', 'email',
      'opaque-envelope', 'pii-v1', ?, 'pii-v1', ?, ?, ?, ?, 1)
  `).run(
    Buffer.alloc(32, 1),
    marketingAccepted,
    receivedAtMs,
    receivedAtMs,
    retentionExpiresAtMs,
  );
  database.sqlite.prepare(`
    INSERT INTO consent_documents (
      id, bundle_id, kind, locale, version, title, body_markdown,
      content_sha256, retention_months, state, effective_at_ms, created_at_ms
    ) VALUES ('privacy-document', 'bundle', 'privacy', 'ko', 'privacy-v1',
      'Privacy', 'Privacy terms', ?, 12, 'active', 0, 0)
  `).run(Buffer.alloc(32, 3));
  database.sqlite.prepare(`
    INSERT INTO consent_documents (
      id, bundle_id, kind, locale, version, title, body_markdown,
      content_sha256, retention_months, state, effective_at_ms, created_at_ms
    ) VALUES ('marketing-document', 'bundle', 'marketing', 'ko', 'marketing-v1',
      'Marketing', 'Marketing terms', ?, 24, 'active', 0, 0)
  `).run(Buffer.alloc(32, 2));
  database.sqlite.prepare(`
    INSERT INTO consent_events (
      id, consultation_id, document_id, kind, decision, sequence,
      document_version, document_sha256, actor_type, request_id, occurred_at_ms
    ) VALUES ('privacy-accepted', 'consultation-1', 'privacy-document',
      'privacy', 'accepted', 1, 'privacy-v1', ?, 'visitor', 'request-intake', ?)
  `).run(Buffer.alloc(32, 3), receivedAtMs);
  database.sqlite.prepare(`
    INSERT INTO consent_events (
      id, consultation_id, document_id, kind, decision, sequence,
      document_version, document_sha256, actor_type, request_id, occurred_at_ms
    ) VALUES ('marketing-accepted', 'consultation-1', 'marketing-document',
      'marketing', ?, 1, 'marketing-v1', ?, 'visitor', 'request-intake', 0)
  `).run(marketingAccepted ? "accepted" : "declined", Buffer.alloc(32, 2));
}

interface MintResult {
  token: string;
  url: string;
}

type Mint = (
  db: TestDatabase["db"],
  secret: Uint8Array,
  input: {
    consultationId: string;
    publicOrigin: string;
    nowMs: number;
    expiresAtMs: number;
    randomBytes?: (length: number) => Buffer;
  },
) => MintResult;

describe("accountless marketing withdrawal", () => {
  it("mints independent 256-bit capabilities while storing only domain hashes", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    testDatabase = createTestDatabase();
    seedMarketingConsultation(testDatabase.db);
    const first = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: 1,
      expiresAtMs: 10_000,
      randomBytes: () => Buffer.alloc(32, 11),
    });
    const second = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: 2,
      expiresAtMs: 10_000,
      randomBytes: () => Buffer.alloc(32, 12),
    });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.url).toBe(`https://www.example.test/marketing/withdraw/${first.token}`);
    expect(second.token).not.toBe(first.token);
    const stored = testDatabase.db.sqlite.prepare(`
      SELECT token_hash, consultation_id, consent_event_id
      FROM marketing_withdrawal_capabilities ORDER BY created_at_ms
    `).all() as Array<{ token_hash: Buffer; consultation_id: string; consent_event_id: string }>;
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.token_hash.length === 32)).toBe(true);
    expect(JSON.stringify(stored.map((row) => ({ ...row, token_hash: row.token_hash.toString("hex") })))).not.toContain(
      first.token,
    );
    expect(testDatabase.db.sqlite.serialize().indexOf(Buffer.from(first.token, "utf8"))).toBe(-1);

    const invalidDatabase = createTestDatabase();
    try {
      seedMarketingConsultation(invalidDatabase.db, 0);
      expect(() => mint(invalidDatabase.db, withdrawalSecret, {
        consultationId: "consultation-1",
        publicOrigin: "https://www.example.test",
        nowMs: 1,
        expiresAtMs: 10_000,
      })).toThrow(/marketing consent/i);
    } finally {
      invalidDatabase.close();
    }
  });

  it("exchanges the raw token for a short host cookie and clean localized redirect", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array,
      input: {
        token: string; publicOrigin: string; nowMs: number;
        randomBytes?: (length: number) => Buffer;
      },
    ) => { kind: "invalid" } | {
      kind: "redirect"; location: string; cookie: string; landingToken: string;
    }>("openMarketingWithdrawalCapability");
    testDatabase = createTestDatabase();
    seedMarketingConsultation(testDatabase.db);
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: 0,
      expiresAtMs: 10_000,
      randomBytes: () => Buffer.alloc(32, 21),
    });
    const opened = open(testDatabase.db, withdrawalSecret, {
      token: minted.token,
      publicOrigin: "https://www.example.test",
      nowMs: 1,
      randomBytes: () => Buffer.alloc(32, 22),
    });
    expect(opened).toMatchObject({ kind: "redirect", location: "https://www.example.test/marketing/withdraw/confirm" });
    if (opened.kind !== "redirect") throw new Error("expected redirect");
    expect(opened.cookie).toBe(
      `__Host-wisdom-marketing-withdraw=${opened.landingToken}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=9`,
    );
    expect(opened.cookie).not.toContain(minted.token);
    const recipientOpen = open(testDatabase.db, withdrawalSecret, {
      token: minted.token,
      publicOrigin: "https://www.example.test",
      nowMs: 2,
    });
    expect(recipientOpen).toMatchObject({
      kind: "redirect",
      location: "https://www.example.test/marketing/withdraw/confirm",
      landingToken: opened.landingToken,
    });
    if (recipientOpen.kind !== "redirect") throw new Error("expected repeat redirect");
    expect(recipientOpen.cookie).toContain(`=${opened.landingToken};`);
    const row = testDatabase.db.sqlite.prepare(`
      SELECT token_hash, landing_hash, landing_expires_at_ms, used_at_ms
      FROM marketing_withdrawal_capabilities
    `).get() as { token_hash: Buffer; landing_hash: Buffer; landing_expires_at_ms: number; used_at_ms: null };
    expect(row.token_hash).toHaveLength(32);
    expect(row.landing_hash).toHaveLength(32);
    expect(row.landing_expires_at_ms).toBe(10_000);
    expect(row.used_at_ms).toBeNull();
    expect(row.landing_hash.toString("base64url")).not.toBe(opened.landingToken);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT marketing_withdrawn_at_ms FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ marketing_withdrawn_at_ms: null });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM consent_events WHERE decision = 'withdrawn'
    `).get()).toEqual({ count: 0 });
    expect(open(testDatabase.db, withdrawalSecret, {
      token: minted.token,
      publicOrigin: "https://www.example.test",
      nowMs: 10_000,
    })).toEqual({ kind: "invalid" });
    expect(requiredFunction<any>("getMarketingWithdrawalConfirmation")(
      testDatabase.db,
      withdrawalSecret,
      { landingToken: opened.landingToken, nowMs: 600_001 },
    )).toEqual({ kind: "invalid" });
  });

  it("survives concurrent security-scanner prefetch and keeps the stable landing capability one-shot at POST", async () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<any>("openMarketingWithdrawalCapability") as any;
    const confirmation = requiredFunction<any>("getMarketingWithdrawalConfirmation") as any;
    const withdraw = requiredFunction<any>("withdrawMarketingConsent") as any;
    testDatabase = createTestDatabase();
    seedMarketingConsultation(testDatabase.db);
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: 0,
      expiresAtMs: 2_000_000,
      randomBytes: () => Buffer.alloc(32, 31),
    });

    const scanner = open(testDatabase.db, withdrawalSecret, {
      token: minted.token, publicOrigin: "https://www.example.test", nowMs: 1,
    });
    const recipient = open(testDatabase.db, withdrawalSecret, {
      token: minted.token, publicOrigin: "https://www.example.test", nowMs: 2,
    });
    expect(scanner.kind).toBe("redirect");
    if (scanner.kind !== "redirect" || recipient.kind !== "redirect") {
      throw new Error("expected stable redirects");
    }
    expect(recipient.landingToken).toBe(scanner.landingToken);
    expect(recipient.location).toBe(scanner.location);
    expect(recipient.location).not.toContain(minted.token);

    const competing = openDatabase(testDatabase.path);
    runMigrations(competing);
    try {
      const repeated = await Promise.all(Array.from({ length: 8 }, async (_, index) => open(
        index % 2 === 0 ? testDatabase!.db : competing,
        withdrawalSecret,
        { token: minted.token, publicOrigin: "https://www.example.test", nowMs: 2 + index },
      )));
      expect(repeated.every((result) => (
        result.kind === "redirect" && result.landingToken === scanner.landingToken
      ))).toBe(true);
    } finally {
      closeDatabase(competing);
    }

    const confirm = confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: recipient.landingToken, nowMs: 10,
    });
    if (confirm.kind !== "confirm") throw new Error("expected confirmation");
    expect(withdraw(testDatabase.db, withdrawalSecret, {
      landingToken: recipient.landingToken,
      confirmationValue: confirm.confirmationValue,
      nowMs: 11,
      requestId: "scanner-safe-withdrawal",
    })).toEqual({ kind: "withdrawn" });
    expect(open(testDatabase.db, withdrawalSecret, {
      token: minted.token, publicOrigin: "https://www.example.test", nowMs: 12,
    })).toEqual({ kind: "invalid" });
    expect(confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: recipient.landingToken, nowMs: 12,
    })).toEqual({ kind: "invalid" });
    expect(withdraw(testDatabase.db, withdrawalSecret, {
      landingToken: recipient.landingToken,
      confirmationValue: confirm.confirmationValue,
      nowMs: 12,
      requestId: "scanner-safe-repeat",
    })).toEqual({ kind: "invalid" });
  });

  it("keeps confirmation GET read-only and withdraws once across repeated connections", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<any>("openMarketingWithdrawalCapability") as (
      db: TestDatabase["db"], secret: Uint8Array,
      input: { token: string; publicOrigin: string; nowMs: number },
    ) => { kind: "invalid" } | { kind: "redirect"; landingToken: string };
    const confirmation = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array,
      input: { landingToken: string; nowMs: number },
    ) => { kind: "invalid" } | { kind: "confirm"; locale: string; confirmationValue: string }>(
      "getMarketingWithdrawalConfirmation",
    );
    const withdraw = requiredFunction<(
      db: TestDatabase["db"], secret: Uint8Array,
      input: {
        landingToken: string; confirmationValue: string; nowMs: number; requestId: string;
      },
      options?: { faultInjector?: (point: string) => void },
    ) => { kind: "invalid" | "withdrawn" | "already-withdrawn" }>("withdrawMarketingConsent");
    testDatabase = createTestDatabase();
    seedMarketingConsultation(testDatabase.db);
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: 0,
      expiresAtMs: 1_000_000,
    });
    const opened = open(testDatabase.db, withdrawalSecret, {
      token: minted.token, publicOrigin: "https://www.example.test", nowMs: 1,
    });
    if (opened.kind !== "redirect") throw new Error("expected redirect");
    testDatabase.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, state, attempt_count,
        available_at_ms, purpose, delivery_cycle, created_at_ms, updated_at_ms
      ) VALUES
        ('marketing-pending', 'consultation-1', 'email', 'marketing.followup',
          'pending', 0, 0, 'marketing', 1, 0, 0),
        ('transactional-pending', 'consultation-1', 'hermes-telegram', 'consultation.received',
          'pending', 0, 0, 'transactional', 1, 0, 0)
    `).run();
    const before = testDatabase.db.sqlite.serialize();
    const confirm = confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken, nowMs: 2,
    });
    expect(confirm).toMatchObject({ kind: "confirm", locale: "ko" });
    expect(testDatabase.db.sqlite.serialize()).toEqual(before);
    if (confirm.kind !== "confirm") throw new Error("expected confirmation");
    const competing = openDatabase(testDatabase.path);
    runMigrations(competing);
    expect(withdraw(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      confirmationValue: `${confirm.confirmationValue}x`,
      nowMs: 3,
      requestId: "request-wrong-confirmation",
    })).toEqual({ kind: "invalid" });
    try {
      expect(withdraw(testDatabase.db, withdrawalSecret, {
        landingToken: opened.landingToken,
        confirmationValue: confirm.confirmationValue,
        nowMs: 4,
        requestId: "request-withdraw",
      })).toEqual({ kind: "withdrawn" });
      expect(withdraw(competing, withdrawalSecret, {
        landingToken: opened.landingToken,
        confirmationValue: confirm.confirmationValue,
        nowMs: 5,
        requestId: "request-repeat",
      })).toEqual({ kind: "invalid" });
    } finally {
      closeDatabase(competing);
    }
    expect(testDatabase.db.sqlite.prepare(`
      SELECT decision, sequence, request_id FROM consent_events
      WHERE kind = 'marketing' ORDER BY sequence
    `).all()).toEqual([
      { decision: "accepted", sequence: 1, request_id: "request-intake" },
      { decision: "withdrawn", sequence: 2, request_id: "request-withdraw" },
    ]);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT marketing_withdrawn_at_ms, row_version FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ marketing_withdrawn_at_ms: 4, row_version: 2 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT id, state FROM notification_outbox ORDER BY id
    `).all()).toEqual([
      { id: "marketing-pending", state: "cancelled" },
      { id: "transactional-pending", state: "pending" },
    ]);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events WHERE action = 'marketing.withdrawn'
    `).get()).toEqual({ action: "marketing.withdrawn", metadata_json: '{"cancelledPending":1}' });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM marketing_withdrawal_capabilities WHERE used_at_ms IS NOT NULL
    `).get()).toEqual({ count: 1 });
    expect(confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      nowMs: 6,
    })).toEqual({ kind: "invalid" });
  });

  it("shortens retention to the accepted privacy document period in the withdrawal transaction", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<any>("openMarketingWithdrawalCapability") as any;
    const confirmation = requiredFunction<any>("getMarketingWithdrawalConfirmation") as any;
    const withdraw = requiredFunction<any>("withdrawMarketingConsent") as any;
    testDatabase = createTestDatabase();
    const receivedAtMs = Date.UTC(2024, 0, 31, 12);
    const marketingExpiryMs = Date.UTC(2026, 0, 31, 12);
    const expectedPrivacyExpiryMs = Date.UTC(2025, 0, 31, 12);
    seedMarketingConsultation(testDatabase.db, 1, {
      receivedAtMs,
      retentionExpiresAtMs: marketingExpiryMs,
    });
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs: receivedAtMs + 1,
      expiresAtMs: receivedAtMs + 100_000,
    });
    const opened = open(testDatabase.db, withdrawalSecret, {
      token: minted.token,
      publicOrigin: "https://www.example.test",
      nowMs: receivedAtMs + 2,
    });
    const confirm = confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      nowMs: receivedAtMs + 3,
    });

    expect(withdraw(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      confirmationValue: confirm.confirmationValue,
      nowMs: receivedAtMs + 4,
      requestId: "request-retention-shortening",
    })).toEqual({ kind: "withdrawn" });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT retention_expires_at_ms FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ retention_expires_at_ms: expectedPrivacyExpiryMs });
  });

  it("makes a missed privacy expiry immediately eligible for the retention purge", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<any>("openMarketingWithdrawalCapability") as any;
    const confirmation = requiredFunction<any>("getMarketingWithdrawalConfirmation") as any;
    const withdraw = requiredFunction<any>("withdrawMarketingConsent") as any;
    testDatabase = createTestDatabase();
    const receivedAtMs = Date.UTC(2022, 0, 1);
    const nowMs = Date.UTC(2024, 6, 1);
    const expectedPrivacyExpiryMs = Date.UTC(2023, 0, 1);
    seedMarketingConsultation(testDatabase.db, 1, {
      receivedAtMs,
      retentionExpiresAtMs: Date.UTC(2025, 0, 1),
    });
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1",
      publicOrigin: "https://www.example.test",
      nowMs,
      expiresAtMs: nowMs + 100_000,
    });
    const opened = open(testDatabase.db, withdrawalSecret, {
      token: minted.token,
      publicOrigin: "https://www.example.test",
      nowMs: nowMs + 1,
    });
    const confirm = confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      nowMs: nowMs + 2,
    });

    expect(withdraw(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      confirmationValue: confirm.confirmationValue,
      nowMs: nowMs + 3,
      requestId: "request-expired-retention",
    })).toEqual({ kind: "withdrawn" });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT retention_expires_at_ms FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ retention_expires_at_ms: expectedPrivacyExpiryMs });
    expect(purgeExpiredConsultations(testDatabase.db, {
      nowMs: nowMs + 3,
      apply: false,
    })).toEqual({ dueCount: 1, purgedCount: 0 });
  });

  it("rolls back consent, flags, cancellation, capability use, and audit on a late fault", () => {
    const mint = requiredFunction<Mint>("mintMarketingWithdrawalCapability");
    const open = requiredFunction<any>("openMarketingWithdrawalCapability") as any;
    const confirmation = requiredFunction<any>("getMarketingWithdrawalConfirmation") as any;
    const withdraw = requiredFunction<any>("withdrawMarketingConsent") as any;
    testDatabase = createTestDatabase();
    seedMarketingConsultation(testDatabase.db);
    const minted = mint(testDatabase.db, withdrawalSecret, {
      consultationId: "consultation-1", publicOrigin: "https://www.example.test",
      nowMs: 0, expiresAtMs: 1_000_000,
    });
    const opened = open(testDatabase.db, withdrawalSecret, {
      token: minted.token, publicOrigin: "https://www.example.test", nowMs: 1,
    });
    const confirm = confirmation(testDatabase.db, withdrawalSecret, {
      landingToken: opened.landingToken, nowMs: 2,
    });
    testDatabase.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, state, attempt_count,
        available_at_ms, purpose, delivery_cycle, created_at_ms, updated_at_ms
      ) VALUES ('marketing-pending', 'consultation-1', 'email', 'marketing.followup',
        'pending', 0, 0, 'marketing', 1, 0, 0)
    `).run();

    expect(() => withdraw(testDatabase!.db, withdrawalSecret, {
      landingToken: opened.landingToken,
      confirmationValue: confirm.confirmationValue,
      nowMs: 3,
      requestId: "request-fault",
    }, {
      faultInjector(point: string) {
        if (point === "after-audit") throw new Error("injected withdrawal fault");
      },
    })).toThrow(/injected/);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT marketing_withdrawn_at_ms, retention_expires_at_ms, row_version
      FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({
      marketing_withdrawn_at_ms: null,
      retention_expires_at_ms: 10_000_000,
      row_version: 1,
    });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM consent_events WHERE decision = 'withdrawn'
    `).get()).toEqual({ count: 0 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT state FROM notification_outbox WHERE id = 'marketing-pending'
    `).get()).toEqual({ state: "pending" });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT used_at_ms FROM marketing_withdrawal_capabilities
    `).get()).toEqual({ used_at_ms: null });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM audit_events WHERE action = 'marketing.withdrawn'
    `).get()).toEqual({ count: 0 });
  });
});
