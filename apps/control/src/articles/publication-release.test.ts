import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  computePublishedArticleContentSha256,
  type Locale,
} from "@wisdom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStaticKeyProvider } from "../crypto/index.js";
import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  claimIndexNowDelivery,
  completeIndexNowDelivery,
} from "./indexnow-outbox.js";
import {
  verifyAndSealPublicationBuild,
  type SealedPublicationRelease,
} from "./publication-build.js";
import {
  createRetentionPruningPath,
  publishApprovedArticles,
  pruneRetiredPublicationReleases,
  reconcilePublicationActivation,
  rollbackPublication,
  type PublicationReleaseConfig,
  type PublicationReleaseDependencies,
} from "./publication-release.js";
import type { PublicationSnapshot } from "./publication-snapshot.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const KO_REVISION_ID = "22222222-2222-4222-8222-222222222222";
const EN_REVISION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-07-16T05:00:00.000Z");
const BODY = "## Complete answer\n\nSafe public guidance.\n";
const SOURCES = [{
  id: "official",
  url: "https://example.com/official",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
}];

let fixture: TestDatabase;
let root: string;
let config: PublicationReleaseConfig;
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 81) });

function contentHash(title: string, summary: string, locale: Locale): Buffer {
  return Buffer.from(computePublishedArticleContentSha256({
    title, summary, bodyMarkdown: BODY, sources: SOURCES, locale,
  }), "hex");
}

function insertRevision(
  revisionId: string,
  locale: "ko" | "en",
  title: string,
  summary: string,
) {
  fixture.db.sqlite.prepare(`
    INSERT INTO article_revisions (
      id, article_id, locale, revision_no, title, summary, body_markdown,
      content_sha256, source_revision_id, sources_json, source_sha256, initial_review_state,
      created_at_ms, created_by_type, created_by_id
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'hermes', 'draft')
  `).run(
    revisionId, ARTICLE_ID, locale, title, summary, BODY,
    contentHash(title, summary, locale), locale === "en" ? KO_REVISION_ID : null,
    JSON.stringify(SOURCES), Buffer.alloc(32, 4), NOW - 2_000,
  );
}

beforeEach(() => {
  fixture = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), "wisdom-publication-release-"));
  mkdirSync(join(root, "releases"));
  mkdirSync(join(root, "site"));
  config = {
    releaseRoot: resolve(root, "releases"),
    currentLink: resolve(root, "public-current"),
    siteSourceRoot: resolve(root, "site"),
    npmBinary: resolve(root, "bin", "npm"),
    nodeBinary: resolve(root, "bin", "node"),
    buildTimeoutMs: 120_000,
    requiredCoreRoutes: ["/", "/insights"],
    forbiddenCanaries: ["DRAFT_PRIVATE_CANARY"],
    publicOrigin: "https://www.example.com",
  };
  fixture.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms
    ) VALUES (?, 'reviewer', 'Kang Jihye', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms
    ) VALUES (?, 'procurement-guide', 'approved', 'ko', ?, 'hermes', 0, 0)
  `).run(ARTICLE_ID, KO_REVISION_ID);
  insertRevision(KO_REVISION_ID, "ko", "조달 안내", "공식 자료를 검토한 공개 안내입니다.");
  insertRevision(EN_REVISION_ID, "en", "Procurement guide", "A reviewed public guide.");
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id, approved_revision_id,
      approved_by_admin_id, approved_at_ms, row_version, updated_at_ms
    ) VALUES
      (?, 'ko', 'procurement-guide', 'approved', ?, ?, ?, ?, 3, ?),
      (?, 'en', 'procurement-guide', 'in_review', ?, NULL, NULL, NULL, 1, ?)
  `).run(
    ARTICLE_ID, KO_REVISION_ID, KO_REVISION_ID, ADMIN_ID, NOW - 1_000, NOW - 1_000,
    ARTICLE_ID, EN_REVISION_ID, NOW - 1_000,
  );
});

afterEach(() => {
  fixture.close();
  rmSync(root, { force: true, recursive: true });
});

function write(relativePath: string, contents: string, outputDirectory: string) {
  const path = join(outputDirectory, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function prepareRelease(
  snapshot: PublicationSnapshot,
  outputDirectory: string,
  sitemapUrls?: readonly string[],
): SealedPublicationRelease {
  mkdirSync(outputDirectory);
  const alternates = new Map<string, string>();
  for (const document of snapshot.documents) {
    const related = snapshot.documents.filter(({ articleId }) => articleId === document.articleId);
    const korean = related.find(({ locale }) => locale === "ko");
    alternates.set(document.revisionId, related.map(({ locale, route }) =>
      `<link rel="alternate" hreflang="${locale}" href="https://www.example.com${route}">`,
    ).join("") + (korean
      ? `<link rel="alternate" hreflang="x-default" href="https://www.example.com${korean.route}">`
      : ""));
  }
  write("index.html", "<html><body><a href=\"/insights\">Insights</a></body></html>", outputDirectory);
  write("insights/index.html", `<html><body>${snapshot.documents.map((document) =>
    `<a href="${document.route}">${document.title}</a>`,
  ).join("")}</body></html>`, outputDirectory);
  for (const document of snapshot.documents) {
    write(`${document.route.slice(1)}/index.html`, `<html><head><link rel="canonical" href="${config.publicOrigin}${document.route}">${alternates.get(document.revisionId)}</head><body><article>${document.bodyHtml}</article><a href="/">Home</a></body></html>`, outputDirectory);
  }
  write("robots.txt", "User-agent: *\nAllow: /\n", outputDirectory);
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${(sitemapUrls ?? [
    ...snapshot.documents.map(({ route }) => `${config.publicOrigin}${route}`),
    `${config.publicOrigin}/`,
    `${config.publicOrigin}/insights`,
  ]).map((url) => `  <url><loc>${url}</loc></url>`).join("\n")}
</urlset>
`, outputDirectory);
  return verifyAndSealPublicationBuild({
    outputDirectory,
    snapshot,
    requiredCoreRoutes: config.requiredCoreRoutes,
    forbiddenCanaries: config.forbiddenCanaries,
    publicOrigin: config.publicOrigin,
  });
}

function idFactory() {
  let value = 10;
  return () => {
    const suffix = String(value++).padStart(12, "0");
    return `99999999-9999-4999-8999-${suffix}`;
  };
}

function dependencies(
  overrides: Partial<PublicationReleaseDependencies> = {},
): PublicationReleaseDependencies {
  return {
    randomUUID: idFactory(),
    prepareRelease: ({ snapshot, outputDirectory }) => Promise.resolve(
      prepareRelease(snapshot, outputDirectory),
    ),
    ...overrides,
  };
}

describe("journaled publication activation", () => {
  it("accepts one fully verified ops bootstrap pointer before the first database release", async () => {
    const bootstrap = join(config.releaseRoot, "bootstrap-initial");
    mkdirSync(bootstrap);
    const index = Buffer.from("initial public page\n", "utf8");
    writeFileSync(join(bootstrap, "index.html"), index);
    const bootstrapManifest = {
      formatVersion: 1,
      kind: "bootstrap",
      releaseId: "bootstrap-initial",
      createdAt: "2026-07-16T00:00:00.000Z",
      files: {
        "index.html": createHash("sha256").update(index).digest("hex"),
      },
    };
    writeFileSync(
      join(bootstrap, ".ops-public-release.json"),
      `${JSON.stringify(bootstrapManifest, null, 2)}\n`,
      "utf8",
    );
    symlinkSync(bootstrap, config.currentLink, process.platform === "win32" ? "junction" : "dir");
    expect(reconcilePublicationActivation(fixture.db, {
      requestId: "bootstrap-startup",
      nowMs: NOW - 1,
    }, config, dependencies())).toEqual({ kind: "already-consistent" });

    const result = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-after-bootstrap",
      nowMs: NOW,
    }, config, dependencies());
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, result.version));
    expect(fixture.db.sqlite.prepare(`
      SELECT previous_release_id, previous_path, state FROM release_activations
    `).get()).toEqual({
      previous_release_id: null,
      previous_path: bootstrap,
      state: "committed",
    });
  });

  it("publishes all explicitly approved heads only after a verified atomic switch", async () => {
    const result = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-publish",
      nowMs: NOW,
    }, config, dependencies());

    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, result.version));
    expect(fixture.db.sqlite.prepare(`
      SELECT state, verified_at_ms, activated_at_ms, verification_sha256,
        activation_generation FROM releases WHERE id = ?
    `).get(result.releaseId)).toEqual({
      state: "active",
      verified_at_ms: NOW,
      activated_at_ms: NOW,
      verification_sha256: Buffer.from(result.manifestSha256, "hex"),
      activation_generation: 1,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT locale, state, published_revision_id FROM article_locale_heads
      ORDER BY locale
    `).all()).toEqual([
      { locale: "en", state: "in_review", published_revision_id: null },
      { locale: "ko", state: "published", published_revision_id: KO_REVISION_ID },
    ]);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, operation FROM release_activations
    `).get()).toEqual({ state: "committed", operation: "publish" });
    const outbox = fixture.db.sqlite.prepare(`
      SELECT state, payload_json FROM publication_outbox
    `).get() as { state: string; payload_json: string };
    expect(outbox.state).toBe("pending");
    const urls = [
      "https://www.example.com/",
      "https://www.example.com/insights",
      "https://www.example.com/insights/procurement-guide",
    ];
    expect(JSON.parse(outbox.payload_json)).toEqual({
      host: "www.example.com",
      urlSetSha256: createHash("sha256").update(urls.join("\n")).digest("hex"),
      urls,
    });
  });

  it("submits URLs removed from the new sealed sitemap so crawlers can observe their 404s", async () => {
    const deps = dependencies();
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW - 500, ARTICLE_ID);
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-ko-en",
      nowMs: NOW,
    }, config, deps);

    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'in_review', approved_revision_id = NULL,
        published_revision_id = NULL, approved_by_admin_id = NULL,
        approved_at_ms = NULL, published_at_ms = NULL,
        row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ARTICLE_ID);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        published_revision_id = NULL, published_at_ms = NULL,
        row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(ARTICLE_ID);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-ko-only",
      nowMs: NOW + 1,
    }, config, deps);

    const payload = fixture.db.sqlite.prepare(`
      SELECT payload_json FROM publication_outbox WHERE release_id = ?
    `).pluck().get(second.releaseId) as string;
    expect(JSON.parse(payload).urls).toEqual([
      "https://www.example.com/",
      "https://www.example.com/en/insights/procurement-guide",
      "https://www.example.com/insights",
      "https://www.example.com/insights/procurement-guide",
    ]);
  });

  it("rejects a target-plus-previous URL union over IndexNow limits before switching", async () => {
    const firstUrls = Array.from({ length: 6_000 }, (_, index) =>
      `${config.publicOrigin}/first/${index.toString(36).padStart(3, "0")}`);
    const secondUrls = Array.from({ length: 6_000 }, (_, index) =>
      `${config.publicOrigin}/second/${index.toString(36).padStart(3, "0")}`);
    const payloadBytes = (urls: readonly string[]) => Buffer.byteLength(JSON.stringify({
      host: "www.example.com",
      urlSetSha256: createHash("sha256").update(urls.join("\n")).digest("hex"),
      urls,
    }), "utf8");
    expect(payloadBytes(firstUrls)).toBeLessThanOrEqual(256 * 1_024);
    expect(payloadBytes(secondUrls)).toBeLessThanOrEqual(256 * 1_024);
    expect(firstUrls.length + secondUrls.length).toBeGreaterThan(10_000);

    let build = 0;
    const deps = dependencies({
      prepareRelease: ({ snapshot, outputDirectory }) => Promise.resolve(
        prepareRelease(snapshot, outputDirectory, build++ === 0 ? firstUrls : secondUrls),
      ),
    });
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-first-bounded-set",
      nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, published_revision_id = NULL,
        published_at_ms = NULL, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);

    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-oversized-union",
      nowMs: NOW + 2,
    }, config, deps)).rejects.toThrow("PUBLICATION_INDEXNOW_PAYLOAD_LIMIT_EXCEEDED");
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, first.version));
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM release_activations").get()).toEqual({ count: 1 });
    expect(readdirSync(config.releaseRoot).sort()).toEqual([first.version]);
  });

  it("rejects an under-10,000 target-plus-previous union over 256 KiB before switching", async () => {
    const firstUrls = Array.from({ length: 3_500 }, (_, index) =>
      `${config.publicOrigin}/bytes-first/${index.toString(36).padStart(3, "0")}/${"x".repeat(15)}`);
    const secondUrls = Array.from({ length: 3_500 }, (_, index) =>
      `${config.publicOrigin}/bytes-second/${index.toString(36).padStart(3, "0")}/${"y".repeat(15)}`);
    const payloadBytes = (urls: readonly string[]) => Buffer.byteLength(JSON.stringify({
      host: "www.example.com",
      urlSetSha256: createHash("sha256").update(urls.join("\n")).digest("hex"),
      urls,
    }), "utf8");
    expect(firstUrls.length + secondUrls.length).toBeLessThanOrEqual(10_000);
    expect(payloadBytes(firstUrls)).toBeLessThanOrEqual(256 * 1_024);
    expect(payloadBytes(secondUrls)).toBeLessThanOrEqual(256 * 1_024);
    expect(payloadBytes([...firstUrls, ...secondUrls])).toBeGreaterThan(256 * 1_024);

    let build = 0;
    const deps = dependencies({
      prepareRelease: ({ snapshot, outputDirectory }) => Promise.resolve(
        prepareRelease(snapshot, outputDirectory, build++ === 0 ? firstUrls : secondUrls),
      ),
    });
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-first-byte-bounded-set",
      nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, published_revision_id = NULL,
        published_at_ms = NULL, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);

    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-oversized-byte-union",
      nowMs: NOW + 2,
    }, config, deps)).rejects.toThrow("PUBLICATION_INDEXNOW_PAYLOAD_LIMIT_EXCEEDED");
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, first.version));
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM release_activations").get()).toEqual({ count: 1 });
    expect(readdirSync(config.releaseRoot).sort()).toEqual([first.version]);
  });

  it("preserves the previous pointer on build failure and retains failed output for investigation", async () => {
    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-failed-build",
      nowMs: NOW,
    }, config, dependencies({
      prepareRelease: ({ outputDirectory }) => {
        mkdirSync(outputDirectory);
        write("build.log", "safe failure", outputDirectory);
        return Promise.reject(new Error("PUBLICATION_BUILD_FAILED"));
      },
    }))).rejects.toThrow("PUBLICATION_BUILD_FAILED");
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(existsSync(config.releaseRoot)).toBe(true);
    expect(readFileSync(join(config.releaseRoot, "failed-publication.log"), "utf8")).toContain("PUBLICATION_BUILD_FAILED");
  });

  it("rejects an approved-head change that races the long static build", async () => {
    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-stale-snapshot",
      nowMs: NOW,
    }, config, dependencies({
      prepareRelease: ({ snapshot, outputDirectory }) => {
        const sealed = prepareRelease(snapshot, outputDirectory);
        fixture.db.sqlite.prepare(`
          UPDATE article_locale_heads
          SET state = 'in_review', approved_revision_id = NULL,
            approved_by_admin_id = NULL, approved_at_ms = NULL,
            row_version = row_version + 1
          WHERE article_id = ? AND locale = 'ko'
        `).run(ARTICLE_ID);
        return Promise.resolve(sealed);
      },
    }))).rejects.toThrow("PUBLICATION_PROMOTION_CHANGED_DURING_BUILD");
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare("SELECT state FROM article_locale_heads WHERE locale = 'ko'").pluck().get()).toBe("in_review");
  });

  it("reconciles a crash after the symlink switch exactly once", async () => {
    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-crash",
      nowMs: NOW,
    }, config, dependencies({
      faultInjector(point) {
        if (point === "after-switch") throw new Error("simulated-crash");
      },
    }))).rejects.toThrow("simulated-crash");
    expect(existsSync(config.currentLink)).toBe(true);
    expect(fixture.db.sqlite.prepare("SELECT state FROM releases").get()).toEqual({ state: "building" });
    expect(fixture.db.sqlite.prepare("SELECT state FROM release_activations").get()).toEqual({ state: "prepared" });

    const reconciled = reconcilePublicationActivation(fixture.db, {
      requestId: "startup-reconcile",
      nowMs: NOW + 1,
    }, config, dependencies());
    expect(reconciled.kind).toBe("committed");
    expect(fixture.db.sqlite.prepare("SELECT state FROM releases").get()).toEqual({ state: "active" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM publication_outbox").get()).toEqual({ count: 1 });
    expect(reconcilePublicationActivation(fixture.db, {
      requestId: "startup-reconcile-again",
      nowMs: NOW + 2,
    }, config, dependencies())).toEqual({ kind: "already-consistent" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM publication_outbox").get()).toEqual({ count: 1 });
  });
});

describe("verified publication rollback", () => {
  it("re-verifies and atomically rolls back without Codex or a rebuild", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-ko", nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE publication_outbox
      SET state = 'sent', sent_at_ms = ?, updated_at_ms = ?
      WHERE release_id = ?
    `).run(NOW + 1, NOW + 1, first.releaseId);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = 2
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-en", nowMs: NOW + 2,
    }, config, deps);
    expect(second.releaseId).not.toBe(first.releaseId);

    const rolledBack = rollbackPublication(fixture.db, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-first",
      nowMs: NOW + 3,
    }, config, deps);
    expect(rolledBack.releaseId).toBe(first.releaseId);
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, first.version));
    expect(fixture.db.sqlite.prepare(`
      SELECT locale, state, published_revision_id FROM article_locale_heads ORDER BY locale
    `).all()).toEqual([
      { locale: "en", state: "approved", published_revision_id: null },
      { locale: "ko", state: "published", published_revision_id: KO_REVISION_ID },
    ]);
    expect(fixture.db.sqlite.prepare("SELECT state FROM releases WHERE id = ?").pluck().get(second.releaseId)).toBe("retired");
    expect(fixture.db.sqlite.prepare(`
      SELECT state, attempt_count, sent_at_ms, payload_json
      FROM publication_outbox WHERE release_id = ?
    `).get(first.releaseId)).toEqual({
      state: "pending",
      attempt_count: 0,
      sent_at_ms: null,
      payload_json: JSON.stringify({
        host: "www.example.com",
        urlSetSha256: createHash("sha256").update([
          "https://www.example.com/",
          "https://www.example.com/en/insights/procurement-guide",
          "https://www.example.com/insights",
          "https://www.example.com/insights/procurement-guide",
        ].join("\n")).digest("hex"),
        urls: [
          "https://www.example.com/",
          "https://www.example.com/en/insights/procurement-guide",
          "https://www.example.com/insights",
          "https://www.example.com/insights/procurement-guide",
        ],
      }),
    });
    expect(fixture.db.sqlite.prepare(
      "SELECT count(*) count FROM publication_outbox",
    ).get()).toEqual({ count: 2 });
  });

  it("fences a stale delivery claim after rollback replaces and resets its payload", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-before-claim", nowMs: NOW,
    }, config, deps);
    const staleClaim = claimIndexNowDelivery(fixture.db, {
      workerId: "stale-worker",
      nowMs: NOW + 1,
      randomBytes: () => Buffer.alloc(32, 41),
    });
    expect(staleClaim?.releaseId).toBe(first.releaseId);

    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = 2
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 2, ARTICLE_ID);
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-after-claim", nowMs: NOW + 3,
    }, config, deps);
    rollbackPublication(fixture.db, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-resets-claim",
      nowMs: NOW + 4,
    }, config, deps);

    expect(completeIndexNowDelivery(fixture.db, staleClaim!, {
      nowMs: NOW + 5,
      providerMessageId: "late-success",
    })).toBe(false);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, attempt_count, locked_by, fencing_token, sent_at_ms
      FROM publication_outbox WHERE release_id = ?
    `).get(first.releaseId)).toEqual({
      state: "pending",
      attempt_count: 0,
      locked_by: null,
      fencing_token: null,
      sent_at_ms: null,
    });
  });

  it("rejects a tampered rollback release before changing the current pointer", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-first", nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'approved', published_revision_id = NULL,
        published_at_ms = NULL, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(ARTICLE_ID);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID, requestId: "publish-second", nowMs: NOW + 1,
    }, config, deps);
    writeFileSync(join(config.releaseRoot, first.version, "robots.txt"), "tampered", "utf8");
    expect(() => rollbackPublication(fixture.db, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-tampered",
      nowMs: NOW + 2,
    }, config, deps)).toThrow(/PUBLICATION_RELEASE_(HASH|INVENTORY)_MISMATCH/);
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, second.version));
  });
});

describe("publication release retention", () => {
  it("derives pruning names only from a fresh validated UUID", () => {
    const pruning = createRetentionPruningPath(config.releaseRoot, () =>
      "99999999-9999-4999-8999-000000000099");

    expect(dirname(pruning)).toBe(resolve(config.releaseRoot));
    expect(basename(pruning)).toBe(".pruning-99999999-9999-4999-8999-000000000099");
    expect(pruning).not.toContain("legacy-release-id");
  });

  it("keeps active, two newest verified retirees, tampered evidence, and outbox-referenced releases", () => {
    const canonical = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const createRetainedRelease = (
      id: string,
      version: string,
      state: "active" | "retired",
      createdAtMs: number,
    ) => {
      const directory = join(config.releaseRoot, version);
      mkdirSync(directory);
      const fileBytes = Buffer.from(`release ${version}\n`, "utf8");
      const sitemapBytes = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${config.publicOrigin}/</loc></url></urlset>\n`,
        "utf8",
      );
      writeFileSync(join(directory, "index.html"), fileBytes);
      writeFileSync(join(directory, "sitemap.xml"), sitemapBytes);
      const releaseManifest = canonical({
        schemaVersion: 1,
        snapshotManifestSha256: "ab".repeat(32),
        files: [
          {
            path: "index.html",
            sha256: createHash("sha256").update(fileBytes).digest("hex"),
            size: fileBytes.byteLength,
          },
          {
            path: "sitemap.xml",
            sha256: createHash("sha256").update(sitemapBytes).digest("hex"),
            size: sitemapBytes.byteLength,
          },
        ],
      });
      writeFileSync(join(directory, ".wisdom-release-manifest.json"), releaseManifest, "utf8");
      const manifestSha = createHash("sha256").update(releaseManifest).digest();
      fixture.db.sqlite.prepare(`
        INSERT INTO releases (
          id, version, path, manifest_sha256, state, created_at_ms,
          activated_at_ms, created_by, verified_at_ms, verification_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, version, directory, manifestSha, state, createdAtMs, createdAtMs,
        ADMIN_ID, createdAtMs, manifestSha,
      );
      return directory;
    };
    const active = createRetainedRelease(
      "70000000-0000-4000-8000-000000000000", "release-active", "active", 500,
    );
    const retired = [
      ["71000000-0000-4000-8000-000000000000", "release-retired-4", 400],
      ["72000000-0000-4000-8000-000000000000", "release-retired-3", 300],
      ["73000000-0000-4000-8000-000000000000", "release-retired-2", 200],
      ["74000000-0000-4000-8000-000000000000", "release-retired-1", 100],
      ["75000000-0000-4000-8000-000000000000", "release-retired-0", 50],
    ] as const;
    for (const [id, version, createdAt] of retired) {
      createRetainedRelease(id, version, "retired", createdAt);
    }
    writeFileSync(join(config.releaseRoot, retired[0][1], "index.html"), "tampered", "utf8");
    const referencedManifest = fixture.db.sqlite.prepare(
      "SELECT manifest_sha256 FROM releases WHERE id = ?",
    ).pluck().get(retired[3][0]) as Buffer;
    fixture.db.sqlite.prepare(`
      INSERT INTO publication_outbox (
        id, release_id, event_type, manifest_sha256, payload_json, state,
        available_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('76000000-0000-4000-8000-000000000000', ?, 'indexnow', ?,
        '{"host":"www.example.com","urls":["https://www.example.com/"]}',
        'pending', 0, 0, 0)
    `).run(retired[3][0], referencedManifest);
    const terminalManifest = fixture.db.sqlite.prepare(
      "SELECT manifest_sha256 FROM releases WHERE id = ?",
    ).pluck().get(retired[4][0]) as Buffer;
    fixture.db.sqlite.prepare(`
      INSERT INTO publication_outbox (
        id, release_id, event_type, manifest_sha256, payload_json, state,
        attempt_count, available_at_ms, last_error_code, created_at_ms, updated_at_ms
      ) VALUES ('77000000-0000-4000-8000-000000000000', ?, 'indexnow', ?,
        '{"host":"www.example.com","urls":["https://www.example.com/"]}',
        'failed', 1, 0, 'INDEXNOW_PAYLOAD_INVALID', 0, 0)
    `).run(retired[4][0], terminalManifest);
    symlinkSync(active, config.currentLink, process.platform === "win32" ? "junction" : "dir");

    expect(pruneRetiredPublicationReleases(fixture.db, config, {
      nowMs: 1_000,
      randomUUID: idFactory(),
    })).toEqual({ prunedReleaseIds: [retired[4][0]] });
    expect(existsSync(active)).toBe(true);
    expect(existsSync(join(config.releaseRoot, retired[0][1]))).toBe(true);
    expect(existsSync(join(config.releaseRoot, retired[1][1]))).toBe(true);
    expect(existsSync(join(config.releaseRoot, retired[2][1]))).toBe(true);
    expect(existsSync(join(config.releaseRoot, retired[3][1]))).toBe(true);
    expect(existsSync(join(config.releaseRoot, retired[4][1]))).toBe(false);
    expect(fixture.db.sqlite.prepare(`
      SELECT id, state FROM releases ORDER BY created_at_ms DESC
    `).all()).toEqual([
      { id: "70000000-0000-4000-8000-000000000000", state: "active" },
      { id: retired[0][0], state: "failed" },
      { id: retired[1][0], state: "retired" },
      { id: retired[2][0], state: "retired" },
      { id: retired[3][0], state: "retired" },
      { id: retired[4][0], state: "failed" },
    ]);
  });
});
