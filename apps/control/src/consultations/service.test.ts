import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  blindIndex,
  createStaticKeyProvider,
  encryptPii,
} from "../crypto/index.js";
import { findConsultationIdsByContact } from "./service.js";

let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

describe("consultation contact lookup", () => {
  it("finds a pre-rotation row through active and previous blind-index candidates", () => {
    testDatabase = createTestDatabase();
    const hmacRoot = Buffer.alloc(32, 8);
    const oldKey = { id: "pii-v1", secret: Buffer.alloc(32, 1) };
    const newKey = { id: "pii-v2", secret: Buffer.alloc(32, 2) };
    const oldProvider = createStaticKeyProvider(oldKey, [], hmacRoot);
    const rotatedProvider = createStaticKeyProvider(newKey, [oldKey], hmacRoot);
    const consultationId = "consultation-before-rotation";
    const phone = "+82 (10) 1234-5678";

    testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone', ?, ?, ?, NULL, ?, 0, ?, ?, ?, 1)
    `).run(
      consultationId,
      "receipt-before-rotation",
      encryptPii(oldProvider, consultationId, {
        name: "Before Rotation",
        phone: "+821012345678",
        message: "This encrypted message is long enough for a persisted consultation.",
      }),
      oldKey.id,
      blindIndex(oldProvider, "phone", phone),
      oldKey.id,
      1_000,
      1_000,
      2_000,
    );

    expect(findConsultationIdsByContact(
      testDatabase.db,
      rotatedProvider,
      "phone",
      phone,
    )).toEqual([consultationId]);
    expect(findConsultationIdsByContact(
      testDatabase.db,
      rotatedProvider,
      "phone",
      "+821099999999",
    )).toEqual([]);
  });
});
