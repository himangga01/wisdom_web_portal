import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type ControlDatabase } from "../db/client.js";
import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  INDEXNOW_LEASE_MS,
  claimIndexNowDelivery,
  completeIndexNowDelivery,
  deliverNextIndexNowOutbox,
} from "./indexnow-outbox.js";

const NOW = Date.parse("2026-07-16T08:00:00.000Z");
const RELEASE_ID = "11111111-1111-4111-8111-111111111111";
const MANIFEST_SHA256 = Buffer.alloc(32, 17);

let fixture: TestDatabase;

function insertActiveRelease(db: ControlDatabase = fixture.db): void {
  db.sqlite.prepare(`
    INSERT INTO releases (
      id, version, path, manifest_sha256, state, created_at_ms,
      activated_at_ms, created_by, verified_at_ms, verification_sha256,
      activation_generation
    ) VALUES (?, 'release-v1', '/safe/release-v1', ?, 'active', ?, ?,
      'admin', ?, ?, 1)
  `).run(RELEASE_ID, MANIFEST_SHA256, NOW - 2_000, NOW - 1_000, NOW - 1_500, MANIFEST_SHA256);
}

function insertOutbox(
  overrides: Partial<{
    id: string;
    releaseId: string;
    manifestSha256: Buffer;
    payloadJson: string;
    state: "pending" | "processing" | "sent" | "failed";
    attemptCount: number;
    availableAtMs: number;
    lockedAtMs: number | null;
    leaseExpiresAtMs: number | null;
    lockedBy: string | null;
    fencingToken: Buffer | null;
    lastErrorCode: string | null;
  }> = {},
): string {
  const row = {
    id: "22222222-2222-4222-8222-222222222222",
    releaseId: RELEASE_ID,
    manifestSha256: MANIFEST_SHA256,
    payloadJson: JSON.stringify({
      host: "www.example.com",
      urls: [
        "https://www.example.com/insights",
        "https://www.example.com/insights/procurement-guide",
      ],
    }),
    state: "pending" as const,
    attemptCount: 0,
    availableAtMs: NOW,
    lockedAtMs: null,
    leaseExpiresAtMs: null,
    lockedBy: null,
    fencingToken: null,
    lastErrorCode: null,
    ...overrides,
  };
  fixture.db.sqlite.prepare(`
    INSERT INTO publication_outbox (
      id, release_id, event_type, manifest_sha256, payload_json, state,
      attempt_count, available_at_ms, locked_at_ms, lease_expires_at_ms,
      locked_by, fencing_token, last_error_code, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'indexnow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.releaseId,
    row.manifestSha256,
    row.payloadJson,
    row.state,
    row.attemptCount,
    row.availableAtMs,
    row.lockedAtMs,
    row.leaseExpiresAtMs,
    row.lockedBy,
    row.fencingToken,
    row.lastErrorCode,
    NOW - 1_000,
    NOW - 1_000,
  );
  return row.id;
}

beforeEach(() => {
  fixture = createTestDatabase();
  insertActiveRelease();
});

afterEach(() => {
  fixture.close();
});

describe("IndexNow outbox claim fencing", () => {
  it("serializes two file-backed connections and permits only one processing delivery", () => {
    insertOutbox();
    const secondManifest = Buffer.alloc(32, 18);
    fixture.db.sqlite.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by,
        verified_at_ms, verification_sha256, activation_generation
      ) VALUES ('55555555-5555-4555-8555-555555555555', 'release-v0',
        '/safe/release-v0', ?, 'retired', ?, 'admin', ?, ?, 1)
    `).run(secondManifest, NOW - 4_000, NOW - 3_000, secondManifest);
    insertOutbox({
      id: "33333333-3333-4333-8333-333333333333",
      releaseId: "55555555-5555-4555-8555-555555555555",
      manifestSha256: secondManifest,
      payloadJson: JSON.stringify({
        host: "www.example.com",
        urls: ["https://www.example.com/insights/visa-guide"],
      }),
    });
    const second = openDatabase(fixture.path);
    try {
      const firstClaim = claimIndexNowDelivery(fixture.db, {
        workerId: "worker-a",
        nowMs: NOW,
        randomBytes: () => Buffer.alloc(32, 1),
      });
      const secondClaim = claimIndexNowDelivery(second, {
        workerId: "worker-b",
        nowMs: NOW,
        randomBytes: () => Buffer.alloc(32, 2),
      });

      expect(firstClaim).toMatchObject({
        outboxId: "22222222-2222-4222-8222-222222222222",
        attemptCount: 1,
        workerId: "worker-a",
        leaseExpiresAtMs: NOW + INDEXNOW_LEASE_MS,
      });
      expect(firstClaim?.fencingToken).toEqual(Buffer.alloc(32, 1));
      expect(secondClaim).toBeUndefined();
      expect(second.sqlite.prepare(`
        SELECT count(*) FROM publication_outbox WHERE state = 'processing'
      `).pluck().get()).toBe(1);
    } finally {
      second.sqlite.close();
    }
  });

  it("reclaims an exactly expired lease and fences the late worker completion", () => {
    insertOutbox();
    const second = openDatabase(fixture.path);
    try {
      const firstClaim = claimIndexNowDelivery(fixture.db, {
        workerId: "worker-a",
        nowMs: NOW,
        randomBytes: () => Buffer.alloc(32, 3),
      });
      const replacement = claimIndexNowDelivery(second, {
        workerId: "worker-b",
        nowMs: NOW + INDEXNOW_LEASE_MS,
        randomBytes: () => Buffer.alloc(32, 4),
      });

      expect(replacement).toMatchObject({ workerId: "worker-b", attemptCount: 2 });
      expect(replacement?.fencingToken).toEqual(Buffer.alloc(32, 4));
      expect(completeIndexNowDelivery(fixture.db, firstClaim!, {
        nowMs: NOW + INDEXNOW_LEASE_MS + 1,
        providerMessageId: "late-message",
      })).toBe(false);
      expect(completeIndexNowDelivery(second, replacement!, {
        nowMs: NOW + INDEXNOW_LEASE_MS + 1,
        providerMessageId: "accepted-2",
      })).toBe(true);
      expect(fixture.db.sqlite.prepare(`
        SELECT state, attempt_count, provider_message_id
        FROM publication_outbox
      `).get()).toEqual({
        state: "sent",
        attempt_count: 2,
        provider_message_id: "accepted-2",
      });
    } finally {
      second.sqlite.close();
    }
  });
});

describe("IndexNow outbox delivery", () => {
  it("posts validated JSON outside the claim transaction and accepts the documented 200 and 202 statuses", async () => {
    insertOutbox();
    const sendJson = vi.fn(async (payload: { host: string; urls: string[] }) => {
      expect(fixture.db.sqlite.inTransaction).toBe(false);
      expect(payload).toEqual({
        host: "www.example.com",
        urls: [
          "https://www.example.com/insights",
          "https://www.example.com/insights/procurement-guide",
        ],
      });
      return { status: 202, providerMessageId: "indexnow-request-202" };
    });

    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => NOW,
      randomBytes: () => Buffer.alloc(32, 5),
      sendJson,
    })).resolves.toEqual({
      kind: "sent",
      outboxId: "22222222-2222-4222-8222-222222222222",
      status: 202,
    });
    expect(sendJson).toHaveBeenCalledTimes(1);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, provider_message_id, sent_at_ms, last_error_code
      FROM publication_outbox
    `).get()).toEqual({
      state: "sent",
      provider_message_id: "indexnow-request-202",
      sent_at_ms: NOW,
      last_error_code: null,
    });
  });

  it("does not silently accept an undocumented 2xx status", async () => {
    insertOutbox();
    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => NOW,
      randomBytes,
      sendJson: () => Promise.resolve({ status: 204 }),
    })).resolves.toEqual({
      kind: "retry-scheduled",
      outboxId: "22222222-2222-4222-8222-222222222222",
      availableAtMs: NOW + 60_000,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, last_error_code FROM publication_outbox
    `).get()).toEqual({ state: "failed", last_error_code: "INDEXNOW_HTTP_ERROR" });
  });

  it("retries eligible failures with a bounded deterministic exponential delay", async () => {
    insertOutbox();
    let nowMs = NOW;
    const sendJson = vi.fn()
      .mockResolvedValueOnce({ status: 503, responseBody: "private upstream diagnostics" })
      .mockResolvedValueOnce({ status: 200, providerMessageId: "accepted-after-retry" });

    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => nowMs,
      randomBytes,
      sendJson,
    })).resolves.toEqual({
      kind: "retry-scheduled",
      outboxId: "22222222-2222-4222-8222-222222222222",
      availableAtMs: NOW + 60_000,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, attempt_count, available_at_ms, last_error_code,
        provider_message_id FROM publication_outbox
    `).get()).toEqual({
      state: "failed",
      attempt_count: 1,
      available_at_ms: NOW + 60_000,
      last_error_code: "INDEXNOW_HTTP_ERROR",
      provider_message_id: null,
    });

    nowMs = NOW + 59_999;
    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a", now: () => nowMs, randomBytes, sendJson,
    })).resolves.toEqual({ kind: "idle" });
    nowMs = NOW + 60_000;
    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a", now: () => nowMs, randomBytes, sendJson,
    })).resolves.toEqual({
      kind: "sent",
      outboxId: "22222222-2222-4222-8222-222222222222",
      status: 200,
    });
    expect(sendJson).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or cross-host payloads permanently without calling the sender", async () => {
    insertOutbox({
      payloadJson: JSON.stringify({
        host: "www.example.com",
        urls: ["https://attacker.example/insights"],
        providerKey: "must-not-be-accepted",
      }),
    });
    const sendJson = vi.fn();

    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => NOW,
      randomBytes,
      sendJson,
    })).resolves.toEqual({
      kind: "failed",
      outboxId: "22222222-2222-4222-8222-222222222222",
      errorCode: "INDEXNOW_PAYLOAD_INVALID",
    });
    expect(sendJson).not.toHaveBeenCalled();
    expect(fixture.db.sqlite.prepare(`
      SELECT state, attempt_count, last_error_code, locked_by, fencing_token
      FROM publication_outbox
    `).get()).toEqual({
      state: "failed",
      attempt_count: 1,
      last_error_code: "INDEXNOW_PAYLOAD_INVALID",
      locked_by: null,
      fencing_token: null,
    });
    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-b",
      now: () => NOW + 365 * 24 * 60 * 60_000,
      randomBytes,
      sendJson,
    })).resolves.toEqual({ kind: "idle" });
  });

  it("persists only generic transport errors and never changes the active release", async () => {
    insertOutbox();
    const secret = "provider-key=super-secret&private-response=full-body";

    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => NOW,
      randomBytes,
      sendJson: () => Promise.reject(new Error(secret)),
    })).resolves.toEqual({
      kind: "retry-scheduled",
      outboxId: "22222222-2222-4222-8222-222222222222",
      availableAtMs: NOW + 60_000,
    });
    const persisted = fixture.db.sqlite.prepare(`
      SELECT state, last_error_code, provider_message_id
      FROM publication_outbox
    `).get();
    expect(persisted).toEqual({
      state: "failed",
      last_error_code: "INDEXNOW_TRANSPORT_ERROR",
      provider_message_id: null,
    });
    expect(JSON.stringify(persisted)).not.toContain(secret);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, activation_generation FROM releases WHERE id = ?
    `).get(RELEASE_ID)).toEqual({ state: "active", activation_generation: 1 });
  });

  it("drops unsafe provider message identifiers rather than persisting response material", async () => {
    insertOutbox();
    await deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a",
      now: () => NOW,
      randomBytes,
      sendJson: () => Promise.resolve({
        status: 200,
        providerMessageId: "unsafe response body\nAuthorization: secret",
      }),
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, provider_message_id FROM publication_outbox
    `).get()).toEqual({ state: "sent", provider_message_id: null });
  });

  it("relies on the release/manifest unique key so one activation cannot be delivered twice", async () => {
    insertOutbox();
    expect(() => insertOutbox({ id: "44444444-4444-4444-8444-444444444444" })).toThrow();
    const sendJson = vi.fn().mockResolvedValue({ status: 200, providerMessageId: "once" });
    await deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-a", now: () => NOW, randomBytes, sendJson,
    });
    await expect(deliverNextIndexNowOutbox(fixture.db, {
      workerId: "worker-b", now: () => NOW + 1, randomBytes, sendJson,
    })).resolves.toEqual({ kind: "idle" });
    expect(sendJson).toHaveBeenCalledTimes(1);
  });
});
