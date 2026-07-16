import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

import { publishedSourceSchema } from "./article.js";
import { normalizeValidateAndRenderArticleMarkdown } from "./article-markdown.js";
import { localeSchema } from "./contracts.js";

export const publishedArticleSemanticContentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(320),
  bodyMarkdown: z.string().min(1),
  sources: z.array(publishedSourceSchema).min(1).max(32),
  locale: localeSchema,
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

export type PublishedArticleSemanticContent = z.infer<typeof publishedArticleSemanticContentSchema>;

export function canonicalPublishedArticleContentBytes(input: unknown): Uint8Array {
  const parsed = publishedArticleSemanticContentSchema.parse(input);
  const { bodyMarkdown } = normalizeValidateAndRenderArticleMarkdown(parsed.bodyMarkdown);
  const sources = [...parsed.sources].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  const canonicalJson = JSON.stringify({
    title: parsed.title.normalize("NFC"),
    summary: parsed.summary.normalize("NFC"),
    bodyMarkdown,
    sources,
    locale: parsed.locale,
  });
  return utf8ToBytes(canonicalJson);
}

export function computePublishedArticleContentSha256(input: unknown): string {
  return bytesToHex(sha256(canonicalPublishedArticleContentBytes(input)));
}
