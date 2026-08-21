import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  computePublishedConsentDocumentSha256,
  consentVersionSchema,
  LOCALES,
  type Locale,
  type PublishedConsentBundle,
} from "@wisdom/shared";

import type { ControlDatabase } from "../db/client.js";
import {
  validateCanonicalConsentBundleRows,
  type ConsentBundleRow as ConsentRow,
} from "./bundle-validation.js";

export type ConsentKind = "privacy" | "marketing";

export interface ConsentDocumentSeed {
  bundleId: string;
  kind: ConsentKind;
  locale: Locale;
  version: string;
  title: string;
  bodyMarkdown: string;
  retentionMonths: 12 | 24;
}

export interface StoredConsentDocument extends ConsentDocumentSeed {
  id: string;
  contentSha256: Buffer;
  state: "draft" | "active" | "retired";
  effectiveAtMs?: number;
}

export interface ActiveConsentBundle {
  bundleId: string;
  documents: StoredConsentDocument[];
}

export type ConsentAuthority =
  | { source: "database"; bundle: PublishedConsentBundle }
  | {
      source: "release";
      releaseId: string;
      releaseManifestSha256: string;
      bundle: PublishedConsentBundle;
    };

export interface ConsentAuthorityRequest {
  releaseId?: string;
  nowMs?: number;
}

export type ConsentAuthorityResolver = (
  request?: ConsentAuthorityRequest,
) => ConsentAuthority | undefined;

function contentDigest(document: ConsentDocumentSeed): Buffer {
  return Buffer.from(computePublishedConsentDocumentSha256(document), "hex");
}

function assertSeed(document: ConsentDocumentSeed): void {
  if (!consentVersionSchema.safeParse(document.version).success) {
    throw new Error("Invalid consent document version");
  }
  if (
    (document.kind === "privacy" && document.retentionMonths !== 12) ||
    (document.kind === "marketing" && document.retentionMonths !== 24)
  ) {
    throw new Error("Invalid consent document retention");
  }
  if (
    !document.bundleId.trim() ||
    !document.title.trim() ||
    !document.bodyMarkdown.trim() ||
    !LOCALES.includes(document.locale) ||
    !["privacy", "marketing"].includes(document.kind) ||
    ![12, 24].includes(document.retentionMonths)
  ) {
    throw new Error("Invalid consent document seed");
  }
}

function toStored(row: ConsentRow): StoredConsentDocument {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    kind: row.kind,
    locale: row.locale,
    version: row.version,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    retentionMonths: row.retention_months,
    contentSha256: row.content_sha256,
    state: row.state,
    ...(row.effective_at_ms === null ? {} : { effectiveAtMs: row.effective_at_ms }),
  };
}

export function seedConsentDocuments(
  db: ControlDatabase,
  documents: readonly ConsentDocumentSeed[],
  createdAtMs = Date.now(),
): number {
  if (documents.length === 0) throw new Error("Consent seed requires a complete bundle");
  for (const document of documents) assertSeed(document);
  const identities = new Set(documents.map((document) => (
    `${document.bundleId}\0${document.kind}\0${document.locale}`
  )));
  if (identities.size !== documents.length) throw new Error("Duplicate consent document seed");

  const bundles = new Map<string, ConsentDocumentSeed[]>();
  for (const document of documents) {
    const bundle = bundles.get(document.bundleId) ?? [];
    bundle.push(document);
    bundles.set(document.bundleId, bundle);
  }
  for (const bundle of bundles.values()) {
    const pairs = new Set(bundle.map((document) => `${document.kind}\0${document.locale}`));
    if (
      bundle.length !== LOCALES.length * 2 ||
      pairs.size !== LOCALES.length * 2 ||
      !LOCALES.every((locale) => pairs.has(`privacy\0${locale}`) && pairs.has(`marketing\0${locale}`))
    ) {
      throw new Error("Consent seed requires every complete bundle to contain all eight documents");
    }
  }

  let inserted = 0;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const findBundle = db.sqlite.prepare(
      "SELECT * FROM consent_documents WHERE bundle_id = ? ORDER BY kind, locale",
    );
    const findVersion = db.sqlite.prepare(
      "SELECT bundle_id FROM consent_documents WHERE kind = ? AND locale = ? AND version = ?",
    );
    const insert = db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `);
    for (const [bundleId, bundle] of bundles) {
      const existingRows = findBundle.all(bundleId) as ConsentRow[];
      if (existingRows.length > 0) {
        const exactReseed = existingRows.length === LOCALES.length * 2 && bundle.every((document) => {
          const existing = existingRows.find((row) => (
            row.kind === document.kind && row.locale === document.locale
          ));
          const digest = contentDigest(document);
          return existing !== undefined
            && existing.version === document.version
            && existing.title === document.title
            && existing.body_markdown === document.bodyMarkdown
            && existing.retention_months === document.retentionMonths
            && existing.content_sha256.equals(digest);
        });
        if (!exactReseed) {
          throw new Error("CONSENT_BUNDLE_IMMUTABLE");
        }
        continue;
      }

      for (const document of bundle) {
        if (findVersion.get(document.kind, document.locale, document.version)) {
          throw new Error("CONSENT_DOCUMENT_IDENTITY_CONFLICT");
        }
      }
      for (const document of bundle) {
        insert.run(
          randomUUID(),
          document.bundleId,
          document.kind,
          document.locale,
          document.version,
          document.title,
          document.bodyMarkdown,
          contentDigest(document),
          document.retentionMonths,
          createdAtMs,
        );
        inserted += 1;
      }
    }
    db.sqlite.exec("COMMIT");
    return inserted;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function seedCompleteConsentBundles(
  db: ControlDatabase,
  documents: readonly ConsentDocumentSeed[],
  createdAtMs = Date.now(),
): number {
  return seedConsentDocuments(db, documents, createdAtMs);
}

function hasCompletePairs(rows: readonly ConsentRow[]): boolean {
  if (rows.length !== LOCALES.length * 2) return false;
  const pairs = new Set(rows.map((row) => `${row.kind}\0${row.locale}`));
  return pairs.size === LOCALES.length * 2 && LOCALES.every((locale) =>
    pairs.has(`privacy\0${locale}`) && pairs.has(`marketing\0${locale}`));
}

function digestRows(rows: readonly ConsentRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map((row) => ({
    kind: row.kind,
    locale: row.locale,
    version: row.version,
    contentSha256: row.content_sha256.toString("hex"),
  }))), "utf8").digest("hex");
}

export function getConsentBundleDigest(db: ControlDatabase, bundleId: string): string {
  const rows = db.sqlite.prepare(
    "SELECT * FROM consent_documents WHERE bundle_id = ? ORDER BY kind, locale, version",
  ).all(bundleId) as ConsentRow[];
  if (!hasCompletePairs(rows)) throw new Error("Consent digest requires a complete bundle");
  if (!validateCanonicalConsentBundleRows(rows)) {
    throw new Error("Consent digest requires canonical immutable documents");
  }
  return digestRows(rows);
}

export function activateConsentBundle(
  db: ControlDatabase,
  bundleId: string,
  effectiveAtMs = Date.now(),
  confirmSha?: string,
): void {
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const pendingPublication = db.sqlite.prepare(`
      SELECT 1 present FROM release_activations
      WHERE state IN ('prepared', 'switched') LIMIT 1
    `).get();
    if (pendingPublication) {
      throw new Error("CONSENT_ACTIVATION_BLOCKED_BY_PUBLICATION");
    }
    const rows = db.sqlite.prepare(
      "SELECT * FROM consent_documents WHERE bundle_id = ? ORDER BY kind, locale",
    ).all(bundleId) as ConsentRow[];
    if (!hasCompletePairs(rows)) throw new Error("Consent activation requires a complete bundle");
    if (rows.some((row) => (
      row.state !== "draft" || row.effective_at_ms !== null || row.retired_at_ms !== null
    ))) {
      throw new Error("CONSENT_BUNDLE_REACTIVATION_REJECTED");
    }
    if (!validateCanonicalConsentBundleRows(rows)) {
      throw new Error("Consent activation requires canonical immutable documents");
    }
    if (confirmSha !== undefined) {
      const actual = digestRows(rows);
      const suppliedBytes = Buffer.from(confirmSha, "hex");
      const actualBytes = Buffer.from(actual, "hex");
      if (
        !/^[a-f0-9]{64}$/.test(confirmSha) ||
        suppliedBytes.length !== actualBytes.length ||
        !timingSafeEqual(suppliedBytes, actualBytes)
      ) {
        throw new Error("Consent bundle digest confirmation does not match");
      }
    }
    db.sqlite.prepare(`
      UPDATE consent_documents
      SET state = 'retired', retired_at_ms = ?
      WHERE state = 'active'
    `).run(effectiveAtMs);
    const result = db.sqlite.prepare(`
      UPDATE consent_documents
      SET state = 'active', effective_at_ms = ?, retired_at_ms = NULL
      WHERE bundle_id = ? AND state = 'draft' AND effective_at_ms IS NULL
    `).run(effectiveAtMs, bundleId);
    if (result.changes !== LOCALES.length * 2) throw new Error("Consent activation was incomplete");
    db.sqlite.exec("COMMIT");
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function getActiveConsentBundle(db: ControlDatabase): ActiveConsentBundle | undefined {
  const rows = db.sqlite.prepare(
    "SELECT * FROM consent_documents WHERE state = 'active' ORDER BY kind, locale",
  ).all() as ConsentRow[];
  const validated = validateCanonicalConsentBundleRows(rows);
  if (!validated || validated.state !== "active") return undefined;
  return { bundleId: validated.bundle.bundleId, documents: rows.map(toStored) };
}

export function getActivePublishedConsentBundle(
  db: ControlDatabase,
): PublishedConsentBundle | undefined {
  const rows = db.sqlite.prepare(
    "SELECT * FROM consent_documents WHERE state = 'active' ORDER BY kind, locale",
  ).all() as ConsentRow[];
  return publishedConsentBundleFromRows(rows);
}

function publishedConsentBundleFromRows(
  rows: readonly ConsentRow[],
): PublishedConsentBundle | undefined {
  const validated = validateCanonicalConsentBundleRows(rows);
  return validated && validated.state !== "draft" ? validated.bundle : undefined;
}

export function getPublishedConsentBundleById(
  db: ControlDatabase,
  bundleId: string,
): PublishedConsentBundle | undefined {
  const rows = db.sqlite.prepare(
    "SELECT * FROM consent_documents WHERE bundle_id = ? ORDER BY kind, locale",
  ).all(bundleId) as ConsentRow[];
  return publishedConsentBundleFromRows(rows);
}

export function createDatabaseConsentAuthorityResolver(
  db: ControlDatabase,
): ConsentAuthorityResolver {
  return () => {
    const bundle = getActivePublishedConsentBundle(db);
    return bundle ? { source: "database", bundle } : undefined;
  };
}

export function publicConsentDocumentsFromBundle(
  bundle: PublishedConsentBundle,
  locale: Locale,
) {
  const privacy = bundle.documents.find((document) => (
    document.locale === locale && document.kind === "privacy"
  ));
  const marketing = bundle.documents.find((document) => (
    document.locale === locale && document.kind === "marketing"
  ));
  if (!privacy || !marketing) return undefined;
  const publicDocument = (document: typeof privacy) => ({
    version: document.version,
    title: document.title,
    bodyMarkdown: document.bodyMarkdown,
    contentSha256: document.contentSha256,
    effectiveAt: document.effectiveAt,
    retentionMonths: document.retentionMonths,
    required: document.required,
  });
  return {
    locale,
    documents: {
      privacy: publicDocument(privacy),
      marketing: publicDocument(marketing),
    },
  };
}

export function getPublicConsentDocuments(db: ControlDatabase, locale: Locale) {
  const bundle = getActivePublishedConsentBundle(db);
  return bundle ? publicConsentDocumentsFromBundle(bundle, locale) : undefined;
}
