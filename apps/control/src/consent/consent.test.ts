import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  activateConsentBundle,
  getActiveConsentBundle,
  getConsentBundleDigest,
  getPublishedConsentBundleById,
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

  it("prevents persisted retention roles from being reversed", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    expect(() => testDatabase!.db.sqlite.prepare(`
      UPDATE consent_documents
      SET retention_months = CASE kind WHEN 'privacy' THEN 24 ELSE 12 END
      WHERE bundle_id = ?
    `).run("bundle-2026-07-16")).toThrow(/immutable/i);

    activateConsentBundle(testDatabase.db, "bundle-2026-07-16", 2_000);
    expect(getActiveConsentBundle(testDatabase.db)?.documents.every((document) => (
      document.retentionMonths === (document.kind === "privacy" ? 12 : 24)
    ))).toBe(true);
  });

  it("prevents a persisted consent version from becoming non-canonical", () => {
    testDatabase = createTestDatabase();
    seedConsentDocuments(testDatabase.db, consentBundle(), 1_000);
    expect(() => testDatabase!.db.sqlite.prepare(`
      UPDATE consent_documents SET version = ?
      WHERE bundle_id = ? AND kind = 'privacy' AND locale = 'ko'
    `).run(" privacy-2026-07-16 ", "bundle-2026-07-16")).toThrow(/immutable/i);

    activateConsentBundle(testDatabase.db, "bundle-2026-07-16", 2_000);
    expect(getActiveConsentBundle(testDatabase.db)?.documents.find((document) => (
      document.kind === "privacy" && document.locale === "ko"
    ))?.version).toBe("privacy-2026-07-16");
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
    const identities = testDatabase.db.sqlite.prepare(`
      SELECT id, kind, locale, created_at_ms FROM consent_documents
      WHERE bundle_id = ? ORDER BY kind, locale
    `).all(bundle[0]!.bundleId);
    activateConsentBundle(testDatabase.db, bundle[0]!.bundleId, 2_000);
    expect(seedConsentDocuments(testDatabase.db, bundle, 9_000)).toBe(0);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT id, kind, locale, created_at_ms FROM consent_documents
      WHERE bundle_id = ? ORDER BY kind, locale
    `).all(bundle[0]!.bundleId)).toEqual(identities);
    expect(testDatabase.db.sqlite.prepare(`
      SELECT DISTINCT state, effective_at_ms, retired_at_ms
      FROM consent_documents WHERE bundle_id = ?
    `).all(bundle[0]!.bundleId)).toEqual([{
      state: "active", effective_at_ms: 2_000, retired_at_ms: null,
    }]);

    const changed = bundle.map((document, index) => index === 0
      ? { ...document, bodyMarkdown: `${document.bodyMarkdown} changed` }
      : document);
    expect(() => seedConsentDocuments(testDatabase!.db, changed, 1_000)).toThrow(
      "CONSENT_BUNDLE_IMMUTABLE",
    );
  });

  it("rejects a changed version under an existing bundle identity atomically", () => {
    testDatabase = createTestDatabase();
    const original = consentBundle("bundle-fixed", "fixed");
    seedCompleteConsentBundles(testDatabase.db, original, 1_000);
    const changedVersion = original.map((document, index) => index === 0
      ? { ...document, version: "privacy-replacement" }
      : document);

    expect(() => seedCompleteConsentBundles(
      testDatabase!.db,
      changedVersion,
      2_000,
    )).toThrow("CONSENT_BUNDLE_IMMUTABLE");
    expect(testDatabase.db.sqlite.prepare(`
      SELECT count(*) count FROM consent_documents WHERE bundle_id = 'bundle-fixed'
    `).get()).toEqual({ count: 8 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT version FROM consent_documents
      WHERE bundle_id = 'bundle-fixed' AND kind = 'privacy' AND locale = 'ko'
    `).pluck().get()).toBe("privacy-fixed");
  });

  it("rejects incomplete activation and atomically replaces all eight active documents", () => {
    testDatabase = createTestDatabase();
    const first = consentBundle("bundle-a", "a");
    const insertDraft = testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1_000)
    `);
    first.slice(0, -1).forEach((document, index) => insertDraft.run(
      `incomplete-${index}`,
      "bundle-incomplete",
      document.kind,
      document.locale,
      `${document.version}-incomplete`,
      document.title,
      document.bodyMarkdown,
      Buffer.alloc(32, index + 1),
      document.retentionMonths,
    ));
    expect(() => activateConsentBundle(testDatabase!.db, "bundle-incomplete", 2_000)).toThrow(
      /complete bundle/i,
    );
    expect(getActiveConsentBundle(testDatabase.db)).toBeUndefined();

    seedConsentDocuments(testDatabase.db, first, 1_000);
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

  it("blocks a consent authority change while a publication activation is pending", () => {
    testDatabase = createTestDatabase();
    seedCompleteConsentBundles(testDatabase.db, consentBundle("bundle-a", "a"), 1_000);
    activateConsentBundle(testDatabase.db, "bundle-a", 2_000);
    seedCompleteConsentBundles(testDatabase.db, consentBundle("bundle-b", "b"), 3_000);
    const manifest = Buffer.alloc(32, 7);
    testDatabase.db.sqlite.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by,
        verified_at_ms, verification_sha256
      ) VALUES ('release-pending', 'release-pending-v1', '/pending', ?,
        'building', 4_000, 'admin', 4_000, ?)
    `).run(manifest, manifest);
    testDatabase.db.sqlite.prepare(`
      INSERT INTO release_activations (
        id, release_id, operation, state, manifest_sha256,
        target_path, created_at_ms
      ) VALUES ('activation-pending', 'release-pending', 'publish',
        'prepared', ?, '/pending', 4_000)
    `).run(manifest);

    expect(() => activateConsentBundle(testDatabase!.db, "bundle-b", 5_000)).toThrow(
      "CONSENT_ACTIVATION_BLOCKED_BY_PUBLICATION",
    );
    expect(getActiveConsentBundle(testDatabase.db)?.bundleId).toBe("bundle-a");
  });

  it("rejects retired bundle reactivation without changing its effective time or authority rows", () => {
    testDatabase = createTestDatabase();
    seedCompleteConsentBundles(testDatabase.db, consentBundle("bundle-a", "a"), 1_000);
    activateConsentBundle(testDatabase.db, "bundle-a", 2_000);
    seedCompleteConsentBundles(testDatabase.db, consentBundle("bundle-b", "b"), 3_000);
    activateConsentBundle(testDatabase.db, "bundle-b", 4_000);

    expect(() => activateConsentBundle(testDatabase!.db, "bundle-a", 5_000)).toThrow(
      "CONSENT_BUNDLE_REACTIVATION_REJECTED",
    );
    expect(testDatabase.db.sqlite.prepare(`
      SELECT DISTINCT state, effective_at_ms, retired_at_ms
      FROM consent_documents WHERE bundle_id = 'bundle-a'
    `).all()).toEqual([{ state: "retired", effective_at_ms: 2_000, retired_at_ms: 4_000 }]);
    expect(getActiveConsentBundle(testDatabase.db)?.bundleId).toBe("bundle-b");
    expect(getPublishedConsentBundleById(testDatabase.db, "bundle-a")?.bundleId).toBe("bundle-a");
    expect(getPublishedConsentBundleById(testDatabase.db, "bundle-b")?.bundleId).toBe("bundle-b");
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
