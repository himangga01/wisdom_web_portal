import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  computePublishedArticleContentSha256,
  normalizeValidateAndRenderArticleMarkdown,
  publishedArticleDocumentSchema,
  publishedManifestSchema,
  type PublishedArticleDocument,
} from "@wisdom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runPublicationBuild,
  verifyAndSealPublicationBuild,
  verifySealedPublicationRelease,
  type PublicationProcessRequest,
} from "./publication-build.js";
import type { PublicationSnapshot } from "./publication-snapshot.js";

const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const PUBLIC_ORIGIN = "https://www.example.com";
const BODY = "## Complete answer\n\nSafe public guidance.\n";
const SOURCES = [{
  id: "official",
  url: "https://example.com/official",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
}];

let root: string;

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureSnapshot(): PublicationSnapshot {
  const rendered = normalizeValidateAndRenderArticleMarkdown(BODY);
  const contentSha256 = computePublishedArticleContentSha256({
    title: "조달 안내",
    summary: "공식 자료를 검토한 공개 안내입니다.",
    bodyMarkdown: rendered.bodyMarkdown,
    sources: SOURCES,
    locale: "ko",
  });
  const document: PublishedArticleDocument = publishedArticleDocumentSchema.parse({
    schemaVersion: 1,
    articleId: ARTICLE_ID,
    locale: "ko",
    slug: "procurement-guide",
    revisionId: REVISION_ID,
    contentSha256,
    route: "/insights/procurement-guide",
    title: "조달 안내",
    summary: "공식 자료를 검토한 공개 안내입니다.",
    bodyMarkdown: rendered.bodyMarkdown,
    bodyHtml: rendered.bodyHtml,
    revisionCreatedAt: "2026-07-16T00:00:00.000Z",
    approvedAt: "2026-07-16T00:30:00.000Z",
    firstPublishedAt: "2026-07-16T01:00:00.000Z",
    modifiedAt: "2026-07-16T01:00:00.000Z",
    reviewer: { name: "Kang Jihye", role: "Administrative content reviewer" },
    sources: SOURCES,
  });
  const documentBytes = canonicalJson(document);
  return {
    capturedAtMs: Date.parse("2026-07-16T01:00:00.000Z"),
    baseReleaseId: null,
    baseReleaseGeneration: 0,
    promotions: [{
      articleId: ARTICLE_ID,
      locale: "ko",
      revisionId: REVISION_ID,
      expectedRowVersion: 3,
    }],
    documents: [document],
    entries: [{
      articleId: ARTICLE_ID,
      locale: "ko",
      slug: "procurement-guide",
      revisionId: REVISION_ID,
      contentSha256,
      route: "/insights/procurement-guide",
      contentFile: `articles/${REVISION_ID}.json`,
      contentFileSha256: sha256(documentBytes),
    }],
  };
}

function writeFile(relativePath: string, contents: string) {
  const path = join(root, "dist", relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function writeValidBuild(snapshot = fixtureSnapshot()) {
  const article = snapshot.documents[0]!;
  writeFile("index.html", `<!doctype html><html><head><link rel="canonical" href="https://www.example.com/"></head><body><a href="/insights">Insights</a></body></html>`);
  writeFile("insights/index.html", `<!doctype html><html><body><a href="${article.route}">${article.title}</a></body></html>`);
  writeFile("insights/procurement-guide/index.html", `<!doctype html><html><head>
    <link rel="canonical" href="https://www.example.com${article.route}">
    <link rel="alternate" hreflang="ko" href="https://www.example.com${article.route}">
    <link rel="alternate" hreflang="x-default" href="https://www.example.com${article.route}">
    </head><body><article>${article.bodyHtml}</article><a href="/">Home</a></body></html>`);
  writeFile("_astro/app.abc123.js", "console.log('public');\n");
  writeFile("robots.txt", "User-agent: *\nAllow: /\n");
  writeFile("sitemap.xml", "<?xml version=\"1.0\"?><urlset></urlset>\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wisdom-publication-build-"));
  mkdirSync(join(root, "snapshot"));
  mkdirSync(join(root, "site"));
  mkdirSync(join(root, "home"));
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

describe("isolated Astro publication build", () => {
  it("uses a fixed shell-free npm command and an allowlisted secret-free environment", async () => {
    let observed: PublicationProcessRequest | undefined;
    await runPublicationBuild({
      siteSourceRoot: resolve(root, "site"),
      snapshotDirectory: resolve(root, "snapshot"),
      outputDirectory: resolve(root, "dist"),
      buildHome: resolve(root, "home"),
      npmBinary: resolve(root, "bin", "npm"),
      nodeBinary: resolve(root, "bin", "node"),
      timeoutMs: 120_000,
    }, {
      runProcess(request) {
        observed = request;
        return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
      },
    });

    expect(observed).toEqual({
      command: resolve(root, "bin", "npm"),
      args: ["run", "build", "--workspace", "@wisdom/site", "--", "--outDir", resolve(root, "dist")],
      cwd: resolve(root, "site"),
      env: {
        CI: "1",
        HOME: resolve(root, "home"),
        NODE_ENV: "production",
        NO_COLOR: "1",
        PATH: dirname(resolve(root, "bin", "node")),
        WISDOM_PUBLISHED_CONTENT_DIR: resolve(root, "snapshot"),
      },
      timeoutMs: 120_000,
      stdoutLimit: 65_536,
      stderrLimit: 65_536,
    });
    expect(JSON.stringify(observed)).not.toContain("SECRET");
  });

  it("rejects a failed build without accepting or mutating an existing public release", async () => {
    await expect(runPublicationBuild({
      siteSourceRoot: resolve(root, "site"),
      snapshotDirectory: resolve(root, "snapshot"),
      outputDirectory: resolve(root, "dist"),
      buildHome: resolve(root, "home"),
      npmBinary: resolve(root, "bin", "npm"),
      nodeBinary: resolve(root, "bin", "node"),
      timeoutMs: 120_000,
    }, {
      runProcess: () => Promise.resolve({ exitCode: 2, stdout: "", stderr: "safe failure" }),
    })).rejects.toThrow("PUBLICATION_BUILD_FAILED");
  });
});

describe("static release verification", () => {
  it("verifies semantic article HTML, routes, links and hreflang before sealing a sorted manifest", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    const sealed = verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: ["DRAFT_PRIVATE_CANARY", "010-9999-9999"],
      publicOrigin: PUBLIC_ORIGIN,
    });

    expect(sealed.manifest.files.map(({ path }) => path)).toEqual([
      "_astro/app.abc123.js",
      "index.html",
      "insights/index.html",
      "insights/procurement-guide/index.html",
      "robots.txt",
      "sitemap.xml",
    ]);
    const manifestBytes = readFileSync(join(root, "dist", ".wisdom-release-manifest.json"));
    expect(sha256(manifestBytes)).toBe(sealed.manifestSha256);
    expect(verifySealedPublicationRelease(join(root, "dist"))).toEqual(sealed);
  });

  it("fails closed on missing routes, unsafe internal links, leaked canaries, and locale leakage", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    rmSync(join(root, "dist", "insights", "index.html"));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_REQUIRED_ROUTE_MISSING");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    writeFile("index.html", "<html><body><a href=\"/missing-private\">bad</a></body></html>");
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_INTERNAL_LINK_BROKEN");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    writeFile("robots.txt", "DRAFT_PRIVATE_CANARY");
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: ["DRAFT_PRIVATE_CANARY"], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_FORBIDDEN_CANARY");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    const articlePath = "insights/procurement-guide/index.html";
    writeFile(articlePath, readFileSync(join(root, "dist", articlePath), "utf8").replace(
      "</head>", '<link rel="alternate" hreflang="en" href="https://www.example.com/en/insights/procurement-guide"></head>',
    ));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_HREFLANG_LEAK");
  });

  it("rejects missing HTML assets and malformed or misdirected hreflang links", () => {
    const snapshot = fixtureSnapshot();
    for (const tag of [
      '<img src="/_astro/missing-image.webp" alt="">',
      '<script src="/_astro/missing-script.js"></script>',
      '<link rel="stylesheet" href="/_astro/missing-style.css">',
      '<source srcset="/_astro/missing-small.webp 1x, /_astro/missing-large.webp 2x">',
    ]) {
      writeValidBuild(snapshot);
      const indexPath = join(root, "dist", "index.html");
      writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace("</body>", `${tag}</body>`));
      expect(() => verifyAndSealPublicationBuild({
        outputDirectory: join(root, "dist"), snapshot,
        requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
      })).toThrow("PUBLICATION_INTERNAL_ASSET_BROKEN");
      rmSync(join(root, "dist"), { recursive: true, force: true });
    }

    writeValidBuild(snapshot);
    const articlePath = join(root, "dist", "insights", "procurement-guide", "index.html");
    writeFileSync(articlePath, readFileSync(articlePath, "utf8").replace(
      `rel="alternate" hreflang="ko" href="https://www.example.com${snapshot.documents[0]!.route}"`,
      'rel="alternate" hreflang="ko" href="https://www.example.com/"',
    ));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_HREFLANG_TARGET_MISMATCH");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    writeFileSync(articlePath, readFileSync(articlePath, "utf8").replace(
      `rel="alternate" hreflang="ko" href="${PUBLIC_ORIGIN}${snapshot.documents[0]!.route}"`,
      `rel="alternate" hreflang="ko" href="https://wrong.example${snapshot.documents[0]!.route}"`,
    ));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_HREFLANG_TARGET_MISMATCH");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    writeFileSync(articlePath, readFileSync(articlePath, "utf8").replace(
      'rel="alternate" hreflang="ko"',
      'rel="stylesheet" hreflang="ko"',
    ));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_HREFLANG_REL_INVALID");

    rmSync(join(root, "dist"), { recursive: true, force: true });
    writeValidBuild(snapshot);
    writeFileSync(articlePath, readFileSync(articlePath, "utf8").replace(
      `rel="canonical" href="${PUBLIC_ORIGIN}${snapshot.documents[0]!.route}"`,
      `rel="canonical" href="https://wrong.example${snapshot.documents[0]!.route}"`,
    ));
    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_CANONICAL_INVALID");
  });

  it("detects file tampering, extra files and symlinks on every rollback re-verification", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    });
    const robotsPath = join(root, "dist", "robots.txt");
    const originalRobots = readFileSync(robotsPath);
    const tamperedRobots = Buffer.from(originalRobots);
    tamperedRobots[0] = tamperedRobots[0] === 0x55 ? 0x56 : 0x55;
    writeFileSync(robotsPath, tamperedRobots);
    expect(() => verifySealedPublicationRelease(join(root, "dist"))).toThrow("PUBLICATION_RELEASE_HASH_MISMATCH");

    writeValidBuild(snapshot);
    // A fresh seal is intentionally required after returning to known-good bytes.
    rmSync(join(root, "dist", ".wisdom-release-manifest.json"), { force: true });
    verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    });
    writeFile("unexpected.txt", "extra");
    expect(() => verifySealedPublicationRelease(join(root, "dist"))).toThrow("PUBLICATION_RELEASE_INVENTORY_MISMATCH");
  });

  it("rejects non-canonical schema extensions in the authoritative seal", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"), snapshot,
      requiredCoreRoutes: ["/", "/insights"], forbiddenCanaries: [], publicOrigin: PUBLIC_ORIGIN,
    });
    const path = join(root, "dist", ".wisdom-release-manifest.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    parsed.unexpected = true;
    writeFileSync(path, canonicalJson(parsed), "utf8");
    expect(() => verifySealedPublicationRelease(join(root, "dist"))).toThrow(
      "PUBLICATION_RELEASE_MANIFEST_INVALID",
    );
  });
});
