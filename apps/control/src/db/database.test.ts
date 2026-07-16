import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  closeDatabase,
  isDatabaseReady,
  MIGRATION_FINGERPRINTS,
  openDatabase,
  runMigrations,
} from "./client.js";
import { REQUIRED_INDEXES, REQUIRED_TABLES, SCHEMA_VERSION } from "./schema.js";

let testDatabase: TestDatabase | undefined;

afterEach(() => testDatabase?.close());

describe("SQLite durability and migrations", () => {
  it("keeps the immutable v1 and v2 migration bytes unchanged", () => {
    expect(MIGRATION_FINGERPRINTS.slice(0, 2)).toEqual([
      { version: 1, sha256: "0c7085ea33ea2c92181e55cd2161af57557fadd34cd1675f293e0388d4fff86b" },
      { version: 2, sha256: "83919e59c87120db696d8854c539ddf71020e47d2257f561e80feb038f5e15d9" },
    ]);
  });

  it("appends the v3 article publication schema without rewriting v1 or v2", () => {
    testDatabase = createTestDatabase();
    expect(SCHEMA_VERSION).toBe(3);
    expect(testDatabase.db.sqlite.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ).all()).toEqual([
      { version: 1, name: "initial-control-schema" },
      { version: 2, name: "admin-notification-withdrawal" },
      { version: 3, name: "article-publication-pipeline" },
    ]);
    const tables = new Set((testDatabase.db.sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "article_locale_heads",
      "article_review_runs",
      "article_translation_jobs",
      "release_entries",
      "release_activations",
      "publication_outbox",
      "hermes_article_idempotency",
      "hermes_article_nonces",
    ]) expect(tables.has(table), table).toBe(true);
  });

  it("enforces immutable revisions, locale ownership, one Codex lane, and one active release", () => {
    testDatabase = createTestDatabase();
    const db = testDatabase.db.sqlite;
    const insertArticle = db.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, created_by_type, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'draft', 'ko', 'hermes', 0, 0)
    `);
    insertArticle.run("article-a", "source-a");
    insertArticle.run("article-b", "source-b");
    const insertRevision = db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, parent_revision_id, sources_json,
        prompt_sha256, schema_sha256, source_sha256, model_id,
        initial_review_state, created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL, ?, NULL, 'draft', 0, 'hermes', 'draft')
    `);
    insertRevision.run(
      "revision-a-ko", "article-a", "ko", "Title A", "Summary A", "# Body A",
      Buffer.alloc(32, 1), Buffer.alloc(32, 2),
    );
    insertRevision.run(
      "revision-b-ko", "article-b", "ko", "Title B", "Summary B", "# Body B",
      Buffer.alloc(32, 3), Buffer.alloc(32, 4),
    );
    insertRevision.run(
      "revision-b-en", "article-b", "en", "Title B", "Summary B", "# Body B",
      Buffer.alloc(32, 5), Buffer.alloc(32, 6),
    );

    expect(() => db.prepare(
      "UPDATE article_revisions SET title = 'mutated' WHERE id = 'revision-a-ko'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(
      "DELETE FROM article_revisions WHERE id = 'revision-a-ko'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('article-a', 'ko', 'guide-a', 'draft', 'revision-b-ko', 1, 0)
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('article-a', 'ko', 'guide-a', 'published', 'revision-a-ko', 1, 0)
    `).run()).toThrow();
    db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('article-a', 'ko', 'guide-a', 'draft', 'revision-a-ko', 1, 0)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('article-b', 'ko', 'guide-a', 'draft', 'revision-b-ko', 1, 0)
    `).run()).toThrow();
    db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('article-b', 'en', 'guide-a', 'draft', 'revision-b-en', 1, 0)
    `).run();

    const insertRunningJob = db.prepare(`
      INSERT INTO article_translation_jobs (
        id, article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        locked_at_ms, lease_expires_at_ms, heartbeat_at_ms, locked_by,
        fencing_token, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, 1, 0, 0, 120000, 0, 'worker', ?, 0, 0)
    `);
    insertRunningJob.run(
      "job-a", "article-a", "revision-a-ko", "en",
      Buffer.alloc(32, 7), "dedupe-a", Buffer.alloc(32, 8),
    );
    expect(() => insertRunningJob.run(
      "job-b", "article-b", "revision-b-ko", "zh-Hans",
      Buffer.alloc(32, 9), "dedupe-b", Buffer.alloc(32, 10),
    )).toThrow();
    expect(() => db.prepare(`
      INSERT INTO article_translation_jobs (
        id, article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        created_at_ms, updated_at_ms
      ) VALUES ('job-invalid', 'article-b', 'revision-b-ko', 'en', 'running', ?, 'dedupe-invalid', 1, 0, 0, 0)
    `).run(Buffer.alloc(32, 11))).toThrow();
    db.prepare(`
      INSERT INTO article_review_runs (
        id, job_id, article_id, locale, source_revision_id, pass_kind, state,
        prompt_sha256, schema_sha256, source_sha256, output_sha256,
        model_id, cli_version, findings_json, exit_code, created_at_ms, finished_at_ms
      ) VALUES ('review-a', 'job-a', 'article-a', 'en', 'revision-a-ko', 'translation',
        'succeeded', ?, ?, ?, ?, 'fixed-model', 'codex 1', '{}', 0, 0, 1)
    `).run(
      Buffer.alloc(32, 12), Buffer.alloc(32, 13), Buffer.alloc(32, 14), Buffer.alloc(32, 15),
    );
    expect(() => db.prepare(
      "UPDATE article_review_runs SET findings_json = '{\"mutated\":true}' WHERE id = 'review-a'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(
      "DELETE FROM article_review_runs WHERE id = 'review-a'",
    ).run()).toThrow(/immutable/i);

    expect(() => db.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by
      ) VALUES (?, ?, ?, ?, 'active', 0, 'admin')
    `).run("release-invalid", "v-invalid", "/safe/invalid", Buffer.alloc(32, 16))).toThrow();
    const insertRelease = db.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by,
        verified_at_ms, verification_sha256, activated_at_ms
      ) VALUES (?, ?, ?, ?, 'active', 0, 'admin', 0, ?, 0)
    `);
    expect(() => insertRelease.run(
      "release-hash-mismatch", "v-hash-mismatch", "/safe/hash-mismatch",
      Buffer.alloc(32, 17), Buffer.alloc(32, 18),
    )).toThrow();
    insertRelease.run(
      "release-a", "v-a", "/safe/release-a", Buffer.alloc(32, 17), Buffer.alloc(32, 17),
    );
    expect(() => insertRelease.run(
      "release-b", "v-b", "/safe/release-b", Buffer.alloc(32, 19), Buffer.alloc(32, 19),
    )).toThrow();
    expect(() => db.prepare("DELETE FROM releases WHERE id = 'release-a'").run()).toThrow();
  });

  it("binds revision provenance to the same article and locale and requires complete Codex provenance", () => {
    testDatabase = createTestDatabase();
    const db = testDatabase.db.sqlite;
    const insertArticle = db.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, created_by_type, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'draft', 'ko', 'hermes', 0, 0)
    `);
    insertArticle.run("provenance-a", "provenance-a");
    insertArticle.run("provenance-b", "provenance-b");
    const insertBase = db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, ?, 1, 'Title', '', '# Body', ?, '[]', ?, 'draft', 0, 'hermes', 'hermes')
    `);
    insertBase.run("provenance-a-ko", "provenance-a", "ko", Buffer.alloc(32, 31), Buffer.alloc(32, 32));
    insertBase.run("provenance-b-ko", "provenance-b", "ko", Buffer.alloc(32, 33), Buffer.alloc(32, 34));
    insertBase.run("provenance-b-en", "provenance-b", "en", Buffer.alloc(32, 35), Buffer.alloc(32, 36));

    const insertCodex = db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, parent_revision_id, sources_json,
        prompt_sha256, schema_sha256, source_sha256, model_id,
        initial_review_state, created_at_ms, created_by_type, created_by_id
      ) VALUES (?, 'provenance-a', 'en', 1, 'Translated', '', '# Translated', ?, ?, ?, '[]',
        ?, ?, ?, ?, 'draft', 1, 'codex', 'codex-cli')
    `);
    const valid = [
      Buffer.alloc(32, 37), "provenance-a-ko", null,
      Buffer.alloc(32, 38), Buffer.alloc(32, 39), Buffer.alloc(32, 40), "fixed-model",
    ] as const;
    expect(() => insertCodex.run("codex-cross-source", ...[
      valid[0], "provenance-b-ko", valid[2], valid[3], valid[4], valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-cross-article-parent", ...[
      valid[0], valid[1], "provenance-b-en", valid[3], valid[4], valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-cross-locale-parent", ...[
      valid[0], valid[1], "provenance-a-ko", valid[3], valid[4], valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-missing-source", ...[
      valid[0], null, valid[2], valid[3], valid[4], valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-missing-prompt", ...[
      valid[0], valid[1], valid[2], null, valid[4], valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-missing-schema", ...[
      valid[0], valid[1], valid[2], valid[3], null, valid[5], valid[6],
    ])).toThrow();
    expect(() => insertCodex.run("codex-missing-model", ...[
      valid[0], valid[1], valid[2], valid[3], valid[4], valid[5], "",
    ])).toThrow();
    insertCodex.run("codex-valid", ...valid);
  });

  it("binds review runs to their exact job identity and enforces terminal job coherence", () => {
    testDatabase = createTestDatabase();
    const db = testDatabase.db.sqlite;
    db.exec(`
      INSERT INTO articles (
        id, slug, state, source_locale, created_by_type, created_at_ms, updated_at_ms
      ) VALUES
        ('job-article-a', 'job-article-a', 'draft', 'ko', 'hermes', 0, 0),
        ('job-article-b', 'job-article-b', 'draft', 'ko', 'hermes', 0, 0);
    `);
    const insertRevision = db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, ?, 1, 'Title', '', '# Body', ?, '[]', ?, 'draft', 0, 'hermes', 'hermes')
    `);
    insertRevision.run("job-a-ko", "job-article-a", "ko", Buffer.alloc(32, 41), Buffer.alloc(32, 42));
    insertRevision.run("job-a-en", "job-article-a", "en", Buffer.alloc(32, 43), Buffer.alloc(32, 44));
    insertRevision.run("job-b-ko", "job-article-b", "ko", Buffer.alloc(32, 45), Buffer.alloc(32, 46));

    const insertJob = db.prepare(`
      INSERT INTO article_translation_jobs (
        id, article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        result_revision_id, last_error_code, created_at_ms, updated_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0, ?)
    `);
    expect(() => insertJob.run(
      "queued-with-finish", "job-article-a", "job-a-ko", "en", "queued",
      Buffer.alloc(32, 47), "queued-with-finish", null, null, 1,
    )).toThrow();
    expect(() => insertJob.run(
      "failed-without-finish", "job-article-a", "job-a-ko", "en", "failed",
      Buffer.alloc(32, 48), "failed-without-finish", null, "failed", null,
    )).toThrow();
    expect(() => insertJob.run(
      "failed-with-result", "job-article-a", "job-a-ko", "en", "failed",
      Buffer.alloc(32, 49), "failed-with-result", "job-a-en", "failed", 1,
    )).toThrow();
    insertJob.run(
      "queued-review-job", "job-article-a", "job-a-ko", "en", "queued",
      Buffer.alloc(32, 50), "queued-review-job", null, null, null,
    );
    insertJob.run(
      "cancelled-review-job", "job-article-a", "job-a-ko", "en", "cancelled",
      Buffer.alloc(32, 54), "cancelled-review-job", null, "cancelled", 1,
    );
    db.prepare(`
      INSERT INTO article_translation_jobs (
        id, article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        locked_at_ms, lease_expires_at_ms, heartbeat_at_ms, locked_by,
        fencing_token, created_at_ms, updated_at_ms
      ) VALUES ('review-job', 'job-article-a', 'job-a-ko', 'en', 'running',
        ?, 'review-job', 1, 0, 1, 120000, 1, 'worker', ?, 0, 1)
    `).run(Buffer.alloc(32, 55), Buffer.alloc(32, 56));

    const insertReview = db.prepare(`
      INSERT INTO article_review_runs (
        id, job_id, article_id, locale, source_revision_id, pass_kind, state,
        prompt_sha256, schema_sha256, source_sha256, model_id, cli_version,
        findings_json, exit_code, created_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'translation', 'failed',
        ?, ?, ?, 'fixed-model', 'codex 1', '{}', 1, 0, 1)
    `);
    const reviewHashes = [Buffer.alloc(32, 51), Buffer.alloc(32, 52), Buffer.alloc(32, 53)] as const;
    expect(() => insertReview.run(
      "review-wrong-article", "review-job", "job-article-b", "en", "job-b-ko", ...reviewHashes,
    )).toThrow();
    expect(() => insertReview.run(
      "review-wrong-source", "review-job", "job-article-a", "en", "job-a-en", ...reviewHashes,
    )).toThrow();
    expect(() => insertReview.run(
      "review-wrong-locale", "review-job", "job-article-a", "zh-Hans", "job-a-ko", ...reviewHashes,
    )).toThrow();
    expect(() => insertReview.run(
      "review-queued", "queued-review-job", "job-article-a", "en", "job-a-ko", ...reviewHashes,
    )).toThrow();
    expect(() => insertReview.run(
      "review-cancelled", "cancelled-review-job", "job-article-a", "en", "job-a-ko", ...reviewHashes,
    )).toThrow();
    insertReview.run(
      "review-valid", "review-job", "job-article-a", "en", "job-a-ko", ...reviewHashes,
    );
  });

  it("requires an administrator for approved heads and binds publication artifacts to stored hashes", () => {
    testDatabase = createTestDatabase();
    const db = testDatabase.db.sqlite;
    db.exec(`
      INSERT INTO admins (
        id, username, display_name, password_hash, status, created_at_ms, updated_at_ms
      ) VALUES ('publishing-admin', 'publishing-admin', 'Publishing Admin', 'hash', 'active', 0, 0);
      INSERT INTO articles (
        id, slug, state, source_locale, created_by_type, created_at_ms, updated_at_ms
      ) VALUES ('publication-article', 'publication-article', 'draft', 'ko', 'hermes', 0, 0);
    `);
    const contentHash = Buffer.alloc(32, 61);
    db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES ('publication-revision', 'publication-article', 'ko', 1, 'Title', '',
        '# Body', ?, '[]', ?, 'draft', 0, 'hermes', 'hermes')
    `).run(contentHash, Buffer.alloc(32, 62));
    db.exec(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('publication-article', 'ko', 'publication-guide', 'draft',
        'publication-revision', 1, 0);
    `);
    expect(() => db.exec(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = 'publication-revision', approved_at_ms = 1
      WHERE article_id = 'publication-article' AND locale = 'ko';
    `)).toThrow();
    db.exec(`
      UPDATE article_locale_heads
      SET state = 'approved', approved_revision_id = 'publication-revision',
        approved_by_admin_id = 'publishing-admin', approved_at_ms = 1
      WHERE article_id = 'publication-article' AND locale = 'ko';
    `);
    expect(() => db.exec(`
      UPDATE article_locale_heads
      SET state = 'published', published_revision_id = 'publication-revision',
        published_at_ms = 2, approved_by_admin_id = NULL
      WHERE article_id = 'publication-article' AND locale = 'ko';
    `)).toThrow();
    db.exec(`
      UPDATE article_locale_heads
      SET state = 'published', published_revision_id = 'publication-revision',
        published_at_ms = 2
      WHERE article_id = 'publication-article' AND locale = 'ko';
    `);
    db.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by
      ) VALUES ('publication-release', 'publication-v1', '/safe/publication', ?, 'building', 0, 'admin')
    `).run(Buffer.alloc(32, 63));

    const insertEntry = db.prepare(`
      INSERT INTO release_entries (
        release_id, article_id, locale, slug, revision_id, content_sha256, route
      ) VALUES ('publication-release', 'publication-article', 'ko', 'publication-guide',
        'publication-revision', ?, '/insights/publication-guide')
    `);
    expect(() => insertEntry.run(Buffer.alloc(32, 64))).toThrow();
    insertEntry.run(contentHash);

    db.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by
      ) VALUES ('cleanup-release', 'cleanup-v1', '/safe/cleanup', ?, 'retired', 0, 'admin')
    `).run(Buffer.alloc(32, 70));
    db.prepare(`
      INSERT INTO release_entries (
        release_id, article_id, locale, slug, revision_id, content_sha256, route
      ) VALUES ('cleanup-release', 'publication-article', 'ko', 'publication-guide',
        'publication-revision', ?, '/insights/publication-guide')
    `).run(contentHash);
    expect(() => db.prepare(`
      DELETE FROM release_entries WHERE release_id = 'cleanup-release'
    `).run()).toThrow(/immutable/i);
    db.prepare("DELETE FROM releases WHERE id = 'cleanup-release'").run();
    expect(db.prepare(`
      SELECT count(*) count FROM release_entries WHERE release_id = 'cleanup-release'
    `).get()).toEqual({ count: 0 });

    const insertActivation = db.prepare(`
      INSERT INTO release_activations (
        id, release_id, operation, state, manifest_sha256, target_path, created_at_ms
      ) VALUES (?, 'publication-release', 'publish', 'failed', ?, '/safe/publication', 0)
    `);
    expect(() => insertActivation.run("activation-mismatch", Buffer.alloc(32, 65))).toThrow();
    insertActivation.run("activation-valid", Buffer.alloc(32, 63));

    const insertOutbox = db.prepare(`
      INSERT INTO publication_outbox (
        id, release_id, event_type, manifest_sha256, payload_json, state,
        attempt_count, available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'publication-release', 'indexnow', ?, '{}', 'pending', 0, 0, 0, 0)
    `);
    expect(() => insertOutbox.run("outbox-mismatch", Buffer.alloc(32, 66))).toThrow();
    insertOutbox.run("outbox-valid", Buffer.alloc(32, 63));
  });

  it.each([1, 2] as const)(
    "preserves real legacy content while upgrading a file-backed v%i database to v3",
    (legacyVersion) => {
      const directory = mkdtempSync(join(tmpdir(), `wisdom-control-v${legacyVersion}-content-`));
      const path = join(directory, "control.sqlite");
      const legacy = openDatabase(path);
      runMigrations(legacy, 1_000, legacyVersion);
      legacy.sqlite.prepare(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES ('legacy-article', 'legacy-guide', 'approved', 'ko',
          'legacy-revision', 'hermes', 100, 200)
      `).run();
      const legacyArticleRowId = (legacy.sqlite.prepare(
        "SELECT rowid FROM articles WHERE id = 'legacy-article'",
      ).get() as { rowid: number }).rowid;
      const legacyArticleRowIdHex = legacyArticleRowId.toString(16).padStart(16, "0");
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, translation_metadata_json, review_state,
          created_at_ms, created_by
        ) VALUES ('legacy-revision', 'legacy-article', 'ko', 7, '# Legacy body', ?,
          '[{"url":"https://example.com/source"}]', '{"legacy":true}', 'approved',
          150, 'legacy-worker')
      `).run(Buffer.alloc(32, 21));
      legacy.sqlite.exec(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES ('legacy-codex-article', 'legacy-codex', 'draft', 'ko',
          'legacy-codex-revision', 'system', 100, 200);
      `);
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, review_state, created_at_ms, created_by
        ) VALUES ('legacy-codex-revision', 'legacy-codex-article', 'ko', 1,
          '# Legacy Codex body', ?, '[]', 'draft', 150, 'codex')
      `).run(Buffer.alloc(32, 29));
      legacy.sqlite.exec(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES ('legacy-empty-article', 'legacy-empty', 'draft', 'ko',
          'legacy-empty-revision', 'hermes', 100, 200);
      `);
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, review_state, created_at_ms, created_by
        ) VALUES ('legacy-empty-revision', 'legacy-empty-article', 'ko', 1,
          '', ?, '[]', 'draft', 150, 'hermes')
      `).run(Buffer.alloc(32, 30));
      legacy.sqlite.prepare(`
        INSERT INTO jobs (
          id, type, state, payload_json, dedupe_key, attempt_count,
          available_at_ms, created_at_ms, updated_at_ms
        ) VALUES ('legacy-job', 'legacy-type', 'queued', '{"legacy":true}',
          'legacy-dedupe', 2, 300, 250, 250)
      `).run();
      legacy.sqlite.prepare(`
        INSERT INTO releases (
          id, version, path, manifest_sha256, state, created_at_ms, created_by, metadata_json
        ) VALUES ('legacy-release', 'legacy-v1', '/safe/legacy-release', ?,
          'retired', 300, 'legacy-worker', '{"legacy":true}')
      `).run(Buffer.alloc(32, 22));
      legacy.sqlite.prepare(`
        INSERT INTO releases (
          id, version, path, manifest_sha256, state, created_at_ms,
          activated_at_ms, created_by, metadata_json
        ) VALUES ('legacy-active-release', 'legacy-active-v1', '/safe/legacy-active', ?,
          'active', 301, 302, 'legacy-worker', '{"legacyActive":true}')
      `).run(Buffer.alloc(32, 28));
      const unsafeLegacySlug = ` Legacy ${"X".repeat(220)} / 한글 `;
      legacy.sqlite.prepare(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES ('weird-article', ?, 'draft', 'ko', 'weird-revision', 'hermes', 100, 200)
      `).run(unsafeLegacySlug);
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, translation_metadata_json, review_state,
          created_at_ms, created_by
        ) VALUES ('weird-revision', 'weird-article', 'ko', 1, '# Weird body', ?,
          '[]', NULL, 'draft', 150, 'hermes')
      `).run(Buffer.alloc(32, 23));
      const weirdRowId = (legacy.sqlite.prepare(
        "SELECT rowid FROM articles WHERE id = 'weird-article'",
      ).get() as { rowid: number }).rowid;
      const weirdRowIdHex = weirdRowId.toString(16).padStart(16, "0");
      const collisionPrefix = `collision-prefix-${"a".repeat(40)}`;
      for (const [suffix, row] of [["one", 1], ["two", 2]] as const) {
        const articleId = `${collisionPrefix}-${suffix}`;
        const revisionId = `collision-revision-${suffix}`;
        legacy.sqlite.prepare(`
          INSERT INTO articles (
            id, slug, state, source_locale, current_revision_id,
            created_by_type, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'draft', 'ko', ?, 'hermes', 100, 200)
        `).run(articleId, `Invalid / ${suffix}`, revisionId);
        legacy.sqlite.prepare(`
          INSERT INTO article_revisions (
            id, article_id, locale, revision_no, body_markdown, content_sha256,
            sources_json, translation_metadata_json, review_state,
            created_at_ms, created_by
          ) VALUES (?, ?, 'ko', 1, '# Collision', ?, '[]', NULL, 'draft', 150, 'hermes')
        `).run(revisionId, articleId, Buffer.alloc(32, 24));
        expect(row).toBeGreaterThan(0);
      }
      const mixedFallbackId = "mixed-fallback";
      legacy.sqlite.prepare(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES (?, 'Invalid / mixed fallback', 'draft', 'ko',
          'mixed-fallback-revision', 'hermes', 100, 200)
      `).run(mixedFallbackId);
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, review_state, created_at_ms, created_by
        ) VALUES ('mixed-fallback-revision', ?, 'ko', 1, '# Mixed fallback', ?,
          '[]', 'draft', 150, 'hermes')
      `).run(mixedFallbackId, Buffer.alloc(32, 67));
      const mixedFallbackRowId = (legacy.sqlite.prepare(
        "SELECT rowid FROM articles WHERE id = ?",
      ).get(mixedFallbackId) as { rowid: number }).rowid;
      const mixedIdHex = Buffer.from(mixedFallbackId, "utf8").toString("hex");
      const mixedRowIdHex = mixedFallbackRowId.toString(16).padStart(16, "0");
      const oldFallbackCandidate = `legacy-${mixedIdHex.slice(0, 64)}-${mixedRowIdHex}`;
      const reservedCollision = `legacy-migrated-${mixedIdHex.slice(0, 48)}-${mixedRowIdHex}`;
      for (const [kind, slug, hashByte] of [
        ["old", oldFallbackCandidate, 68],
        ["base", reservedCollision, 69],
      ] as const) {
        const articleId = `mixed-natural-${kind}`;
        const revisionId = `${articleId}-revision`;
        legacy.sqlite.prepare(`
          INSERT INTO articles (
            id, slug, state, source_locale, current_revision_id,
            created_by_type, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'draft', 'ko', ?, 'hermes', 100, 200)
        `).run(articleId, slug, revisionId);
        legacy.sqlite.prepare(`
          INSERT INTO article_revisions (
            id, article_id, locale, revision_no, body_markdown, content_sha256,
            sources_json, review_state, created_at_ms, created_by
          ) VALUES (?, ?, 'ko', 1, '# Natural collision', ?, '[]', 'draft', 150, 'hermes')
        `).run(revisionId, articleId, Buffer.alloc(32, hashByte));
      }
      const mixedNaturalBaseRowId = (legacy.sqlite.prepare(
        "SELECT rowid FROM articles WHERE id = 'mixed-natural-base'",
      ).get() as { rowid: number }).rowid;
      const mixedNaturalOldRowId = (legacy.sqlite.prepare(
        "SELECT rowid FROM articles WHERE id = 'mixed-natural-old'",
      ).get() as { rowid: number }).rowid;
      legacy.sqlite.prepare(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id, created_by_type,
          created_at_ms, updated_at_ms, published_at_ms
        ) VALUES ('multi-locale-article', 'multi-locale', 'published', 'ko',
          'multi-ko-approved', 'admin', 100, 400, 350)
      `).run();
      const insertMultiRevision = legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, translation_metadata_json, review_state, created_at_ms, created_by
        ) VALUES (?, 'multi-locale-article', ?, ?, ?, ?, '[]', NULL, ?, ?, 'admin')
      `);
      insertMultiRevision.run(
        "multi-ko-approved", "ko", 1, "# Approved Korean", Buffer.alloc(32, 25), "approved", 200,
      );
      insertMultiRevision.run(
        "multi-ko-newer-draft", "ko", 2, "# Newer draft", Buffer.alloc(32, 26), "draft", 300,
      );
      insertMultiRevision.run(
        "multi-en-draft", "en", 1, "# English draft", Buffer.alloc(32, 27), "draft", 300,
      );
      closeDatabase(legacy);

      const upgraded = openDatabase(path);
      runMigrations(upgraded, 2_000);
      expect(upgraded.sqlite.prepare(`
        SELECT id, article_id, locale, revision_no, title, summary, body_markdown,
          content_sha256, sources_json, source_sha256, translation_metadata_json,
          initial_review_state, created_by_type, created_by_id
        FROM article_revisions WHERE id = 'legacy-revision'
      `).get()).toEqual({
        id: "legacy-revision",
        article_id: "legacy-article",
        locale: "ko",
        revision_no: 7,
        title: "legacy-guide",
        summary: "",
        body_markdown: "# Legacy body",
        content_sha256: Buffer.alloc(32, 21),
        sources_json: '[{"url":"https://example.com/source"}]',
        source_sha256: Buffer.alloc(32, 21),
        translation_metadata_json: '{"legacy":true}',
        initial_review_state: "approved",
        created_by_type: "system",
        created_by_id: "legacy-worker",
      });
      expect(upgraded.sqlite.prepare(`
        SELECT article_id, locale, slug, state, head_revision_id, approved_revision_id
        FROM article_locale_heads WHERE article_id = 'legacy-article'
      `).get()).toEqual({
        article_id: "legacy-article",
        locale: "ko",
        slug: `legacy-v3-${legacyArticleRowIdHex}`,
        state: "in_review",
        head_revision_id: "legacy-revision",
        approved_revision_id: null,
      });
      expect(upgraded.sqlite.prepare(`
        SELECT created_by_type, created_by_id
        FROM article_revisions WHERE id = 'legacy-codex-revision'
      `).get()).toEqual({ created_by_type: "system", created_by_id: "codex" });
      expect(upgraded.sqlite.prepare(`
        SELECT body_markdown, created_by_type, created_by_id
        FROM article_revisions WHERE id = 'legacy-empty-revision'
      `).get()).toEqual({
        body_markdown: "", created_by_type: "system", created_by_id: "hermes",
      });
      expect(upgraded.sqlite.prepare(
        "SELECT id, type, state, payload_json, dedupe_key, attempt_count FROM jobs",
      ).get()).toEqual({
        id: "legacy-job", type: "legacy-type", state: "queued",
        payload_json: '{"legacy":true}', dedupe_key: "legacy-dedupe", attempt_count: 2,
      });
      expect(upgraded.sqlite.prepare(
        "SELECT id, version, path, state, metadata_json FROM releases",
      ).get()).toEqual({
        id: "legacy-release", version: "legacy-v1", path: "/safe/legacy-release",
        state: "retired", metadata_json: '{"legacy":true}',
      });
      expect(upgraded.sqlite.prepare(`
        SELECT state, verified_at_ms, verification_sha256
        FROM releases WHERE id = 'legacy-active-release'
      `).get()).toEqual({ state: "retired", verified_at_ms: null, verification_sha256: null });
      expect(upgraded.sqlite.prepare(
        "SELECT slug FROM articles WHERE id = 'weird-article'",
      ).get()).toEqual({ slug: unsafeLegacySlug });
      expect(upgraded.sqlite.prepare(`
        SELECT title, summary, source_sha256, translation_metadata_json, initial_review_state
        FROM article_revisions WHERE id = 'weird-revision'
      `).get()).toEqual({
        title: `Legacy article 77656972642d61727469636c65-${weirdRowIdHex}`,
        summary: "",
        source_sha256: Buffer.alloc(32, 23),
        translation_metadata_json: null,
        initial_review_state: "draft",
      });
      expect(upgraded.sqlite.prepare(`
        SELECT slug FROM article_locale_heads WHERE article_id = 'weird-article' AND locale = 'ko'
      `).get()).toEqual({
        slug: `legacy-v3-${weirdRowIdHex}`,
      });
      const collisionHeads = upgraded.sqlite.prepare(`
        SELECT slug FROM article_locale_heads WHERE article_id LIKE 'collision-prefix-%'
        ORDER BY article_id
      `).all() as Array<{ slug: string }>;
      expect(collisionHeads).toHaveLength(2);
      expect(new Set(collisionHeads.map((row) => row.slug)).size).toBe(2);
      for (const { slug } of collisionHeads) {
        expect(slug).toMatch(/^legacy-v3-[a-f0-9]{16}$/);
        expect(slug.length).toBeLessThanOrEqual(96);
      }
      expect(upgraded.sqlite.prepare(`
        SELECT article_id, slug FROM article_locale_heads
        WHERE article_id IN ('mixed-fallback', 'mixed-natural-old', 'mixed-natural-base')
        ORDER BY article_id
      `).all()).toEqual([
        {
          article_id: "mixed-fallback",
          slug: `legacy-v3-${mixedRowIdHex}`,
        },
        {
          article_id: "mixed-natural-base",
          slug: `legacy-v3-${mixedNaturalBaseRowId.toString(16).padStart(16, "0")}`,
        },
        {
          article_id: "mixed-natural-old",
          slug: `legacy-v3-${mixedNaturalOldRowId.toString(16).padStart(16, "0")}`,
        },
      ]);
      expect(upgraded.sqlite.prepare(`
        SELECT locale, state, head_revision_id, approved_revision_id, published_revision_id
        FROM article_locale_heads WHERE article_id = 'multi-locale-article'
        ORDER BY locale
      `).all()).toEqual([
        {
          locale: "en", state: "draft", head_revision_id: "multi-en-draft",
          approved_revision_id: null, published_revision_id: null,
        },
        {
          locale: "ko", state: "draft", head_revision_id: "multi-ko-newer-draft",
          approved_revision_id: null, published_revision_id: null,
        },
      ]);
      closeDatabase(upgraded);

      const restarted = openDatabase(path);
      runMigrations(restarted, 3_000);
      expect(restarted.sqlite.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      ).all()).toHaveLength(3);
      expect(restarted.sqlite.prepare(
        "SELECT body_markdown FROM article_revisions WHERE id = 'legacy-revision'",
      ).get()).toEqual({ body_markdown: "# Legacy body" });
      closeDatabase(restarted);
      rmSync(directory, { force: true, recursive: true });
    },
  );

  it("rejects migration histories that are not an exact contiguous known prefix", () => {
    const histories = [
      [{ version: 2, name: "admin-notification-withdrawal" }],
      [{ version: 1, name: "wrong-name" }],
      [
        { version: 1, name: "initial-control-schema" },
        { version: 2, name: "admin-notification-withdrawal" },
        { version: 4, name: "future-schema" },
      ],
    ];
    for (const history of histories) {
      const db = openDatabase(":memory:");
      try {
        db.sqlite.exec(`
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
          )
        `);
        const insert = db.sqlite.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, 0)",
        );
        for (const row of history) insert.run(row.version, row.name);
        expect(() => runMigrations(db, 1_000), JSON.stringify(history)).toThrow(/migration/i);
        expect(db.sqlite.prepare(
          "SELECT count(*) count FROM sqlite_master WHERE type = 'table' AND name = 'consultations'",
        ).get()).toEqual({ count: 0 });
      } finally {
        closeDatabase(db);
      }
    }
  });

  it("rolls back a v3 failure after the revision table rebuild and remains restart-safe", () => {
    const directory = mkdtempSync(join(tmpdir(), "wisdom-control-v3-rollback-"));
    const path = join(directory, "control.sqlite");
    const legacy = openDatabase(path);
    try {
      runMigrations(legacy, 1_000, 2);
      legacy.sqlite.exec(`
        INSERT INTO articles (
          id, slug, state, source_locale, current_revision_id,
          created_by_type, created_at_ms, updated_at_ms
        ) VALUES ('rollback-article', 'rollback-article', 'draft', 'ko',
          'rollback-revision', 'hermes', 0, 0);
      `);
      legacy.sqlite.prepare(`
        INSERT INTO article_revisions (
          id, article_id, locale, revision_no, body_markdown, content_sha256,
          sources_json, review_state, created_at_ms, created_by
        ) VALUES ('rollback-revision', 'rollback-article', 'ko', 1, '# Original', ?,
          '[]', 'draft', 0, 'hermes')
      `).run(Buffer.alloc(32, 71));
      legacy.sqlite.exec("CREATE TABLE article_locale_heads (blocker TEXT)");

      expect(() => runMigrations(legacy, 2_000)).toThrow();
      expect(legacy.sqlite.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      ).all()).toEqual([
        { version: 1, name: "initial-control-schema" },
        { version: 2, name: "admin-notification-withdrawal" },
      ]);
      const columns = (legacy.sqlite.pragma("table_info(article_revisions)") as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toContain("review_state");
      expect(columns).not.toContain("title");
      expect(legacy.sqlite.prepare(
        "SELECT id, body_markdown, review_state FROM article_revisions",
      ).get()).toEqual({
        id: "rollback-revision", body_markdown: "# Original", review_state: "draft",
      });
    } finally {
      closeDatabase(legacy);
    }

    const restarted = openDatabase(path);
    try {
      expect(() => runMigrations(restarted, 3_000)).toThrow();
      expect(restarted.sqlite.prepare(
        "SELECT max(version) version FROM schema_migrations",
      ).get()).toEqual({ version: 2 });
      expect(restarted.sqlite.prepare(
        "SELECT body_markdown FROM article_revisions WHERE id = 'rollback-revision'",
      ).get()).toEqual({ body_markdown: "# Original" });
    } finally {
      closeDatabase(restarted);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports ready only for the exact full history and required v3 schema invariants", () => {
    for (const mutation of [
      "ALTER TABLE consultations DROP COLUMN marketing_withdrawn_at_ms",
      "DROP TABLE admin_pre_auth_challenges",
      "DROP INDEX notification_outbox_lease_idx",
      "DROP TABLE article_locale_heads",
      "DROP INDEX article_translation_jobs_one_running_uidx",
      "DROP TRIGGER article_revisions_immutable_update",
      `DROP TRIGGER article_revisions_immutable_update;
        CREATE TRIGGER article_revisions_immutable_update
        BEFORE UPDATE ON article_revisions BEGIN SELECT 1; END`,
      `DROP INDEX article_translation_jobs_one_running_uidx;
        CREATE INDEX article_translation_jobs_one_running_uidx
        ON article_translation_jobs((1)) WHERE state = 'running'`,
      "ALTER TABLE releases DROP COLUMN activation_generation",
    ]) {
      const database = createTestDatabase();
      try {
        expect(isDatabaseReady(database.db)).toBe(true);
        database.db.sqlite.exec(mutation);
        expect(isDatabaseReady(database.db), mutation).toBe(false);
      } finally {
        database.close();
      }
    }
  });

  it("upgrades a file-backed v1 database to v3 without losing consultations or sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "wisdom-control-v1-"));
    const path = join(directory, "control.sqlite");
    const v1 = openDatabase(path);
    (runMigrations as unknown as (db: typeof v1, nowMs: number, targetVersion: number) => void)(v1, 1_000, 1);
    expect(v1.sqlite.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({ version: 1 });
    v1.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('consultation-v1', 'receipt-v1', 'received', 'ko', 'procurement', 'phone',
        'opaque-envelope', 'pii-v1', ?, NULL, 'pii-v1', 0, 1000, 1000, 2000, 1)
    `).run(Buffer.alloc(32, 1));
    v1.sqlite.prepare(`
      INSERT INTO admins (
        id, username, display_name, password_hash, status, created_at_ms, updated_at_ms
      ) VALUES ('admin-v1', 'owner', 'Owner', 'argon-placeholder', 'active', 1000, 1000)
    `).run();
    v1.sqlite.prepare(`
      INSERT INTO admin_sessions (
        token_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms,
        idle_expires_at_ms, last_seen_at_ms
      ) VALUES (?, 'admin-v1', ?, 1000, 2000, 1500, 1000)
    `).run(Buffer.alloc(32, 2), Buffer.alloc(32, 3));
    closeDatabase(v1);

    const upgraded = openDatabase(path);
    runMigrations(upgraded, 3_000);
    expect(upgraded.sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
    ]);
    expect(upgraded.sqlite.prepare("SELECT id FROM consultations").all()).toEqual([{ id: "consultation-v1" }]);
    expect(upgraded.sqlite.prepare("SELECT admin_id FROM admin_sessions").all()).toEqual([{ admin_id: "admin-v1" }]);
    const upgradedTables = upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => (row as { name: string }).name);
    expect(upgradedTables).toEqual(expect.arrayContaining([
      "admin_recovery_codes",
      "admin_pre_auth_challenges",
      "admin_login_buckets",
      "notification_delivery_attempts",
      "marketing_withdrawal_capabilities",
      "article_locale_heads",
      "article_translation_jobs",
      "release_activations",
    ]));
    const columns = (table: string) => (
      upgraded.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns("consultations")).toContain("marketing_withdrawn_at_ms");
    expect(columns("admins")).toContain("totp_last_counter");
    expect(columns("notification_outbox")).toEqual(expect.arrayContaining([
      "lease_expires_at_ms",
      "purpose",
      "delivery_cycle",
    ]));
    expect(() => upgraded.sqlite.prepare(`
      INSERT INTO admin_login_buckets (
        subject_kind, subject_hash, window_start_ms, failure_count, expires_at_ms
      ) VALUES ('invalid', ?, 0, 1, 1)
    `).run(Buffer.alloc(32))).toThrow();

    closeDatabase(upgraded);
    const restarted = openDatabase(path);
    runMigrations(restarted, 4_000);
    expect(restarted.sqlite.prepare("SELECT count(*) count FROM schema_migrations").get()).toEqual({ count: 3 });
    closeDatabase(restarted);
    rmSync(directory, { force: true, recursive: true });
  });

  it("normalizes a legacy v1 processing outbox row before a v2 restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "wisdom-control-v1-outbox-"));
    const path = join(directory, "control.sqlite");
    const v1 = openDatabase(path);
    try {
      (runMigrations as unknown as (db: typeof v1, nowMs: number, targetVersion: number) => void)(v1, 1_000, 1);
      v1.sqlite.prepare(`
        INSERT INTO consultations (
          id, receipt_id, status, locale, category, preferred_contact,
          pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
          marketing_accepted, received_at_ms, updated_at_ms,
          retention_expires_at_ms, row_version
        ) VALUES ('legacy-consultation', 'legacy-receipt', 'received', 'ko', 'procurement', 'phone',
          'opaque-envelope', 'pii-v1', ?, 'pii-v1', 0, 1000, 1000, 2000, 1)
      `).run(Buffer.alloc(32, 9));
      v1.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, state, attempt_count,
          available_at_ms, locked_at_ms, locked_by, created_at_ms, updated_at_ms
        ) VALUES ('legacy-delivery', 'legacy-consultation', 'email',
          'consultation.received', 'processing', 1, 1000, 1000, 'legacy-worker', 1000, 1000)
      `).run();
    } finally {
      closeDatabase(v1);
    }

    const upgraded = openDatabase(path);
    try {
      runMigrations(upgraded, 2_000);
      expect(upgraded.sqlite.prepare(`
        SELECT state, locked_at_ms, locked_by, lease_expires_at_ms, purpose, delivery_cycle
        FROM notification_outbox WHERE id = 'legacy-delivery'
      `).get()).toEqual({
        state: "pending",
        locked_at_ms: null,
        locked_by: null,
        lease_expires_at_ms: null,
        purpose: "transactional",
        delivery_cycle: 1,
      });
    } finally {
      closeDatabase(upgraded);
    }

    const restarted = openDatabase(path);
    try {
      runMigrations(restarted, 3_000);
      expect(restarted.sqlite.prepare(`
        SELECT state, locked_at_ms, locked_by, lease_expires_at_ms
        FROM notification_outbox WHERE id = 'legacy-delivery'
      `).get()).toEqual({
        state: "pending",
        locked_at_ms: null,
        locked_by: null,
        lease_expires_at_ms: null,
      });
    } finally {
      closeDatabase(restarted);
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("applies repeatable migrations and required PRAGMAs on every connection", () => {
    testDatabase = createTestDatabase();
    runMigrations(testDatabase.db);

    const pragma = (name: string) => testDatabase!.db.sqlite.pragma(name, { simple: true });
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(2);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("secure_delete")).toBe(1);
    expect(testDatabase.db.sqlite.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({
      version: SCHEMA_VERSION,
    });

    const tables = testDatabase.db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => (row as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining([...REQUIRED_TABLES]));

    const indexes = testDatabase.db.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => (row as { name: string }).name);
    expect(indexes).toEqual(expect.arrayContaining([...REQUIRED_INDEXES]));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO admin_pre_auth_challenges (
        challenge_hash, admin_id, csrf_hash, created_at_ms, expires_at_ms
      ) VALUES (?, 'missing-admin', ?, 0, 1)
    `).run(Buffer.alloc(31), Buffer.alloc(32))).toThrow();

    const insertConsultation = testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 1, 0, 0, 1000, 1)
    `);
    insertConsultation.run("consultation-a", "receipt-a", Buffer.alloc(32, 1));
    insertConsultation.run("consultation-b", "receipt-b", Buffer.alloc(32, 2));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('consultation-c', 'receipt-c', 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 0, 0, 0, 1000, 1)
    `).run(Buffer.alloc(32, 5));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES ('marketing-document', 'bundle', 'marketing', 'ko', 'm-v1',
        'Marketing', 'Terms', ?, 24, 'active', 0)
    `).run(Buffer.alloc(32, 3));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_documents (
        id, bundle_id, kind, locale, version, title, body_markdown,
        content_sha256, retention_months, state, created_at_ms
      ) VALUES ('privacy-document', 'bundle', 'privacy', 'ko', 'p-v1',
        'Privacy', 'Terms', ?, 12, 'active', 0)
    `).run(Buffer.alloc(32, 6));
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('marketing-event-a', 'consultation-a', 'marketing-document',
        'marketing', 'accepted', 1, 'm-v1', ?, 'visitor', 'request-a', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'marketing-event-a', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 4))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('privacy-event-b', 'consultation-b', 'privacy-document',
        'privacy', 'accepted', 1, 'p-v1', ?, 'visitor', 'request-b', 0)
    `).run(Buffer.alloc(32, 6));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'privacy-event-b', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 7))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('declined-event-b', 'consultation-b', 'marketing-document',
        'marketing', 'declined', 1, 'm-v1', ?, 'visitor', 'request-b', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-b', 'declined-event-b', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 8))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES ('accepted-event-c', 'consultation-c', 'marketing-document',
        'marketing', 'accepted', 1, 'm-v1', ?, 'visitor', 'request-c', 0)
    `).run(Buffer.alloc(32, 3));
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-c', 'accepted-event-c', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 9))).toThrow();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO marketing_withdrawal_capabilities (
        token_hash, consultation_id, consent_event_id, locale,
        created_at_ms, expires_at_ms
      ) VALUES (?, 'consultation-a', 'marketing-event-a', 'ko', 0, 1000)
    `).run(Buffer.alloc(32, 10));
    expect(() => testDatabase!.db.sqlite.prepare(`
      UPDATE marketing_withdrawal_capabilities
      SET consultation_id = 'consultation-b'
      WHERE token_hash = ?
    `).run(Buffer.alloc(32, 10))).toThrow();
  });

  it("enforces foreign keys and reopens a file-backed WAL database", () => {
    testDatabase = createTestDatabase();
    expect(() => testDatabase!.db.sqlite.prepare(`
      INSERT INTO consent_events (
        id, consultation_id, document_id, kind, decision, sequence,
        document_version, document_sha256, actor_type, request_id, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("event", "missing", "missing", "privacy", "accepted", 1, "v1", Buffer.alloc(32), "visitor", "req", 1)).toThrow();

    const path = testDatabase.path;
    closeDatabase(testDatabase.db);
    const reopened = openDatabase(path);
    runMigrations(reopened);
    expect(reopened.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    closeDatabase(reopened);
  });
});
