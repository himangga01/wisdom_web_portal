import {
  CONSENT_KINDS,
  LOCALES,
  publishedConsentBundleSchema,
  type ConsentKind,
  type Locale,
  type PublishedConsentBundle,
} from "@wisdom/shared";

export type ConsentBundleLifecycleState = "draft" | "active" | "retired";

export interface ConsentBundleRow {
  id: string;
  bundle_id: string;
  kind: ConsentKind;
  locale: Locale;
  version: string;
  title: string;
  body_markdown: string;
  content_sha256: Buffer;
  retention_months: 12 | 24;
  state: ConsentBundleLifecycleState;
  effective_at_ms: number | null;
  retired_at_ms: number | null;
}

export interface ValidatedConsentBundleRows {
  state: ConsentBundleLifecycleState;
  effectiveAtMs: number | null;
  retiredAtMs: number | null;
  bundle: PublishedConsentBundle;
}

const DRAFT_VALIDATION_EFFECTIVE_AT = "1970-01-01T00:00:00.000Z";

function validInstant(value: number): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

export function validateCanonicalConsentBundleRows(
  rows: readonly ConsentBundleRow[],
): ValidatedConsentBundleRows | undefined {
  if (rows.length !== LOCALES.length * CONSENT_KINDS.length) return undefined;
  const bundleId = rows[0]?.bundle_id;
  const state = rows[0]?.state;
  if (!bundleId || !state || rows.some((row) => (
    row.bundle_id !== bundleId || row.state !== state
  ))) return undefined;

  let effectiveAtMs: number | null = null;
  let retiredAtMs: number | null = null;
  let effectiveAt = DRAFT_VALIDATION_EFFECTIVE_AT;
  if (state === "draft") {
    if (rows.some((row) => row.effective_at_ms !== null || row.retired_at_ms !== null)) {
      return undefined;
    }
  } else {
    effectiveAtMs = rows[0]!.effective_at_ms;
    if (effectiveAtMs === null || rows.some((row) => row.effective_at_ms !== effectiveAtMs)) {
      return undefined;
    }
    const instant = validInstant(effectiveAtMs);
    if (!instant) return undefined;
    effectiveAt = instant;
    if (state === "active") {
      if (rows.some((row) => row.retired_at_ms !== null)) return undefined;
    } else {
      retiredAtMs = rows[0]!.retired_at_ms;
      if (retiredAtMs === null || retiredAtMs < effectiveAtMs
        || rows.some((row) => row.retired_at_ms !== retiredAtMs)) {
        return undefined;
      }
      if (!validInstant(retiredAtMs)) return undefined;
    }
  }

  const documents = LOCALES.flatMap((locale) => CONSENT_KINDS.map((kind) => {
    const matches = rows.filter((row) => row.locale === locale && row.kind === kind);
    const row = matches.length === 1 ? matches[0] : undefined;
    if (!row || !Buffer.isBuffer(row.content_sha256)) return undefined;
    return {
      kind,
      locale,
      version: row.version,
      title: row.title,
      bodyMarkdown: row.body_markdown,
      contentSha256: row.content_sha256.toString("hex"),
      effectiveAt,
      retentionMonths: row.retention_months,
      required: kind === "privacy",
    };
  }));
  if (documents.some((document) => document === undefined)) return undefined;
  const parsed = publishedConsentBundleSchema.safeParse({
    schemaVersion: 1,
    bundleId,
    documents,
  });
  if (!parsed.success) return undefined;
  return { state, effectiveAtMs, retiredAtMs, bundle: parsed.data };
}
