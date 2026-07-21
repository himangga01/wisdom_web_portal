import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { consentVersionSchema } from "./consultation.js";
import { LOCALES, localeSchema, type Locale } from "./contracts.js";

export const CONSENT_KINDS = ["privacy", "marketing"] as const;
export const consentKindSchema = z.enum(CONSENT_KINDS);
export type ConsentKind = z.infer<typeof consentKindSchema>;

export interface PublishedConsentDocumentHashInput {
  kind: ConsentKind;
  locale: Locale;
  version: string;
  title: string;
  bodyMarkdown: string;
  retentionMonths: 12 | 24;
}

export function computePublishedConsentDocumentSha256(
  document: PublishedConsentDocumentHashInput,
): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify({
      kind: document.kind,
      locale: document.locale,
      version: document.version,
      title: document.title,
      bodyMarkdown: document.bodyMarkdown,
      retentionMonths: document.retentionMonths,
    }))));
}

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nonBlankTextSchema = z.string().min(1).refine((value) => value.trim().length > 0);

export const publishedConsentDocumentSchema = z.object({
  kind: consentKindSchema,
  locale: localeSchema,
  version: consentVersionSchema,
  title: nonBlankTextSchema.max(200),
  bodyMarkdown: nonBlankTextSchema.max(32_000),
  contentSha256: sha256HexSchema,
  effectiveAt: z.iso.datetime({ offset: true }).refine(
    (value) => new Date(value).toISOString() === value,
    { message: "effectiveAt must be canonical UTC with milliseconds" },
  ),
  retentionMonths: z.union([z.literal(12), z.literal(24)]),
  required: z.boolean(),
}).strict().superRefine((value, context) => {
  const privacy = value.kind === "privacy";
  if (value.retentionMonths !== (privacy ? 12 : 24)) {
    context.addIssue({ code: "custom", path: ["retentionMonths"], message: "Retention does not match consent kind" });
  }
  if (value.required !== privacy) {
    context.addIssue({ code: "custom", path: ["required"], message: "Required flag does not match consent kind" });
  }
  if (value.contentSha256 !== computePublishedConsentDocumentSha256(value)) {
    context.addIssue({ code: "custom", path: ["contentSha256"], message: "Consent content hash mismatch" });
  }
});
export type PublishedConsentDocument = z.infer<typeof publishedConsentDocumentSchema>;

const expectedIdentityOrder = LOCALES.flatMap((locale) => (
  CONSENT_KINDS.map((kind) => `${kind}\0${locale}`)
));

export const publishedConsentBundleSchema = z.object({
  schemaVersion: z.literal(1),
  bundleId: nonBlankTextSchema.max(200),
  documents: z.array(publishedConsentDocumentSchema).length(LOCALES.length * CONSENT_KINDS.length),
}).strict().superRefine((value, context) => {
  const identities = value.documents.map(({ kind, locale }) => `${kind}\0${locale}`);
  if (identities.some((identity, index) => identity !== expectedIdentityOrder[index])) {
    context.addIssue({ code: "custom", path: ["documents"], message: "Consent documents are incomplete or not canonically ordered" });
  }
  const effectiveAt = value.documents[0]?.effectiveAt;
  if (!effectiveAt || value.documents.some((document) => document.effectiveAt !== effectiveAt)) {
    context.addIssue({ code: "custom", path: ["documents"], message: "Consent bundle effective time is inconsistent" });
  }
});
export type PublishedConsentBundle = z.infer<typeof publishedConsentBundleSchema>;
