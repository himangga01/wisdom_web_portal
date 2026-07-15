import {
  CONSULTATION_STATUSES,
  type ConsultationStatus,
} from "@wisdom/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  changeConsultationStatus,
  type ConsultationWorkflowFaultPoint,
} from "./workflow.js";

const PII_CANARIES = [
  "Customer <script>alert(1)</script>",
  "customer.private@example.test",
  "+821012345678",
  "A confidential consultation message",
] as const;

const ALLOWED_TRANSITIONS = [
  ["received", "received"],
  ["received", "acknowledged"],
  ["received", "in_progress"],
  ["received", "closed"],
  ["received", "spam"],
  ["acknowledged", "acknowledged"],
  ["acknowledged", "in_progress"],
  ["acknowledged", "closed"],
  ["acknowledged", "spam"],
  ["in_progress", "in_progress"],
  ["in_progress", "closed"],
  ["in_progress", "spam"],
  ["closed", "closed"],
  ["spam", "spam"],
] as const satisfies ReadonlyArray<readonly [ConsultationStatus, ConsultationStatus]>;

const allowedKeys = new Set(ALLOWED_TRANSITIONS.map(([from, to]) => `${from}:${to}`));
const FORBIDDEN_TRANSITIONS = CONSULTATION_STATUSES.flatMap((from) =>
  CONSULTATION_STATUSES
    .filter((to) => !allowedKeys.has(`${from}:${to}`))
    .map((to) => [from, to] as const),
);

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedConsultation(
  db: TestDatabase["db"],
  status: ConsultationStatus,
  rowVersion = 7,
): void {
  db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES (
      'consultation-workflow', 'receipt-workflow', ?, 'ko', 'procurement', 'email',
      ?, 'pii-v1', ?, ?, 'pii-v1', 1, 1000, 1000, 999999999, ?
    )
  `).run(
    status,
    JSON.stringify({
      name: PII_CANARIES[0],
      email: PII_CANARIES[1],
      phone: PII_CANARIES[2],
      message: PII_CANARIES[3],
    }),
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    rowVersion,
  );
}

function nextIdFactory(): () => string {
  let sequence = 0;
  return () => `workflow-id-${++sequence}`;
}

function runChange(
  db: TestDatabase["db"],
  targetStatus: ConsultationStatus,
  expectedRowVersion = 7,
  options: {
    notificationChannels?: readonly ("email" | "hermes-telegram")[];
    faultInjector?: (point: ConsultationWorkflowFaultPoint) => void;
  } = {},
) {
  return changeConsultationStatus(db, {
    consultationId: "consultation-workflow",
    targetStatus,
    expectedRowVersion,
    actorAdminId: "admin-owner",
    requestId: "request-workflow",
    nowMs: 2_000,
    ...(options.notificationChannels
      ? { notificationChannels: options.notificationChannels }
      : {}),
  }, {
    randomUUID: nextIdFactory(),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
}

function storedConsultation(db: TestDatabase["db"]) {
  return db.sqlite.prepare(`
    SELECT status, row_version, updated_at_ms
    FROM consultations WHERE id = 'consultation-workflow'
  `).get();
}

function mutationCounts(db: TestDatabase["db"]) {
  return {
    audit: (db.sqlite.prepare(`
      SELECT count(*) count FROM audit_events
      WHERE target_type = 'consultation' AND target_id = 'consultation-workflow'
    `).get() as { count: number }).count,
    outbox: (db.sqlite.prepare(`
      SELECT count(*) count FROM notification_outbox
      WHERE consultation_id = 'consultation-workflow'
    `).get() as { count: number }).count,
  };
}

describe("consultation status workflow", () => {
  it.each(ALLOWED_TRANSITIONS)(
    "accepts the allowed or idempotent transition %s -> %s",
    (fromStatus, targetStatus) => {
      testDatabase = createTestDatabase();
      seedConsultation(testDatabase.db, fromStatus);

      const result = runChange(testDatabase.db, targetStatus, 7, {
        notificationChannels: ["email"],
      });

      if (fromStatus === targetStatus) {
        expect(result).toEqual({
          kind: "unchanged",
          httpStatus: 200,
          consultationStatus: fromStatus,
          rowVersion: 7,
        });
        expect(storedConsultation(testDatabase.db)).toEqual({
          status: fromStatus,
          row_version: 7,
          updated_at_ms: 1_000,
        });
        expect(mutationCounts(testDatabase.db)).toEqual({ audit: 0, outbox: 0 });
        return;
      }

      expect(result).toEqual({
        kind: "updated",
        httpStatus: 200,
        consultationStatus: targetStatus,
        rowVersion: 8,
      });
      expect(storedConsultation(testDatabase.db)).toEqual({
        status: targetStatus,
        row_version: 8,
        updated_at_ms: 2_000,
      });
      expect(mutationCounts(testDatabase.db)).toEqual({ audit: 1, outbox: 1 });
    },
  );

  it.each(FORBIDDEN_TRANSITIONS)(
    "rejects the forbidden transition %s -> %s without mutation",
    (fromStatus, targetStatus) => {
      testDatabase = createTestDatabase();
      seedConsultation(testDatabase.db, fromStatus);

      expect(runChange(testDatabase.db, targetStatus, 7, {
        notificationChannels: ["email", "hermes-telegram"],
      })).toEqual({
        kind: "invalid-transition",
        httpStatus: 422,
        consultationStatus: fromStatus,
        rowVersion: 7,
      });
      expect(storedConsultation(testDatabase.db)).toEqual({
        status: fromStatus,
        row_version: 7,
        updated_at_ms: 1_000,
      });
      expect(mutationCounts(testDatabase.db)).toEqual({ audit: 0, outbox: 0 });
    },
  );

  it("returns a 409-equivalent conflict for a stale row version", () => {
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db, "received");

    expect(runChange(testDatabase.db, "acknowledged")).toMatchObject({
      kind: "updated",
      rowVersion: 8,
    });
    expect(runChange(testDatabase.db, "in_progress")).toEqual({
      kind: "conflict",
      httpStatus: 409,
      consultationStatus: "acknowledged",
      rowVersion: 8,
    });
    expect(storedConsultation(testDatabase.db)).toEqual({
      status: "acknowledged",
      row_version: 8,
      updated_at_ms: 2_000,
    });
    expect(mutationCounts(testDatabase.db)).toEqual({ audit: 1, outbox: 0 });
  });

  it("requires the current row version even for an idempotent same-state request", () => {
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db, "closed", 8);

    expect(runChange(testDatabase.db, "closed", 7)).toEqual({
      kind: "conflict",
      httpStatus: 409,
      consultationStatus: "closed",
      rowVersion: 8,
    });
    expect(mutationCounts(testDatabase.db)).toEqual({ audit: 0, outbox: 0 });
  });

  it("atomically writes a redacted audit event and selected notification rows", () => {
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db, "received");

    expect(runChange(testDatabase.db, "acknowledged", 7, {
      notificationChannels: ["email", "hermes-telegram", "email"],
    })).toMatchObject({ kind: "updated", rowVersion: 8 });

    const audit = testDatabase.db.sqlite.prepare(`
      SELECT actor_type, actor_id, action, target_type, target_id, request_id,
             metadata_json, created_at_ms
      FROM audit_events
    `).get() as Record<string, unknown>;
    expect(audit).toEqual({
      actor_type: "admin",
      actor_id: "admin-owner",
      action: "consultation.status.changed",
      target_type: "consultation",
      target_id: "consultation-workflow",
      request_id: "request-workflow",
      metadata_json: JSON.stringify({
        fromStatus: "received",
        toStatus: "acknowledged",
        rowVersion: 8,
      }),
      created_at_ms: 2_000,
    });

    const deliveries = testDatabase.db.sqlite.prepare(`
      SELECT channel, event_type, payload_json, state, attempt_count,
             available_at_ms, purpose, delivery_cycle, created_at_ms, updated_at_ms
      FROM notification_outbox ORDER BY channel
    `).all();
    expect(deliveries).toEqual([
      {
        channel: "email",
        event_type: "consultation.status.acknowledged",
        payload_json: JSON.stringify({
          receiptId: "receipt-workflow",
          status: "acknowledged",
        }),
        state: "pending",
        attempt_count: 0,
        available_at_ms: 2_000,
        purpose: "transactional",
        delivery_cycle: 1,
        created_at_ms: 2_000,
        updated_at_ms: 2_000,
      },
      {
        channel: "hermes-telegram",
        event_type: "consultation.status.acknowledged",
        payload_json: JSON.stringify({
          receiptId: "receipt-workflow",
          status: "acknowledged",
        }),
        state: "pending",
        attempt_count: 0,
        available_at_ms: 2_000,
        purpose: "transactional",
        delivery_cycle: 1,
        created_at_ms: 2_000,
        updated_at_ms: 2_000,
      },
    ]);

    const persistedMetadata = JSON.stringify({ audit, deliveries });
    for (const pii of PII_CANARIES) expect(persistedMetadata).not.toContain(pii);
  });

  it.each([
    "after-status",
    "after-audit",
    "after-outbox",
  ] as const)("rolls back all workflow writes after an injected %s fault", (faultPoint) => {
    testDatabase = createTestDatabase();
    seedConsultation(testDatabase.db, "received");

    expect(() => runChange(testDatabase!.db, "acknowledged", 7, {
      notificationChannels: ["email", "hermes-telegram"],
      faultInjector(point) {
        if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
      },
    })).toThrow(`injected ${faultPoint}`);
    expect(storedConsultation(testDatabase.db)).toEqual({
      status: "received",
      row_version: 7,
      updated_at_ms: 1_000,
    });
    expect(mutationCounts(testDatabase.db)).toEqual({ audit: 0, outbox: 0 });
  });

  it("returns not found without leaving a transaction or side effects", () => {
    testDatabase = createTestDatabase();

    expect(runChange(testDatabase.db, "acknowledged")).toEqual({
      kind: "not-found",
      httpStatus: 404,
    });
    expect(testDatabase.db.sqlite.inTransaction).toBe(false);
    expect(mutationCounts(testDatabase.db)).toEqual({ audit: 0, outbox: 0 });
  });
});
