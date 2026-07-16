import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  blindIndex,
  createStaticKeyProvider,
  type KeyProvider,
} from "../crypto/index.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

function seedConsultation(
  provider: KeyProvider,
  phone = "+821012345678",
  email = "private@example.com",
): void {
  testDatabase!.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('pii-consultation', 'pii-receipt', 'received', 'ko', 'procurement', 'phone',
      'not-a-decryptable-envelope', ?, ?, ?, ?, 0, 0, 0, 999999, 1)
  `).run(
    provider.active().id,
    blindIndex(provider, "phone", phone),
    blindIndex(provider, "email", email),
    provider.active().id,
  );
}

describe("article retained-consultation PII gate", () => {
  it("matches formatted phone and email blind indexes without decrypting the consultation", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 1) });
    seedConsultation(provider);

    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["Call +82 (10) 1234-5678 for private details."],
    )).toEqual({ safe: false, kind: "phone" });
    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["Contact PRIVATE@example.com for private details."],
    )).toEqual({ safe: false, kind: "email" });
  });

  it("allows public-looking contacts that do not match retained consultation indexes", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 2) });
    seedConsultation(provider);
    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["Official office: office@example.org / 02-1234-5678"],
    )).toEqual({ safe: true });
  });

  it("ignores purged rows and checks previous blind-index keys after rotation", () => {
    testDatabase = createTestDatabase();
    const root = Buffer.alloc(32, 9);
    const oldKey = { id: "pii-v1", secret: Buffer.alloc(32, 3) };
    const newKey = { id: "pii-v2", secret: Buffer.alloc(32, 4) };
    const oldProvider = createStaticKeyProvider(oldKey, [], root);
    const rotatedProvider = createStaticKeyProvider(newKey, [oldKey], root);
    seedConsultation(oldProvider);

    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      rotatedProvider,
      ["private@example.com"],
    )).toEqual({ safe: false, kind: "email" });
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations
      SET purged_at_ms = 1, pii_envelope = NULL, pii_key_id = NULL,
        phone_blind_index = NULL, email_blind_index = NULL, blind_index_key_id = NULL
      WHERE id = 'pii-consultation'
    `).run();
    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      rotatedProvider,
      ["private@example.com and +82-10-1234-5678"],
    )).toEqual({ safe: true });
  });

  it("fails closed when untrusted text contains too many contact candidates", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 5) });
    const candidates = Array.from(
      { length: 65 },
      (_, index) => `person${index}@example.com`,
    ).join(" ");
    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      [candidates],
    )).toEqual({ safe: false, kind: "candidate-limit" });
  });
});
