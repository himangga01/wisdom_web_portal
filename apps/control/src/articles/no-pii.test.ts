import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  blindIndex,
  createStaticKeyProvider,
  encryptPii,
  type KeyProvider,
} from "../crypto/index.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

function seedConsultation(
  provider: KeyProvider,
  phone = "+821012345678",
  email = "private@example.com",
  pii: {
    name: string;
    company?: string;
    message: string;
  } = {
    name: "김민지",
    company: "비공개테크",
    message: "혁신제품 지정 심사에서 내부 사정으로 두 차례 보완 요청을 받았습니다.",
  },
): void {
  const envelope = encryptPii(provider, "pii-consultation", {
    ...pii,
    phone,
    email,
  });
  testDatabase!.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('pii-consultation', 'pii-receipt', 'received', 'ko', 'procurement', 'phone',
      ?, ?, ?, ?, ?, 0, 0, 0, 999999, 1)
  `).run(
    envelope,
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

  it("rejects retained consultation names and companies after Unicode and punctuation normalization", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 6) });
    seedConsultation(provider);

    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["김 민지 고객의 공개 사례입니다."],
    )).toEqual({ safe: false, kind: "name" });
    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["비공개-테크의 조달 사례입니다."],
    )).toEqual({ safe: false, kind: "company" });
  });

  it("rejects a meaningful retained consultation message excerpt", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 7) });
    seedConsultation(provider);

    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["의뢰인은 내부 사정으로 두 차례 보완 요청을 받았습니다."],
    )).toEqual({ safe: false, kind: "message" });
  });

  it("fails closed when any retained consultation envelope cannot be decrypted", () => {
    testDatabase = createTestDatabase();
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 8) });
    seedConsultation(provider);
    testDatabase.db.sqlite.prepare(`
      UPDATE consultations SET pii_envelope = 'corrupt-envelope'
      WHERE id = 'pii-consultation'
    `).run();

    expect(checkArticleForRetainedConsultationPii(
      testDatabase.db,
      provider,
      ["A public article with no known contact details."],
    )).toEqual({ safe: false, kind: "decrypt-failed" });
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
