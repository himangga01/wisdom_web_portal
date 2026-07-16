import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";

import {
  computePublishedArticleContentSha256,
  localeSchema,
  normalizeValidateAndRenderArticleMarkdown,
  publishedSourceSchema,
  type ArticleState,
  type Locale,
  type PublishedSource,
} from "@wisdom/shared";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

export type ArticleReviewState = Exclude<ArticleState, "published">;

export type ArticleWorkflowFaultPoint =
  | "after-head"
  | "after-article"
  | "after-translation-job"
  | "after-audit";

export interface ArticleWorkflowOptions {
  randomUUID?: () => string;
  faultInjector?: (point: ArticleWorkflowFaultPoint) => void;
}

export interface ChangeArticleLocaleStateInput {
  articleId: string;
  locale: Locale;
  targetState: ArticleReviewState;
  expectedRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

export type ChangeArticleLocaleStateResult =
  | {
      kind: "updated" | "unchanged";
      httpStatus: 200;
      state: ArticleState;
      rowVersion: number;
      headRevisionId: string;
    }
  | {
      kind: "conflict";
      httpStatus: 409;
      state: ArticleState;
      rowVersion: number;
      headRevisionId: string;
    }
  | {
      kind: "invalid-transition";
      httpStatus: 422;
      state: ArticleState;
      rowVersion: number;
      headRevisionId: string;
    }
  | { kind: "not-found"; httpStatus: 404 };

interface LocaleHeadRow {
  state: ArticleState;
  head_revision_id: string;
  row_version: number;
  source_locale: Locale;
}

const ALLOWED_REVIEW_TRANSITIONS: Readonly<Record<ArticleState, readonly ArticleReviewState[]>> = {
  draft: ["in_review", "rejected"],
  in_review: ["draft", "approved", "rejected"],
  approved: ["in_review"],
  published: [],
  rejected: [],
};

function currentResult(
  kind: "unchanged" | "conflict" | "invalid-transition",
  row: LocaleHeadRow,
): ChangeArticleLocaleStateResult {
  const current = {
    state: row.state,
    rowVersion: row.row_version,
    headRevisionId: row.head_revision_id,
  };
  if (kind === "unchanged") return { kind, httpStatus: 200, ...current };
  if (kind === "conflict") return { kind, httpStatus: 409, ...current };
  return { kind, httpStatus: 422, ...current };
}

export function changeArticleLocaleState(
  db: ControlDatabase,
  input: ChangeArticleLocaleStateInput,
  options: ArticleWorkflowOptions = {},
): ChangeArticleLocaleStateResult {
  const createId = options.randomUUID ?? nodeRandomUUID;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT head.state, head.head_revision_id, head.row_version, article.source_locale
      FROM article_locale_heads head
      JOIN articles article ON article.id = head.article_id
      WHERE head.article_id = ? AND head.locale = ?
    `).get(input.articleId, input.locale) as LocaleHeadRow | undefined;
    if (!row) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "not-found", httpStatus: 404 };
    }
    if (row.row_version !== input.expectedRowVersion) {
      db.sqlite.exec("ROLLBACK");
      return currentResult("conflict", row);
    }
    if (row.state === input.targetState) {
      db.sqlite.exec("ROLLBACK");
      return currentResult("unchanged", row);
    }
    if (!ALLOWED_REVIEW_TRANSITIONS[row.state].includes(input.targetState)) {
      db.sqlite.exec("ROLLBACK");
      return currentResult("invalid-transition", row);
    }

    if (input.targetState === "approved" && input.locale !== row.source_locale) {
      const sourceBindingIsCurrent = db.sqlite.prepare(`
        SELECT 1 present
        FROM article_revisions derived
        JOIN article_locale_heads source_head
          ON source_head.article_id = derived.article_id
        WHERE derived.id = ? AND derived.article_id = ? AND derived.locale = ?
          AND derived.source_revision_id IS NOT NULL
          AND source_head.locale = ?
          AND source_head.state IN ('approved','published')
          AND source_head.head_revision_id = derived.source_revision_id
          AND source_head.approved_revision_id = derived.source_revision_id
        LIMIT 1
      `).get(
        row.head_revision_id,
        input.articleId,
        input.locale,
        row.source_locale,
      );
      if (!sourceBindingIsCurrent) {
        db.sqlite.exec("ROLLBACK");
        return currentResult("invalid-transition", row);
      }
    }

    const revokingSourceApproval = input.locale === row.source_locale &&
      row.state === "approved" && input.targetState === "in_review";
    if (revokingSourceApproval) {
      const publishedDerivative = db.sqlite.prepare(`
        SELECT 1 present
        FROM article_locale_heads derived_head
        JOIN article_revisions derived
          ON derived.id = derived_head.head_revision_id
          AND derived.article_id = derived_head.article_id
          AND derived.locale = derived_head.locale
        WHERE derived_head.article_id = ?
          AND derived_head.locale <> ?
          AND derived_head.state = 'published'
          AND derived.source_revision_id = ?
        LIMIT 1
      `).get(input.articleId, row.source_locale, row.head_revision_id);
      if (publishedDerivative) {
        db.sqlite.exec("ROLLBACK");
        return currentResult("invalid-transition", row);
      }
    }

    const nextVersion = row.row_version + 1;
    const reviewCompleted = input.targetState === "draft" || input.targetState === "rejected" ||
      input.targetState === "approved";
    const approved = input.targetState === "approved";
    const updated = db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = ?,
        reviewed_by_admin_id = ?, reviewed_at_ms = ?,
        approved_revision_id = ?, approved_by_admin_id = ?, approved_at_ms = ?,
        published_revision_id = NULL, published_at_ms = NULL,
        row_version = ?, updated_at_ms = ?
      WHERE article_id = ? AND locale = ? AND state = ? AND row_version = ?
    `).run(
      input.targetState,
      reviewCompleted ? input.actorAdminId : null,
      reviewCompleted ? input.nowMs : null,
      approved ? row.head_revision_id : null,
      approved ? input.actorAdminId : null,
      approved ? input.nowMs : null,
      nextVersion,
      input.nowMs,
      input.articleId,
      input.locale,
      row.state,
      row.row_version,
    );
    if (updated.changes !== 1) throw new Error("Article locale head changed during locked transition");
    options.faultInjector?.("after-head");

    // articles.state/current_revision_id are a legacy projection of the source locale only.
    // Other locale approvals must never overwrite that projection.
    if (input.locale === row.source_locale) {
      const article = db.sqlite.prepare(`
        UPDATE articles
        SET state = ?, current_revision_id = ?, updated_at_ms = ?, published_at_ms = NULL
        WHERE id = ? AND source_locale = ?
      `).run(
        input.targetState,
        row.head_revision_id,
        input.nowMs,
        input.articleId,
        input.locale,
      );
      if (article.changes !== 1) throw new Error("Source article projection is missing");
    }
    let cancelledTranslationJobs = 0;
    let demotedDerivedLocales = 0;
    if (revokingSourceApproval) {
      cancelledTranslationJobs = db.sqlite.prepare(`
        UPDATE article_translation_jobs
        SET state = 'cancelled', result_revision_id = NULL,
          last_error_code = 'SOURCE_APPROVAL_REVOKED', finished_at_ms = ?,
          locked_at_ms = NULL, lease_expires_at_ms = NULL,
          heartbeat_at_ms = NULL, locked_by = NULL, fencing_token = NULL,
          updated_at_ms = ?
        WHERE article_id = ? AND source_revision_id = ?
          AND state IN ('queued','running')
      `).run(
        input.nowMs,
        input.nowMs,
        input.articleId,
        row.head_revision_id,
      ).changes;
      demotedDerivedLocales = db.sqlite.prepare(`
        UPDATE article_locale_heads
        SET state = 'in_review', approved_revision_id = NULL,
          reviewed_by_admin_id = NULL, reviewed_at_ms = NULL,
          approved_by_admin_id = NULL, approved_at_ms = NULL,
          published_revision_id = NULL, published_at_ms = NULL,
          row_version = row_version + 1, updated_at_ms = ?
        WHERE article_id = ? AND locale <> ? AND state = 'approved'
          AND EXISTS (
            SELECT 1 FROM article_revisions derived
            WHERE derived.id = article_locale_heads.head_revision_id
              AND derived.article_id = article_locale_heads.article_id
              AND derived.locale = article_locale_heads.locale
              AND derived.source_revision_id = ?
          )
      `).run(
        input.nowMs,
        input.articleId,
        row.source_locale,
        row.head_revision_id,
      ).changes;
    }
    options.faultInjector?.("after-article");

    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, 'article.locale_state.changed',
        'article-locale', ?, ?, ?, ?)
    `).run(
      createId(),
      input.actorAdminId,
      `${input.articleId}:${input.locale}`,
      input.requestId,
      JSON.stringify({
        locale: input.locale,
        fromState: row.state,
        toState: input.targetState,
        revisionId: row.head_revision_id,
        rowVersion: nextVersion,
        ...(cancelledTranslationJobs > 0 ? { cancelledTranslationJobs } : {}),
        ...(demotedDerivedLocales > 0 ? { demotedDerivedLocales } : {}),
      }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    return {
      kind: "updated",
      httpStatus: 200,
      state: input.targetState,
      rowVersion: nextVersion,
      headRevisionId: row.head_revision_id,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ChangeArticleLocaleSlugInput {
  articleId: string;
  locale: Locale;
  slug: string;
  expectedRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

export type ChangeArticleLocaleSlugResult =
  | {
      kind: "updated" | "unchanged";
      httpStatus: 200;
      slug: string;
      state: ArticleState;
      rowVersion: number;
    }
  | {
      kind: "conflict";
      httpStatus: 409;
      slug: string;
      state: ArticleState;
      rowVersion: number;
    }
  | { kind: "slug-conflict"; httpStatus: 409 }
  | {
      kind: "state-blocked";
      httpStatus: 422;
      slug: string;
      state: ArticleState;
      rowVersion: number;
    }
  | { kind: "invalid-slug"; httpStatus: 422 }
  | { kind: "not-found"; httpStatus: 404 };

interface SlugHeadRow {
  slug: string;
  state: ArticleState;
  row_version: number;
}

export function changeArticleLocaleSlug(
  db: ControlDatabase,
  input: ChangeArticleLocaleSlugInput,
  options: ArticleWorkflowOptions = {},
): ChangeArticleLocaleSlugResult {
  if (
    input.slug.length < 1 || input.slug.length > 96 ||
    !ARTICLE_SLUG_PATTERN.test(input.slug)
  ) return { kind: "invalid-slug", httpStatus: 422 };
  const createId = options.randomUUID ?? nodeRandomUUID;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT slug, state, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = ?
    `).get(input.articleId, input.locale) as SlugHeadRow | undefined;
    if (!row) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "not-found", httpStatus: 404 };
    }
    if (row.row_version !== input.expectedRowVersion) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "conflict", httpStatus: 409, slug: row.slug,
        state: row.state, rowVersion: row.row_version,
      };
    }
    if (row.slug === input.slug) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "unchanged", httpStatus: 200, slug: row.slug,
        state: row.state, rowVersion: row.row_version,
      };
    }
    if (row.state !== "draft" && row.state !== "in_review") {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "state-blocked", httpStatus: 422, slug: row.slug,
        state: row.state, rowVersion: row.row_version,
      };
    }
    const collision = db.sqlite.prepare(`
      SELECT 1 present FROM article_locale_heads
      WHERE locale = ? AND slug = ? AND article_id <> ? LIMIT 1
    `).get(input.locale, input.slug, input.articleId);
    if (collision) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "slug-conflict", httpStatus: 409 };
    }
    const nextVersion = row.row_version + 1;
    const updated = db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET slug = ?, row_version = ?, updated_at_ms = ?
      WHERE article_id = ? AND locale = ? AND slug = ? AND row_version = ?
    `).run(
      input.slug,
      nextVersion,
      input.nowMs,
      input.articleId,
      input.locale,
      row.slug,
      row.row_version,
    );
    if (updated.changes !== 1) throw new Error("Article locale slug changed while locked");
    options.faultInjector?.("after-head");
    // `article_locale_heads` is the v3 URL authority. The legacy articles.slug
    // remains untouched because it is globally unique rather than locale-scoped.
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, 'article.locale_slug.changed',
        'article-locale', ?, ?, ?, ?)
    `).run(
      createId(),
      input.actorAdminId,
      `${input.articleId}:${input.locale}`,
      input.requestId,
      JSON.stringify({
        locale: input.locale,
        fromSlug: row.slug,
        toSlug: input.slug,
        rowVersion: nextVersion,
      }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    return {
      kind: "updated", httpStatus: 200, slug: input.slug,
      state: row.state, rowVersion: nextVersion,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export interface EnqueueArticleTranslationInput {
  articleId: string;
  targetLocale: Locale;
  expectedSourceRowVersion: number;
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

type TranslationJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type EnqueueArticleTranslationResult =
  | {
      kind: "queued" | "requeued";
      httpStatus: 202;
      jobId: string;
      sourceRevisionId: string;
      targetLocale: Locale;
    }
  | {
      kind: "existing";
      httpStatus: 200;
      jobId: string;
      jobState: TranslationJobState;
      sourceRevisionId: string;
      targetLocale: Locale;
    }
  | { kind: "conflict" | "target-exists"; httpStatus: 409 }
  | {
      kind: "source-not-approved" | "invalid-target" | "source-invalid" | "pii-rejected";
      httpStatus: 422;
    }
  | { kind: "not-found"; httpStatus: 404 };

interface ApprovedSourceRow {
  source_locale: Locale;
  state: ArticleState;
  row_version: number;
  head_revision_id: string;
  approved_revision_id: string | null;
  title: string;
  summary: string;
  body_markdown: string;
  content_sha256: Buffer;
  sources_json: string;
}

interface TargetHeadRow {
  state: ArticleState;
  head_revision_id: string;
  source_revision_id: string | null;
}

interface ExistingTranslationJobRow {
  id: string;
  state: TranslationJobState;
}

function parseApprovedSource(row: ApprovedSourceRow): { sources: PublishedSource[] } | undefined {
  try {
    const normalized = normalizeValidateAndRenderArticleMarkdown(row.body_markdown).bodyMarkdown;
    if (normalized !== row.body_markdown) return undefined;
    const sources = publishedSourceSchema.array().min(1).max(32).parse(JSON.parse(row.sources_json));
    const expected = computePublishedArticleContentSha256({
      title: row.title,
      summary: row.summary,
      bodyMarkdown: row.body_markdown,
      sources,
      locale: row.source_locale,
    });
    if (!row.content_sha256.equals(Buffer.from(expected, "hex"))) return undefined;
    return { sources };
  } catch {
    return undefined;
  }
}

export function computeArticleTranslationInputSha256(
  articleId: string,
  sourceRevisionId: string,
  sourceContentSha256: Uint8Array,
  targetLocale: Locale,
): Buffer {
  return createHash("sha256")
    .update("wisdom:article-translation-input:v1\0", "utf8")
    .update(JSON.stringify({
      articleId,
      sourceRevisionId,
      sourceContentSha256: Buffer.from(sourceContentSha256).toString("hex"),
      targetLocale,
    }), "utf8")
    .digest();
}

export function enqueueArticleTranslation(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  input: EnqueueArticleTranslationInput,
  options: ArticleWorkflowOptions = {},
): EnqueueArticleTranslationResult {
  const createId = options.randomUUID ?? nodeRandomUUID;
  const target = localeSchema.safeParse(input.targetLocale);
  if (!target.success) return { kind: "invalid-target", httpStatus: 422 };

  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const source = db.sqlite.prepare(`
      SELECT article.source_locale, head.state, head.row_version,
        head.head_revision_id, head.approved_revision_id,
        revision.title, revision.summary, revision.body_markdown,
        revision.content_sha256, revision.sources_json
      FROM articles article
      JOIN article_locale_heads head
        ON head.article_id = article.id AND head.locale = article.source_locale
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      WHERE article.id = ?
    `).get(input.articleId) as ApprovedSourceRow | undefined;
    if (!source) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "not-found", httpStatus: 404 };
    }
    if (source.row_version !== input.expectedSourceRowVersion) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "conflict", httpStatus: 409 };
    }
    if (target.data === source.source_locale) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "invalid-target", httpStatus: 422 };
    }
    if (
      !["approved", "published"].includes(source.state) ||
      source.approved_revision_id !== source.head_revision_id
    ) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "source-not-approved", httpStatus: 422 };
    }
    const parsedSource = parseApprovedSource(source);
    if (!parsedSource) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "source-invalid", httpStatus: 422 };
    }

    const targetHead = db.sqlite.prepare(`
      SELECT head.state, head.head_revision_id, revision.source_revision_id
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      WHERE head.article_id = ? AND head.locale = ?
    `).get(input.articleId, target.data) as TargetHeadRow | undefined;
    if (
      targetHead?.state === "published" ||
      (targetHead !== undefined && targetHead.state !== "rejected" && (
        targetHead.source_revision_id === source.head_revision_id ||
        targetHead.state === "draft" || targetHead.state === "in_review"
      ))
    ) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "target-exists", httpStatus: 409 };
    }

    const pii = checkArticleForRetainedConsultationPii(db, keyProvider, [
      source.title,
      source.summary,
      source.body_markdown,
      ...parsedSource.sources.flatMap(({ id, url }) => [id, url]),
    ]);
    if (!pii.safe) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "pii-rejected", httpStatus: 422 };
    }

    const inputSha256 = computeArticleTranslationInputSha256(
      input.articleId,
      source.head_revision_id,
      source.content_sha256,
      target.data,
    );
    const existing = db.sqlite.prepare(`
      SELECT id, state FROM article_translation_jobs
      WHERE article_id = ? AND source_revision_id = ? AND target_locale = ?
        AND input_sha256 = ?
      ORDER BY created_at_ms DESC, id DESC LIMIT 1
    `).get(
      input.articleId,
      source.head_revision_id,
      target.data,
      inputSha256,
    ) as ExistingTranslationJobRow | undefined;
    if (existing && (existing.state === "queued" || existing.state === "running" ||
      (existing.state === "succeeded" && targetHead?.state !== "rejected"))) {
      db.sqlite.exec("ROLLBACK");
      return {
        kind: "existing",
        httpStatus: 200,
        jobId: existing.id,
        jobState: existing.state,
        sourceRevisionId: source.head_revision_id,
        targetLocale: target.data,
      };
    }

    let jobId: string;
    let kind: "queued" | "requeued";
    if (existing && (existing.state === "failed" || existing.state === "cancelled")) {
      jobId = existing.id;
      kind = "requeued";
      const update = db.sqlite.prepare(`
        UPDATE article_translation_jobs
        SET state = 'queued', available_at_ms = ?, last_error_code = NULL,
          result_revision_id = NULL, finished_at_ms = NULL, updated_at_ms = ?
        WHERE id = ? AND state IN ('failed','cancelled')
      `).run(input.nowMs, input.nowMs, jobId);
      if (update.changes !== 1) throw new Error("Translation retry changed while locked");
    } else {
      jobId = createId();
      kind = "queued";
      const ordinal = (db.sqlite.prepare(`
        SELECT count(*) count FROM article_translation_jobs
        WHERE article_id = ? AND source_revision_id = ? AND target_locale = ?
          AND input_sha256 = ?
      `).get(
        input.articleId,
        source.head_revision_id,
        target.data,
        inputSha256,
      ) as { count: number }).count + 1;
      const baseDedupeKey = `article-translation-v1:${inputSha256.toString("hex")}`;
      const dedupeKey = ordinal === 1 ? baseDedupeKey : `${baseDedupeKey}:${ordinal}`;
      db.sqlite.prepare(`
        INSERT INTO article_translation_jobs (
          id, article_id, source_revision_id, target_locale, state,
          input_sha256, dedupe_key, attempt_count, available_at_ms,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?)
      `).run(
        jobId,
        input.articleId,
        source.head_revision_id,
        target.data,
        inputSha256,
        dedupeKey,
        input.nowMs,
        input.nowMs,
        input.nowMs,
      );
    }
    options.faultInjector?.("after-translation-job");

    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'admin', ?, ?, 'article-translation-job', ?, ?, ?, ?)
    `).run(
      createId(),
      input.actorAdminId,
      kind === "queued" ? "article.translation.queued" : "article.translation.requeued",
      jobId,
      input.requestId,
      JSON.stringify({
        articleId: input.articleId,
        sourceRevisionId: source.head_revision_id,
        targetLocale: target.data,
      }),
      input.nowMs,
    );
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    return {
      kind,
      httpStatus: 202,
      jobId,
      sourceRevisionId: source.head_revision_id,
      targetLocale: target.data,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
