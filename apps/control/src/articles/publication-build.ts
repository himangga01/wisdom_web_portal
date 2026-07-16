import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { publishedManifestSchema, type Locale } from "@wisdom/shared";

import type { PublicationSnapshot } from "./publication-snapshot.js";

const RELEASE_MANIFEST_NAME = ".wisdom-release-manifest.json";
const MAX_RELEASE_MANIFEST_BYTES = 2 * 1_048_576;
const MAX_RELEASE_FILE_BYTES = 16 * 1_048_576;
const MAX_RELEASE_BYTES = 256 * 1_048_576;
const LAUNCH_LOCALES = new Set<Locale>(["ko", "en", "zh-Hans", "zh-Hant"]);

export interface PublicationProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  stdoutLimit: number;
  stderrLimit: number;
}

export interface PublicationProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PublicationBuildDependencies {
  runProcess(request: PublicationProcessRequest): Promise<PublicationProcessResult>;
}

export interface PublicationReleaseManifest {
  schemaVersion: 1;
  snapshotManifestSha256: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

export interface SealedPublicationRelease {
  manifest: PublicationReleaseManifest;
  manifestSha256: string;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireAbsolutePath(value: string, code: string): void {
  if (!isAbsolute(value)) throw new Error(code);
}

function requireRealDirectory(value: string, code: string, allowSymlink = false): string {
  requireAbsolutePath(value, code);
  const metadata = lstatSync(value);
  if ((!metadata.isDirectory() && !(allowSymlink && metadata.isSymbolicLink()))
    || (!allowSymlink && metadata.isSymbolicLink())) throw new Error(code);
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory()) throw new Error(code);
  return resolved;
}

async function defaultRunProcess(request: PublicationProcessRequest): Promise<PublicationProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const append = (chunks: Buffer[], chunk: Buffer, used: number, limit: number): number => {
      if (used >= limit) return used;
      const accepted = chunk.subarray(0, Math.max(0, limit - used));
      if (accepted.byteLength > 0) chunks.push(accepted);
      return used + accepted.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes, request.stdoutLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes, request.stderrLimit);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("PUBLICATION_BUILD_TIMEOUT"));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function runPublicationBuild(
  input: {
    siteSourceRoot: string;
    snapshotDirectory: string;
    outputDirectory: string;
    buildHome: string;
    npmBinary: string;
    nodeBinary: string;
    timeoutMs: number;
  },
  dependencies: PublicationBuildDependencies = { runProcess: defaultRunProcess },
): Promise<void> {
  const siteSourceRoot = requireRealDirectory(
    input.siteSourceRoot,
    "PUBLICATION_SITE_ROOT_INVALID",
    true,
  );
  const snapshotDirectory = requireRealDirectory(
    input.snapshotDirectory,
    "PUBLICATION_SNAPSHOT_ROOT_INVALID",
  );
  const buildHome = requireRealDirectory(input.buildHome, "PUBLICATION_BUILD_HOME_INVALID");
  requireAbsolutePath(input.outputDirectory, "PUBLICATION_OUTPUT_PATH_INVALID");
  requireAbsolutePath(input.npmBinary, "PUBLICATION_NPM_BINARY_INVALID");
  requireAbsolutePath(input.nodeBinary, "PUBLICATION_NODE_BINARY_INVALID");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 30 * 60_000) {
    throw new Error("PUBLICATION_BUILD_TIMEOUT_INVALID");
  }
  try {
    lstatSync(input.outputDirectory);
    throw new Error("PUBLICATION_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "PUBLICATION_OUTPUT_ALREADY_EXISTS") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const result = await dependencies.runProcess({
    command: input.npmBinary,
    args: [
      "run", "build", "--workspace", "@wisdom/site", "--",
      "--outDir", input.outputDirectory,
    ],
    cwd: siteSourceRoot,
    env: {
      CI: "1",
      HOME: buildHome,
      NODE_ENV: "production",
      NO_COLOR: "1",
      PATH: dirname(input.nodeBinary),
      WISDOM_PUBLISHED_CONTENT_DIR: snapshotDirectory,
    },
    timeoutMs: input.timeoutMs,
    stdoutLimit: 65_536,
    stderrLimit: 65_536,
  });
  if (result.exitCode !== 0) throw new Error("PUBLICATION_BUILD_FAILED");
}

interface InventoryFile {
  path: string;
  absolutePath: string;
  bytes: Buffer;
}

function inventoryFiles(root: string, includeManifest: boolean): InventoryFile[] {
  requireRealDirectory(root, "PUBLICATION_RELEASE_DIRECTORY_INVALID");
  const realRoot = realpathSync(root);
  const files: InventoryFile[] = [];
  let aggregateBytes = 0;
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const safePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error("PUBLICATION_RELEASE_SYMLINK_REJECTED");
      if (metadata.isDirectory()) {
        visit(absolutePath, safePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error("PUBLICATION_RELEASE_SPECIAL_FILE_REJECTED");
      if (!includeManifest && safePath === RELEASE_MANIFEST_NAME) {
        throw new Error("PUBLICATION_RELEASE_ALREADY_SEALED");
      }
      if (metadata.size > MAX_RELEASE_FILE_BYTES) throw new Error("PUBLICATION_RELEASE_FILE_TOO_LARGE");
      const realFile = realpathSync(absolutePath);
      const containment = relative(realRoot, realFile);
      if (containment.startsWith(`..${sep}`) || containment === ".." || isAbsolute(containment)) {
        throw new Error("PUBLICATION_RELEASE_PATH_ESCAPE");
      }
      const bytes = readFileSync(absolutePath);
      aggregateBytes += bytes.byteLength;
      if (aggregateBytes > MAX_RELEASE_BYTES) throw new Error("PUBLICATION_RELEASE_TOO_LARGE");
      files.push({ path: safePath.replaceAll("\\", "/"), absolutePath, bytes });
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function routeFile(route: string): string {
  if (route === "/") return "index.html";
  const pathname = route.replace(/^\/+|\/+$/g, "");
  return `${pathname}/index.html`;
}

function existingPublicTarget(files: ReadonlySet<string>, href: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(href, "https://public.invalid").pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith("/") || pathname.includes("\\")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.split("/").includes("..")) return false;
  const relativePath = decoded.replace(/^\/+/, "");
  if (!relativePath) return files.has("index.html");
  return files.has(relativePath)
    || files.has(`${relativePath.replace(/\/+$/, "")}/index.html`)
    || files.has(`${relativePath}.html`);
}

function verifyInternalLinks(files: readonly InventoryFile[]): void {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files.filter(({ path }) => path.endsWith(".html"))) {
    const html = file.bytes.toString("utf8");
    for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
      const href = match[1]!;
      if (href.startsWith("//")) throw new Error("PUBLICATION_INTERNAL_LINK_BROKEN");
      if (!href.startsWith("/")) continue;
      if (!existingPublicTarget(paths, href)) throw new Error("PUBLICATION_INTERNAL_LINK_BROKEN");
    }
  }
}

function verifyInternalAssets(files: readonly InventoryFile[]): void {
  const paths = new Set(files.map((file) => file.path));
  const verifyReference = (reference: string): void => {
    const normalized = reference.trim();
    if (normalized.startsWith("//")) throw new Error("PUBLICATION_INTERNAL_ASSET_BROKEN");
    if (!normalized.startsWith("/")) return;
    if (!existingPublicTarget(paths, normalized)) {
      throw new Error("PUBLICATION_INTERNAL_ASSET_BROKEN");
    }
  };
  const verifySrcset = (srcset: string): void => {
    for (const candidate of srcset.split(",")) {
      const reference = candidate.trim().split(/\s+/u, 1)[0];
      if (reference) verifyReference(reference);
    }
  };
  for (const file of files.filter(({ path }) => path.endsWith(".html"))) {
    const html = file.bytes.toString("utf8");
    for (const match of html.matchAll(/<(img|script|source|video|audio|iframe|link)\b[^>]*>/giu)) {
      const tagName = match[1]!.toLowerCase();
      const attributes = linkAttributes(match[0]);
      if (tagName === "link") {
        const href = attributes.get("href");
        if (href) verifyReference(href);
        continue;
      }
      for (const name of tagName === "video" ? ["src", "poster"] : ["src"]) {
        const reference = attributes.get(name);
        if (reference) verifyReference(reference);
      }
      if (tagName === "img" || tagName === "source") {
        const srcset = attributes.get("srcset");
        if (srcset) verifySrcset(srcset);
      }
    }
  }
}

function linkAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*["']([^"']*)["']/gu)) {
    attributes.set(match[1]!.toLowerCase(), match[2]!);
  }
  return attributes;
}

function verifyArticles(
  files: readonly InventoryFile[],
  snapshot: PublicationSnapshot,
  publicOrigin: string,
): void {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const localesByArticle = new Map<string, Set<Locale>>();
  for (const document of snapshot.documents) {
    const locales = localesByArticle.get(document.articleId) ?? new Set<Locale>();
    locales.add(document.locale);
    localesByArticle.set(document.articleId, locales);
  }
  for (const document of snapshot.documents) {
    const page = fileByPath.get(routeFile(document.route));
    if (!page) throw new Error("PUBLICATION_ARTICLE_ROUTE_MISSING");
    const html = page.bytes.toString("utf8");
    if (!html.includes(document.bodyHtml)) throw new Error("PUBLICATION_ARTICLE_BODY_MISMATCH");
    if (/\b(?:href|src)\s*=\s*["']\s*javascript:/iu.test(html)
      || /\son[a-z]+\s*=/iu.test(html)) {
      throw new Error("PUBLICATION_ARTICLE_HTML_UNSAFE");
    }
    const canonicalTags = [...html.matchAll(/<link\b[^>]*>/giu)].filter((match) => {
      const rel = new Set((linkAttributes(match[0]).get("rel") ?? "")
        .toLowerCase().split(/\s+/u).filter(Boolean));
      return rel.has("canonical");
    });
    if (canonicalTags.length !== 1) throw new Error("PUBLICATION_CANONICAL_INVALID");
    const canonicalHref = linkAttributes(canonicalTags[0]![0]).get("href");
    if (canonicalHref !== `${publicOrigin}${document.route}`) {
      throw new Error("PUBLICATION_CANONICAL_INVALID");
    }
    const expectedDocuments = new Map(
      snapshot.documents
        .filter(({ articleId }) => articleId === document.articleId)
        .map((candidate) => [candidate.locale, candidate]),
    );
    const actualLocales = new Set<Locale>();
    let sawXDefault = false;
    for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
      const attributes = linkAttributes(match[0]);
      const hreflang = attributes.get("hreflang");
      if (!hreflang) continue;
      const rel = new Set((attributes.get("rel") ?? "").toLowerCase().split(/\s+/u).filter(Boolean));
      if (!rel.has("alternate")) throw new Error("PUBLICATION_HREFLANG_REL_INVALID");
      const href = attributes.get("href");
      if (!href || href.startsWith("//")) throw new Error("PUBLICATION_HREFLANG_TARGET_MISMATCH");
      let target: URL;
      try {
        target = new URL(href, "https://public.invalid");
      } catch {
        throw new Error("PUBLICATION_HREFLANG_TARGET_MISMATCH");
      }
      if (!["http:", "https:"].includes(target.protocol)
        || target.origin !== publicOrigin || target.search || target.hash) {
        throw new Error("PUBLICATION_HREFLANG_TARGET_MISMATCH");
      }
      if (hreflang === "x-default") {
        const korean = expectedDocuments.get("ko");
        if (!korean) throw new Error("PUBLICATION_HREFLANG_LEAK");
        if (sawXDefault) throw new Error("PUBLICATION_HREFLANG_DUPLICATE");
        if (target.pathname !== korean.route) {
          throw new Error("PUBLICATION_HREFLANG_TARGET_MISMATCH");
        }
        sawXDefault = true;
        continue;
      }
      if (!LAUNCH_LOCALES.has(hreflang as Locale)) throw new Error("PUBLICATION_HREFLANG_INVALID");
      const locale = hreflang as Locale;
      const alternate = expectedDocuments.get(locale);
      if (!alternate) throw new Error("PUBLICATION_HREFLANG_LEAK");
      if (actualLocales.has(locale)) throw new Error("PUBLICATION_HREFLANG_DUPLICATE");
      if (target.pathname !== alternate.route) {
        throw new Error("PUBLICATION_HREFLANG_TARGET_MISMATCH");
      }
      actualLocales.add(locale);
    }
    const expectedLocales = localesByArticle.get(document.articleId)!;
    for (const locale of expectedLocales) {
      if (!actualLocales.has(locale)) throw new Error("PUBLICATION_HREFLANG_MISSING");
    }
    if (expectedLocales.has("ko") !== sawXDefault) {
      throw new Error(expectedLocales.has("ko")
        ? "PUBLICATION_HREFLANG_MISSING"
        : "PUBLICATION_HREFLANG_LEAK");
    }
  }
}

export function computePublicationSnapshotManifestSha256(snapshot: PublicationSnapshot): string {
  const manifest = publishedManifestSchema.parse({ schemaVersion: 1, entries: snapshot.entries });
  return sha256Hex(canonicalJson(manifest));
}

function parseReleaseManifest(bytes: Buffer): PublicationReleaseManifest {
  if (bytes.byteLength > MAX_RELEASE_MANIFEST_BYTES) throw new Error("PUBLICATION_RELEASE_MANIFEST_TOO_LARGE");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("PUBLICATION_RELEASE_MANIFEST_INVALID");
  }
  if (bytes.toString("utf8") !== canonicalJson(value)) {
    throw new Error("PUBLICATION_RELEASE_MANIFEST_NOT_CANONICAL");
  }
  const record = value as Partial<PublicationReleaseManifest>;
  if (Object.keys(record).sort().join("\0") !== "files\0schemaVersion\0snapshotManifestSha256"
    || record.schemaVersion !== 1
    || typeof record.snapshotManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.snapshotManifestSha256)
    || !Array.isArray(record.files)) {
    throw new Error("PUBLICATION_RELEASE_MANIFEST_INVALID");
  }
  const seen = new Set<string>();
  let previous = "";
  for (const file of record.files) {
    if (!file || typeof file !== "object"
      || Object.keys(file).sort().join("\0") !== "path\0sha256\0size"
      || typeof file.path !== "string"
      || file.path.length < 1 || file.path.startsWith("/") || file.path.includes("\\")
      || file.path.split("/").some((part) => !part || part === "." || part === "..")
      || file.path === RELEASE_MANIFEST_NAME
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_RELEASE_FILE_BYTES
      || seen.has(file.path) || (previous && previous.localeCompare(file.path) >= 0)) {
      throw new Error("PUBLICATION_RELEASE_MANIFEST_INVALID");
    }
    seen.add(file.path);
    previous = file.path;
  }
  return record as PublicationReleaseManifest;
}

export function verifyAndSealPublicationBuild(input: {
  outputDirectory: string;
  snapshot: PublicationSnapshot;
  requiredCoreRoutes: readonly string[];
  forbiddenCanaries: readonly string[];
  publicOrigin: string;
}): SealedPublicationRelease {
  const origin = new URL(input.publicOrigin);
  if (origin.origin !== input.publicOrigin || origin.username || origin.password) {
    throw new Error("PUBLICATION_ORIGIN_INVALID");
  }
  const files = inventoryFiles(input.outputDirectory, false);
  const paths = new Set(files.map((file) => file.path));
  for (const route of input.requiredCoreRoutes) {
    if (!paths.has(routeFile(route))) throw new Error("PUBLICATION_REQUIRED_ROUTE_MISSING");
  }
  for (const canary of input.forbiddenCanaries) {
    if (!canary) throw new Error("PUBLICATION_CANARY_INVALID");
    const bytes = Buffer.from(canary, "utf8");
    if (files.some((file) => file.bytes.includes(bytes))) {
      throw new Error("PUBLICATION_FORBIDDEN_CANARY");
    }
  }
  verifyArticles(files, input.snapshot, input.publicOrigin);
  verifyInternalLinks(files);
  verifyInternalAssets(files);
  const manifest: PublicationReleaseManifest = {
    schemaVersion: 1,
    snapshotManifestSha256: computePublicationSnapshotManifestSha256(input.snapshot),
    files: files.map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.bytes),
      size: file.bytes.byteLength,
    })),
  };
  const manifestBytes = canonicalJson(manifest);
  writeFileSync(join(input.outputDirectory, RELEASE_MANIFEST_NAME), manifestBytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return verifySealedPublicationRelease(input.outputDirectory);
}

export function verifySealedPublicationRelease(directory: string): SealedPublicationRelease {
  const files = inventoryFiles(directory, true);
  const manifestFile = files.find(({ path }) => path === RELEASE_MANIFEST_NAME);
  if (!manifestFile) throw new Error("PUBLICATION_RELEASE_MANIFEST_MISSING");
  const manifest = parseReleaseManifest(manifestFile.bytes);
  const actualFiles = files.filter(({ path }) => path !== RELEASE_MANIFEST_NAME);
  if (actualFiles.length !== manifest.files.length) {
    throw new Error("PUBLICATION_RELEASE_INVENTORY_MISMATCH");
  }
  for (let index = 0; index < manifest.files.length; index += 1) {
    const expected = manifest.files[index]!;
    const actual = actualFiles[index]!;
    if (expected.path !== actual.path || expected.size !== actual.bytes.byteLength) {
      throw new Error("PUBLICATION_RELEASE_INVENTORY_MISMATCH");
    }
    if (expected.sha256 !== sha256Hex(actual.bytes)) {
      throw new Error("PUBLICATION_RELEASE_HASH_MISMATCH");
    }
  }
  return { manifest, manifestSha256: sha256Hex(manifestFile.bytes) };
}
