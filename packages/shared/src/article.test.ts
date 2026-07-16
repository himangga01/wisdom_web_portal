import { describe, expect, it } from "vitest";

import * as articleModule from "./article.js";

interface RuntimeSchema {
  safeParse(input: unknown): { success: boolean };
}

const article = articleModule as unknown as Record<string, unknown>;

function schema(name: string): RuntimeSchema {
  expect(article[name], `${name} must be exported`).toBeDefined();
  return article[name] as RuntimeSchema;
}

const source = {
  id: "source-1",
  url: "https://example.com/guidance",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
};

describe("article pipeline contracts", () => {
  it("accepts a strict Hermes draft and rejects unsafe or non-canonical source input", () => {
    const draftSchema = schema("hermesArticleDraftSchema");
    const valid = {
      idempotencyKey: "hermes-draft-20260716-0001",
      hermesDraftId: "hermes_01JZZZZZZZZZZZZZZZZZZZZZZZ",
      sourceLocale: "ko",
      title: "공공조달 진입 전 확인사항",
      summary: "기업이 먼저 확인할 행정 절차를 정리합니다.",
      bodyMarkdown: "# 공공조달 진입 전 확인사항\n\n본문입니다.",
      sources: [source],
    };
    expect(draftSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, title: ` ${valid.title}` },
      { ...valid, sources: [{ ...source, url: "http://example.com/guidance" }] },
      { ...valid, sources: [{ ...source, url: "https://user@example.com/guidance" }] },
      { ...valid, sources: [{ ...source, url: "https://example.com/guidance#fragment" }] },
      { ...valid, sources: [{ ...source, sourceTimestamp: "16 July 2026" }] },
    ]) expect(draftSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires strict structured translation output with preserved source ids and findings", () => {
    const translationSchema = schema("articleTranslationOutputSchema");
    const valid = {
      locale: "en",
      title: "Checks before entering public procurement",
      summary: "A practical administrative overview.",
      bodyMarkdown: "# Checks before entering public procurement\n\nBody.",
      sourceIds: ["source-1"],
      reviewerFindings: [{
        code: "terminology",
        severity: "info",
        message: "Terminology checked against the source.",
      }],
    };
    expect(translationSchema.safeParse(valid).success).toBe(true);
    expect(translationSchema.safeParse({ ...valid, sourceIds: [] }).success).toBe(false);
    expect(translationSchema.safeParse({ ...valid, reasoning: "private chain of thought" }).success).toBe(false);
    expect(translationSchema.safeParse({ ...valid, locale: "fr" }).success).toBe(false);
  });

  it("validates the empty manifest and strict published entry/document shapes", () => {
    const manifestSchema = schema("publishedManifestSchema");
    const documentSchema = schema("publishedArticleDocumentSchema");
    const consentBundle = {
      contentFile: "consent-bundle.json",
      contentFileSha256: "a".repeat(64),
    };
    expect(manifestSchema.safeParse({ schemaVersion: 1, entries: [] }).success).toBe(false);
    expect(manifestSchema.safeParse({
      schemaVersion: 1,
      entries: [],
      consentBundle,
    }).success).toBe(true);
    const entry = {
      articleId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
      slug: "public-procurement-guide",
      revisionId: "22222222-2222-4222-8222-222222222222",
      contentSha256: "a".repeat(64),
      route: "/en/insights/public-procurement-guide",
      contentFile: "articles/22222222-2222-4222-8222-222222222222.json",
      contentFileSha256: "b".repeat(64),
    };
    expect(manifestSchema.safeParse({ schemaVersion: 1, entries: [entry], consentBundle }).success).toBe(true);
    expect(manifestSchema.safeParse({
      schemaVersion: 1, entries: [{ ...entry, route: "/insights/wrong-locale" }], consentBundle,
    }).success).toBe(false);
    expect(manifestSchema.safeParse({
      schemaVersion: 1, entries: [{ ...entry, contentFile: "../secret.json" }], consentBundle,
    }).success).toBe(false);
    expect(manifestSchema.safeParse({
      schemaVersion: 1, entries: [{ ...entry, articleId: "legacy-text-id" }], consentBundle,
    }).success).toBe(false);
    expect(manifestSchema.safeParse({ schemaVersion: 1, entries: [], consentBundle, extra: true }).success).toBe(false);

    const secondRevision = {
      ...entry,
      revisionId: "33333333-3333-4333-8333-333333333333",
      contentFile: "articles/33333333-3333-4333-8333-333333333333.json",
    };
    for (const duplicate of [
      secondRevision,
      { ...secondRevision, articleId: "44444444-4444-4444-8444-444444444444" },
      {
        ...secondRevision,
        articleId: "44444444-4444-4444-8444-444444444444",
        slug: "different-slug",
      },
    ]) expect(manifestSchema.safeParse({ schemaVersion: 1, entries: [entry, duplicate], consentBundle }).success).toBe(false);

    const document = {
      schemaVersion: 1,
      ...entry,
      title: "Public procurement guide",
      summary: "Practical administrative guidance.",
      bodyMarkdown: "# Public procurement guide\n\nBody.",
      bodyHtml: "<h1>Public procurement guide</h1><p>Body.</p>",
      revisionCreatedAt: "2026-07-16T00:00:00.000Z",
      approvedAt: "2026-07-16T01:00:00.000Z",
      firstPublishedAt: "2026-07-16T02:00:00.000Z",
      modifiedAt: "2026-07-16T02:00:00.000Z",
      reviewer: { name: "Jihye Kang", role: "Representative Administrative Attorney" },
      sources: [source],
    };
    delete (document as Partial<typeof entry>).contentFile;
    delete (document as Partial<typeof entry>).contentFileSha256;
    expect(documentSchema.safeParse(document).success).toBe(true);
    expect(documentSchema.safeParse({ ...document, approvedAt: "2026-07-15T23:00:00.000Z" }).success).toBe(false);
    expect(documentSchema.safeParse({
      ...document,
      revisionCreatedAt: "2026-07-17T00:00:00.000Z",
      approvedAt: "2026-07-17T01:00:00.000Z",
      firstPublishedAt: "2026-07-16T02:00:00.000Z",
      modifiedAt: "2026-07-17T02:00:00.000Z",
    }).success).toBe(true);
    expect(documentSchema.safeParse({ ...document, firstPublishedAt: "2026-07-16T03:00:00.000Z" }).success).toBe(false);
    expect(documentSchema.safeParse({ ...document, modifiedAt: "2026-07-16T01:30:00.000Z" }).success).toBe(false);
    expect(documentSchema.safeParse({ ...document, title: "😀".repeat(161) }).success).toBe(false);
    expect(documentSchema.safeParse({ ...document, bodyHtml: "x".repeat(512 * 1_024 + 1) }).success).toBe(false);
  });

  it("maps all four locales to exact canonical article routes", () => {
    const route = article.publishedArticleRoute as (locale: string, slug: string) => string;
    expect(route("ko", "guide")).toBe("/insights/guide");
    expect(route("en", "guide")).toBe("/en/insights/guide");
    expect(route("zh-Hans", "guide")).toBe("/zh-hans/insights/guide");
    expect(route("zh-Hant", "guide")).toBe("/zh-hant/insights/guide");
  });
});
