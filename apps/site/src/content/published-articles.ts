import {
  computePublishedArticleContentSha256,
  normalizeValidateAndRenderArticleMarkdown,
  publishedArticleDocumentSchema,
  publishedConsentBundleSchema,
  publishedManifestSchema,
  type PublishedArticleDocument,
  type PublishedConsentBundle,
  type PublishedManifest,
  type PublishedManifestEntry,
} from "@wisdom/shared";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export interface PublishedContent {
  manifest: PublishedManifest;
  consentBundle: PublishedConsentBundle;
  articles: readonly PublishedArticleDocument[];
  byRoute: ReadonlyMap<string, PublishedArticleDocument>;
  byArticleId: ReadonlyMap<string, readonly PublishedArticleDocument[]>;
}

type PublishedEnvironment = Record<string, string | undefined>;

const manifestByteLimit = 1_048_576;
const articleByteLimit = 524_288;
const consentByteLimit = 131_072;
const aggregateArticleByteLimit = 16 * 1_048_576;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function publishedContentError(code: string, safePath: string): Error {
  return new Error(`PUBLISHED_CONTENT_${code}: ${safePath}`);
}

function parseCanonicalJson(
  bytes: Uint8Array,
  kind: "MANIFEST" | "ARTICLE" | "CONSENT",
  safePath: string,
): unknown {
  let text: string;
  let parsed: unknown;
  try {
    text = utf8Decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw publishedContentError(`${kind}_INVALID`, safePath);
  }
  if (text !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw publishedContentError(`${kind}_NOT_CANONICAL`, safePath);
  }
  return parsed;
}

function readConsentBundle(
  directory: string,
  realDirectory: string,
  manifest: PublishedManifest,
): PublishedConsentBundle {
  const safePath = manifest.consentBundle.contentFile;
  const path = join(directory, safePath);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw publishedContentError("CONSENT_MISSING", safePath);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw publishedContentError("CONSENT_INVALID", safePath);
  }
  if (metadata.size > consentByteLimit) {
    throw publishedContentError("CONSENT_TOO_LARGE", safePath);
  }
  let realFile: string;
  let bytes: Buffer;
  try {
    realFile = realpathSync(path);
    bytes = readFileSync(path);
  } catch {
    throw publishedContentError("CONSENT_INVALID", safePath);
  }
  const containment = relative(realDirectory, realFile);
  if (containment.startsWith("..") || isAbsolute(containment)) {
    throw publishedContentError("CONSENT_INVALID", safePath);
  }
  if (bytes.byteLength > consentByteLimit) {
    throw publishedContentError("CONSENT_TOO_LARGE", safePath);
  }
  if (createHash("sha256").update(bytes).digest("hex")
    !== manifest.consentBundle.contentFileSha256) {
    throw publishedContentError("CONSENT_HASH_MISMATCH", safePath);
  }
  const parsed = parseCanonicalJson(bytes, "CONSENT", safePath);
  const result = publishedConsentBundleSchema.safeParse(parsed);
  if (!result.success) throw publishedContentError("CONSENT_INVALID", safePath);
  return result.data;
}

export function resolveCheckedInPublishedContentDirectory(moduleUrl: string): string {
  let candidate = dirname(fileURLToPath(moduleUrl));
  while (true) {
    try {
      const packageJson = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === "@wisdom/site") return join(candidate, "published-content");
    } catch {
      // Continue walking to the package boundary. Operational paths never enter an error message.
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw publishedContentError("SITE_ROOT_NOT_FOUND", ".");
    candidate = parent;
  }
}

function readManifest(directory: string): PublishedManifest {
  const safePath = "manifest.json";
  const path = join(directory, safePath);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw publishedContentError("MANIFEST_MISSING", safePath);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw publishedContentError("MANIFEST_INVALID", safePath);
  }
  if (metadata.size > manifestByteLimit) {
    throw publishedContentError("MANIFEST_TOO_LARGE", safePath);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw publishedContentError("MANIFEST_INVALID", safePath);
  }
  if (bytes.byteLength > manifestByteLimit) {
    throw publishedContentError("MANIFEST_TOO_LARGE", safePath);
  }
  const parsed = parseCanonicalJson(bytes, "MANIFEST", safePath);
  const result = publishedManifestSchema.safeParse(parsed);
  if (!result.success) throw publishedContentError("MANIFEST_INVALID", safePath);
  for (let index = 1; index < result.data.entries.length; index += 1) {
    if (compareManifestEntries(result.data.entries[index - 1]!, result.data.entries[index]!) > 0) {
      throw publishedContentError("MANIFEST_NOT_SORTED", safePath);
    }
  }
  return result.data;
}

function readArticle(
  directory: string,
  realDirectory: string,
  entry: PublishedManifestEntry,
): PublishedArticleDocument {
  const safePath = entry.contentFile;
  const path = join(directory, safePath);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw publishedContentError("ARTICLE_MISSING", safePath);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw publishedContentError("ARTICLE_INVALID", safePath);
  }
  if (metadata.size > articleByteLimit) {
    throw publishedContentError("ARTICLE_TOO_LARGE", safePath);
  }
  let realFile: string;
  try {
    realFile = realpathSync(path);
  } catch {
    throw publishedContentError("ARTICLE_INVALID", safePath);
  }
  const containment = relative(realDirectory, realFile);
  if (containment.startsWith("..") || isAbsolute(containment)) {
    throw publishedContentError("ARTICLE_INVALID", safePath);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw publishedContentError("ARTICLE_INVALID", safePath);
  }
  if (bytes.byteLength > articleByteLimit) {
    throw publishedContentError("ARTICLE_TOO_LARGE", safePath);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== entry.contentFileSha256) {
    throw publishedContentError("ARTICLE_HASH_MISMATCH", safePath);
  }
  const parsed = parseCanonicalJson(bytes, "ARTICLE", safePath);
  const result = publishedArticleDocumentSchema.safeParse(parsed);
  if (!result.success) throw publishedContentError("ARTICLE_INVALID", safePath);
  if (
    result.data.articleId !== entry.articleId
    || result.data.locale !== entry.locale
    || result.data.slug !== entry.slug
    || result.data.revisionId !== entry.revisionId
    || result.data.contentSha256 !== entry.contentSha256
    || result.data.route !== entry.route
  ) {
    throw publishedContentError("ARTICLE_IDENTITY_MISMATCH", safePath);
  }
  let rendered;
  try {
    rendered = normalizeValidateAndRenderArticleMarkdown(result.data.bodyMarkdown);
  } catch {
    throw publishedContentError("ARTICLE_MARKDOWN_INVALID", safePath);
  }
  if (rendered.bodyMarkdown !== result.data.bodyMarkdown) {
    throw publishedContentError("ARTICLE_MARKDOWN_MISMATCH", safePath);
  }
  if (rendered.bodyHtml !== result.data.bodyHtml) {
    throw publishedContentError("ARTICLE_HTML_MISMATCH", safePath);
  }
  for (let index = 1; index < result.data.sources.length; index += 1) {
    if (result.data.sources[index - 1]!.id > result.data.sources[index]!.id) {
      throw publishedContentError("ARTICLE_SOURCES_NOT_SORTED", safePath);
    }
  }
  let semanticSha256: string;
  try {
    semanticSha256 = computePublishedArticleContentSha256({
      title: result.data.title,
      summary: result.data.summary,
      bodyMarkdown: result.data.bodyMarkdown,
      sources: result.data.sources,
      locale: result.data.locale,
    });
  } catch {
    throw publishedContentError("ARTICLE_CONTENT_INVALID", safePath);
  }
  if (semanticSha256 !== result.data.contentSha256) {
    throw publishedContentError("ARTICLE_CONTENT_HASH_MISMATCH", safePath);
  }
  return result.data;
}

function verifyArticleFileSizes(directory: string, manifest: PublishedManifest): void {
  let aggregateBytes = 0;
  for (const entry of manifest.entries) {
    let metadata;
    try {
      metadata = lstatSync(join(directory, entry.contentFile));
    } catch {
      throw publishedContentError("ARTICLE_MISSING", entry.contentFile);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw publishedContentError("ARTICLE_INVALID", entry.contentFile);
    }
    if (metadata.size > articleByteLimit) {
      throw publishedContentError("ARTICLE_TOO_LARGE", entry.contentFile);
    }
    aggregateBytes += metadata.size;
    if (aggregateBytes > aggregateArticleByteLimit) {
      throw publishedContentError("AGGREGATE_TOO_LARGE", "articles");
    }
  }
}

const localeOrder = { ko: 0, en: 1, "zh-Hans": 2, "zh-Hant": 3 } as const;

function compareManifestEntries(
  left: PublishedManifestEntry,
  right: PublishedManifestEntry,
): number {
  for (const comparison of [
    left.articleId < right.articleId ? -1 : left.articleId > right.articleId ? 1 : 0,
    localeOrder[left.locale] - localeOrder[right.locale],
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
    left.revisionId < right.revisionId ? -1 : left.revisionId > right.revisionId ? 1 : 0,
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function verifySnapshotInventory(directory: string, manifest: PublishedManifest): void {
  const rootEntries = readdirSync(directory, { withFileTypes: true });
  for (const entry of rootEntries) {
    const allowed = entry.name === "manifest.json" && entry.isFile()
      || entry.name === manifest.consentBundle.contentFile && entry.isFile()
      || entry.name === "articles" && entry.isDirectory();
    if (!allowed) throw publishedContentError("UNEXPECTED_FILE", entry.name);
  }

  const articlesDirectory = join(directory, "articles");
  let articleEntries;
  try {
    articleEntries = readdirSync(articlesDirectory, { withFileTypes: true });
  } catch {
    if (manifest.entries.length === 0) return;
    throw publishedContentError("ARTICLE_MISSING", manifest.entries[0]!.contentFile);
  }
  const expected = new Set(manifest.entries.map(({ contentFile }) => contentFile.slice("articles/".length)));
  for (const entry of articleEntries) {
    if (!entry.isFile() || !expected.has(entry.name)) {
      throw publishedContentError("UNEXPECTED_FILE", `articles/${entry.name}`);
    }
  }
}

class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #values: Map<Key, Value>;

  constructor(values: ReadonlyMap<Key, Value>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: Key): Value | undefined { return this.#values.get(key); }
  has(key: Key): boolean { return this.#values.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.#values.entries(); }
  keys(): MapIterator<Key> { return this.#values.keys(); }
  values(): MapIterator<Value> { return this.#values.values(); }
  forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void): void {
    for (const [key, value] of this.#values) callback(value, key, this);
  }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.entries(); }
  get [Symbol.toStringTag](): string { return "ReadonlyMap"; }
}

function freezeArticle(article: PublishedArticleDocument): PublishedArticleDocument {
  Object.freeze(article.reviewer);
  for (const source of article.sources) Object.freeze(source);
  Object.freeze(article.sources);
  return Object.freeze(article);
}

function freezeConsentBundle(bundle: PublishedConsentBundle): PublishedConsentBundle {
  for (const document of bundle.documents) Object.freeze(document);
  Object.freeze(bundle.documents);
  return Object.freeze(bundle);
}

export function resolvePublishedContentDirectory(
  environment: PublishedEnvironment = process.env,
): string {
  const override = environment.WISDOM_PUBLISHED_CONTENT_DIR;
  if (!override) return resolveCheckedInPublishedContentDirectory(import.meta.url);
  if (!isAbsolute(override)) throw new Error("PUBLISHED_CONTENT_DIRECTORY_NOT_ABSOLUTE");
  return override;
}

export function loadPublishedContent(directory: string): PublishedContent {
  let realDirectory: string;
  try {
    if (!statSync(directory).isDirectory()) {
      throw publishedContentError("DIRECTORY_INVALID", ".");
    }
    realDirectory = realpathSync(directory);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PUBLISHED_CONTENT_")) throw error;
    throw publishedContentError("DIRECTORY_INVALID", ".");
  }
  const manifest = readManifest(directory);
  verifySnapshotInventory(directory, manifest);
  const consentBundle = freezeConsentBundle(readConsentBundle(directory, realDirectory, manifest));
  verifyArticleFileSizes(directory, manifest);
  const articles = manifest.entries.map((entry) => freezeArticle(
    readArticle(directory, realDirectory, entry),
  ));
  const byRoute = new Map<string, PublishedArticleDocument>();
  const byArticleId = new Map<string, PublishedArticleDocument[]>();
  for (const article of articles) {
    byRoute.set(article.route, article);
    const related = byArticleId.get(article.articleId) ?? [];
    related.push(article);
    byArticleId.set(article.articleId, related);
  }
  for (const related of byArticleId.values()) Object.freeze(related);
  Object.freeze(articles);
  for (const entry of manifest.entries) Object.freeze(entry);
  Object.freeze(manifest.entries);
  Object.freeze(manifest);
  return {
    manifest,
    consentBundle,
    articles,
    byRoute: new ReadonlyMapView(byRoute),
    byArticleId: new ReadonlyMapView(byArticleId),
  };
}

export function loadBuildPublishedContent(
  environment: PublishedEnvironment = process.env,
): PublishedContent {
  return loadPublishedContent(resolvePublishedContentDirectory(environment));
}
