import { createHash, randomUUID } from "node:crypto";

import { computePublishedArticleContentSha256 } from "@wisdom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { blindIndex, createStaticKeyProvider } from "../crypto/index.js";
import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  changeArticleLocaleState,
  changeArticleLocaleSlug,
  computeArticleTranslationInputSha256,
  enqueueArticleTranslation,
  type ArticleWorkflowFaultPoint,
} from "./workflow.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const REVISION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-07-16T01:00:00.000Z");
const SOURCES = [{
  id: "official-source",
  url: "https://example.com/official",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
}];
const SOURCE_SUMMARY = "Official procurement overview. Contact private@example.com";
const SOURCE_BODY = "## Complete answer\n\nReviewed public guidance.\n";
const SOURCE_CONTENT_SHA256 = Buffer.from(computePublishedArticleContentSha256({
  title: "Procurement guide",
  summary: SOURCE_SUMMARY,
  bodyMarkdown: SOURCE_BODY,
  sources: SOURCES,
  locale: "ko",
}), "hex");

let fixture: TestDatabase;
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 91) });

beforeEach(() => {
  fixture = createTestDatabase();
  fixture.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms
    ) VALUES (?, 'reviewer', 'Review Administrator', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms
    ) VALUES (?, 'procurement-guide', 'draft', 'ko', ?, 'hermes', 0, 0)
  `).run(ARTICLE_ID, REVISION_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO article_revisions (
      id, article_id, locale, revision_no, title, summary, body_markdown,
      content_sha256, sources_json, source_sha256, initial_review_state,
      created_at_ms, created_by_type, created_by_id
    ) VALUES (?, ?, 'ko', 1, 'Procurement guide', ?, ?, ?, ?, ?, 'draft', 0, 'hermes', 'hermes-draft-1')
  `).run(
    REVISION_ID,
    ARTICLE_ID,
    SOURCE_SUMMARY,
    SOURCE_BODY,
    SOURCE_CONTENT_SHA256,
    JSON.stringify(SOURCES),
    Buffer.alloc(32, 2),
  );
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
    ) VALUES (?, 'ko', 'procurement-guide', 'draft', ?, 1, 0)
  `).run(ARTICLE_ID, REVISION_ID);
});

afterEach(() => fixture.close());

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++]!;
}

function transition(
  targetState: "draft" | "in_review" | "approved" | "rejected",
  expectedRowVersion: number,
  faultInjector?: (point: ArticleWorkflowFaultPoint) => void,
) {
  return changeArticleLocaleState(fixture.db, {
    articleId: ARTICLE_ID,
    locale: "ko",
    targetState,
    expectedRowVersion,
    actorAdminId: ADMIN_ID,
    requestId: "request-article-workflow",
    nowMs: NOW,
  }, {
    randomUUID,
    ...(faultInjector ? { faultInjector } : {}),
  });
}

describe("administrator article locale workflow", () => {
  it("updates an unapproved locale slug with optimistic versioning while keeping the locale head authoritative", () => {
    expect(changeArticleLocaleSlug(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "ko",
      slug: "public-procurement-guide",
      expectedRowVersion: 1,
      actorAdminId: ADMIN_ID,
      requestId: "request-change-slug",
      nowMs: NOW,
    }, { randomUUID: () => AUDIT_ID })).toEqual({
      kind: "updated",
      httpStatus: 200,
      slug: "public-procurement-guide",
      state: "draft",
      rowVersion: 2,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT slug, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = 'ko'
    `).get(ARTICLE_ID)).toEqual({ slug: "public-procurement-guide", row_version: 2 });
    expect(fixture.db.sqlite.prepare("SELECT slug FROM articles WHERE id = ?").get(ARTICLE_ID)).toEqual({
      slug: "procurement-guide",
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT action, target_id, metadata_json FROM audit_events
    `).get()).toEqual({
      action: "article.locale_slug.changed",
      target_id: `${ARTICLE_ID}:ko`,
      metadata_json: JSON.stringify({
        locale: "ko",
        fromSlug: "procurement-guide",
        toSlug: "public-procurement-guide",
        rowVersion: 2,
      }),
    });
  });

  it("rejects unsafe, stale, duplicate, and approved slug changes without writes", () => {
    expect(changeArticleLocaleSlug(fixture.db, {
      articleId: ARTICLE_ID, locale: "ko", slug: "Unsafe Slug", expectedRowVersion: 1,
      actorAdminId: ADMIN_ID, requestId: "request", nowMs: NOW,
    })).toEqual({ kind: "invalid-slug", httpStatus: 422 });
    expect(changeArticleLocaleSlug(fixture.db, {
      articleId: ARTICLE_ID, locale: "ko", slug: "safe-slug", expectedRowVersion: 9,
      actorAdminId: ADMIN_ID, requestId: "request", nowMs: NOW,
    })).toMatchObject({ kind: "conflict", httpStatus: 409, rowVersion: 1 });

    fixture.db.sqlite.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, current_revision_id,
        created_by_type, created_at_ms, updated_at_ms
      ) VALUES ('99999999-9999-4999-8999-999999999991', 'other', 'draft', 'ko',
        '99999999-9999-4999-8999-999999999992', 'system', 0, 0)
    `).run();
    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES ('99999999-9999-4999-8999-999999999992',
        '99999999-9999-4999-8999-999999999991', 'ko', 1, 'Other', 'Other summary',
        '## Other\n', ?, ?, ?, 'draft', 0, 'system', 'seed')
    `).run(Buffer.alloc(32, 71), JSON.stringify(SOURCES), Buffer.alloc(32, 72));
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES ('99999999-9999-4999-8999-999999999991', 'ko', 'reserved-slug',
        'draft', '99999999-9999-4999-8999-999999999992', 1, 0)
    `).run();
    expect(changeArticleLocaleSlug(fixture.db, {
      articleId: ARTICLE_ID, locale: "ko", slug: "reserved-slug", expectedRowVersion: 1,
      actorAdminId: ADMIN_ID, requestId: "request", nowMs: NOW,
    })).toEqual({ kind: "slug-conflict", httpStatus: 409 });

    expect(transition("in_review", 1)).toMatchObject({ kind: "updated" });
    expect(transition("approved", 2)).toMatchObject({ kind: "updated" });
    expect(changeArticleLocaleSlug(fixture.db, {
      articleId: ARTICLE_ID, locale: "ko", slug: "approved-change", expectedRowVersion: 3,
      actorAdminId: ADMIN_ID, requestId: "request", nowMs: NOW,
    })).toMatchObject({ kind: "state-blocked", httpStatus: 422, state: "approved" });
  });

  it("moves draft to review and then approval with optimistic versioning and audit", () => {
    expect(transition("in_review", 1)).toEqual({
      kind: "updated",
      httpStatus: 200,
      state: "in_review",
      rowVersion: 2,
      headRevisionId: REVISION_ID,
    });
    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "ko",
      targetState: "approved",
      expectedRowVersion: 2,
      actorAdminId: ADMIN_ID,
      requestId: "request-approve",
      nowMs: NOW + 1,
    }, { randomUUID: ids("55555555-5555-4555-8555-555555555555") })).toEqual({
      kind: "updated",
      httpStatus: 200,
      state: "approved",
      rowVersion: 3,
      headRevisionId: REVISION_ID,
    });

    expect(fixture.db.sqlite.prepare(`
      SELECT state, head_revision_id, approved_revision_id,
        reviewed_by_admin_id, reviewed_at_ms,
        approved_by_admin_id, approved_at_ms, row_version
      FROM article_locale_heads WHERE article_id = ? AND locale = 'ko'
    `).get(ARTICLE_ID)).toEqual({
      state: "approved",
      head_revision_id: REVISION_ID,
      approved_revision_id: REVISION_ID,
      reviewed_by_admin_id: ADMIN_ID,
      reviewed_at_ms: NOW + 1,
      approved_by_admin_id: ADMIN_ID,
      approved_at_ms: NOW + 1,
      row_version: 3,
    });
    expect(fixture.db.sqlite.prepare(
      "SELECT state, current_revision_id, updated_at_ms FROM articles WHERE id = ?",
    ).get(ARTICLE_ID)).toEqual({
      state: "approved",
      current_revision_id: REVISION_ID,
      updated_at_ms: NOW + 1,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT actor_type, actor_id, action, target_type, target_id, request_id, metadata_json
      FROM audit_events ORDER BY created_at_ms, id
    `).all()).toEqual([
      {
        actor_type: "admin",
        actor_id: ADMIN_ID,
        action: "article.locale_state.changed",
        target_type: "article-locale",
        target_id: `${ARTICLE_ID}:ko`,
        request_id: "request-article-workflow",
        metadata_json: JSON.stringify({
          locale: "ko", fromState: "draft", toState: "in_review",
          revisionId: REVISION_ID, rowVersion: 2,
        }),
      },
      {
        actor_type: "admin",
        actor_id: ADMIN_ID,
        action: "article.locale_state.changed",
        target_type: "article-locale",
        target_id: `${ARTICLE_ID}:ko`,
        request_id: "request-approve",
        metadata_json: JSON.stringify({
          locale: "ko", fromState: "in_review", toState: "approved",
          revisionId: REVISION_ID, rowVersion: 3,
        }),
      },
    ]);
  });

  it("enforces the exact non-publication transition matrix and treats same-state requests as unchanged", () => {
    expect(transition("approved", 1)).toMatchObject({ kind: "invalid-transition", httpStatus: 422 });
    expect(transition("draft", 1)).toEqual({
      kind: "unchanged", httpStatus: 200, state: "draft", rowVersion: 1,
      headRevisionId: REVISION_ID,
    });
    expect(transition("in_review", 1)).toMatchObject({ kind: "updated" });
    expect(transition("draft", 2)).toMatchObject({ kind: "updated", state: "draft", rowVersion: 3 });
    expect(transition("rejected", 3)).toMatchObject({ kind: "updated", state: "rejected", rowVersion: 4 });
    expect(transition("draft", 4)).toMatchObject({ kind: "invalid-transition", httpStatus: 422 });

    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'published', approved_revision_id = head_revision_id,
        published_revision_id = head_revision_id, approved_by_admin_id = ?,
        approved_at_ms = ?, published_at_ms = ?, row_version = 5
      WHERE article_id = ? AND locale = 'ko'
    `).run(ADMIN_ID, NOW, NOW, ARTICLE_ID);
    expect(transition("approved", 5)).toMatchObject({ kind: "invalid-transition", httpStatus: 422 });
  });

  it("returns conflicts without writes and rolls all writes back at every fault boundary", () => {
    expect(transition("in_review", 9)).toEqual({
      kind: "conflict", httpStatus: 409, state: "draft", rowVersion: 1,
      headRevisionId: REVISION_ID,
    });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });

    for (const point of ["after-head", "after-article", "after-audit"] as const) {
      expect(() => transition("in_review", 1, (candidate) => {
        if (candidate === point) throw new Error(point);
      })).toThrow(point);
      expect(fixture.db.sqlite.prepare(`
        SELECT state, row_version FROM article_locale_heads WHERE article_id = ? AND locale = 'ko'
      `).get(ARTICLE_ID)).toEqual({ state: "draft", row_version: 1 });
      expect(fixture.db.sqlite.prepare("SELECT state FROM articles WHERE id = ?").get(ARTICLE_ID)).toEqual({ state: "draft" });
      expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
    }
  });

  it("keeps the legacy article projection bound to the source locale only", () => {
    approveSource();
    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        prompt_sha256, schema_sha256, model_id, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES ('88888888-8888-4888-8888-888888888888', ?, 'en', 1,
        'English', 'English summary', '## English\n', ?, ?, ?, ?, ?, ?,
        'fixed-model', 'in_review', 1, 'codex', 'job-en')
    `).run(
      ARTICLE_ID, Buffer.alloc(32, 21), REVISION_ID, JSON.stringify(SOURCES),
      Buffer.alloc(32, 22), Buffer.alloc(32, 23), Buffer.alloc(32, 24),
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-guide', 'in_review',
        '88888888-8888-4888-8888-888888888888', 1, 1)
    `).run(ARTICLE_ID);
    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "en",
      targetState: "approved",
      expectedRowVersion: 1,
      actorAdminId: ADMIN_ID,
      requestId: "request-approve-en",
      nowMs: NOW,
    })).toMatchObject({ kind: "updated", state: "approved" });
    expect(fixture.db.sqlite.prepare(
      "SELECT state, current_revision_id, updated_at_ms FROM articles WHERE id = ?",
    ).get(ARTICLE_ID)).toEqual({
      state: "approved", current_revision_id: REVISION_ID, updated_at_ms: NOW,
    });
  });

  it("demotes approved derived locales and refuses stale derivative approval after source revocation", () => {
    approveSource();
    const translatedRevisionId = "88888888-8888-4888-8888-888888888888";
    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        prompt_sha256, schema_sha256, model_id, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'en', 1, 'English', 'English summary', '## English\n',
        ?, ?, ?, ?, ?, ?, 'fixed-model', 'in_review', 1, 'codex', 'job-en')
    `).run(
      translatedRevisionId, ARTICLE_ID, Buffer.alloc(32, 21), REVISION_ID,
      JSON.stringify(SOURCES), Buffer.alloc(32, 22), Buffer.alloc(32, 23),
      Buffer.alloc(32, 24),
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-guide', 'in_review', ?, 1, 1)
    `).run(ARTICLE_ID, translatedRevisionId);
    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "en",
      targetState: "approved",
      expectedRowVersion: 1,
      actorAdminId: ADMIN_ID,
      requestId: "request-approve-en",
      nowMs: NOW + 10,
    })).toMatchObject({ kind: "updated", state: "approved", rowVersion: 2 });

    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "ko",
      targetState: "in_review",
      expectedRowVersion: 3,
      actorAdminId: ADMIN_ID,
      requestId: "request-revoke-source",
      nowMs: NOW + 20,
    })).toMatchObject({ kind: "updated", state: "in_review", rowVersion: 4 });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, approved_revision_id, approved_by_admin_id, approved_at_ms,
        reviewed_by_admin_id, reviewed_at_ms, row_version
      FROM article_locale_heads WHERE article_id = ? AND locale = 'en'
    `).get(ARTICLE_ID)).toEqual({
      state: "in_review",
      approved_revision_id: null,
      approved_by_admin_id: null,
      approved_at_ms: null,
      reviewed_by_admin_id: null,
      reviewed_at_ms: null,
      row_version: 3,
    });
    const audit = fixture.db.sqlite.prepare(`
      SELECT metadata_json FROM audit_events
      WHERE action = 'article.locale_state.changed'
      ORDER BY created_at_ms DESC LIMIT 1
    `).pluck().get() as string;
    expect(JSON.parse(audit)).toMatchObject({ demotedDerivedLocales: 1 });

    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "en",
      targetState: "approved",
      expectedRowVersion: 3,
      actorAdminId: ADMIN_ID,
      requestId: "request-approve-stale-en",
      nowMs: NOW + 30,
    })).toMatchObject({ kind: "invalid-transition", httpStatus: 422 });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = 'en'
    `).get(ARTICLE_ID)).toEqual({ state: "in_review", row_version: 3 });
  });

  it("requires rollback before revoking a source approval with a published derivative", () => {
    approveSource();
    const translatedRevisionId = "88888888-8888-4888-8888-888888888888";
    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        prompt_sha256, schema_sha256, model_id, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'en', 1, 'Published English', 'Published summary',
        '## Published English\n', ?, ?, ?, ?, ?, ?, 'fixed-model', 'in_review',
        1, 'codex', 'job-en')
    `).run(
      translatedRevisionId, ARTICLE_ID, Buffer.alloc(32, 31), REVISION_ID,
      JSON.stringify(SOURCES), Buffer.alloc(32, 32), Buffer.alloc(32, 33),
      Buffer.alloc(32, 34),
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id,
        approved_revision_id, published_revision_id,
        reviewed_by_admin_id, reviewed_at_ms,
        approved_by_admin_id, approved_at_ms, published_at_ms,
        row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-guide', 'published', ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
    `).run(
      ARTICLE_ID, translatedRevisionId, translatedRevisionId, translatedRevisionId,
      ADMIN_ID, NOW, ADMIN_ID, NOW, NOW, NOW,
    );

    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "ko",
      targetState: "in_review",
      expectedRowVersion: 3,
      actorAdminId: ADMIN_ID,
      requestId: "request-revoke-source",
      nowMs: NOW + 20,
    })).toMatchObject({ kind: "invalid-transition", httpStatus: 422 });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = 'ko'
    `).get(ARTICLE_ID)).toEqual({ state: "approved", row_version: 3 });
  });

  it("cancels and fences queued or running translations when source approval is revoked", () => {
    approveSource();
    expect(enqueue()).toMatchObject({ kind: "queued" });
    expect(changeArticleLocaleState(fixture.db, {
      articleId: ARTICLE_ID,
      locale: "ko",
      targetState: "in_review",
      expectedRowVersion: 3,
      actorAdminId: ADMIN_ID,
      requestId: "request-revoke-approval",
      nowMs: NOW + 20,
    })).toMatchObject({ kind: "updated", state: "in_review", rowVersion: 4 });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, last_error_code, finished_at_ms, locked_by, fencing_token
      FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      state: "cancelled",
      last_error_code: "SOURCE_APPROVAL_REVOKED",
      finished_at_ms: NOW + 20,
      locked_by: null,
      fencing_token: null,
    });
    const audit = fixture.db.sqlite.prepare(`
      SELECT metadata_json FROM audit_events
      WHERE action = 'article.locale_state.changed'
      ORDER BY created_at_ms DESC LIMIT 1
    `).pluck().get() as string;
    expect(JSON.parse(audit)).toMatchObject({ cancelledTranslationJobs: 1 });
  });
});

function approveSource(): void {
  expect(transition("in_review", 1)).toMatchObject({ kind: "updated" });
  expect(changeArticleLocaleState(fixture.db, {
    articleId: ARTICLE_ID,
    locale: "ko",
    targetState: "approved",
    expectedRowVersion: 2,
    actorAdminId: ADMIN_ID,
    requestId: "request-approve-source",
    nowMs: NOW,
  }, { randomUUID: ids("55555555-5555-4555-8555-555555555555") })).toMatchObject({ kind: "updated" });
  fixture.db.sqlite.prepare("DELETE FROM audit_events").run();
}

function enqueue(overrides: Partial<Parameters<typeof enqueueArticleTranslation>[2]> = {}) {
  return enqueueArticleTranslation(fixture.db, keyProvider, {
    articleId: ARTICLE_ID,
    targetLocale: "en",
    expectedSourceRowVersion: 3,
    actorAdminId: ADMIN_ID,
    requestId: "request-translate",
    nowMs: NOW + 10,
    ...overrides,
  }, { randomUUID: ids(JOB_ID, AUDIT_ID) });
}

describe("explicit administrator translation enqueue", () => {
  it("queues one deterministic job only after source approval and audits the explicit action", () => {
    approveSource();
    const result = enqueue();
    expect(result).toEqual({
      kind: "queued",
      httpStatus: 202,
      jobId: JOB_ID,
      sourceRevisionId: REVISION_ID,
      targetLocale: "en",
    });
    const row = fixture.db.sqlite.prepare(`
      SELECT article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        created_at_ms, updated_at_ms
      FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID) as Record<string, unknown>;
    expect(row).toMatchObject({
      article_id: ARTICLE_ID,
      source_revision_id: REVISION_ID,
      target_locale: "en",
      state: "queued",
      attempt_count: 0,
      available_at_ms: NOW + 10,
      created_at_ms: NOW + 10,
      updated_at_ms: NOW + 10,
    });
    expect(row.input_sha256).toBeInstanceOf(Buffer);
    expect((row.input_sha256 as Buffer)).toHaveLength(32);
    expect(row.dedupe_key).toBe(`article-translation-v1:${(row.input_sha256 as Buffer).toString("hex")}`);
    expect(fixture.db.sqlite.prepare(`
      SELECT actor_id, action, target_id, metadata_json FROM audit_events
    `).get()).toEqual({
      actor_id: ADMIN_ID,
      action: "article.translation.queued",
      target_id: JOB_ID,
      metadata_json: JSON.stringify({
        articleId: ARTICLE_ID,
        sourceRevisionId: REVISION_ID,
        targetLocale: "en",
      }),
    });

    expect(enqueue()).toEqual({
      kind: "existing",
      httpStatus: 200,
      jobId: JOB_ID,
      jobState: "queued",
      sourceRevisionId: REVISION_ID,
      targetLocale: "en",
    });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_translation_jobs").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 1 });
  });

  it("requires an approved source, matching row version, missing target locale, and a distinct locale", () => {
    expect(enqueue({ expectedSourceRowVersion: 1 })).toMatchObject({ kind: "source-not-approved", httpStatus: 422 });
    approveSource();
    expect(enqueue({ expectedSourceRowVersion: 99 })).toMatchObject({ kind: "conflict", httpStatus: 409 });
    expect(enqueue({ targetLocale: "ko" })).toMatchObject({ kind: "invalid-target", httpStatus: 422 });

    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        initial_review_state, created_at_ms, created_by_type, created_by_id,
        prompt_sha256, schema_sha256, model_id
      ) VALUES ('66666666-6666-4666-8666-666666666666', ?, 'en', 1,
        'English', 'English summary', '## English\n', ?, ?, ?, ?, 'in_review', 1,
        'codex', 'job-old', ?, ?, 'fixed-model')
    `).run(
      ARTICLE_ID, Buffer.alloc(32, 3), REVISION_ID, JSON.stringify(SOURCES),
      Buffer.alloc(32, 4), Buffer.alloc(32, 5), Buffer.alloc(32, 6),
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-guide', 'in_review',
        '66666666-6666-4666-8666-666666666666', 1, 1)
    `).run(ARTICLE_ID);
    expect(enqueue()).toMatchObject({ kind: "target-exists", httpStatus: 409 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_translation_jobs").get()).toEqual({ count: 0 });
  });

  it("runs the retained-consultation PII gate before creating a job", () => {
    approveSource();
    fixture.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('private-consultation', 'private-receipt', 'received', 'ko',
        'procurement', 'email', 'undecryptable', 'pii-v1', ?, ?, 'pii-v1',
        0, 0, 0, 9999999999999, 1)
    `).run(
      blindIndex(keyProvider, "phone", "+821099999999"),
      blindIndex(keyProvider, "email", "private@example.com"),
    );

    expect(enqueue()).toEqual({ kind: "pii-rejected", httpStatus: 422 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_translation_jobs").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
  });

  it("requeues a failed deterministic job and rolls back queue plus audit on a fault", () => {
    approveSource();
    expect(enqueue()).toMatchObject({ kind: "queued" });
    fixture.db.sqlite.prepare(`
      UPDATE article_translation_jobs
      SET state = 'failed', finished_at_ms = ?, last_error_code = 'PROCESS_FAILED', updated_at_ms = ?
      WHERE id = ?
    `).run(NOW + 20, NOW + 20, JOB_ID);
    fixture.db.sqlite.prepare("DELETE FROM audit_events").run();

    expect(enqueue()).toEqual({
      kind: "requeued", httpStatus: 202, jobId: JOB_ID,
      sourceRevisionId: REVISION_ID, targetLocale: "en",
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT state, finished_at_ms, last_error_code, available_at_ms
      FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      state: "queued", finished_at_ms: null, last_error_code: null,
      available_at_ms: NOW + 10,
    });

    fixture.db.sqlite.prepare(`
      UPDATE article_translation_jobs
      SET state = 'failed', finished_at_ms = ?, last_error_code = 'PROCESS_FAILED', updated_at_ms = ?
      WHERE id = ?
    `).run(NOW + 30, NOW + 30, JOB_ID);
    fixture.db.sqlite.prepare("DELETE FROM audit_events").run();
    expect(() => enqueueArticleTranslation(fixture.db, keyProvider, {
      articleId: ARTICLE_ID,
      targetLocale: "en",
      expectedSourceRowVersion: 3,
      actorAdminId: ADMIN_ID,
      requestId: "request-fault",
      nowMs: NOW + 40,
    }, {
      randomUUID: ids("77777777-7777-4777-8777-777777777777"),
      faultInjector(point) {
        if (point === "after-translation-job") throw new Error(point);
      },
    })).toThrow("after-translation-job");
    expect(fixture.db.sqlite.prepare(`
      SELECT state, finished_at_ms, last_error_code FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      state: "failed", finished_at_ms: NOW + 30, last_error_code: "PROCESS_FAILED",
    });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
  });

  it("allows an explicit second translation after the same-source result was rejected", () => {
    approveSource();
    const rejectedRevisionId = "77777777-7777-4777-8777-777777777777";
    const originalJobId = "99999999-9999-4999-8999-999999999999";
    const inputSha = computeArticleTranslationInputSha256(
      ARTICLE_ID,
      REVISION_ID,
      SOURCE_CONTENT_SHA256,
      "en",
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        prompt_sha256, schema_sha256, model_id, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'en', 1, 'Rejected English', 'Rejected summary',
        '## Rejected\n', ?, ?, ?, ?, ?, ?, 'fixed-model', 'in_review',
        1, 'codex', ?)
    `).run(
      rejectedRevisionId, ARTICLE_ID, Buffer.alloc(32, 31), REVISION_ID,
      JSON.stringify(SOURCES), Buffer.alloc(32, 32), Buffer.alloc(32, 33),
      Buffer.alloc(32, 34), originalJobId,
    );
    fixture.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id,
        reviewed_by_admin_id, reviewed_at_ms, row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-guide', 'rejected', ?, ?, ?, 2, ?)
    `).run(ARTICLE_ID, rejectedRevisionId, ADMIN_ID, NOW, NOW);
    fixture.db.sqlite.prepare(`
      INSERT INTO article_translation_jobs (
        id, article_id, source_revision_id, target_locale, state,
        input_sha256, dedupe_key, attempt_count, available_at_ms,
        result_revision_id, created_at_ms, updated_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, 'en', 'succeeded', ?, ?, 1, 0, ?, 0, 1, 1)
    `).run(
      originalJobId,
      ARTICLE_ID,
      REVISION_ID,
      inputSha,
      `article-translation-v1:${inputSha.toString("hex")}`,
      rejectedRevisionId,
    );

    expect(enqueue()).toMatchObject({ kind: "queued", jobId: JOB_ID });
    expect(fixture.db.sqlite.prepare(`
      SELECT dedupe_key, state FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      dedupe_key: `article-translation-v1:${inputSha.toString("hex")}:2`,
      state: "queued",
    });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_translation_jobs").get()).toEqual({ count: 2 });
  });

  it("derives the same input digest independently of request time and UUID", () => {
    approveSource();
    expect(enqueue()).toMatchObject({ kind: "queued" });
    const first = fixture.db.sqlite.prepare(
      "SELECT input_sha256 FROM article_translation_jobs WHERE id = ?",
    ).pluck().get(JOB_ID) as Buffer;
    const expected = createHash("sha256")
      .update("wisdom:article-translation-input:v1\0", "utf8")
      .update(JSON.stringify({
        articleId: ARTICLE_ID,
        sourceRevisionId: REVISION_ID,
        sourceContentSha256: SOURCE_CONTENT_SHA256.toString("hex"),
        targetLocale: "en",
      }), "utf8")
      .digest();
    expect(first).toEqual(expected);
  });
});
