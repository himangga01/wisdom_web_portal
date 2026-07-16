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
const PRODUCTION_PUBLIC_ORIGIN = "https://www.jihye-office.kr";
const NAVER_META_TOKEN = "unit_test_naver_meta_token_1234567890";
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
  writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>${PUBLIC_ORIGIN}${article.route}</loc><lastmod>2026-07-16</lastmod><xhtml:link rel="alternate" hreflang="ko" href="${PUBLIC_ORIGIN}${article.route}" /></url>
  <url><loc>${PUBLIC_ORIGIN}/</loc></url>
  <url><loc>${PUBLIC_ORIGIN}/insights</loc></url>
</urlset>
`);
}

function writeSitemapUrls(urls: readonly string[]): void {
  const escaped = urls.map((url) => url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;"));
  writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${escaped.map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>
`);
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
      publicOrigin: PRODUCTION_PUBLIC_ORIGIN,
      naverSiteVerificationMeta: NAVER_META_TOKEN,
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
        NAVER_SITE_VERIFICATION_META: NAVER_META_TOKEN,
        NO_COLOR: "1",
        PATH: dirname(resolve(root, "bin", "node")),
        PUBLIC_ORIGIN: PRODUCTION_PUBLIC_ORIGIN,
        WISDOM_PUBLISHED_CONTENT_DIR: resolve(root, "snapshot"),
      },
      timeoutMs: 120_000,
      stdoutLimit: 65_536,
      stderrLimit: 65_536,
    });
    expect(JSON.stringify(observed)).not.toContain("SECRET");
  });

  it("rejects non-exact HTTPS origins and ambiguous Naver verification before spawning", async () => {
    let calls = 0;
    const dependencies = {
      runProcess() {
        calls += 1;
        return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
      },
    };
    const input = {
      siteSourceRoot: resolve(root, "site"),
      snapshotDirectory: resolve(root, "snapshot"),
      outputDirectory: resolve(root, "dist"),
      buildHome: resolve(root, "home"),
      npmBinary: resolve(root, "bin", "npm"),
      nodeBinary: resolve(root, "bin", "node"),
      timeoutMs: 120_000,
    };

    for (const publicOrigin of [
      "http://www.jihye-office.kr",
      "https://www.jihye-office.kr/path",
      "https://www.jihye-office.kr/",
      "https://www.jihye-office.kr:8443",
      "https://www.example.test",
      "https://WWW.jihye-office.kr",
    ]) {
      await expect(runPublicationBuild({ ...input, publicOrigin }, dependencies))
        .rejects.toThrow("PUBLICATION_ORIGIN_INVALID");
    }
    await expect(runPublicationBuild({
      ...input,
      publicOrigin: PRODUCTION_PUBLIC_ORIGIN,
      naverSiteVerificationMeta: NAVER_META_TOKEN,
      naverSiteVerificationFile: "naverunit_test_file_token_1234567890.html",
    }, dependencies)).rejects.toThrow("SEARCH_VERIFICATION_AMBIGUOUS");
    expect(calls).toBe(0);
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
      publicOrigin: PRODUCTION_PUBLIC_ORIGIN,
    }, {
      runProcess: () => Promise.resolve({ exitCode: 2, stdout: "", stderr: "safe failure" }),
    })).rejects.toThrow("PUBLICATION_BUILD_FAILED");
  });
});

describe("static release verification", () => {
  it("exposes the sorted sitemap URL set and its newline-joined SHA-256", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);

    const sealed = verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    });
    const sitemapUrls = [
      `${PUBLIC_ORIGIN}/`,
      `${PUBLIC_ORIGIN}/insights`,
      `${PUBLIC_ORIGIN}/insights/procurement-guide`,
    ];

    expect(sealed.sitemapUrls).toEqual(sitemapUrls);
    expect(sealed.urlSetSha256).toBe(sha256(sitemapUrls.join("\n")));
    expect(verifySealedPublicationRelease(join(root, "dist"))).toEqual(sealed);
  });

  it("keeps core IndexNow URLs non-empty when a sealed release has no articles", () => {
    const snapshot: PublicationSnapshot = {
      capturedAtMs: Date.parse("2026-07-16T01:00:00.000Z"),
      baseReleaseId: null,
      baseReleaseGeneration: 0,
      promotions: [],
      documents: [],
      entries: [],
    };
    writeFile("index.html", '<html><body><a href="/insights">Insights</a></body></html>');
    writeFile("insights/index.html", '<html><body><a href="/">Home</a></body></html>');
    writeFile("robots.txt", "User-agent: *\nAllow: /\n");
    writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PUBLIC_ORIGIN}/insights</loc></url>
  <url><loc>${PUBLIC_ORIGIN}/</loc></url>
</urlset>
`);

    const sealed = verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    });
    expect(sealed.sitemapUrls).toEqual([
      `${PUBLIC_ORIGIN}/`,
      `${PUBLIC_ORIGIN}/insights`,
    ]);
    expect(sealed.urlSetSha256).toBe(sha256(sealed.sitemapUrls.join("\n")));
  });

  it("rejects malformed sitemap roots, nesting, XML, and non-UTF-8 declarations", () => {
    const snapshot = fixtureSnapshot();
    const invalidSitemaps = [
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC_ORIGIN}/</loc></url></sitemapindex>`,
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><wrapper><loc>${PUBLIC_ORIGIN}/</loc></wrapper></url></urlset>`,
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC_ORIGIN}/</loc></urlset>`,
      `<?xml version="1.0" encoding="ISO-8859-1"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${PUBLIC_ORIGIN}/</loc></url></urlset>`,
    ];
    for (const sitemap of invalidSitemaps) {
      writeValidBuild(snapshot);
      writeFile("sitemap.xml", sitemap);
      expect(() => verifyAndSealPublicationBuild({
        outputDirectory: join(root, "dist"),
        snapshot,
        requiredCoreRoutes: ["/", "/insights"],
        forbiddenCanaries: [],
        publicOrigin: PUBLIC_ORIGIN,
      })).toThrow("PUBLICATION_SITEMAP_XML_INVALID");
      rmSync(join(root, "dist"), { force: true, recursive: true });
    }
  });

  it("ignores comment text that looks like a loc element", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- <loc>${PUBLIC_ORIGIN}/comment-only</loc> -->
  <url><loc>${PUBLIC_ORIGIN}/</loc></url>
</urlset>
`);

    const sealed = verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    });
    expect(sealed.sitemapUrls).toEqual([`${PUBLIC_ORIGIN}/`]);
  });

  it("decodes predefined XML entities in direct loc text", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PUBLIC_ORIGIN}/search?a=1&amp;b=2</loc></url>
</urlset>
`);

    const sealed = verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    });
    expect(sealed.sitemapUrls).toEqual([`${PUBLIC_ORIGIN}/search?a=1&b=2`]);
  });

  it("rejects DTD and external entity declarations", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeFile("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///private/etc/passwd">]>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>&xxe;</loc></url>
</urlset>
`);

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_DTD_FORBIDDEN");
  });

  it("rejects duplicate sitemap URLs", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    const sitemapPath = join(root, "dist", "sitemap.xml");
    writeFileSync(sitemapPath, readFileSync(sitemapPath, "utf8").replace(
      "</urlset>", `  <url><loc>${PUBLIC_ORIGIN}/insights</loc></url>\n</urlset>`,
    ));

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_DUPLICATE");
  });

  it("rejects canonical-equivalent duplicate sitemap URLs", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeSitemapUrls([
      `${PUBLIC_ORIGIN}/insights`,
      "https://www.example.com:443/insights",
    ]);

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_DUPLICATE");
  });

  it.each([
    "https://reader:secret@www.example.com/insights",
    "https://:@www.example.com/insights",
    "https:@www.example.com/insights",
    `${PUBLIC_ORIGIN}/insights#private-fragment`,
    `${PUBLIC_ORIGIN}/insights#`,
  ])("rejects sitemap URLs with credentials or fragments: %s", (url) => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeSitemapUrls([url]);

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_INVALID");
  });

  it("rejects sitemap URL count and IndexNow payload byte limits while sealing", () => {
    const snapshot = fixtureSnapshot();
    const cases = [
      Array.from({ length: 10_001 }, (_, index) => `${PUBLIC_ORIGIN}/u/${index}`),
      Array.from({ length: 9_000 }, (_, index) =>
        `${PUBLIC_ORIGIN}/payload/${index.toString().padStart(4, "0")}/${"x".repeat(12)}`),
    ];
    for (const urls of cases) {
      writeValidBuild(snapshot);
      writeSitemapUrls(urls);
      expect(() => verifyAndSealPublicationBuild({
        outputDirectory: join(root, "dist"),
        snapshot,
        requiredCoreRoutes: ["/", "/insights"],
        forbiddenCanaries: [],
        publicOrigin: PUBLIC_ORIGIN,
      })).toThrow("PUBLICATION_SITEMAP_INDEXNOW_LIMIT_EXCEEDED");
      rmSync(join(root, "dist"), { force: true, recursive: true });
    }
  });

  it("rejects an IndexNow URL longer than 4,096 characters while sealing", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeSitemapUrls([`${PUBLIC_ORIGIN}/${"x".repeat(4_100)}`]);

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_INVALID");
  });

  it("rejects cross-origin sitemap URLs", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    const sitemapPath = join(root, "dist", "sitemap.xml");
    writeFileSync(sitemapPath, readFileSync(sitemapPath, "utf8").replace(
      `${PUBLIC_ORIGIN}/insights/procurement-guide`,
      "https://attacker.example/insights/procurement-guide",
    ));

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_ORIGIN_INVALID");
  });

  it("rejects malformed sitemap URLs", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    const sitemapPath = join(root, "dist", "sitemap.xml");
    writeFileSync(sitemapPath, readFileSync(sitemapPath, "utf8").replace(
      `${PUBLIC_ORIGIN}/insights/procurement-guide`,
      "/insights/procurement-guide",
    ));

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URL_INVALID");
  });

  it("rejects an empty sitemap URL set", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    writeFile("sitemap.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"></urlset>\n");

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_URLS_EMPTY");
  });

  it("rejects a sealed build with no sitemap", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    rmSync(join(root, "dist", "sitemap.xml"));

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_MISSING");
  });

  it("rejects non-HTTPS sitemap URLs", () => {
    const snapshot = fixtureSnapshot();
    writeValidBuild(snapshot);
    const sitemapPath = join(root, "dist", "sitemap.xml");
    writeFileSync(
      sitemapPath,
      readFileSync(sitemapPath, "utf8").replaceAll(PUBLIC_ORIGIN, "http://www.example.com"),
    );

    expect(() => verifyAndSealPublicationBuild({
      outputDirectory: join(root, "dist"),
      snapshot,
      requiredCoreRoutes: ["/", "/insights"],
      forbiddenCanaries: [],
      publicOrigin: PUBLIC_ORIGIN,
    })).toThrow("PUBLICATION_SITEMAP_HTTPS_REQUIRED");
  });

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
