import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { consentVersionSchema, LOCALES, type Locale } from "@wisdom/shared";

import type { ControlDatabase } from "../db/client.js";

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

interface ConsentRow {
  id: string;
  bundle_id: string;
  kind: ConsentKind;
  locale: Locale;
  version: string;
  title: string;
  body_markdown: string;
  content_sha256: Buffer;
  retention_months: 12 | 24;
  state: "draft" | "active" | "retired";
  effective_at_ms: number | null;
}

function contentDigest(document: ConsentDocumentSeed): Buffer {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: document.kind,
      locale: document.locale,
      version: document.version,
      title: document.title,
      bodyMarkdown: document.bodyMarkdown,
      retentionMonths: document.retentionMonths,
    }), "utf8")
    .digest();
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
  for (const document of documents) assertSeed(document);
  const identities = new Set(documents.map((document) => `${document.kind}\0${document.locale}\0${document.version}`));
  if (identities.size !== documents.length) throw new Error("Duplicate consent document seed");

  let inserted = 0;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const find = db.sqlite.prepare(
      "SELECT * FROM consent_documents WHERE kind = ? AND locale = ? AND version = ?",
    );
    const insert = db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `);
    for (const document of documents) {
      const digest = contentDigest(document);
      const existing = find.get(document.kind, document.locale, document.version) as ConsentRow | undefined;
      if (existing) {
        const unchanged =
          existing.bundle_id === document.bundleId &&
          existing.title === document.title &&
          existing.body_markdown === document.bodyMarkdown &&
          existing.retention_months === document.retentionMonths &&
          existing.content_sha256.equals(digest);
        if (!unchanged) throw new Error("Immutable consent document conflict");
        continue;
      }
      insert.run(
        randomUUID(),
        document.bundleId,
        document.kind,
        document.locale,
        document.version,
        document.title,
        document.bodyMarkdown,
        digest,
        document.retentionMonths,
        createdAtMs,
      );
      inserted += 1;
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
  if (documents.length === 0) throw new Error("Consent seed requires a complete bundle");
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
  return seedConsentDocuments(db, documents, createdAtMs);
}

function hasCompletePairs(rows: readonly ConsentRow[]): boolean {
  if (rows.length !== LOCALES.length * 2) return false;
  const pairs = new Set(rows.map((row) => `${row.kind}\0${row.locale}`));
  return pairs.size === LOCALES.length * 2 && LOCALES.every((locale) =>
    pairs.has(`privacy\0${locale}`) && pairs.has(`marketing\0${locale}`));
}

function hasRequiredRetention(rows: readonly ConsentRow[]): boolean {
  return rows.every((row) => row.retention_months === (row.kind === "privacy" ? 12 : 24));
}

function hasCanonicalVersions(rows: readonly ConsentRow[]): boolean {
  return rows.every((row) => consentVersionSchema.safeParse(row.version).success);
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
    const rows = db.sqlite.prepare(
      "SELECT * FROM consent_documents WHERE bundle_id = ? ORDER BY kind, locale",
    ).all(bundleId) as ConsentRow[];
    if (!hasCompletePairs(rows)) throw new Error("Consent activation requires a complete bundle");
    if (!hasRequiredRetention(rows)) throw new Error("Consent activation requires fixed retention roles");
    if (!hasCanonicalVersions(rows)) throw new Error("Consent activation requires canonical versions");
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
      WHERE bundle_id = ?
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
  if (!hasCompletePairs(rows) || !hasRequiredRetention(rows) || !hasCanonicalVersions(rows)) return undefined;
  const bundleId = rows[0]?.bundle_id;
  if (!bundleId || rows.some((row) => row.bundle_id !== bundleId)) return undefined;
  return { bundleId, documents: rows.map(toStored) };
}

export function getPublicConsentDocuments(db: ControlDatabase, locale: Locale) {
  const bundle = getActiveConsentBundle(db);
  if (!bundle) return undefined;
  const privacy = bundle.documents.find((document) => document.locale === locale && document.kind === "privacy");
  const marketing = bundle.documents.find((document) => document.locale === locale && document.kind === "marketing");
  if (!privacy || !marketing || privacy.effectiveAtMs === undefined || marketing.effectiveAtMs === undefined) {
    return undefined;
  }
  const publicDocument = (document: StoredConsentDocument, required: boolean) => ({
    version: document.version,
    title: document.title,
    bodyMarkdown: document.bodyMarkdown,
    contentSha256: document.contentSha256.toString("hex"),
    effectiveAt: new Date(document.effectiveAtMs!).toISOString(),
    retentionMonths: document.retentionMonths,
    required,
  });
  return {
    locale,
    documents: {
      privacy: publicDocument(privacy, true),
      marketing: publicDocument(marketing, false),
    },
  };
}
