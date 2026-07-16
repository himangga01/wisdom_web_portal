import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computePublishedArticleContentSha256,
  publishedManifestSchema,
} from "@wisdom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blindIndex, createStaticKeyProvider } from "../crypto/index.js";
import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  activateConsentBundle,
  getPublicConsentDocuments,
  seedCompleteConsentBundles,
} from "../consent/service.js";
import {
  capturePublicationSnapshot,
  writePublicationSnapshot,
} from "./publication-snapshot.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const KO_REVISION_ID = "22222222-2222-4222-8222-222222222222";
const EN_REVISION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ARTICLE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_REVISION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-07-16T03:00:00.000Z");
const FIRST_PUBLISHED_AT = Date.parse("2026-07-16T01:00:00.000Z");
const SOURCES = [{
  id: "official",
  url: "https://example.com/guidance",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
}];
const BODY = "## Complete answer\n\nVerified public guidance.\n";

let fixture: TestDatabase;
let outputDirectory: string | undefined;
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 71) });

function contentHash(title: string, summary: string, locale: "ko" | "en") {
  return Buffer.from(computePublishedArticleContentSha256({
    title, summary, bodyMarkdown: BODY, sources: SOURCES, locale,
  }), "hex");
}

function insertRevision(input: {
  articleId: string;
  revisionId: string;
  locale: "ko" | "en";
  title: string;
  summary: string;
  createdAtMs: number;
}) {
  fixture.db.sqlite.prepare(`
    INSERT INTO article_revisions (
      id, article_id, locale, revision_no, title, summary, body_markdown,
      content_sha256, source_revision_id, sources_json, source_sha256, initial_review_state,
      created_at_ms, created_by_type, created_by_id
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'hermes', 'draft')
  `).run(
    input.revisionId,
    input.articleId,
    input.locale,
    input.title,
    input.summary,
    BODY,
    contentHash(input.title, input.summary, input.locale),
    input.locale === "en" ? KO_REVISION_ID : null,
    JSON.stringify(SOURCES),
    Buffer.alloc(32, 9),
    input.createdAtMs,
  );
}

beforeEach(() => {
  fixture = createTestDatabase();
  const activeConsent = consentBundle();
  activeConsent[0] = {
    ...activeConsent[0]!,
    bodyMarkdown: '<script>alert("not html")</script>\n\nExact privacy text.',
  };
  seedCompleteConsentBundles(fixture.db, activeConsent, NOW - 10_000);
  activateConsentBundle(fixture.db, activeConsent[0]!.bundleId, NOW - 9_000);
  fixture.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms
    ) VALUES (?, 'reviewer', 'Kang Jihye', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);

  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms, published_at_ms
    ) VALUES (?, 'procurement-guide', 'published', 'ko', ?, 'hermes', 0, 0, ?)
  `).run(ARTICLE_ID, KO_REVISION_ID, FIRST_PUBLISHED_AT);
  insertRevision({
    articleId: ARTICLE_ID,
    revisionId: KO_REVISION_ID,
    locale: "ko",
    title: "조달 안내",
    summary: "공식 자료를 검토한 조달 안내입니다.",
    createdAtMs: FIRST_PUBLISHED_AT - 2_000,
  });
  insertRevision({
    articleId: ARTICLE_ID,
    revisionId: EN_REVISION_ID,
    locale: "en",
    title: "Procurement guide",
    summary: "A reviewed guide based on official sources.",
    createdAtMs: NOW - 2_000,
  });
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id,
      approved_revision_id, published_revision_id,
      approved_by_admin_id, approved_at_ms, published_at_ms,
      row_version, updated_at_ms
    ) VALUES
      (?, 'ko', 'procurement-guide', 'published', ?, ?, ?, ?, ?, ?, 4, ?),
      (?, 'en', 'procurement-guide', 'approved', ?, ?, NULL, ?, ?, NULL, 3, ?)
  `).run(
    ARTICLE_ID, KO_REVISION_ID, KO_REVISION_ID, KO_REVISION_ID,
    ADMIN_ID, FIRST_PUBLISHED_AT - 1_000, FIRST_PUBLISHED_AT, FIRST_PUBLISHED_AT,
    ARTICLE_ID, EN_REVISION_ID, EN_REVISION_ID,
    ADMIN_ID, NOW - 1_000, NOW - 1_000,
  );

  fixture.db.sqlite.prepare(`
    INSERT INTO releases (
      id, version, path, manifest_sha256, state, created_at_ms,
      activated_at_ms, created_by, verified_at_ms, verification_sha256
    ) VALUES (
      '66666666-6666-4666-8666-666666666666', 'release-previous',
      '/safe/releases/release-previous', ?, 'active', ?, ?, 'admin', ?, ?
    )
  `).run(
    Buffer.alloc(32, 6), FIRST_PUBLISHED_AT, FIRST_PUBLISHED_AT,
    FIRST_PUBLISHED_AT, Buffer.alloc(32, 6),
  );
  fixture.db.sqlite.prepare(`
    INSERT INTO release_entries (
      release_id, article_id, locale, slug, revision_id, content_sha256, route
    ) VALUES (
      '66666666-6666-4666-8666-666666666666', ?, 'ko',
      'procurement-guide', ?, ?, '/insights/procurement-guide'
    )
  `).run(ARTICLE_ID, KO_REVISION_ID, contentHash(
    "조달 안내", "공식 자료를 검토한 조달 안내입니다.", "ko",
  ));

  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms
    ) VALUES (?, 'unrelated', 'approved', 'ko', ?, 'hermes', 0, 0)
  `).run(OTHER_ARTICLE_ID, OTHER_REVISION_ID);
  insertRevision({
    articleId: OTHER_ARTICLE_ID,
    revisionId: OTHER_REVISION_ID,
    locale: "ko",
    title: "다른 승인 글",
    summary: "아직 발행을 선택하지 않은 글입니다.",
    createdAtMs: NOW - 2_000,
  });
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id, approved_revision_id,
      approved_by_admin_id, approved_at_ms, row_version, updated_at_ms
    ) VALUES (?, 'ko', 'unrelated', 'approved', ?, ?, ?, ?, 2, ?)
  `).run(OTHER_ARTICLE_ID, OTHER_REVISION_ID, OTHER_REVISION_ID, ADMIN_ID, NOW - 1_000, NOW);
});

afterEach(() => {
  fixture.close();
  if (outputDirectory) rmSync(outputDirectory, { force: true, recursive: true });
});

describe("immutable publication snapshot", () => {
  it("allows a policy-only snapshot while preserving promotion count and duplicate fences", () => {
    const snapshot = capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [],
      nowMs: NOW,
    });

    expect(snapshot.promotions).toEqual([]);
    expect(snapshot.documents.map(({ locale }) => locale)).toEqual(["ko"]);
    expect(snapshot.consentBundle.documents).toHaveLength(8);

    const promotion = {
      articleId: ARTICLE_ID,
      locale: "en" as const,
      revisionId: EN_REVISION_ID,
      expectedRowVersion: 3,
    };
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: Array.from({ length: 65 }, () => ({ ...promotion })),
      nowMs: NOW,
    })).toThrow(/^PUBLICATION_PROMOTION_COUNT_INVALID$/);
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{ ...promotion }, { ...promotion }],
      nowMs: NOW,
    })).toThrow(/^PUBLICATION_PROMOTION_DUPLICATE$/);
  });

  it("captures the exact active eight-document consent bundle used by consultation intake", () => {
    const snapshot = capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{
        articleId: ARTICLE_ID,
        locale: "en",
        revisionId: EN_REVISION_ID,
        expectedRowVersion: 3,
      }],
      nowMs: NOW,
    });
    const publicEnglish = getPublicConsentDocuments(fixture.db, "en")!;

    expect(snapshot.consentBundle.bundleId).toBe("bundle-2026-07-16");
    expect(snapshot.consentBundle.documents).toHaveLength(8);
    expect(Object.isFrozen(snapshot.consentBundle)).toBe(true);
    expect(Object.isFrozen(snapshot.consentBundle.documents)).toBe(true);
    expect(snapshot.consentBundle.documents.every((document) => Object.isFrozen(document))).toBe(true);
    expect(snapshot.consentBundle.documents.map(({ kind, locale }) => `${kind}:${locale}`)).toEqual([
      "privacy:ko", "marketing:ko", "privacy:en", "marketing:en",
      "privacy:zh-Hans", "marketing:zh-Hans", "privacy:zh-Hant", "marketing:zh-Hant",
    ]);
    for (const kind of ["privacy", "marketing"] as const) {
      const published = snapshot.consentBundle.documents.find((document) => (
        document.locale === "en" && document.kind === kind
      ));
      expect(published).toMatchObject(publicEnglish.documents[kind]);
    }
  });

  it("fails closed when no complete consistent active consent bundle exists", () => {
    fixture.db.sqlite.prepare(
      "UPDATE consent_documents SET state = 'retired' WHERE kind = 'privacy' AND locale = 'en'",
    ).run();

    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{
        articleId: ARTICLE_ID,
        locale: "en",
        revisionId: EN_REVISION_ID,
        expectedRowVersion: 3,
      }],
      nowMs: NOW,
    })).toThrow(/^PUBLICATION_CONSENT_BUNDLE_INVALID$/);
  });

  it("contains existing public heads plus only the explicitly promoted approved head", () => {
    const snapshot = capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{
        articleId: ARTICLE_ID,
        locale: "en",
        revisionId: EN_REVISION_ID,
        expectedRowVersion: 3,
      }],
      nowMs: NOW,
    });

    expect(snapshot.documents.map(({ locale, revisionId }) => ({ locale, revisionId }))).toEqual([
      { locale: "ko", revisionId: KO_REVISION_ID },
      { locale: "en", revisionId: EN_REVISION_ID },
    ]);
    expect(snapshot.documents.some(({ articleId }) => articleId === OTHER_ARTICLE_ID)).toBe(false);
    expect(snapshot.documents[0]).toMatchObject({
      firstPublishedAt: "2026-07-16T01:00:00.000Z",
      modifiedAt: "2026-07-16T01:00:00.000Z",
      reviewer: { name: "Kang Jihye", role: "Administrative content reviewer" },
    });
    expect(snapshot.documents[1]).toMatchObject({
      firstPublishedAt: "2026-07-16T03:00:00.000Z",
      modifiedAt: "2026-07-16T03:00:00.000Z",
    });
    expect(snapshot.entries.map(({ route }) => route)).toEqual([
      "/insights/procurement-guide",
      "/en/insights/procurement-guide",
    ]);
  });

  it("fails closed on stale promotion identity, non-approved state, and retained consultation PII", () => {
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{ articleId: ARTICLE_ID, locale: "en", revisionId: EN_REVISION_ID, expectedRowVersion: 99 }],
      nowMs: NOW,
    })).toThrow("PUBLICATION_PROMOTION_CONFLICT");

    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'in_review', approved_revision_id = NULL,
        approved_by_admin_id = NULL, approved_at_ms = NULL
      WHERE article_id = ? AND locale = 'en'
    `).run(ARTICLE_ID);
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{ articleId: ARTICLE_ID, locale: "en", revisionId: EN_REVISION_ID, expectedRowVersion: 3 }],
      nowMs: NOW,
    })).toThrow("PUBLICATION_PROMOTION_NOT_APPROVED");

    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW - 1_000, ARTICLE_ID);
    fixture.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('private', 'receipt-private', 'received', 'ko', 'procurement',
        'email', 'opaque', 'pii-v1', ?, ?, 'pii-v1', 0, 0, 0, 9999999999999, 1)
    `).run(Buffer.alloc(32, 1), Buffer.from("ab", "hex"));
    const privateSummary = "Contact retained-person@example.com for details.";
    fixture.db.sqlite.prepare("DROP TRIGGER article_revisions_immutable_update").run();
    fixture.db.sqlite.prepare(`
      UPDATE article_revisions SET summary = ?, content_sha256 = ? WHERE id = ?
    `).run(
      privateSummary,
      contentHash("Procurement guide", privateSummary, "en"),
      EN_REVISION_ID,
    );
    fixture.db.sqlite.prepare(`
      UPDATE consultations SET email_blind_index = ? WHERE id = 'private'
    `).run(blindIndex(keyProvider, "email", "retained-person@example.com"));
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{ articleId: ARTICLE_ID, locale: "en", revisionId: EN_REVISION_ID, expectedRowVersion: 3 }],
      nowMs: NOW,
    })).toThrow("PUBLICATION_PII_REJECTED");
  });

  it("writes a canonical, self-hashing snapshot accepted by the shared manifest schema", () => {
    const snapshot = capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{ articleId: ARTICLE_ID, locale: "en", revisionId: EN_REVISION_ID, expectedRowVersion: 3 }],
      nowMs: NOW,
    });
    outputDirectory = mkdtempSync(join(tmpdir(), "wisdom-publication-snapshot-"));
    writePublicationSnapshot(snapshot, outputDirectory);

    const manifestBytes = readFileSync(join(outputDirectory, "manifest.json"));
    const manifest = publishedManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    expect(manifestBytes.toString("utf8")).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    const consentBytes = readFileSync(join(outputDirectory, manifest.consentBundle.contentFile));
    expect(createHash("sha256").update(consentBytes).digest("hex"))
      .toBe(manifest.consentBundle.contentFileSha256);
    expect(JSON.parse(consentBytes.toString("utf8"))).toEqual(snapshot.consentBundle);
    for (const entry of manifest.entries) {
      const articleBytes = readFileSync(join(outputDirectory, entry.contentFile));
      expect(createHash("sha256").update(articleBytes).digest("hex")).toBe(entry.contentFileSha256);
    }
  });

  it("rejects a translated head when its approved source binding is no longer current", () => {
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'in_review', approved_revision_id = NULL,
        published_revision_id = NULL, approved_by_admin_id = NULL,
        approved_at_ms = NULL, published_at_ms = NULL, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(ARTICLE_ID);
    expect(() => capturePublicationSnapshot(fixture.db, keyProvider, {
      promote: [{
        articleId: ARTICLE_ID,
        locale: "en",
        revisionId: EN_REVISION_ID,
        expectedRowVersion: 3,
      }],
      nowMs: NOW,
    })).toThrow("PUBLICATION_TRANSLATION_SOURCE_STALE");
  });
});
