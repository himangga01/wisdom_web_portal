import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  activateConsentBundle,
  getActiveConsentBundle,
  getConsentBundleDigest,
  getPublicConsentDocuments,
  seedConsentDocuments,
  seedCompleteConsentBundles,
} from "./service.js";

let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

describe("immutable consent bundles", () => {
  it("enforces privacy 12-month and marketing 24-month retention roles", () => {
    testDatabase = createTestDatabase();
    const reversed = consentBundle().map((document) => ({
      ...document,
      retentionMonths: document.kind === "privacy" ? 24 as const : 12 as const,
    }));
    expect(() => seedConsentDocuments(testDatabase!.db, reversed, 1_000)).toThrow(
      /retention/i,
    );

    const nonstandard = consentBundle().map((document, index) => index === 0
      ? { ...document, retentionMonths: 18 as unknown as 12 }
      : document);
    expect(() => seedConsentDocuments(testDatabase!.db, nonstandard, 1_000)).toThrow(
      /retention/i,
    );
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM consent_documents").get()).toEqual({ count: 0 });
  });

  it("refuses activation when persisted retention roles are reversed", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    testDatabase.db.sqlite.prepare(`
      UPDATE consent_documents
      SET retention_months = CASE kind WHEN 'privacy' THEN 24 ELSE 12 END
      WHERE bundle_id = ?
    `).run("bundle-2026-07-16");

    expect(() => activateConsentBundle(testDatabase!.db, "bundle-2026-07-16", 2_000)).toThrow(
      /retention/i,
    );
    expect(getActiveConsentBundle(testDatabase.db)).toBeUndefined();
  });

  it("refuses activation when a persisted consent version is non-canonical", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    testDatabase.db.sqlite.prepare(`
      UPDATE consent_documents SET version = ?
      WHERE bundle_id = ? AND kind = 'privacy' AND locale = 'ko'
    `).run(" privacy-2026-07-16 ", "bundle-2026-07-16");

    expect(() => activateConsentBundle(testDatabase!.db, "bundle-2026-07-16", 2_000)).toThrow(
      /version/i,
    );
    expect(getActiveConsentBundle(testDatabase.db)).toBeUndefined();
  });

  it("rejects non-canonical, overlong, or unsupported consent versions before persistence", () => {
    testDatabase = createTestDatabase();
    for (const version of [" privacy-2026-07-16", "privacy-2026-07-16 ", "v".repeat(65), "privacy/2026"] as const) {
      const invalid = consentBundle().map((document, index) => index === 0
        ? { ...document, version }
        : document);
      expect(() => seedConsentDocuments(testDatabase!.db, invalid, 1_000), version).toThrow(
        /version/i,
      );
    }
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM consent_documents").get()).toEqual({ count: 0 });
  });

  it("rejects an incomplete production seed before writing any document", () => {
    testDatabase = createTestDatabase();
    expect(() => seedCompleteConsentBundles(
      testDatabase!.db,
      consentBundle().slice(0, -1),
      1_000,
    )).toThrow(/complete bundle/i);
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM consent_documents").get()).toEqual({ count: 0 });
  });

  it("seeds documents idempotently but rejects content changes at the same identity", () => {
    testDatabase = createTestDatabase();
    const bundle = consentBundle();
    expect(seedConsentDocuments(testDatabase.db, bundle, 1_000)).toBe(8);
    expect(seedConsentDocuments(testDatabase.db, bundle, 1_000)).toBe(0);

    const changed = bundle.map((document, index) => index === 0
      ? { ...document, bodyMarkdown: `${document.bodyMarkdown} changed` }
      : document);
    expect(() => seedConsentDocuments(testDatabase!.db, changed, 1_000)).toThrow(
      /immutable consent document conflict/i,
    );
  });

  it("rejects incomplete activation and atomically replaces all eight active documents", () => {
    testDatabase = createTestDatabase();
    const first = consentBundle("bundle-a", "a");
    seedConsentDocuments(testDatabase.db, first.slice(0, -1), 1_000);
    expect(() => activateConsentBundle(testDatabase!.db, "bundle-a", 2_000)).toThrow(
      /complete bundle/i,
    );
    expect(getActiveConsentBundle(testDatabase.db)).toBeUndefined();

    seedConsentDocuments(testDatabase.db, first.slice(-1), 1_000);
    const digest = getConsentBundleDigest(testDatabase.db, "bundle-a");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => activateConsentBundle(testDatabase!.db, "bundle-a", 2_000, "0".repeat(64))).toThrow(
      /digest confirmation/i,
    );
    activateConsentBundle(testDatabase.db, "bundle-a", 2_000, digest);
    expect(getActiveConsentBundle(testDatabase.db)?.documents).toHaveLength(8);

    const second = consentBundle("bundle-b", "b");
    seedConsentDocuments(testDatabase.db, second, 3_000);
    activateConsentBundle(testDatabase.db, "bundle-b", 4_000);
    expect(getActiveConsentBundle(testDatabase.db)?.bundleId).toBe("bundle-b");
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM consent_documents WHERE state = 'active'",
    ).get()).toEqual({ count: 8 });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM consent_documents WHERE bundle_id = 'bundle-a' AND state = 'retired'",
    ).get()).toEqual({ count: 8 });
  });

  it("returns the nested locale response consumed by the public-site adapter", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    activateConsentBundle(testDatabase.db, "bundle-2026-07-16", 2_000);

    expect(getPublicConsentDocuments(testDatabase.db, "en")).toMatchObject({
      locale: "en",
      documents: {
        privacy: { version: "privacy-2026-07-16", required: true, retentionMonths: 12 },
        marketing: { version: "marketing-2026-07-16", required: false, retentionMonths: 24 },
      },
    });
  });
});
