import { z } from "zod";

import { localeSchema, type Locale } from "./contracts.js";

const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase(), {
  message: "UUID must use canonical lowercase form",
});
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const slugSchema = z.string().min(1).max(96).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const utcInstantSchema = z.iso.datetime({ offset: true }).refine((value) => value.endsWith("Z"), {
  message: "Timestamp must be UTC",
});

function trimmedCodePointString(min: number, max: number) {
  return z.string().refine(
    (value) => value === value.trim() && [...value].length >= min && [...value].length <= max,
    { message: `Expected ${min}..${max} trimmed Unicode code points` },
  );
}

export function isXml10SafeText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09
      && codePoint !== 0x0a
      && codePoint !== 0x0d
      && (codePoint < 0x20
        || (codePoint > 0xd7ff && codePoint < 0xe000)
        || codePoint > 0xfffd && codePoint < 0x10000)
    ) return false;
  }
  return true;
}

function xmlSafeTrimmedCodePointString(min: number, max: number) {
  return trimmedCodePointString(min, max).refine(isXml10SafeText, {
    message: "Text contains a character forbidden by XML 1.0",
  });
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const canonicalHttpsUrlSchema = z.url().refine((value) => {
  if (!value.startsWith("https://") || value.includes("#") || /[\s\\]/.test(value)) return false;
  const authority = value.slice("https://".length).split("/", 1)[0]!;
  return authority.length > 0 && !authority.includes("@") && authority === authority.toLowerCase();
}, { message: "Expected a canonical credential-free HTTPS URL without a fragment" });

export const publishedSourceSchema = z.object({
  id: sourceIdSchema,
  url: canonicalHttpsUrlSchema,
  sourceTimestamp: utcInstantSchema,
}).strict();
export type PublishedSource = z.infer<typeof publishedSourceSchema>;

export const hermesArticleDraftSchema = z.object({
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  hermesDraftId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  sourceLocale: localeSchema,
  title: xmlSafeTrimmedCodePointString(1, 200),
  summary: xmlSafeTrimmedCodePointString(1, 500),
  bodyMarkdown: z.string().min(1).refine(
    (value) => utf8ByteLength(value) <= 240 * 1_024,
    { message: "Markdown exceeds the byte limit" },
  ),
  sources: z.array(publishedSourceSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const [index, source] of value.sources.entries()) {
    if (ids.has(source.id)) context.addIssue({
      code: "custom", path: ["sources", index, "id"], message: "Duplicate source ID",
    });
    if (urls.has(source.url)) context.addIssue({
      code: "custom", path: ["sources", index, "url"], message: "Duplicate source URL",
    });
    ids.add(source.id);
    urls.add(source.url);
  }
});
export type HermesArticleDraft = z.infer<typeof hermesArticleDraftSchema>;

export const articleReviewerFindingSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  severity: z.enum(["info", "warning", "error"]),
  message: trimmedCodePointString(1, 500),
}).strict();

export const articleTranslationOutputSchema = z.object({
  locale: localeSchema,
  title: xmlSafeTrimmedCodePointString(1, 200),
  summary: xmlSafeTrimmedCodePointString(1, 500),
  bodyMarkdown: z.string().min(1).refine(
    (value) => utf8ByteLength(value) <= 240 * 1_024,
    { message: "Markdown exceeds the byte limit" },
  ),
  sourceIds: z.array(sourceIdSchema).min(1).max(32),
  reviewerFindings: z.array(articleReviewerFindingSchema).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceIds).size !== value.sourceIds.length) context.addIssue({
    code: "custom", path: ["sourceIds"], message: "Source IDs must be unique",
  });
});
export type ArticleTranslationOutput = z.infer<typeof articleTranslationOutputSchema>;

const publishedManifestEntryBaseSchema = z.object({
  articleId: canonicalUuidSchema,
  locale: localeSchema,
  slug: slugSchema,
  revisionId: canonicalUuidSchema,
  contentSha256: sha256HexSchema,
  route: z.string().min(1).max(180),
  contentFile: z.string().min(1).max(180),
  contentFileSha256: sha256HexSchema,
}).strict();

export function publishedArticleRoute(locale: Locale, slug: string): string {
  const prefix = locale === "ko"
    ? ""
    : locale === "en"
      ? "/en"
      : locale === "zh-Hans" ? "/zh-hans" : "/zh-hant";
  return `${prefix}/insights/${slug}`;
}

export const publishedManifestEntrySchema = publishedManifestEntryBaseSchema.superRefine(
  (value, context) => {
    if (value.route !== publishedArticleRoute(value.locale, value.slug)) context.addIssue({
      code: "custom", path: ["route"], message: "Route does not match locale and slug",
    });
    if (value.contentFile !== `articles/${value.revisionId}.json`) context.addIssue({
      code: "custom", path: ["contentFile"], message: "Content file does not match revision",
    });
  },
);
export type PublishedManifestEntry = z.infer<typeof publishedManifestEntrySchema>;

export const publishedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(publishedManifestEntrySchema),
  consentBundle: z.object({
    contentFile: z.literal("consent-bundle.json"),
    contentFileSha256: sha256HexSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  const slugs = new Set<string>();
  const routes = new Set<string>();
  const revisions = new Set<string>();
  const files = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    const keys = [
      [identities, `${entry.articleId}\0${entry.locale}`, "Duplicate article locale"],
      [slugs, `${entry.locale}\0${entry.slug}`, "Duplicate locale slug"],
      [routes, entry.route, "Duplicate route"],
      [revisions, entry.revisionId, "Duplicate revision"],
      [files, entry.contentFile, "Duplicate content file"],
    ] as const;
    for (const [seen, key, message] of keys) {
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["entries", index], message });
      seen.add(key);
    }
  }
});
export type PublishedManifest = z.infer<typeof publishedManifestSchema>;

export const publishedReviewerSchema = z.object({
  name: xmlSafeTrimmedCodePointString(1, 100),
  role: xmlSafeTrimmedCodePointString(1, 100),
}).strict();

export const publishedArticleDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  articleId: canonicalUuidSchema,
  locale: localeSchema,
  slug: slugSchema,
  revisionId: canonicalUuidSchema,
  contentSha256: sha256HexSchema,
  route: z.string().min(1).max(180),
  title: xmlSafeTrimmedCodePointString(1, 160),
  summary: xmlSafeTrimmedCodePointString(1, 320),
  bodyMarkdown: z.string().min(1).refine(
    (value) => utf8ByteLength(value) <= 240 * 1_024,
    { message: "Published Markdown exceeds the byte limit" },
  ),
  bodyHtml: z.string().min(1).refine(
    (value) => utf8ByteLength(value) <= 512 * 1_024,
    { message: "Published HTML exceeds the byte limit" },
  ),
  revisionCreatedAt: utcInstantSchema,
  approvedAt: utcInstantSchema,
  firstPublishedAt: utcInstantSchema,
  modifiedAt: utcInstantSchema,
  reviewer: publishedReviewerSchema,
  sources: z.array(publishedSourceSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (value.route !== publishedArticleRoute(value.locale, value.slug)) context.addIssue({
    code: "custom", path: ["route"], message: "Route does not match locale and slug",
  });
  if (Date.parse(value.approvedAt) < Date.parse(value.revisionCreatedAt)) context.addIssue({
    code: "custom", path: ["approvedAt"], message: "Approval predates the revision",
  });
  if (Date.parse(value.modifiedAt) < Date.parse(value.approvedAt)) context.addIssue({
    code: "custom", path: ["modifiedAt"], message: "Modification predates approval",
  });
  if (Date.parse(value.modifiedAt) < Date.parse(value.firstPublishedAt)) context.addIssue({
    code: "custom", path: ["modifiedAt"], message: "Modification predates first publication",
  });
});
export type PublishedArticleDocument = z.infer<typeof publishedArticleDocumentSchema>;
