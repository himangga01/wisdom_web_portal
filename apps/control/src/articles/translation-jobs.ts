import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

import {
  articleTranslationOutputSchema,
  computePublishedArticleContentSha256,
  normalizeValidateAndRenderArticleMarkdown,
  publishedSourceSchema,
  type Locale,
} from "@wisdom/shared";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import type {
  CodexPassEvidence,
  CodexTranslationResult,
  CodexTranslationSource,
} from "./codex-executor.js";
import {
  computeCodexPassPromptSha256,
  computeCodexTranslationOutputSha256,
  computeCodexTranslationSchemaSha256,
} from "./codex-executor.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";
import { computeArticleTranslationInputSha256 } from "./workflow.js";

export const ARTICLE_TRANSLATION_LEASE_MS = 120_000;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;
const CLI_VERSION_PATTERN = /^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

export type TranslationJobFaultPoint =
  | "after-revision"
  | "after-review-runs"
  | "after-head"
  | "after-job"
  | "after-audit";

export interface ClaimArticleTranslationJobInput {
  workerId: string;
  nowMs: number;
}

export interface TranslationJobClaim {
  jobId: string;
  articleId: string;
  sourceRevisionId: string;
  sourceLocale: Locale;
  targetLocale: Locale;
  inputSha256: Buffer;
  attemptCount: number;
  workerId: string;
  fencingToken: Buffer;
  leaseExpiresAtMs: number;
  source: CodexTranslationSource;
}

export interface ClaimArticleTranslationJobOptions {
  randomBytes?: (size: number) => Uint8Array;
}

interface CandidateJobRow {
  id: string;
  article_id: string;
  source_revision_id: string;
  target_locale: Locale;
  state: "queued" | "running";
  input_sha256: Buffer;
  attempt_count: number;
  lease_expires_at_ms: number | null;
}

interface SourceRevisionRow {
  source_locale: Locale;
  locale: Locale;
  title: string;
  summary: string;
  body_markdown: string;
  content_sha256: Buffer;
  sources_json: string;
  head_state: "draft" | "in_review" | "approved" | "published" | "rejected";
  head_revision_id: string;
  approved_revision_id: string | null;
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function sourceForJob(
  db: ControlDatabase,
  candidate: Pick<CandidateJobRow, "article_id" | "source_revision_id">,
): { source: CodexTranslationSource; sourceContentSha256: Buffer } {
  const row = db.sqlite.prepare(`
    SELECT article.source_locale, revision.locale, revision.title,
      revision.summary, revision.body_markdown, revision.content_sha256,
      revision.sources_json, head.state AS head_state,
      head.head_revision_id, head.approved_revision_id
    FROM article_revisions revision
    JOIN articles article ON article.id = revision.article_id
    JOIN article_locale_heads head
      ON head.article_id = article.id AND head.locale = article.source_locale
    WHERE revision.id = ? AND revision.article_id = ?
  `).get(candidate.source_revision_id, candidate.article_id) as SourceRevisionRow | undefined;
  if (
    !row || row.locale !== row.source_locale
    || !["approved", "published"].includes(row.head_state)
    || row.head_revision_id !== candidate.source_revision_id
    || row.approved_revision_id !== candidate.source_revision_id
  ) throw new Error("Translation source revision is not the current approved source");
  const markdown = normalizeValidateAndRenderArticleMarkdown(row.body_markdown).bodyMarkdown;
  if (markdown !== row.body_markdown) throw new Error("Translation source Markdown is not canonical");
  const sources = publishedSourceSchema.array().min(1).max(32).parse(JSON.parse(row.sources_json))
    .map((source) => ({ ...source }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const expectedContent = Buffer.from(computePublishedArticleContentSha256({
    title: row.title,
    summary: row.summary,
    bodyMarkdown: markdown,
    sources,
    locale: row.locale,
  }), "hex");
  if (!row.content_sha256.equals(expectedContent)) throw new Error("Translation source hash is invalid");
  return {
    source: {
      articleId: candidate.article_id,
      revisionId: candidate.source_revision_id,
      locale: row.locale,
      title: row.title,
      summary: row.summary,
      bodyMarkdown: markdown,
      sources,
    },
    sourceContentSha256: row.content_sha256,
  };
}

export function claimArticleTranslationJob(
  db: ControlDatabase,
  input: ClaimArticleTranslationJobInput,
  options: ClaimArticleTranslationJobOptions = {},
): TranslationJobClaim | undefined {
  if (!WORKER_ID_PATTERN.test(input.workerId)) throw new Error("Invalid article worker identifier");
  assertSafeInteger(input.nowMs, "nowMs");
  const createToken = options.randomBytes ?? nodeRandomBytes;
  const token = Buffer.from(createToken(32));
  if (token.byteLength !== 32) throw new Error("Fencing token must contain exactly 32 bytes");

  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    let candidate = db.sqlite.prepare(`
      SELECT id, article_id, source_revision_id, target_locale, state,
        input_sha256, attempt_count, lease_expires_at_ms
      FROM article_translation_jobs
      WHERE state = 'running'
      ORDER BY locked_at_ms, id LIMIT 1
    `).get() as CandidateJobRow | undefined;
    if (candidate && candidate.lease_expires_at_ms! > input.nowMs) {
      db.sqlite.exec("ROLLBACK");
      return undefined;
    }
    if (!candidate) {
      candidate = db.sqlite.prepare(`
        SELECT id, article_id, source_revision_id, target_locale, state,
          input_sha256, attempt_count, lease_expires_at_ms
        FROM article_translation_jobs
        WHERE state = 'queued' AND available_at_ms <= ?
        ORDER BY available_at_ms, created_at_ms, id LIMIT 1
      `).get(input.nowMs) as CandidateJobRow | undefined;
    }
    if (!candidate) {
      db.sqlite.exec("ROLLBACK");
      return undefined;
    }

    const sourceRecord = sourceForJob(db, candidate);
    const expectedInputSha256 = computeArticleTranslationInputSha256(
      candidate.article_id,
      candidate.source_revision_id,
      sourceRecord.sourceContentSha256,
      candidate.target_locale,
    );
    if (!candidate.input_sha256.equals(expectedInputSha256)) {
      throw new Error("Translation job input hash is invalid");
    }
    const source = sourceRecord.source;
    const leaseExpiresAtMs = input.nowMs + ARTICLE_TRANSLATION_LEASE_MS;
    const where = candidate.state === "running"
      ? "id = ? AND state = 'running' AND lease_expires_at_ms <= ?"
      : "id = ? AND state = 'queued' AND available_at_ms <= ?";
    const update = db.sqlite.prepare(`
      UPDATE article_translation_jobs
      SET state = 'running', attempt_count = attempt_count + 1,
        locked_at_ms = ?, lease_expires_at_ms = ?, heartbeat_at_ms = ?,
        locked_by = ?, fencing_token = ?, updated_at_ms = ?
      WHERE ${where}
    `).run(
      input.nowMs,
      leaseExpiresAtMs,
      input.nowMs,
      input.workerId,
      token,
      input.nowMs,
      candidate.id,
      candidate.state === "running" ? input.nowMs : input.nowMs,
    );
    if (update.changes !== 1) throw new Error("Translation job claim changed while locked");
    db.sqlite.exec("COMMIT");
    return {
      jobId: candidate.id,
      articleId: candidate.article_id,
      sourceRevisionId: candidate.source_revision_id,
      sourceLocale: source.locale,
      targetLocale: candidate.target_locale,
      inputSha256: Buffer.from(candidate.input_sha256),
      attemptCount: candidate.attempt_count + 1,
      workerId: input.workerId,
      fencingToken: token,
      leaseExpiresAtMs,
      source,
    };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function claimWhere(claim: TranslationJobClaim): readonly unknown[] {
  return [claim.jobId, claim.articleId, claim.sourceRevisionId, claim.targetLocale,
    claim.workerId, claim.fencingToken];
}

export function heartbeatArticleTranslationJob(
  db: ControlDatabase,
  claim: TranslationJobClaim,
  nowMs: number,
): boolean {
  assertSafeInteger(nowMs, "nowMs");
  const result = db.sqlite.prepare(`
    UPDATE article_translation_jobs
    SET heartbeat_at_ms = ?, lease_expires_at_ms = ?, updated_at_ms = ?
    WHERE id = ? AND article_id = ? AND source_revision_id = ? AND target_locale = ?
      AND state = 'running' AND locked_by = ? AND fencing_token = ?
      AND heartbeat_at_ms <= ? AND lease_expires_at_ms > ?
  `).run(
    nowMs,
    nowMs + ARTICLE_TRANSLATION_LEASE_MS,
    nowMs,
    ...claimWhere(claim),
    nowMs,
    nowMs,
  );
  return result.changes === 1;
}

interface CommitOptions {
  nowMs: number;
  expectedModel: string;
  randomUUID?: () => string;
  faultInjector?: (point: TranslationJobFaultPoint) => void;
}

export type CommitTranslationResult =
  | { kind: "committed"; revisionId: string; state: "in_review"; rowVersion: number }
  | { kind: "fenced" | "invalid-result" | "target-conflict" };

function hasLiveClaim(db: ControlDatabase, claim: TranslationJobClaim, nowMs: number): boolean {
  return db.sqlite.prepare(`
    SELECT lease_expires_at_ms
    FROM article_translation_jobs
    WHERE id = ? AND article_id = ? AND source_revision_id = ? AND target_locale = ?
      AND state = 'running' AND locked_by = ? AND fencing_token = ?
      AND lease_expires_at_ms > ?
  `).get(...claimWhere(claim), nowMs) !== undefined;
}

function canonicalSourceArtifactSha256(source: CodexTranslationSource): string {
  return createHash("sha256").update(`${JSON.stringify({
    schemaVersion: 1,
    articleId: source.articleId,
    revisionId: source.revisionId,
    locale: source.locale,
    title: source.title,
    summary: source.summary,
    bodyMarkdown: source.bodyMarkdown,
    sources: source.sources,
  })}\n`).digest("hex");
}

function validPasses(passes: readonly CodexPassEvidence[]): passes is readonly [CodexPassEvidence, CodexPassEvidence, CodexPassEvidence] {
  const kinds = ["translation", "review-accuracy", "review-language"] as const;
  return passes.length === 3 && passes.every((pass, index) => (
    pass.kind === kinds[index]
    && pass.exitCode === 0
    && SHA256_PATTERN.test(pass.promptSha256)
    && SHA256_PATTERN.test(pass.outputSha256)
  ));
}

function validateSuccessResult(
  claim: TranslationJobClaim,
  result: CodexTranslationResult,
): { output: CodexTranslationResult["output"]; passes: readonly [CodexPassEvidence, CodexPassEvidence, CodexPassEvidence] } | undefined {
  try {
    const output = articleTranslationOutputSchema.parse(result.output);
    const normalized = normalizeValidateAndRenderArticleMarkdown(output.bodyMarkdown).bodyMarkdown;
    const evidence = result.evidence;
    const sourceIds = claim.source.sources.map(({ id }) => id);
    if (
      normalized !== output.bodyMarkdown
      || output.locale !== claim.targetLocale
      || JSON.stringify(output.sourceIds) !== JSON.stringify(sourceIds)
      || evidence.sourceRevisionId !== claim.sourceRevisionId
      || evidence.sourceLocale !== claim.sourceLocale
      || evidence.targetLocale !== claim.targetLocale
      || evidence.sourceSha256 !== canonicalSourceArtifactSha256(claim.source)
      || evidence.schemaSha256 !== computeCodexTranslationSchemaSha256()
      || !MODEL_PATTERN.test(evidence.model)
      || !CLI_VERSION_PATTERN.test(evidence.cliVersion)
      || !validPasses(evidence.passes)
      || evidence.passes.some((pass) => (
        pass.promptSha256 !== computeCodexPassPromptSha256(pass.kind)
      ))
      || evidence.passes[2].outputSha256 !== computeCodexTranslationOutputSha256(output)
      || evidence.reviewOutputSha256[0] !== evidence.passes[1].outputSha256
      || evidence.reviewOutputSha256[1] !== evidence.passes[2].outputSha256
    ) return undefined;
    return { output, passes: evidence.passes };
  } catch {
    return undefined;
  }
}

interface ExistingTargetHead {
  slug: string;
  state: "draft" | "in_review" | "approved" | "published" | "rejected";
  head_revision_id: string;
  source_revision_id: string | null;
  row_version: number;
}

export function commitArticleTranslationSuccess(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  claim: TranslationJobClaim,
  result: CodexTranslationResult,
  options: CommitOptions,
): CommitTranslationResult {
  assertSafeInteger(options.nowMs, "nowMs");
  if (!MODEL_PATTERN.test(options.expectedModel)) throw new Error("Invalid expected Codex model");
  const validated = validateSuccessResult(claim, result);
  if (!validated || result.evidence.model !== options.expectedModel) return { kind: "invalid-result" };
  const createId = options.randomUUID ?? nodeRandomUUID;

  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (!hasLiveClaim(db, claim, options.nowMs)) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "fenced" };
    }
    let currentSourceRecord: ReturnType<typeof sourceForJob>;
    try {
      currentSourceRecord = sourceForJob(db, {
        article_id: claim.articleId,
        source_revision_id: claim.sourceRevisionId,
      });
    } catch {
      db.sqlite.exec("ROLLBACK");
      return { kind: "invalid-result" };
    }
    const currentSource = currentSourceRecord.source;
    if (canonicalSourceArtifactSha256(currentSource) !== result.evidence.sourceSha256) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "invalid-result" };
    }
    const expectedInputSha256 = computeArticleTranslationInputSha256(
      claim.articleId,
      claim.sourceRevisionId,
      currentSourceRecord.sourceContentSha256,
      claim.targetLocale,
    );
    if (!claim.inputSha256.equals(expectedInputSha256)) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "invalid-result" };
    }
    const pii = checkArticleForRetainedConsultationPii(db, keyProvider, [
      validated.output.title,
      validated.output.summary,
      validated.output.bodyMarkdown,
      ...currentSource.sources.flatMap(({ id, url }) => [id, url]),
    ]);
    if (!pii.safe) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "invalid-result" };
    }

    const existingTarget = db.sqlite.prepare(`
      SELECT head.slug, head.state, head.head_revision_id, head.row_version,
        revision.source_revision_id
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      WHERE head.article_id = ? AND head.locale = ?
    `).get(claim.articleId, claim.targetLocale) as ExistingTargetHead | undefined;
    const replaceable = existingTarget === undefined || existingTarget.state === "rejected" || (
      existingTarget.state === "approved" &&
      existingTarget.source_revision_id !== claim.sourceRevisionId
    );
    if (!replaceable) {
      db.sqlite.exec("ROLLBACK");
      return { kind: "target-conflict" };
    }
    const sourceSlug = db.sqlite.prepare(`
      SELECT slug FROM article_locale_heads WHERE article_id = ? AND locale = ?
    `).pluck().get(claim.articleId, claim.sourceLocale) as string | undefined;
    if (!sourceSlug) throw new Error("Source locale head is missing");

    const revisionId = createId();
    const reviewIds = [createId(), createId(), createId()] as const;
    const auditId = createId();
    const revisionNo = (db.sqlite.prepare(`
      SELECT coalesce(max(revision_no), 0) + 1
      FROM article_revisions WHERE article_id = ? AND locale = ?
    `).pluck().get(claim.articleId, claim.targetLocale) as number);
    const contentSha256 = Buffer.from(computePublishedArticleContentSha256({
      title: validated.output.title,
      summary: validated.output.summary,
      bodyMarkdown: validated.output.bodyMarkdown,
      sources: claim.source.sources,
      locale: claim.targetLocale,
    }), "hex");
    db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, parent_revision_id, sources_json,
        prompt_sha256, schema_sha256, source_sha256, model_id,
        translation_metadata_json, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?, 'codex', ?)
    `).run(
      revisionId,
      claim.articleId,
      claim.targetLocale,
      revisionNo,
      validated.output.title,
      validated.output.summary,
      validated.output.bodyMarkdown,
      contentSha256,
      claim.sourceRevisionId,
      existingTarget?.head_revision_id ?? null,
      JSON.stringify(claim.source.sources),
      Buffer.from(validated.passes[0].promptSha256, "hex"),
      Buffer.from(result.evidence.schemaSha256, "hex"),
      Buffer.from(result.evidence.sourceSha256, "hex"),
      result.evidence.model,
      JSON.stringify({
        jobId: claim.jobId,
        cliVersion: result.evidence.cliVersion,
        model: result.evidence.model,
        reviewOutputSha256: result.evidence.reviewOutputSha256,
      }),
      options.nowMs,
      claim.jobId,
    );
    options.faultInjector?.("after-revision");

    const reviewKinds = ["translation", "review-1", "review-2"] as const;
    const insertReview = db.sqlite.prepare(`
      INSERT INTO article_review_runs (
        id, job_id, article_id, locale, source_revision_id, pass_kind, state,
        prompt_sha256, schema_sha256, source_sha256, output_sha256,
        model_id, cli_version, findings_json, exit_code,
        created_at_ms, finished_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    for (const [index, pass] of validated.passes.entries()) {
      const findings = index === 2 ? validated.output.reviewerFindings : [];
      insertReview.run(
        reviewIds[index],
        claim.jobId,
        claim.articleId,
        claim.targetLocale,
        claim.sourceRevisionId,
        reviewKinds[index],
        Buffer.from(pass.promptSha256, "hex"),
        Buffer.from(result.evidence.schemaSha256, "hex"),
        Buffer.from(result.evidence.sourceSha256, "hex"),
        Buffer.from(pass.outputSha256, "hex"),
        result.evidence.model,
        result.evidence.cliVersion,
        JSON.stringify(findings),
        options.nowMs,
        options.nowMs,
      );
    }
    options.faultInjector?.("after-review-runs");

    const rowVersion = existingTarget ? existingTarget.row_version + 1 : 1;
    if (existingTarget) {
      const updated = db.sqlite.prepare(`
        UPDATE article_locale_heads
        SET state = 'in_review', head_revision_id = ?,
          approved_revision_id = NULL, published_revision_id = NULL,
          reviewed_by_admin_id = NULL, reviewed_at_ms = NULL,
          approved_by_admin_id = NULL, approved_at_ms = NULL,
          published_at_ms = NULL, row_version = ?, updated_at_ms = ?
        WHERE article_id = ? AND locale = ? AND head_revision_id = ? AND row_version = ?
      `).run(
        revisionId, rowVersion, options.nowMs, claim.articleId, claim.targetLocale,
        existingTarget.head_revision_id, existingTarget.row_version,
      );
      if (updated.changes !== 1) throw new Error("Target locale changed while locked");
    } else {
      db.sqlite.prepare(`
        INSERT INTO article_locale_heads (
          article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
        ) VALUES (?, ?, ?, 'in_review', ?, 1, ?)
      `).run(claim.articleId, claim.targetLocale, sourceSlug, revisionId, options.nowMs);
    }
    options.faultInjector?.("after-head");

    const completed = db.sqlite.prepare(`
      UPDATE article_translation_jobs
      SET state = 'succeeded', result_revision_id = ?, finished_at_ms = ?,
        last_error_code = NULL, locked_at_ms = NULL, lease_expires_at_ms = NULL,
        heartbeat_at_ms = NULL, locked_by = NULL, fencing_token = NULL,
        updated_at_ms = ?
      WHERE id = ? AND article_id = ? AND source_revision_id = ? AND target_locale = ?
        AND state = 'running' AND locked_by = ? AND fencing_token = ?
        AND lease_expires_at_ms > ?
    `).run(
      revisionId,
      options.nowMs,
      options.nowMs,
      ...claimWhere(claim),
      options.nowMs,
    );
    if (completed.changes !== 1) throw new Error("Translation completion was fenced while locked");
    options.faultInjector?.("after-job");

    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'system', 'article-translation-worker',
        'article.translation.completed', 'article-translation-job', ?, ?, ?, ?)
    `).run(
      auditId,
      claim.jobId,
      `article-worker:${claim.jobId}`,
      JSON.stringify({
        articleId: claim.articleId,
        sourceRevisionId: claim.sourceRevisionId,
        targetLocale: claim.targetLocale,
        revisionId,
      }),
      options.nowMs,
    );
    options.faultInjector?.("after-audit");
    db.sqlite.exec("COMMIT");
    return { kind: "committed", revisionId, state: "in_review", rowVersion };
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

export interface FailArticleTranslationJobOptions {
  nowMs: number;
  errorCode: string;
  randomUUID?: () => string;
}

export function failArticleTranslationJob(
  db: ControlDatabase,
  claim: TranslationJobClaim,
  options: FailArticleTranslationJobOptions,
): boolean {
  assertSafeInteger(options.nowMs, "nowMs");
  if (!ERROR_CODE_PATTERN.test(options.errorCode)) throw new Error("Invalid translation error code");
  const createId = options.randomUUID ?? nodeRandomUUID;
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    if (!hasLiveClaim(db, claim, options.nowMs)) {
      db.sqlite.exec("ROLLBACK");
      return false;
    }
    const failed = db.sqlite.prepare(`
      UPDATE article_translation_jobs
      SET state = 'failed', result_revision_id = NULL, last_error_code = ?,
        finished_at_ms = ?, locked_at_ms = NULL, lease_expires_at_ms = NULL,
        heartbeat_at_ms = NULL, locked_by = NULL, fencing_token = NULL,
        updated_at_ms = ?
      WHERE id = ? AND article_id = ? AND source_revision_id = ? AND target_locale = ?
        AND state = 'running' AND locked_by = ? AND fencing_token = ?
        AND lease_expires_at_ms > ?
    `).run(
      options.errorCode,
      options.nowMs,
      options.nowMs,
      ...claimWhere(claim),
      options.nowMs,
    );
    if (failed.changes !== 1) throw new Error("Translation failure was fenced while locked");
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'system', 'article-translation-worker',
        'article.translation.failed', 'article-translation-job', ?, ?, ?, ?)
    `).run(
      createId(),
      claim.jobId,
      `article-worker:${claim.jobId}`,
      JSON.stringify({
        articleId: claim.articleId,
        sourceRevisionId: claim.sourceRevisionId,
        targetLocale: claim.targetLocale,
        errorCode: options.errorCode,
      }),
      options.nowMs,
    );
    db.sqlite.exec("COMMIT");
    return true;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
