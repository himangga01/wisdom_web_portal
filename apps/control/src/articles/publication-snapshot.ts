import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  computePublishedArticleContentSha256,
  normalizeValidateAndRenderArticleMarkdown,
  publishedArticleDocumentSchema,
  publishedArticleRoute,
  publishedConsentBundleSchema,
  publishedManifestSchema,
  publishedSourceSchema,
  type Locale,
  type PublishedArticleDocument,
  type PublishedConsentBundle,
  type PublishedManifest,
  type PublishedManifestEntry,
} from "@wisdom/shared";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { getActiveConsentBundle } from "../consent/service.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

export interface PublicationPromotion {
  articleId: string;
  locale: Locale;
  revisionId: string;
  expectedRowVersion: number;
}

export interface PublicationSnapshot {
  readonly entries: readonly PublishedManifestEntry[];
  readonly documents: readonly PublishedArticleDocument[];
  readonly capturedAtMs: number;
  readonly promotions: readonly PublicationPromotion[];
  readonly baseReleaseId: string | null;
  readonly baseReleaseGeneration: number;
  readonly consentBundle: PublishedConsentBundle;
}

interface SnapshotRow {
  article_id: string;
  locale: Locale;
  slug: string;
  state: "approved" | "published";
  head_revision_id: string;
  approved_revision_id: string;
  published_revision_id: string | null;
  approved_at_ms: number;
  published_at_ms: number | null;
  row_version: number;
  title: string;
  summary: string;
  body_markdown: string;
  content_sha256: Buffer;
  sources_json: string;
  revision_created_at_ms: number;
  reviewer_name: string | null;
  source_locale: Locale;
  source_revision_id: string | null;
}

const localeOrder: Record<Locale, number> = {
  ko: 0,
  en: 1,
  "zh-Hans": 2,
  "zh-Hant": 3,
};

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezePublishedConsentBundle(bundle: PublishedConsentBundle): PublishedConsentBundle {
  for (const document of bundle.documents) Object.freeze(document);
  Object.freeze(bundle.documents);
  return Object.freeze(bundle);
}

function utcInstant(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("PUBLICATION_TIMESTAMP_INVALID");
  }
  return new Date(milliseconds).toISOString();
}

function promotionKey(input: Pick<PublicationPromotion, "articleId" | "locale">): string {
  return `${input.articleId}\0${input.locale}`;
}

function compareRows(left: SnapshotRow, right: SnapshotRow): number {
  return left.article_id.localeCompare(right.article_id)
    || localeOrder[left.locale] - localeOrder[right.locale]
    || left.slug.localeCompare(right.slug)
    || left.head_revision_id.localeCompare(right.head_revision_id);
}

function reviewerRole(locale: Locale): string {
  if (locale === "ko") return "대표행정사";
  if (locale === "en") return "Representative Administrative Attorney";
  return "代表行政士";
}

function selectSnapshotRow(
  db: ControlDatabase,
  articleId: string,
  locale: Locale,
): SnapshotRow | undefined {
  return db.sqlite.prepare(`
    SELECT
      head.article_id, head.locale, head.slug, head.state,
      head.head_revision_id, head.approved_revision_id,
      head.published_revision_id, head.approved_at_ms,
      head.published_at_ms, head.row_version,
      revision.title, revision.summary, revision.body_markdown,
      revision.content_sha256, revision.sources_json,
      revision.source_revision_id, article.source_locale,
      revision.created_at_ms AS revision_created_at_ms,
      admin.display_name AS reviewer_name
    FROM article_locale_heads head
    JOIN articles article ON article.id = head.article_id
    JOIN article_revisions revision
      ON revision.id = head.head_revision_id
      AND revision.article_id = head.article_id
      AND revision.locale = head.locale
    LEFT JOIN admins admin ON admin.id = head.approved_by_admin_id
    WHERE head.article_id = ? AND head.locale = ?
  `).get(articleId, locale) as SnapshotRow | undefined;
}

function firstPublicationTime(
  db: ControlDatabase,
  row: SnapshotRow,
  nowMs: number,
): number {
  const first = db.sqlite.prepare(`
    SELECT MIN(release.activated_at_ms) AS first_published_at_ms
    FROM release_entries entry
    JOIN releases release ON release.id = entry.release_id
    WHERE entry.article_id = ? AND entry.locale = ?
      AND release.activated_at_ms IS NOT NULL
      AND release.state IN ('active', 'retired')
  `).get(row.article_id, row.locale) as { first_published_at_ms: number | null };
  return first.first_published_at_ms ?? row.published_at_ms ?? nowMs;
}

function rowToDocument(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  row: SnapshotRow,
  nowMs: number,
): PublishedArticleDocument {
  if (!row.approved_revision_id || row.approved_revision_id !== row.head_revision_id) {
    throw new Error("PUBLICATION_APPROVAL_IDENTITY_INVALID");
  }
  if (!row.reviewer_name) throw new Error("PUBLICATION_REVIEWER_MISSING");
  if (row.state === "published" && row.published_revision_id !== row.head_revision_id) {
    throw new Error("PUBLICATION_PUBLISHED_IDENTITY_INVALID");
  }
  if (row.locale !== row.source_locale) {
    const sourceHead = db.sqlite.prepare(`
      SELECT state, head_revision_id, approved_revision_id
      FROM article_locale_heads
      WHERE article_id = ? AND locale = ?
    `).get(row.article_id, row.source_locale) as {
      state: string;
      head_revision_id: string;
      approved_revision_id: string | null;
    } | undefined;
    if (!sourceHead
      || !["approved", "published"].includes(sourceHead.state)
      || sourceHead.head_revision_id !== sourceHead.approved_revision_id
      || row.source_revision_id !== sourceHead.head_revision_id) {
      throw new Error("PUBLICATION_TRANSLATION_SOURCE_STALE");
    }
  }
  const sources = publishedSourceSchema.array().min(1).max(32)
    .parse(JSON.parse(row.sources_json))
    .sort((left, right) => left.id.localeCompare(right.id));
  const rendered = normalizeValidateAndRenderArticleMarkdown(row.body_markdown);
  const semantic = {
    title: row.title,
    summary: row.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    sources,
    locale: row.locale,
  } as const;
  const contentSha256 = computePublishedArticleContentSha256(semantic);
  if (!Buffer.from(contentSha256, "hex").equals(row.content_sha256)) {
    throw new Error("PUBLICATION_CONTENT_HASH_MISMATCH");
  }
  const pii = checkArticleForRetainedConsultationPii(db, keyProvider, [
    row.title,
    row.summary,
    rendered.bodyMarkdown,
    row.slug,
    publishedArticleRoute(row.locale, row.slug),
    ...sources.flatMap((source) => [source.id, source.url]),
  ]);
  if (!pii.safe) throw new Error("PUBLICATION_PII_REJECTED");

  const firstPublishedAtMs = firstPublicationTime(db, row, nowMs);
  const modifiedAtMs = row.state === "published"
    ? (row.published_at_ms ?? firstPublishedAtMs)
    : nowMs;
  return publishedArticleDocumentSchema.parse({
    schemaVersion: 1,
    articleId: row.article_id,
    locale: row.locale,
    slug: row.slug,
    revisionId: row.head_revision_id,
    contentSha256,
    route: publishedArticleRoute(row.locale, row.slug),
    title: row.title,
    summary: row.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    bodyHtml: rendered.bodyHtml,
    revisionCreatedAt: utcInstant(row.revision_created_at_ms),
    approvedAt: utcInstant(row.approved_at_ms),
    firstPublishedAt: utcInstant(firstPublishedAtMs),
    modifiedAt: utcInstant(Math.max(modifiedAtMs, row.approved_at_ms, firstPublishedAtMs)),
    reviewer: {
      name: row.reviewer_name,
      role: reviewerRole(row.locale),
    },
    sources,
  });
}

function captureInsideTransaction(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  input: { promote: readonly PublicationPromotion[]; nowMs: number },
): PublicationSnapshot {
  if (input.promote.length > 64) {
    throw new Error("PUBLICATION_PROMOTION_COUNT_INVALID");
  }
  const promotions = new Map<string, PublicationPromotion>();
  for (const promotion of input.promote) {
    const key = promotionKey(promotion);
    if (promotions.has(key)) throw new Error("PUBLICATION_PROMOTION_DUPLICATE");
    promotions.set(key, { ...promotion });
  }

  const rows = db.sqlite.prepare(`
    SELECT
      head.article_id, head.locale, head.slug, head.state,
      head.head_revision_id, head.approved_revision_id,
      head.published_revision_id, head.approved_at_ms,
      head.published_at_ms, head.row_version,
      revision.title, revision.summary, revision.body_markdown,
      revision.content_sha256, revision.sources_json,
      revision.source_revision_id, article.source_locale,
      revision.created_at_ms AS revision_created_at_ms,
      admin.display_name AS reviewer_name
    FROM article_locale_heads head
    JOIN articles article ON article.id = head.article_id
    JOIN article_revisions revision
      ON revision.id = head.head_revision_id
      AND revision.article_id = head.article_id
      AND revision.locale = head.locale
    LEFT JOIN admins admin ON admin.id = head.approved_by_admin_id
    WHERE head.state = 'published'
  `).all() as SnapshotRow[];
  const included = new Map(rows.map((row) => [promotionKey({
    articleId: row.article_id,
    locale: row.locale,
  }), row]));

  for (const promotion of promotions.values()) {
    const row = selectSnapshotRow(db, promotion.articleId, promotion.locale);
    if (!row) throw new Error("PUBLICATION_PROMOTION_NOT_FOUND");
    if (
      row.head_revision_id !== promotion.revisionId
      || row.row_version !== promotion.expectedRowVersion
    ) throw new Error("PUBLICATION_PROMOTION_CONFLICT");
    if (row.state !== "approved" || row.approved_revision_id !== promotion.revisionId) {
      throw new Error("PUBLICATION_PROMOTION_NOT_APPROVED");
    }
    included.set(promotionKey(promotion), row);
  }

  const documents = [...included.values()]
    .sort(compareRows)
    .map((row) => rowToDocument(db, keyProvider, row, input.nowMs));
  const entries = documents.map((document) => {
    const bytes = canonicalJson(document);
    return {
      articleId: document.articleId,
      locale: document.locale,
      slug: document.slug,
      revisionId: document.revisionId,
      contentSha256: document.contentSha256,
      route: document.route,
      contentFile: `articles/${document.revisionId}.json`,
      contentFileSha256: sha256Hex(bytes),
    } satisfies PublishedManifestEntry;
  });
  const activeConsentBundle = getActiveConsentBundle(db);
  if (!activeConsentBundle) throw new Error("PUBLICATION_CONSENT_BUNDLE_INVALID");
  let consentBundle: PublishedConsentBundle;
  try {
    consentBundle = publishedConsentBundleSchema.parse({
      schemaVersion: 1,
      bundleId: activeConsentBundle.bundleId,
      documents: (["ko", "en", "zh-Hans", "zh-Hant"] as const).flatMap((locale) => (
        (["privacy", "marketing"] as const).map((kind) => {
          const document = activeConsentBundle.documents.find((candidate) => (
            candidate.locale === locale && candidate.kind === kind
          ));
          if (!document || document.effectiveAtMs === undefined) {
            throw new Error("PUBLICATION_CONSENT_BUNDLE_INVALID");
          }
          return {
            kind,
            locale,
            version: document.version,
            title: document.title,
            bodyMarkdown: document.bodyMarkdown,
            contentSha256: document.contentSha256.toString("hex"),
            effectiveAt: utcInstant(document.effectiveAtMs),
            retentionMonths: document.retentionMonths,
            required: kind === "privacy",
          };
        })
      )),
    });
  } catch {
    throw new Error("PUBLICATION_CONSENT_BUNDLE_INVALID");
  }
  const consentPii = checkArticleForRetainedConsultationPii(
    db,
    keyProvider,
    consentBundle.documents.flatMap((document) => [document.title, document.bodyMarkdown]),
  );
  if (!consentPii.safe) throw new Error("PUBLICATION_CONSENT_PII_REJECTED");
  consentBundle = freezePublishedConsentBundle(consentBundle);
  const consentBytes = canonicalJson(consentBundle);
  const manifest = publishedManifestSchema.parse({
    schemaVersion: 1,
    entries,
    consentBundle: {
      contentFile: "consent-bundle.json",
      contentFileSha256: sha256Hex(consentBytes),
    },
  });
  const activeRelease = db.sqlite.prepare(`
    SELECT id, activation_generation FROM releases WHERE state = 'active'
  `).get() as { id: string; activation_generation: number } | undefined;
  return Object.freeze({
    entries: Object.freeze([...manifest.entries]),
    documents: Object.freeze([...documents]),
    capturedAtMs: input.nowMs,
    promotions: Object.freeze([...promotions.values()].map((promotion) => Object.freeze(promotion))),
    baseReleaseId: activeRelease?.id ?? null,
    baseReleaseGeneration: activeRelease?.activation_generation ?? 0,
    consentBundle,
  });
}

export function publicationSnapshotManifest(snapshot: PublicationSnapshot): PublishedManifest {
  const consentBytes = canonicalJson(publishedConsentBundleSchema.parse(snapshot.consentBundle));
  return publishedManifestSchema.parse({
    schemaVersion: 1,
    entries: snapshot.entries,
    consentBundle: {
      contentFile: "consent-bundle.json",
      contentFileSha256: sha256Hex(consentBytes),
    },
  });
}

export function capturePublicationSnapshot(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  input: { promote: readonly PublicationPromotion[]; nowMs: number },
): PublicationSnapshot {
  return db.sqlite.transaction(() => captureInsideTransaction(db, keyProvider, input)).immediate();
}

export function writePublicationSnapshot(
  snapshot: PublicationSnapshot,
  outputDirectory: string,
): void {
  const metadata = lstatSync(outputDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_SNAPSHOT_DIRECTORY_INVALID");
  }
  realpathSync(outputDirectory);
  if (readdirSync(outputDirectory).length !== 0) {
    throw new Error("PUBLICATION_SNAPSHOT_DIRECTORY_NOT_EMPTY");
  }
  const articlesDirectory = join(outputDirectory, "articles");
  mkdirSync(articlesDirectory, { mode: 0o700 });
  const manifest = publicationSnapshotManifest(snapshot);
  writeFileSync(
    join(outputDirectory, manifest.consentBundle.contentFile),
    canonicalJson(snapshot.consentBundle),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const byRevision = new Map(snapshot.documents.map((document) => [document.revisionId, document]));
  for (const entry of snapshot.entries) {
    const document = byRevision.get(entry.revisionId);
    if (!document) throw new Error("PUBLICATION_SNAPSHOT_DOCUMENT_MISSING");
    const bytes = canonicalJson(document);
    if (sha256Hex(bytes) !== entry.contentFileSha256) {
      throw new Error("PUBLICATION_SNAPSHOT_FILE_HASH_MISMATCH");
    }
    writeFileSync(join(outputDirectory, entry.contentFile), bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  writeFileSync(
    join(outputDirectory, "manifest.json"),
    canonicalJson(manifest),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}
