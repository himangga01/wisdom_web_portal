import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { issueFormToken } from "../abuse/form-token.js";
import {
  activateConsentBundle,
  createDatabaseConsentAuthorityResolver,
  getActivePublishedConsentBundle,
  getConsentBundleDigest,
  getPublicConsentDocuments,
  seedConsentDocuments,
} from "../consent/service.js";
import { acceptConsultation } from "../consultations/service.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { drainExpiredConsultations, purgeExpiredConsultations } from "./purge.js";

const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 6) });
let database: TestDatabase | undefined;
afterEach(() => database?.close());

function createIntake(marketingAccepted: boolean, index: number, nowMs: number): void {
  const documents = getPublicConsentDocuments(database!.db, "en")!;
  const bundle = getActivePublishedConsentBundle(database!.db)!;
  const issuedAtMs = nowMs - 2_000;
  const token = issueFormToken(provider, {
    locale: "en",
    releaseId: `database:${bundle.bundleId}`,
    bundleId: bundle.bundleId,
    manifestSha256: getConsentBundleDigest(database!.db, bundle.bundleId),
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
  }, {
    resolveConsentAuthority: createDatabaseConsentAuthorityResolver(database!.db),
  });
  expect(result.kind).toBe("created");
}

function insertDueConsultations(count: number, expiresAtMs = 1): void {
  const insert = database!.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
      marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES (?, ?, 'received', 'en', 'other', 'email',
      ?, 'pii-v1', ?, 'pii-v1', 0, 0, 0, ?, 1)
  `);
  database!.db.sqlite.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `drain-consultation-${index}`,
        `drain-receipt-${index}`,
        `ciphertext-${index}`,
        Buffer.alloc(32, index % 256),
        expiresAtMs,
      );
    }
  })();
}

describe("retention purge", () => {
  it("drains every due row across bounded batches in one invocation", () => {
    database = createTestDatabase();
    insertDueConsultations(5);

    expect(drainExpiredConsultations(database.db, {
      nowMs: 1,
      apply: true,
      batchSize: 2,
      maxBatches: 3,
    })).toEqual({
      dueCount: 5,
      purgedCount: 5,
      batchesProcessed: 3,
      remainingDueCount: 0,
      complete: true,
    });
  });

  it("reports an incomplete bounded run when due rows remain", () => {
    database = createTestDatabase();
    insertDueConsultations(5);

    expect(drainExpiredConsultations(database.db, {
      nowMs: 1,
      apply: true,
      batchSize: 2,
      maxBatches: 2,
    })).toEqual({
      dueCount: 5,
      purgedCount: 4,
      batchesProcessed: 2,
      remainingDueCount: 1,
      complete: false,
    });
  });

  it("keeps bounded drain dry-run non-mutating and validates max batches", () => {
    database = createTestDatabase();
    insertDueConsultations(3);

    expect(drainExpiredConsultations(database.db, {
      nowMs: 1,
      apply: false,
      batchSize: 2,
      maxBatches: 2,
    })).toEqual({
      dueCount: 3,
      purgedCount: 0,
      batchesProcessed: 0,
      remainingDueCount: 3,
      complete: false,
    });
    expect(() => drainExpiredConsultations(database!.db, {
      nowMs: 1,
      apply: true,
      maxBatches: 0,
    })).toThrow(/max batches/i);
  });

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

  it("finishes an in-flight delivery attempt before cancelling its expired outbox row", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 1);
    createIntake(false, 6, receivedAtMs);
    const expiry = (database.db.sqlite.prepare(`
      SELECT retention_expires_at_ms value FROM consultations
    `).get() as { value: number }).value;
    const outbox = database.db.sqlite.prepare(`
      SELECT id FROM notification_outbox ORDER BY id LIMIT 1
    `).get() as { id: string };
    database.db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'processing', attempt_count = 1,
          locked_at_ms = ?, lease_expires_at_ms = ?, locked_by = 'worker-retention'
      WHERE id = ?
    `).run(expiry - 2, expiry + 120_000, outbox.id);
    database.db.sqlite.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, delivery_cycle, attempt_no, worker_id,
        started_at_ms, finished_at_ms
      ) VALUES ('retention-attempt', ?, 1, 1, 'worker-retention', ?, NULL)
    `).run(outbox.id, expiry - 2);

    expect(purgeExpiredConsultations(database.db, {
      nowMs: expiry,
      apply: true,
    })).toEqual({ dueCount: 1, purgedCount: 1 });
    expect(database.db.sqlite.prepare(`
      SELECT state, payload_json, last_error_code,
        locked_at_ms, lease_expires_at_ms, locked_by
      FROM notification_outbox WHERE id = ?
    `).get(outbox.id)).toEqual({
      state: "cancelled",
      payload_json: null,
      last_error_code: "RETENTION_PURGED",
      locked_at_ms: null,
      lease_expires_at_ms: null,
      locked_by: null,
    });
    expect(database.db.sqlite.prepare(`
      SELECT outcome_code, finished_at_ms
      FROM notification_delivery_attempts WHERE id = 'retention-attempt'
    `).get()).toEqual({
      outcome_code: "RETENTION_PURGED",
      finished_at_ms: expiry,
    });
  });

  it("preserves a provider-handoff claim while removing its expired stored payload", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const receivedAtMs = Date.UTC(2026, 0, 1);
    createIntake(false, 7, receivedAtMs);
    const expiry = (database.db.sqlite.prepare(`
      SELECT retention_expires_at_ms value FROM consultations
    `).get() as { value: number }).value;
    const outbox = database.db.sqlite.prepare(`
      SELECT id FROM notification_outbox ORDER BY id LIMIT 1
    `).get() as { id: string };
    database.db.sqlite.prepare(`
      UPDATE notification_outbox
      SET state = 'processing', attempt_count = 1,
          locked_at_ms = ?, lease_expires_at_ms = ?, locked_by = 'worker-handoff',
          last_error_code = 'PROVIDER_HANDOFF_STARTED'
      WHERE id = ?
    `).run(expiry - 2, expiry + 120_000, outbox.id);
    database.db.sqlite.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, delivery_cycle, attempt_no, worker_id,
        started_at_ms, finished_at_ms
      ) VALUES ('handoff-attempt', ?, 1, 1, 'worker-handoff', ?, NULL)
    `).run(outbox.id, expiry - 2);

    expect(purgeExpiredConsultations(database.db, {
      nowMs: expiry,
      apply: true,
    })).toEqual({ dueCount: 1, purgedCount: 1 });
    expect(database.db.sqlite.prepare(`
      SELECT state, payload_json, last_error_code,
        locked_at_ms, lease_expires_at_ms, locked_by
      FROM notification_outbox WHERE id = ?
    `).get(outbox.id)).toEqual({
      state: "processing",
      payload_json: null,
      last_error_code: "PROVIDER_HANDOFF_STARTED",
      locked_at_ms: expiry - 2,
      lease_expires_at_ms: expiry + 120_000,
      locked_by: "worker-handoff",
    });
    expect(database.db.sqlite.prepare(`
      SELECT outcome_code, finished_at_ms
      FROM notification_delivery_attempts WHERE id = 'handoff-attempt'
    `).get()).toEqual({ outcome_code: null, finished_at_ms: null });
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
