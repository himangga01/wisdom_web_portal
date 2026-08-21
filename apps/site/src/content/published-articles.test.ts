import type {
  PublishedArticleDocument,
  PublishedConsentBundle,
  PublishedManifest,
  PublishedManifestEntry,
} from "@wisdom/shared";
import {
  computePublishedArticleContentSha256,
  computePublishedConsentDocumentSha256,
  LOCALES,
  normalizeValidateAndRenderArticleMarkdown,
} from "@wisdom/shared";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadBuildPublishedContent,
  loadPublishedContent,
  resolvePublishedContentDirectory,
} from "./published-articles.js";

const temporaryDirectories: string[] = [];

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function semanticSha256(document: PublishedArticleDocument): string {
  return computePublishedArticleContentSha256({
    title: document.title,
    summary: document.summary,
    bodyMarkdown: document.bodyMarkdown,
    sources: document.sources,
    locale: document.locale,
  });
}

function validConsentBundle(): PublishedConsentBundle {
  return {
    schemaVersion: 1,
    bundleId: "bundle-2026-07-16",
    documents: LOCALES.flatMap((locale) => (["privacy", "marketing"] as const).map((kind) => {
      const semantic = {
        kind,
        locale,
        version: `${kind}-2026-07-16`,
        title: `${kind} ${locale}`,
        bodyMarkdown: kind === "privacy" && locale === "en"
          ? '<script>alert("text only")</script>\n\nExact privacy terms.'
          : `Exact ${kind} terms for ${locale}.`,
        retentionMonths: kind === "privacy" ? 12 as const : 24 as const,
      };
      return {
        ...semantic,
        contentSha256: computePublishedConsentDocumentSha256(semantic),
        effectiveAt: "2026-07-16T00:00:00.000Z",
        required: kind === "privacy",
      };
    })),
  };
}

function validDocument(
  overrides: Partial<PublishedArticleDocument> = {},
): PublishedArticleDocument {
  const requestedMarkdown = overrides.bodyMarkdown ?? "## 시작하기\n\n안전한 본문입니다.";
  const rendered = normalizeValidateAndRenderArticleMarkdown(requestedMarkdown);
  const document: PublishedArticleDocument = {
    schemaVersion: 1,
    articleId: "11111111-1111-4111-8111-111111111111",
    locale: "ko",
    slug: "procurement-basics",
    revisionId: "22222222-2222-4222-8222-222222222222",
    contentSha256: overrides.contentSha256 ?? "0".repeat(64),
    route: "/insights/procurement-basics",
    title: "조달 실무의 기초",
    summary: "공공조달 진입 전에 확인할 기본 사항을 정리합니다.",
    revisionCreatedAt: "2026-07-01T00:00:00.000Z",
    approvedAt: "2026-07-02T00:00:00.000Z",
    firstPublishedAt: "2026-07-03T00:00:00.000Z",
    modifiedAt: "2026-07-03T00:00:00.000Z",
    reviewer: { name: "강지혜", role: "대표행정사" },
    sources: [{
      id: "source-1",
      url: "https://example.test/procurement",
      sourceTimestamp: "2026-06-30T00:00:00.000Z",
    }],
    ...overrides,
    bodyMarkdown: rendered.bodyMarkdown,
    bodyHtml: overrides.bodyHtml ?? rendered.bodyHtml,
  };
  if (overrides.contentSha256 === undefined) {
    document.contentSha256 = semanticSha256(document);
  }
  return document;
}

function writeSnapshot(
  documents: readonly PublishedArticleDocument[],
  transformManifest?: (manifest: PublishedManifest) => unknown,
): string {
  const directory = mkdtempSync(join(tmpdir(), "wisdom-published-content-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "articles"));
  const consentBytes = `${JSON.stringify(validConsentBundle(), null, 2)}\n`;
  writeFileSync(join(directory, "consent-bundle.json"), consentBytes);
  const entries: PublishedManifestEntry[] = documents.map((document) => {
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    writeFileSync(join(directory, "articles", `${document.revisionId}.json`), bytes);
    return {
      articleId: document.articleId,
      locale: document.locale,
      slug: document.slug,
      revisionId: document.revisionId,
      contentSha256: document.contentSha256,
      route: document.route,
      contentFile: `articles/${document.revisionId}.json`,
      contentFileSha256: sha256(bytes),
    };
  });
  const manifest: PublishedManifest = {
    schemaVersion: 1,
    entries,
    consentBundle: {
      contentFile: "consent-bundle.json",
      contentFileSha256: sha256(consentBytes),
    },
  };
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify(transformManifest ? transformManifest(manifest) : manifest, null, 2)}\n`,
  );
  return directory;
}

function rewriteArticleBytes(
  directory: string,
  revisionId: string,
  bytes: string,
  updateManifestHash = true,
): void {
  writeFileSync(join(directory, "articles", `${revisionId}.json`), bytes);
  if (!updateManifestHash) return;
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishedManifest;
  const entry = manifest.entries.find((candidate) => candidate.revisionId === revisionId)!;
  entry.contentFileSha256 = sha256(bytes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("published article filesystem boundary", () => {
  it("fails closed unless the build receives an explicit absolute release snapshot", () => {
    expect(() => resolvePublishedContentDirectory({})).toThrow(
      /^PUBLISHED_CONTENT_DIRECTORY_REQUIRED$/,
    );
    expect(() => loadBuildPublishedContent({})).toThrow(
      /^PUBLISHED_CONTENT_DIRECTORY_REQUIRED$/,
    );
  });

  it("accepts only an absolute release snapshot directory override", () => {
    const directory = writeSnapshot([]);

    expect(resolvePublishedContentDirectory({ WISDOM_PUBLISHED_CONTENT_DIR: directory })).toBe(directory);
    expect(loadBuildPublishedContent({ WISDOM_PUBLISHED_CONTENT_DIR: directory }).articles).toEqual([]);
    expect(() => resolvePublishedContentDirectory({
      WISDOM_PUBLISHED_CONTENT_DIR: "relative/published-content",
    })).toThrow(/^PUBLISHED_CONTENT_DIRECTORY_NOT_ABSOLUTE$/);

    const regularFile = join(directory, "not-a-directory");
    writeFileSync(regularFile, "file");
    expect(() => loadPublishedContent(regularFile)).toThrow(
      /^PUBLISHED_CONTENT_DIRECTORY_INVALID: \.$/,
    );
  });

  it("loads, freezes, and indexes a valid immutable snapshot", () => {
    const article = validDocument();
    const directory = writeSnapshot([article]);

    const content = loadPublishedContent(directory);

    expect(content.articles).toEqual([article]);
    expect(content.byRoute.get(article.route)).toEqual(article);
    expect(content.byArticleId.get(article.articleId)).toEqual([article]);
    expect(Object.isFrozen(content.manifest)).toBe(true);
    expect(Object.isFrozen(content.manifest.entries)).toBe(true);
    expect(Object.isFrozen(content.articles)).toBe(true);
    expect(Object.isFrozen(content.articles[0])).toBe(true);
    expect(Object.isFrozen(content.articles[0]?.sources)).toBe(true);
    expect(Object.isFrozen(content.consentBundle)).toBe(true);
    expect(Object.isFrozen(content.consentBundle.documents)).toBe(true);
    expect("set" in content.byRoute).toBe(false);
    expect("set" in content.byArticleId).toBe(false);
  });

  it("fails closed on a missing, tampered, or semantically inconsistent consent bundle", () => {
    const missing = writeSnapshot([]);
    rmSync(join(missing, "consent-bundle.json"));
    expect(() => loadPublishedContent(missing)).toThrow(
      /^PUBLISHED_CONTENT_CONSENT_MISSING: consent-bundle\.json$/,
    );

    const tampered = writeSnapshot([]);
    writeFileSync(join(tampered, "consent-bundle.json"), "{}\n");
    expect(() => loadPublishedContent(tampered)).toThrow(
      /^PUBLISHED_CONTENT_CONSENT_HASH_MISMATCH: consent-bundle\.json$/,
    );

    const invalid = writeSnapshot([]);
    const path = join(invalid, "consent-bundle.json");
    const manifestPath = join(invalid, "manifest.json");
    const bundle = JSON.parse(readFileSync(path, "utf8")) as PublishedConsentBundle;
    bundle.documents[0]!.retentionMonths = 24;
    const bytes = `${JSON.stringify(bundle, null, 2)}\n`;
    writeFileSync(path, bytes);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishedManifest;
    manifest.consentBundle.contentFileSha256 = sha256(bytes);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => loadPublishedContent(invalid)).toThrow(
      /^PUBLISHED_CONTENT_CONSENT_INVALID: consent-bundle\.json$/,
    );
  });

  it("loads the tracked release fixture through every validation gate", () => {
    const directory = fileURLToPath(new URL("__fixtures__/published-content", import.meta.url));
    const content = loadPublishedContent(directory);

    expect(content.articles).toHaveLength(4);
    expect([...content.byRoute.keys()]).toEqual([
      "/en/insights/procurement-entry-guide",
      "/en/insights/visa-extension-checklist",
      "/insights/jodal-entry-guide",
      "/zh-hant/insights/caigou-ruzhu-zhinan",
    ]);
    expect(content.byRoute.has("/zh-hans/insights/procurement-entry-guide")).toBe(false);
  });

  it("orders Insights content by modified time and then canonical route", () => {
    const older = validDocument();
    const newer = validDocument({
      articleId: "33333333-3333-4333-8333-333333333333",
      revisionId: "44444444-4444-4444-8444-444444444444",
      slug: "newer-guidance",
      route: "/insights/newer-guidance",
      title: "더 최신인 실무 안내",
      modifiedAt: "2026-07-04T00:00:00.000Z",
    });
    const sameTimeLaterRoute = validDocument({
      articleId: "55555555-5555-4555-8555-555555555555",
      revisionId: "66666666-6666-4666-8666-666666666666",
      slug: "z-guidance",
      route: "/insights/z-guidance",
      title: "같은 시각의 두 번째 안내",
      modifiedAt: "2026-07-04T00:00:00.000Z",
    });
    const directory = writeSnapshot([older, newer, sameTimeLaterRoute]);

    expect(loadPublishedContent(directory).articles.map(({ route }) => route)).toEqual([
      "/insights/newer-guidance",
      "/insights/z-guidance",
      "/insights/procurement-basics",
    ]);
  });

  it("fails closed on missing, malformed, or oversized manifests without leaking host paths", () => {
    const missingDirectory = mkdtempSync(join(tmpdir(), "wisdom-published-content-"));
    temporaryDirectories.push(missingDirectory);
    expect(() => loadPublishedContent(missingDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_MISSING: manifest\.json$/,
    );

    const malformedDirectory = mkdtempSync(join(tmpdir(), "wisdom-published-content-"));
    temporaryDirectories.push(malformedDirectory);
    writeFileSync(join(malformedDirectory, "manifest.json"), "{not-json}\n");
    expect(() => loadPublishedContent(malformedDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_INVALID: manifest\.json$/,
    );

    const oversizedDirectory = mkdtempSync(join(tmpdir(), "wisdom-published-content-"));
    temporaryDirectories.push(oversizedDirectory);
    writeFileSync(join(oversizedDirectory, "manifest.json"), " ".repeat(1_048_577));
    expect(() => loadPublishedContent(oversizedDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_TOO_LARGE: manifest\.json$/,
    );
  });

  it("rejects non-canonical manifest order, duplicates, and extra metadata", () => {
    const korean = validDocument();
    const english = validDocument({
      locale: "en",
      slug: "procurement-guide",
      revisionId: "33333333-3333-4333-8333-333333333333",
      contentSha256: "b".repeat(64),
      route: "/en/insights/procurement-guide",
      title: "Procurement guide",
      summary: "A reviewed guide for entering public procurement.",
      bodyMarkdown: "## Start\n\nSafe English guidance.",
    });

    const unsortedDirectory = writeSnapshot([english, korean]);
    expect(() => loadPublishedContent(unsortedDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_NOT_SORTED: manifest\.json$/,
    );

    const duplicateDirectory = writeSnapshot([korean], (manifest) => ({
      ...manifest,
      entries: [...manifest.entries, manifest.entries[0]],
    }));
    expect(() => loadPublishedContent(duplicateDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_INVALID: manifest\.json$/,
    );

    const metadataDirectory = writeSnapshot([korean], (manifest) => ({
      ...manifest,
      generatedAt: "2026-07-16T00:00:00.000Z",
    }));
    expect(() => loadPublishedContent(metadataDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_INVALID: manifest\.json$/,
    );
  });

  it("requires canonical UTF-8 JSON bytes for manifests and revision artifacts", () => {
    const article = validDocument();

    const compactManifestDirectory = writeSnapshot([article]);
    const compactManifest = JSON.parse(
      readFileSync(join(compactManifestDirectory, "manifest.json"), "utf8"),
    );
    writeFileSync(join(compactManifestDirectory, "manifest.json"), JSON.stringify(compactManifest));
    expect(() => loadPublishedContent(compactManifestDirectory)).toThrow(
      /^PUBLISHED_CONTENT_MANIFEST_NOT_CANONICAL: manifest\.json$/,
    );

    const compactArticleDirectory = writeSnapshot([article]);
    rewriteArticleBytes(
      compactArticleDirectory,
      article.revisionId,
      JSON.stringify(article),
    );
    expect(() => loadPublishedContent(compactArticleDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_NOT_CANONICAL: articles/${article.revisionId}\\.json$`),
    );
  });

  it("rejects paths outside the approved immutable article namespace", () => {
    const article = validDocument();
    for (const contentFile of [
      `../${article.revisionId}.json`,
      `articles\\${article.revisionId}.json`,
      `C:/releases/${article.revisionId}.json`,
    ]) {
      const directory = writeSnapshot([article], (manifest) => ({
        ...manifest,
        entries: [{ ...manifest.entries[0], contentFile }],
      }));
      expect(() => loadPublishedContent(directory), contentFile).toThrow(
        /^PUBLISHED_CONTENT_MANIFEST_INVALID: manifest\.json$/,
      );
    }
  });

  it("rejects files that are not listed by the immutable manifest", () => {
    const article = validDocument();

    const extraRootFile = writeSnapshot([article]);
    writeFileSync(join(extraRootFile, "draft.json"), "{}\n");
    expect(() => loadPublishedContent(extraRootFile)).toThrow(
      /^PUBLISHED_CONTENT_UNEXPECTED_FILE: draft\.json$/,
    );

    const extraArticleFile = writeSnapshot([article]);
    writeFileSync(join(extraArticleFile, "articles", "unapproved.json"), "{}\n");
    expect(() => loadPublishedContent(extraArticleFile)).toThrow(
      /^PUBLISHED_CONTENT_UNEXPECTED_FILE: articles\/unapproved\.json$/,
    );
  });

  it("fails closed on missing, malformed, oversized, or linked article files", () => {
    const article = validDocument();

    const missingDirectory = writeSnapshot([article]);
    rmSync(join(missingDirectory, "articles", `${article.revisionId}.json`));
    expect(() => loadPublishedContent(missingDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_MISSING: articles/${article.revisionId}\\.json$`),
    );

    const malformedDirectory = writeSnapshot([article]);
    rewriteArticleBytes(malformedDirectory, article.revisionId, "{not-json}\n");
    expect(() => loadPublishedContent(malformedDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_INVALID: articles/${article.revisionId}\\.json$`),
    );

    const oversizedDirectory = writeSnapshot([article]);
    rewriteArticleBytes(oversizedDirectory, article.revisionId, "x".repeat(524_289));
    expect(() => loadPublishedContent(oversizedDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_TOO_LARGE: articles/${article.revisionId}\\.json$`),
    );

    const linkedDirectory = writeSnapshot([article]);
    const linkedPath = join(linkedDirectory, "articles", `${article.revisionId}.json`);
    const targetDirectory = mkdtempSync(join(tmpdir(), "wisdom-linked-article-"));
    temporaryDirectories.push(targetDirectory);
    const targetPath = join(targetDirectory, "linked-article.json");
    writeFileSync(targetPath, `${JSON.stringify(article, null, 2)}\n`);
    rmSync(linkedPath);
    try {
      symlinkSync(targetPath, linkedPath, "file");
      expect(() => loadPublishedContent(linkedDirectory)).toThrow(
        new RegExp(`^PUBLISHED_CONTENT_UNEXPECTED_FILE: articles/${article.revisionId}\\.json$`),
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    }
  });

  it("verifies raw article bytes against the manifest before parsing JSON", () => {
    const article = validDocument();
    const directory = writeSnapshot([article]);
    rewriteArticleBytes(directory, article.revisionId, "{not-json}\n", false);

    expect(() => loadPublishedContent(directory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_HASH_MISMATCH: articles/${article.revisionId}\\.json$`),
    );
  });

  it("re-renders normalized Markdown and requires byte-identical sanitized HTML", () => {
    const article = validDocument();

    const nonCanonicalMarkdownDirectory = writeSnapshot([article]);
    const nonCanonicalMarkdown = { ...article, bodyMarkdown: article.bodyMarkdown.trimEnd() };
    rewriteArticleBytes(
      nonCanonicalMarkdownDirectory,
      article.revisionId,
      `${JSON.stringify(nonCanonicalMarkdown, null, 2)}\n`,
    );
    expect(() => loadPublishedContent(nonCanonicalMarkdownDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_MARKDOWN_MISMATCH: articles/${article.revisionId}\\.json$`),
    );

    const mismatchedHtmlDirectory = writeSnapshot([article]);
    const mismatchedHtml = { ...article, bodyHtml: "<p>Different but safe HTML.</p>" };
    rewriteArticleBytes(
      mismatchedHtmlDirectory,
      article.revisionId,
      `${JSON.stringify(mismatchedHtml, null, 2)}\n`,
    );
    expect(() => loadPublishedContent(mismatchedHtmlDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_HTML_MISMATCH: articles/${article.revisionId}\\.json$`),
    );

    const unsafeMarkdownDirectory = writeSnapshot([article]);
    const unsafeMarkdown = {
      ...article,
      bodyMarkdown: "Before <script>private canary</script> after\n",
      bodyHtml: "<p>Before private canary after</p>",
    };
    rewriteArticleBytes(
      unsafeMarkdownDirectory,
      article.revisionId,
      `${JSON.stringify(unsafeMarkdown, null, 2)}\n`,
    );
    expect(() => loadPublishedContent(unsafeMarkdownDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_MARKDOWN_INVALID: articles/${article.revisionId}\\.json$`),
    );
  });

  it("recomputes the canonical semantic SHA over every approved content field", () => {
    const article = validDocument();
    const changedMarkdown = normalizeValidateAndRenderArticleMarkdown(
      "## 변경된 본문\n\n검수된 새 내용입니다.",
    );
    const koreanHash = article.contentSha256;
    const tamperedDocuments: PublishedArticleDocument[] = [
      { ...article, title: "변경된 제목" },
      { ...article, summary: "변경된 요약입니다." },
      { ...article, ...changedMarkdown },
      { ...article, sources: [{
        id: "source-2",
        url: "https://example.test/changed-source",
        sourceTimestamp: "2026-06-30T00:00:00.000Z",
      }] },
      validDocument({
        locale: "en",
        route: "/en/insights/procurement-basics",
        title: "Procurement basics",
        summary: "Reviewed procurement basics.",
        contentSha256: koreanHash,
      }),
    ];

    for (const tampered of tamperedDocuments) {
      const directory = writeSnapshot([tampered]);
      expect(() => loadPublishedContent(directory)).toThrow(
        new RegExp(`^PUBLISHED_CONTENT_ARTICLE_CONTENT_HASH_MISMATCH: articles/${tampered.revisionId}\\.json$`),
      );
    }
  });

  it("requires unique sources in canonical ID order", () => {
    const sourceA = {
      id: "a-source",
      url: "https://a.example.test/source",
      sourceTimestamp: "2026-06-29T00:00:00.000Z",
    };
    const sourceB = {
      id: "b-source",
      url: "https://b.example.test/source",
      sourceTimestamp: "2026-06-30T00:00:00.000Z",
    };
    const article = validDocument({ sources: [sourceA, sourceB] });

    const unsortedDirectory = writeSnapshot([{ ...article, sources: [sourceB, sourceA] }]);
    expect(() => loadPublishedContent(unsortedDirectory)).toThrow(
      new RegExp(`^PUBLISHED_CONTENT_ARTICLE_SOURCES_NOT_SORTED: articles/${article.revisionId}\\.json$`),
    );

    for (const sources of [
      [sourceA, sourceA],
      [sourceA, { ...sourceB, url: sourceA.url }],
    ]) {
      const duplicateDirectory = writeSnapshot([{ ...article, sources }]);
      expect(() => loadPublishedContent(duplicateDirectory)).toThrow(
        new RegExp(`^PUBLISHED_CONTENT_ARTICLE_CONTENT_INVALID: articles/${article.revisionId}\\.json$`),
      );
    }
  });

  it("requires every document identity field to equal its manifest entry", () => {
    const article = validDocument();
    const mismatches: PublishedArticleDocument[] = [
      validDocument({ articleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      validDocument({ revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      validDocument({ contentSha256: "b".repeat(64) }),
      validDocument({ locale: "en", route: "/en/insights/procurement-basics" }),
      validDocument({ slug: "different-slug", route: "/insights/different-slug" }),
    ];

    for (const mismatch of mismatches) {
      const directory = writeSnapshot([article]);
      rewriteArticleBytes(
        directory,
        article.revisionId,
        `${JSON.stringify(mismatch, null, 2)}\n`,
      );
      expect(() => loadPublishedContent(directory)).toThrow(
        new RegExp(`^PUBLISHED_CONTENT_ARTICLE_IDENTITY_MISMATCH: articles/${article.revisionId}\\.json$`),
      );
    }
  });

  it("caps aggregate article bytes at sixteen mebibytes", () => {
    const documents = Array.from({ length: 33 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      const slug = `aggregate-${String(index + 1).padStart(2, "0")}`;
      return validDocument({
        articleId: `10000000-0000-4000-8000-${suffix}`,
        revisionId: `20000000-0000-4000-8000-${suffix}`,
        slug,
        route: `/insights/${slug}`,
        contentSha256: (index + 1).toString(16).padStart(64, "0"),
        title: `집계 한도 문서 ${index + 1}`,
        bodyHtml: "x".repeat(508_000),
        sources: [{
          id: `source-${index + 1}`,
          url: `https://example.test/source-${index + 1}`,
          sourceTimestamp: "2026-06-30T00:00:00.000Z",
        }],
      });
    });
    const directory = writeSnapshot(documents);

    expect(() => loadPublishedContent(directory)).toThrow(
      /^PUBLISHED_CONTENT_AGGREGATE_TOO_LARGE: articles$/,
    );
  });
});
