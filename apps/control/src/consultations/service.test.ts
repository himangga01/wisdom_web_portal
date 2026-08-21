import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { issueFormToken } from "../abuse/form-token.js";
import {
  activateConsentBundle,
  createDatabaseConsentAuthorityResolver,
  getActivePublishedConsentBundle,
  getConsentBundleDigest,
  seedConsentDocuments,
} from "../consent/service.js";
import {
  blindIndex,
  createStaticKeyProvider,
  encryptPii,
} from "../crypto/index.js";
import { acceptConsultation, findConsultationIdsByContact } from "./service.js";

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

describe("consultation release binding", () => {
  it("accepts the exact signed release identity and rejects a signed mismatch as stale", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    activateConsentBundle(testDatabase.db, "bundle-2026-07-16", 2_000);
    const bundle = getActivePublishedConsentBundle(testDatabase.db)!;
    const manifestSha256 = getConsentBundleDigest(testDatabase.db, bundle.bundleId);
    const provider = createStaticKeyProvider({
      id: "pii-v1",
      secret: Buffer.alloc(32, 9),
    });
    const binding = {
      locale: "en" as const,
      releaseId: `database:${bundle.bundleId}`,
      bundleId: bundle.bundleId,
      manifestSha256,
      privacyVersion: "privacy-2026-07-16",
      marketingVersion: "marketing-2026-07-16",
    };
    const consultation = {
      locale: "en" as const,
      category: "procurement" as const,
      name: "Release Bound Client",
      phone: "+821012345678",
      email: "release-bound@example.test",
      preferredContact: "email" as const,
      message: "Please review this release-bound consultation request in detail.",
      privacyConsent: { version: binding.privacyVersion, accepted: true as const },
      marketingConsent: { version: binding.marketingVersion, accepted: false },
    };
    const options = {
      resolveConsentAuthority: createDatabaseConsentAuthorityResolver(testDatabase.db),
      randomUUID: (() => {
        let counter = 0;
        return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
      })(),
    };
    expect(acceptConsultation(testDatabase.db, provider, {
      consultation,
      formToken: issueFormToken(provider, binding, 1_000, "release-bound-valid"),
      idempotencyKey: "release-bound-valid-idempotency",
      requestId: "release-bound-valid-request",
      clientIp: "198.51.100.10",
      nowMs: 3_000,
    }, options).kind).toBe("created");

    expect(acceptConsultation(testDatabase.db, provider, {
      consultation: { ...consultation, phone: "+821012345679" },
      formToken: issueFormToken(provider, {
        ...binding,
        releaseId: "different-release",
      }, 1_000, "release-bound-stale"),
      idempotencyKey: "release-bound-stale-idempotency",
      requestId: "release-bound-stale-request",
      clientIp: "198.51.100.11",
      nowMs: 3_000,
    }, options).kind).toBe("stale-consent");
  });
});
