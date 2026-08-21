import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

import { blindIndex, createStaticKeyProvider, encryptPii } from "../crypto/index.js";
import { createControlApp } from "../app.js";
import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  activateConsentBundle,
  getActivePublishedConsentBundle,
  getPublishedConsentBundleById,
  seedCompleteConsentBundles,
} from "../consent/service.js";
import {
  claimIndexNowDelivery,
  completeIndexNowDelivery,
} from "./indexnow-outbox.js";
import {
  verifyAndSealPublicationBuild,
  verifySealedPublicationRelease,
  type SealedPublicationRelease,
} from "./publication-build.js";
import {
  createRetentionPruningPath,
  createReleaseConsentAuthorityResolver,
  createPublicationBatchPlan,
  PublicationActivationSettlementError,
  publishApprovedArticles,
  pruneRetiredPublicationReleases,
  reconcilePublicationActivation,
  rollbackPublication,
  type PublicationAuthorityWorkerInput,
  type PublicationAuthorityWorkerResult,
  type PublicationReleaseConfig,
  type PublicationReleaseDependencies,
} from "./publication-release.js";
import * as publicationReleaseModule from "./publication-release.js";
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

function insertBatchArticle(index: number): void {
  const suffix = String(index).padStart(3, "0");
  const uuidSuffix = String(index + 1).padStart(12, "0");
  const articleId = `10000000-0000-4000-8000-${uuidSuffix}`;
  const revisionId = `20000000-0000-4000-8000-${uuidSuffix}`;
  const slug = `batch-guide-${suffix}`;
  const title = `Batch guide ${suffix}`;
  const summary = `Reviewed batch summary ${suffix}.`;
  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'approved', 'ko', ?, 'hermes', ?, ?)
  `).run(articleId, slug, revisionId, NOW - 2_000, NOW - 1_000);
  fixture.db.sqlite.prepare(`
    INSERT INTO article_revisions (
      id, article_id, locale, revision_no, title, summary, body_markdown,
      content_sha256, source_revision_id, sources_json, source_sha256,
      initial_review_state, created_at_ms, created_by_type, created_by_id
    ) VALUES (?, ?, 'ko', 1, ?, ?, ?, ?, NULL, ?, ?, 'approved', ?,
      'hermes', 'batch-fixture')
  `).run(
    revisionId,
    articleId,
    title,
    summary,
    BODY,
    contentHash(title, summary, "ko"),
    JSON.stringify(SOURCES),
    Buffer.alloc(32, index + 10),
    NOW - 2_000,
  );
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id, approved_revision_id,
      approved_by_admin_id, approved_at_ms, row_version, updated_at_ms
    ) VALUES (?, 'ko', ?, 'approved', ?, ?, ?, ?, 1, ?)
  `).run(
    articleId,
    slug,
    revisionId,
    revisionId,
    ADMIN_ID,
    NOW - 1_000,
    NOW - 1_000,
  );
}

function insertRetainedConsultation(
  id: string,
  pii: {
    name: string;
    phone: string;
    email?: string;
    company?: string;
    message: string;
  },
): void {
  fixture.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone', ?, 'pii-v1',
      ?, ?, 'pii-v1', 0, ?, ?, ?, 1)
  `).run(
    id,
    `receipt-${id}`,
    encryptPii(keyProvider, id, pii),
    blindIndex(keyProvider, "phone", pii.phone),
    pii.email ? blindIndex(keyProvider, "email", pii.email) : null,
    NOW,
    NOW,
    NOW + 1_000_000,
  );
}

beforeEach(() => {
  fixture = createTestDatabase();
  seedCompleteConsentBundles(fixture.db, consentBundle(), NOW - 10_000);
  activateConsentBundle(fixture.db, "bundle-2026-07-16", NOW - 9_000);
  root = realpathSync(mkdtempSync(join(tmpdir(), "wisdom-publication-release-")));
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  for (const document of snapshot.consentBundle.documents) {
    const prefix = document.locale === "ko" ? ""
      : document.locale === "en" ? "en/"
        : document.locale === "zh-Hans" ? "zh-hans/" : "zh-hant/";
    const route = document.kind === "privacy" ? "privacy" : "marketing/withdraw";
    write(`${prefix}${route}/index.html`, `<html><body><article
      data-consent-kind="${document.kind}"
      data-consent-version="${escapeHtml(document.version)}"
      data-consent-effective-at="${document.effectiveAt}"
      data-consent-sha256="${document.contentSha256}"
      data-consent-retention-months="${document.retentionMonths}">
      <h2>${escapeHtml(document.title)}</h2><pre>${escapeHtml(document.bodyMarkdown)}</pre>
      </article></body></html>`, outputDirectory);
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

async function verifyAuthorityForTest(
  input: PublicationAuthorityWorkerInput,
): Promise<PublicationAuthorityWorkerResult> {
  const verified = verifySealedPublicationRelease(
    input.releasePath,
    input.publicOrigin,
  );
  if (verified.manifestSha256 !== input.expectedManifestSha256) {
    throw new Error("PUBLICATION_AUTHORITY_MANIFEST_MISMATCH");
  }
  return {
    manifestSha256: verified.manifestSha256,
    bundle: verified.consentBundle,
  };
}

describe("journaled publication activation", () => {
  it("publishes deterministic groups of 64 and leaves the next approved head for the following batch", async () => {
    for (let index = 0; index < 64; index += 1) insertBatchArticle(index);
    const firstPlan = createPublicationBatchPlan(fixture.db, "next-batch");
    expect(firstPlan).toMatchObject({
      eligibleTotal: 65,
      batchCount: 64,
      remainingAfterBatch: 1,
      mode: "next-batch",
    });
    expect(firstPlan.promotions).toHaveLength(64);

    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-batch-64",
      nowMs: NOW,
      mode: "next-batch",
      expectedFingerprint: firstPlan.fingerprint,
    }, config, dependencies());

    const nextPlan = createPublicationBatchPlan(fixture.db, "next-batch");
    expect(nextPlan).toMatchObject({
      eligibleTotal: 1,
      batchCount: 1,
      remainingAfterBatch: 0,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT json_extract(metadata_json, '$.batchCount') batch_count,
        json_extract(metadata_json, '$.remainingAfterBatch') remaining
      FROM audit_events WHERE action = 'article.release.published'
    `).get()).toEqual({ batch_count: 64, remaining: 1 });
  });

  it("publishes policy-only without consuming an approved content head", async () => {
    const plan = createPublicationBatchPlan(fixture.db, "policy-only");
    expect(plan).toMatchObject({
      eligibleTotal: 1,
      batchCount: 0,
      remainingAfterBatch: 1,
      mode: "policy-only",
    });
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-policy-only-explicit",
      nowMs: NOW,
      mode: "policy-only",
      expectedFingerprint: plan.fingerprint,
    }, config, dependencies());
    expect(fixture.db.sqlite.prepare(`
      SELECT state FROM article_locale_heads WHERE article_id = ? AND locale = 'ko'
    `).pluck().get(ARTICLE_ID)).toBe("approved");
  });

  it("hands the committed authority to the shared resolver before the first public request", async () => {
    const resolver = createReleaseConsentAuthorityResolver(fixture.db, config, {
      verifyAuthority: verifyAuthorityForTest,
      refreshIntervalMs: 0,
    });
    const deps = dependencies({ activateAuthority: resolver.activate });
    const app = createControlApp({
      db: fixture.db,
      keyProvider,
      consentAuthorityResolver: resolver,
      allowedOrigins: [config.publicOrigin],
      enforceOrigin: true,
      peerAddress: () => "203.0.113.71",
    });

    const published = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-immediate-authority",
      nowMs: NOW,
    }, config, deps);

    const activeAuthority = resolver();
    expect(activeAuthority?.source).toBe("release");
    expect(activeAuthority?.bundle.bundleId).toBe("bundle-2026-07-16");
    expect((await app.request(`${config.publicOrigin}/health/ready`)).status).toBe(200);
    const consent = await app.request(
      `${config.publicOrigin}/api/v1/consent-documents?locale=en`,
    );
    expect(consent.status).toBe(200);
    expect((await consent.json()).documents.privacy.version).toBe("privacy-2026-07-16");
    expect(activeAuthority?.source === "release" ? activeAuthority.releaseId : undefined)
      .toBe(published.releaseId);
    resolver.stop();
  });

  it("discards a stale worker result after a newer activation handoff", async () => {
    const deps = dependencies();
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-worker-base",
      nowMs: NOW,
    }, config, deps);
    let resolveWorker: ((result: PublicationAuthorityWorkerResult) => void) | undefined;
    let workerInput: PublicationAuthorityWorkerInput | undefined;
    const resolver = createReleaseConsentAuthorityResolver(fixture.db, config, {
      refreshIntervalMs: 0,
      verifyAuthority: (input) => {
        workerInput = input;
        return new Promise((resolve) => { resolveWorker = resolve; });
      },
    });
    const staleRefresh = resolver.refresh();
    await expect.poll(() => workerInput).toBeDefined();

    seedCompleteConsentBundles(fixture.db, consentBundle("bundle-worker-new", "worker-new"), NOW + 1);
    activateConsentBundle(fixture.db, "bundle-worker-new", NOW + 2);
    deps.activateAuthority = resolver.activate;
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-worker-new",
      nowMs: NOW + 3,
    }, config, deps);
    expect(resolver()?.bundle.bundleId).toBe("bundle-worker-new");

    resolveWorker!(await verifyAuthorityForTest(workerInput!));
    expect(await staleRefresh).toBe(false);
    expect(resolver()?.bundle.bundleId).toBe("bundle-worker-new");
    resolver.stop();
  });

  it("caches verified consent authority and refreshes changed releases once outside request paths", async () => {
    const deps = dependencies();
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-cache-a",
      nowMs: NOW,
    }, config, deps);
    let verificationCount = 0;
    const scheduled: Array<() => void> = [];
    const resolver = (createReleaseConsentAuthorityResolver as unknown as (
      database: typeof fixture.db,
      publicationConfig: PublicationReleaseConfig,
      options: {
        onFullVerification: () => void;
        scheduleRefresh: (task: () => void) => void;
        refreshIntervalMs: number;
        verifyAuthority: typeof verifyAuthorityForTest;
      },
    ) => ReturnType<typeof createReleaseConsentAuthorityResolver> & {
      refresh(): boolean;
      stop(): void;
    })(fixture.db, config, {
      onFullVerification: () => { verificationCount += 1; },
      scheduleRefresh: (task) => { scheduled.push(task); },
      refreshIntervalMs: 0,
      verifyAuthority: verifyAuthorityForTest,
    });
    expect(await resolver.refresh()).toBe(true);
    expect(verificationCount).toBe(1);
    const app = createControlApp({
      db: fixture.db,
      keyProvider,
      consentAuthorityResolver: resolver,
      allowedOrigins: [config.publicOrigin],
      enforceOrigin: true,
      peerAddress: () => "203.0.113.71",
    });
    for (let request = 0; request < 120; request += 1) {
      expect((await app.request(`${config.publicOrigin}/health/ready`)).status).toBe(200);
    }
    for (let request = 0; request < 20; request += 1) {
      expect((await app.request(
        `${config.publicOrigin}/api/v1/consent-documents?locale=en`,
      )).status).toBe(200);
    }
    expect(verificationCount).toBe(1);

    seedCompleteConsentBundles(fixture.db, consentBundle("bundle-cache-b", "cache-b"), NOW + 1);
    activateConsentBundle(fixture.db, "bundle-cache-b", NOW + 2);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-cache-b",
      nowMs: NOW + 3,
    }, config, deps);
    for (let request = 0; request < 32; request += 1) expect(resolver()).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    expect(verificationCount).toBe(1);
    scheduled.shift()!();
    await expect.poll(() => verificationCount).toBe(2);
    await expect.poll(() => resolver()?.bundle.bundleId).toBe("bundle-cache-b");
    expect(resolver()?.source).toBe("release");
    expect(resolver()?.bundle.bundleId).toBe("bundle-cache-b");

    writeFileSync(
      join(config.releaseRoot, second.version, "consent-bundle.json"),
      "tampered",
      "utf8",
    );
    expect(resolver()).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await expect.poll(() => verificationCount).toBe(3);
    await expect.poll(() => resolver()).toBeUndefined();
    expect(resolver()).toBeUndefined();
    const unavailable = await app.request(
      `${config.publicOrigin}/api/v1/consent-documents?locale=en`,
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    resolver.stop();
  });

  it("publishes a policy-only release and moves the sealed API plus all eight policy DOMs together", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-policy-a",
      nowMs: NOW,
    }, config, deps);
    const resolverFactory = (publicationReleaseModule as unknown as {
      createReleaseConsentAuthorityResolver?: (
        db: typeof fixture.db,
        config: PublicationReleaseConfig,
        options: { verifyAuthority: typeof verifyAuthorityForTest; refreshIntervalMs: number },
      ) => ((() => { bundle: PublicationSnapshot["consentBundle"] } | undefined) & {
        refresh(): Promise<boolean>;
        stop(): void;
      });
    }).createReleaseConsentAuthorityResolver;
    expect(typeof resolverFactory).toBe("function");
    const resolveAuthority = resolverFactory!(fixture.db, config, {
      verifyAuthority: verifyAuthorityForTest,
      refreshIntervalMs: 0,
    });
    expect(await resolveAuthority.refresh()).toBe(true);
    expect(resolveAuthority()?.bundle.bundleId).toBe("bundle-2026-07-16");

    seedCompleteConsentBundles(fixture.db, consentBundle("bundle-new", "new"), NOW + 1);
    activateConsentBundle(fixture.db, "bundle-new", NOW + 2);
    expect(resolveAuthority()?.bundle.bundleId).toBe("bundle-2026-07-16");

    const app = createControlApp({
      db: fixture.db,
      keyProvider,
      consentAuthorityResolver: resolveAuthority as never,
      allowedOrigins: [config.publicOrigin],
      enforceOrigin: true,
      now: () => NOW + 3,
    });
    const beforePublication = await app.request(
      `${config.publicOrigin}/api/v1/consent-documents?locale=en`,
    );
    expect((await beforePublication.json()).documents.privacy.version).toBe("privacy-2026-07-16");

    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-policy-b",
      nowMs: NOW + 4,
    }, config, deps);
    expect(second.releaseId).not.toBe(first.releaseId);
    expect(resolveAuthority()).toBeUndefined();
    expect(await resolveAuthority.refresh()).toBe(true);
    const authority = resolveAuthority()!;
    expect(authority.bundle.bundleId).toBe("bundle-new");

    const afterPublication = await app.request(
      `${config.publicOrigin}/api/v1/consent-documents?locale=en`,
    );
    expect((await afterPublication.json()).documents).toMatchObject({
      privacy: { version: "privacy-new", retentionMonths: 12 },
      marketing: { version: "marketing-new", retentionMonths: 24 },
    });
    const releasePath = join(config.releaseRoot, second.version);
    for (const document of authority.bundle.documents) {
      const prefix = document.locale === "ko" ? ""
        : document.locale === "en" ? "en/"
          : document.locale === "zh-Hans" ? "zh-hans/" : "zh-hant/";
      const route = document.kind === "privacy" ? "privacy" : "marketing/withdraw";
      const html = readFileSync(join(releasePath, prefix, route, "index.html"), "utf8");
      expect(html).toContain(`data-consent-sha256="${document.contentSha256}"`);
      expect(html).toContain(`data-consent-retention-months="${document.retentionMonths}"`);
    }
    resolveAuthority.stop();
  });

  it("rejects and cleans a build whose activated consent bundle changes before finalization", async () => {
    seedCompleteConsentBundles(fixture.db, consentBundle("bundle-race", "race"), NOW + 1);
    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-consent-race",
      nowMs: NOW,
    }, config, dependencies({
      prepareRelease: ({ snapshot, outputDirectory }) => {
        const sealed = prepareRelease(snapshot, outputDirectory);
        activateConsentBundle(fixture.db, "bundle-race", NOW + 2);
        return Promise.resolve(sealed);
      },
    }))).rejects.toThrow(/^PUBLICATION_CONSENT_BUNDLE_CHANGED_DURING_BUILD$/);
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(readdirSync(config.releaseRoot).filter((name) => !name.endsWith(".log"))).toEqual([]);
  });

  it("rejects consent policy PII before creating any publication artifacts", async () => {
    const consultationId = "policy-pii-consultation";
    const privatePii = {
      name: "김민지",
      phone: "010-1234-5678",
      email: "policy-private@example.com",
      company: "비공개테크",
      message: "공개되면 안 되는 상담 메시지의 충분히 긴 비공개 내용입니다.",
    };
    fixture.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, 'receipt-policy-pii', 'received', 'ko', 'procurement', 'email',
        ?, ?, ?, ?, ?, 0, 0, 0, 9999999999999, 1)
    `).run(
      consultationId,
      encryptPii(keyProvider, consultationId, privatePii),
      keyProvider.active().id,
      blindIndex(keyProvider, "phone", privatePii.phone),
      blindIndex(keyProvider, "email", privatePii.email),
      keyProvider.active().id,
    );
    const candidate = consentBundle("bundle-policy-pii", "policy-pii");
    candidate[0] = { ...candidate[0]!, title: `Client ${privatePii.name}` };
    seedCompleteConsentBundles(fixture.db, candidate, NOW + 1);
    activateConsentBundle(fixture.db, "bundle-policy-pii", NOW + 2);

    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-policy-pii",
      nowMs: NOW + 3,
    }, config, dependencies())).rejects.toThrow(/^PUBLICATION_CONSENT_PII_REJECTED$/);
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(readdirSync(config.releaseRoot)).toEqual([]);
  });

  it("rechecks consent policy PII after the build before creating release authority", async () => {
    const consultationId = "policy-pii-build-race";
    const privatePii = {
      name: "김민지",
      phone: "010-9876-5432",
      email: "policy-build-race@example.com",
      company: "비공개테크",
      message: "발행 빌드 도중 접수된 상담의 충분히 긴 비공개 내용입니다.",
    };
    const candidate = consentBundle("bundle-policy-build-race", "policy-build-race");
    candidate[0] = {
      ...candidate[0]!,
      title: `Public contact ${privatePii.email}`,
    };
    seedCompleteConsentBundles(fixture.db, candidate, NOW + 1);
    activateConsentBundle(fixture.db, candidate[0]!.bundleId, NOW + 2);

    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-policy-pii-build-race",
      nowMs: NOW + 3,
    }, config, dependencies({
      prepareRelease: ({ snapshot, outputDirectory }) => {
        const sealed = prepareRelease(snapshot, outputDirectory);
        fixture.db.sqlite.prepare(`
          INSERT INTO consultations (
            id, receipt_id, status, locale, category, preferred_contact,
            pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
            blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
            retention_expires_at_ms, row_version
          ) VALUES (?, 'receipt-policy-pii-build-race', 'received', 'ko',
            'procurement', 'email', ?, ?, ?, ?, ?, 0, 0, 0, 9999999999999, 1)
        `).run(
          consultationId,
          encryptPii(keyProvider, consultationId, privatePii),
          keyProvider.active().id,
          blindIndex(keyProvider, "phone", privatePii.phone),
          blindIndex(keyProvider, "email", privatePii.email),
          keyProvider.active().id,
        );
        return Promise.resolve(sealed);
      },
    }))).rejects.toThrow(/^PUBLICATION_PII_CHANGED_DURING_BUILD$/);
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM release_activations").get()).toEqual({ count: 0 });
    expect(readdirSync(config.releaseRoot)).toEqual([]);
  });

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

  it("preserves the previous pointer, audits the failure, and removes all build temporaries", async () => {
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
    expect(readdirSync(config.releaseRoot)).toEqual(["failed-publication.log"]);
    expect(fixture.db.sqlite.prepare(`
      SELECT action, target_type, request_id,
        json_extract(metadata_json, '$.errorCode') error_code
      FROM audit_events
      WHERE action = 'article.release.build_failed'
    `).get()).toEqual({
      action: "article.release.build_failed",
      target_type: "release-attempt",
      request_id: "request-failed-build",
      error_code: "PUBLICATION_BUILD_FAILED",
    });
  });

  it("does not turn a committed publication into a failure when temporary cleanup fails", async () => {
    const result = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-cleanup-failed",
      nowMs: NOW,
    }, config, dependencies({
      prepareRelease: ({ snapshot, snapshotDirectory, outputDirectory }) => {
        const sealed = prepareRelease(snapshot, outputDirectory);
        const target = join(root, "cleanup-target");
        mkdirSync(target);
        rmSync(snapshotDirectory, { recursive: true });
        symlinkSync(target, snapshotDirectory, process.platform === "win32" ? "junction" : "dir");
        return Promise.resolve(sealed);
      },
    }));

    expect(result.releaseId).toBe("99999999-9999-4999-8999-000000000010");
    expect(existsSync(config.currentLink)).toBe(true);
    expect(fixture.db.sqlite.prepare(`
      SELECT action, json_extract(metadata_json, '$.temporaryKind') temporary_kind
      FROM audit_events
      WHERE action = 'article.release.cleanup_failed'
    `).get()).toEqual({
      action: "article.release.cleanup_failed",
      temporary_kind: "snapshot",
    });
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
    }))).rejects.toThrow("PUBLICATION_BATCH_CHANGED_DURING_BUILD");
    expect(existsSync(config.currentLink)).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM releases").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare("SELECT state FROM article_locale_heads WHERE locale = 'ko'").pluck().get()).toBe("in_review");
  });

  it("settles an after-switch fault before the request returns", async () => {
    const published = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "request-crash",
      nowMs: NOW,
    }, config, dependencies({
      faultInjector(point) {
        if (point === "after-switch") throw new Error("simulated-crash");
      },
    }));
    expect(existsSync(config.currentLink)).toBe(true);
    expect(published.releaseId).toBe("99999999-9999-4999-8999-000000000010");
    expect(fixture.db.sqlite.prepare("SELECT state FROM releases").get()).toEqual({ state: "active" });
    expect(fixture.db.sqlite.prepare("SELECT state FROM release_activations").get()).toEqual({ state: "committed" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM publication_outbox").get()).toEqual({ count: 1 });
    expect(reconcilePublicationActivation(fixture.db, {
      requestId: "startup-reconcile-again",
      nowMs: NOW + 1,
    }, config, dependencies())).toEqual({ kind: "already-consistent" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM publication_outbox").get()).toEqual({ count: 1 });
  });

  it("restores the verified previous pointer when the database commit cannot complete", async () => {
    const ids = idFactory();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-recovery-base",
      nowMs: NOW,
    }, config, dependencies({ randomUUID: ids }));
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);

    await expect(publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-recovery-reverted",
      nowMs: NOW + 2,
    }, config, dependencies({
      randomUUID: ids,
      faultInjector(point) {
        if (point !== "before-db-commit") return;
        fixture.db.sqlite.exec(`
          CREATE TRIGGER force_publication_commit_failure
          BEFORE UPDATE OF state ON releases
          WHEN NEW.state = 'active'
          BEGIN
            SELECT RAISE(ABORT, 'forced activation failure');
          END;
        `);
      },
    }))).rejects.toMatchObject({
      outcome: {
        kind: "reverted",
        previousReleaseId: first.releaseId,
      },
    });
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, first.version));
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM releases WHERE id = ?",
    ).pluck().get(first.releaseId)).toBe("active");
    expect(fixture.db.sqlite.prepare(`
      SELECT state, error_code FROM release_activations ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      state: "failed",
      error_code: "PUBLICATION_COMMIT_REVERTED",
    });
  });

  it("keeps an unresolved activation fail-closed when verified pointer recovery fails", async () => {
    const ids = idFactory();
    await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-manual-base",
      nowMs: NOW,
    }, config, dependencies({ randomUUID: ids }));
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);
    let switches = 0;

    const attempt = publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-manual-required",
      nowMs: NOW + 2,
    }, config, dependencies({
      randomUUID: ids,
      switchCurrent(targetPath, currentLink) {
        switches += 1;
        if (switches > 1) throw new Error("forced recovery switch failure");
        rmSync(currentLink, { force: true });
        symlinkSync(targetPath, currentLink, process.platform === "win32" ? "junction" : "dir");
      },
      faultInjector(point) {
        if (point !== "before-db-commit") return;
        fixture.db.sqlite.exec(`
          CREATE TRIGGER force_publication_manual_recovery
          BEFORE UPDATE OF state ON releases
          WHEN NEW.state = 'active'
          BEGIN
            SELECT RAISE(ABORT, 'forced activation failure');
          END;
        `);
      },
    }));
    await expect(attempt).rejects.toBeInstanceOf(PublicationActivationSettlementError);
    await expect(attempt).rejects.toMatchObject({
      outcome: {
        kind: "manual-recovery-required",
        errorCode: "PUBLICATION_RECOVERY_FAILED",
      },
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, error_code FROM release_activations ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      state: "switched",
      error_code: "PUBLICATION_RECOVERY_FAILED",
    });
  });
});

describe("verified publication rollback", () => {
  it("rejects a historical release that matches PII retained after its publication", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-before-new-pii",
      nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-after-new-pii",
      nowMs: NOW + 2,
    }, config, deps);
    insertRetainedConsultation("rollback-new-pii", {
      name: "조달 안내",
      phone: "010-9876-5432",
      message: "공개 문서와 무관했던 비공개 상담 내용이 이후 새로 접수되었습니다.",
    });

    expect(() => rollbackPublication(fixture.db, keyProvider, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-blocked-by-new-pii",
      nowMs: NOW + 3,
    }, config, deps)).toThrow("PUBLICATION_ROLLBACK_PII_REJECTED");
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, second.version));
  });

  it("rejects rollback before pointer switch when privacy generation changes after the scan", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-generation-base",
      nowMs: NOW,
    }, config, deps);
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = head_revision_id,
        approved_by_admin_id = ?, approved_at_ms = ?, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'en'
    `).run(ADMIN_ID, NOW + 1, ARTICLE_ID);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-generation-current",
      nowMs: NOW + 2,
    }, config, deps);
    deps.faultInjector = (point) => {
      if (point !== "after-rollback-pii-scan") return;
      insertRetainedConsultation("rollback-generation-race", {
        name: "새 상담자",
        phone: "010-5555-6666",
        message: "세대 변경 검증을 위한 공개 문서와 무관한 비공개 상담 내용입니다.",
      });
    };

    expect(() => rollbackPublication(fixture.db, keyProvider, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-generation-race",
      nowMs: NOW + 3,
    }, config, deps)).toThrow("PUBLICATION_PRIVACY_GENERATION_CHANGED");
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, second.version));
    expect(fixture.db.sqlite.prepare(`
      SELECT state, error_code FROM release_activations ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      state: "failed",
      error_code: "PUBLICATION_PRIVACY_GENERATION_CHANGED",
    });
  });

  it("serves a retired bundle with its original effective time after a valid release rollback", async () => {
    const deps = dependencies();
    const originalEffectiveAtMs = NOW - 9_000;
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-consent-authority-a",
      nowMs: NOW,
    }, config, deps);

    seedCompleteConsentBundles(fixture.db, consentBundle("bundle-b", "b"), NOW + 1);
    activateConsentBundle(fixture.db, "bundle-b", NOW + 2);
    expect(() => activateConsentBundle(
      fixture.db,
      "bundle-2026-07-16",
      NOW + 3,
    )).toThrow("CONSENT_BUNDLE_REACTIVATION_REJECTED");
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-consent-authority-b",
      nowMs: NOW + 4,
    }, config, deps);

    rollbackPublication(fixture.db, keyProvider, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-consent-authority-a",
      nowMs: NOW + 5,
    }, config, deps);

    const authorityResolver = createReleaseConsentAuthorityResolver(fixture.db, config, {
      verifyAuthority: verifyAuthorityForTest,
      refreshIntervalMs: 0,
    });
    expect(await authorityResolver.refresh()).toBe(true);
    const authority = authorityResolver();
    expect(authority?.source).toBe("release");
    if (authority?.source !== "release") throw new Error("expected release consent authority");
    expect(authority.releaseId).toBe(first.releaseId);
    expect(authority?.bundle.bundleId).toBe("bundle-2026-07-16");
    expect(authority?.bundle.documents.every((document) => (
      document.effectiveAt === new Date(originalEffectiveAtMs).toISOString()
    ))).toBe(true);
    expect(getPublishedConsentBundleById(
      fixture.db,
      "bundle-2026-07-16",
    )?.documents.every((document) => (
      document.effectiveAt === new Date(originalEffectiveAtMs).toISOString()
    ))).toBe(true);
    expect(fixture.db.sqlite.prepare(`
      SELECT DISTINCT state, effective_at_ms FROM consent_documents
      WHERE bundle_id = 'bundle-2026-07-16'
    `).all()).toEqual([{ state: "retired", effective_at_ms: originalEffectiveAtMs }]);
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM releases WHERE id = ?",
    ).pluck().get(second.releaseId)).toBe("retired");
  });

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

    const rolledBack = rollbackPublication(fixture.db, keyProvider, {
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
    rollbackPublication(fixture.db, keyProvider, {
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
    expect(() => rollbackPublication(fixture.db, keyProvider, {
      releaseId: first.releaseId,
      actorAdminId: ADMIN_ID,
      requestId: "rollback-tampered",
      nowMs: NOW + 2,
    }, config, deps)).toThrow(/PUBLICATION_RELEASE_(HASH|INVENTORY)_MISMATCH/);
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, second.version));
  });

  it("prevents published release consent metadata from being tampered", async () => {
    const deps = dependencies();
    const first = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-metadata-first",
      nowMs: NOW,
    }, config, deps);
    const second = await publishApprovedArticles(fixture.db, keyProvider, {
      actorAdminId: ADMIN_ID,
      requestId: "publish-metadata-second",
      nowMs: NOW + 1,
    }, config, deps);
    const metadata = JSON.parse(fixture.db.sqlite.prepare(
      "SELECT metadata_json FROM releases WHERE id = ?",
    ).pluck().get(first.releaseId) as string) as {
      consentBundle: { contentFileSha256: string };
    };
    metadata.consentBundle.contentFileSha256 = "00".repeat(32);
    expect(() => fixture.db.sqlite.prepare(
      "UPDATE releases SET metadata_json = ? WHERE id = ?",
    ).run(JSON.stringify(metadata), first.releaseId)).toThrow(/metadata is immutable/i);
    expect(readlinkSync(config.currentLink)).toBe(join(config.releaseRoot, second.version));
    expect(fixture.db.sqlite.prepare(
      "SELECT count(*) count FROM release_activations",
    ).get()).toEqual({ count: 2 });
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
      const publishedConsentBundle = getActivePublishedConsentBundle(fixture.db)!;
      const consentBytes = Buffer.from(canonical(publishedConsentBundle), "utf8");
      writeFileSync(join(directory, "consent-bundle.json"), consentBytes);
      const releaseManifest = canonical({
        schemaVersion: 1,
        snapshotManifestSha256: "ab".repeat(32),
        consentBundle: {
          bundleId: publishedConsentBundle.bundleId,
          contentFileSha256: createHash("sha256").update(consentBytes).digest("hex"),
        },
        files: [
          {
            path: "consent-bundle.json",
            sha256: createHash("sha256").update(consentBytes).digest("hex"),
            size: consentBytes.byteLength,
          },
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
