import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { issueFormToken } from "../abuse/form-token.js";
import { activateConsentBundle, getPublicConsentDocuments, seedConsentDocuments } from "../consent/service.js";
import { acceptConsultation } from "../consultations/service.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { purgeExpiredConsultations } from "./purge.js";

const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 6) });
let database: TestDatabase | undefined;
afterEach(() => database?.close());

function createIntake(marketingAccepted: boolean, index: number, nowMs: number): void {
  const documents = getPublicConsentDocuments(database!.db, "en")!;
  const issuedAtMs = nowMs - 2_000;
  const token = issueFormToken(provider, {
    locale: "en",
    privacyVersion: documents.documents.privacy.version,
    marketingVersion: documents.documents.marketing.version,
  }, issuedAtMs, `nonce-${index}`);
  const result = acceptConsultation(database!.db, provider, {
    consultation: {
      locale: "en",
      category: "procurement",
      name: `Client ${index}`,
      phone: `0100000000${index}`,
      email: `client${index}@example.com`,
      company: `Company ${index}`,
      preferredContact: "email",
      message: `Please review this sufficiently detailed consultation request number ${index}.`,
      privacyConsent: { version: documents.documents.privacy.version, accepted: true },
      marketingConsent: {
        version: documents.documents.marketing.version,
        accepted: marketingAccepted,
      },
    },
    formToken: token,
    idempotencyKey: `purge-idempotency-key-${index}`,
    requestId: `request-${index}`,
    clientIp: `198.51.100.${index}`,
    nowMs,
  });
  expect(result.kind).toBe("created");
}

describe("retention purge", () => {
  it("is dry-run first and purges normal/marketing records at exact 12/24 month boundaries", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 31, 12, 0, 0);
    createIntake(false, 1, receivedAtMs);
    createIntake(true, 2, receivedAtMs);

    const rows = database.db.sqlite.prepare(`
      SELECT id, marketing_accepted, retention_expires_at_ms
      FROM consultations ORDER BY marketing_accepted
    `).all() as Array<{ id: string; marketing_accepted: number; retention_expires_at_ms: number }>;
    const normal = rows[0]!;
    const marketing = rows[1]!;
    expect(new Date(normal.retention_expires_at_ms).toISOString()).toBe("2027-01-31T12:00:00.000Z");
    expect(new Date(marketing.retention_expires_at_ms).toISOString()).toBe("2028-01-31T12:00:00.000Z");

    expect(purgeExpiredConsultations(database.db, {
      nowMs: normal.retention_expires_at_ms - 1,
      apply: true,
    })).toMatchObject({ dueCount: 0, purgedCount: 0 });
    expect(purgeExpiredConsultations(database.db, {
      nowMs: normal.retention_expires_at_ms,
      apply: false,
    })).toEqual({ dueCount: 1, purgedCount: 0 });
    expect(database.db.sqlite.prepare("SELECT count(*) count FROM consultations WHERE purged_at_ms IS NOT NULL").get()).toEqual({ count: 0 });

    expect(purgeExpiredConsultations(database.db, {
      nowMs: normal.retention_expires_at_ms,
      apply: true,
    })).toEqual({ dueCount: 1, purgedCount: 1 });
    expect(database.db.sqlite.prepare(`
      SELECT pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
             blind_index_key_id, purged_at_ms
      FROM consultations WHERE id = ?
    `).get(normal.id)).toEqual({
      pii_envelope: null,
      pii_key_id: null,
      phone_blind_index: null,
      email_blind_index: null,
      blind_index_key_id: null,
      purged_at_ms: normal.retention_expires_at_ms,
    });
    expect(database.db.sqlite.prepare(
      "SELECT count(*) count FROM consultations WHERE id = ? AND pii_envelope IS NOT NULL",
    ).get(marketing.id)).toEqual({ count: 1 });
    expect(database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_outbox
      WHERE consultation_id = ? AND state = 'cancelled' AND payload_json IS NULL
    `).get(normal.id)).toEqual({ count: 2 });
    expect(database.db.sqlite.prepare("SELECT count(*) count FROM idempotency_keys").get()).toEqual({ count: 0 });
    expect(database.db.sqlite.prepare("SELECT count(*) count FROM abuse_buckets").get()).toEqual({ count: 0 });

    expect(purgeExpiredConsultations(database.db, {
      nowMs: normal.retention_expires_at_ms,
      apply: true,
    })).toEqual({ dueCount: 0, purgedCount: 0 });
    expect(purgeExpiredConsultations(database.db, {
      nowMs: marketing.retention_expires_at_ms,
      apply: true,
    })).toEqual({ dueCount: 1, purgedCount: 1 });
  });

  it("rolls the entire batch back after an injected mid-purge failure", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 1);
    createIntake(false, 3, receivedAtMs);
    const expiry = (database.db.sqlite.prepare(
      "SELECT retention_expires_at_ms value FROM consultations",
    ).get() as { value: number }).value;

    expect(() => purgeExpiredConsultations(database!.db, {
      nowMs: expiry,
      apply: true,
      faultInjector(point) {
        if (point === "after-outbox") throw new Error("injected purge fault");
      },
    })).toThrow("injected purge fault");
    expect(database.db.sqlite.prepare(`
      SELECT count(*) count FROM consultations
      WHERE purged_at_ms IS NULL AND pii_envelope IS NOT NULL
    `).get()).toEqual({ count: 1 });
    expect(database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_outbox
      WHERE state = 'pending' AND payload_json IS NOT NULL
    `).get()).toEqual({ count: 2 });
    expect(database.db.sqlite.prepare(
      "SELECT count(*) count FROM audit_events WHERE action = 'consultation.purged'",
    ).get()).toEqual({ count: 0 });
  });

  it("retries a busy WAL truncate checkpoint and succeeds within the bounded attempt limit", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 1);
    createIntake(false, 4, receivedAtMs);
    const expiry = (database.db.sqlite.prepare(
      "SELECT retention_expires_at_ms value FROM consultations",
    ).get() as { value: number }).value;
    let attempts = 0;

    expect(purgeExpiredConsultations(database.db, {
      nowMs: expiry,
      apply: true,
      checkpointWal() {
        attempts += 1;
        return [{ busy: attempts === 1 ? 1 : 0, log: 0, checkpointed: 0 }];
      },
    })).toEqual({ dueCount: 1, purgedCount: 1 });
    expect(attempts).toBe(2);
  });

  it("fails closed after three busy WAL truncate checkpoints without undoing the committed purge", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 1);
    createIntake(false, 5, receivedAtMs);
    const expiry = (database.db.sqlite.prepare(
      "SELECT retention_expires_at_ms value FROM consultations",
    ).get() as { value: number }).value;
    let attempts = 0;
    let failure: unknown;

    try {
      purgeExpiredConsultations(database.db, {
        nowMs: expiry,
        apply: true,
        checkpointWal() {
          attempts += 1;
          return [{ busy: 1, log: 1, checkpointed: 0 }];
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RETENTION_WAL_CHECKPOINT_BUSY" });
    expect(attempts).toBe(3);
    expect(database.db.sqlite.prepare(`
      SELECT purged_at_ms, pii_envelope FROM consultations
    `).get()).toEqual({ purged_at_ms: expiry, pii_envelope: null });
  });

  it("rejects a checkpoint result that reports success without a truncated WAL", () => {
    database = createTestDatabase();
    let failure: unknown;
    try {
      purgeExpiredConsultations(database.db, {
        nowMs: 1,
        apply: true,
        checkpointWal: () => [{ busy: 0, log: 1, checkpointed: 1 }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RETENTION_WAL_CHECKPOINT_FAILED" });
  });

  it("reports bounded SQLite busy exceptions as an explicit WAL busy failure", () => {
    database = createTestDatabase();
    let attempts = 0;
    let failure: unknown;
    try {
      purgeExpiredConsultations(database.db, {
        nowMs: 1,
        apply: true,
        checkpointWal() {
          attempts += 1;
          throw Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" });
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RETENTION_WAL_CHECKPOINT_BUSY" });
    expect(attempts).toBe(3);
  });
});
