import { createHash } from "node:crypto";

import {
  computePublishedArticleContentSha256,
  type Locale,
} from "@wisdom/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { blindIndex, createStaticKeyProvider } from "../crypto/index.js";
import { closeDatabase, openDatabase, type ControlDatabase } from "../db/client.js";
import {
  computeCodexPassPromptSha256,
  computeCodexTranslationOutputSha256,
  computeCodexTranslationSchemaSha256,
  type CodexTranslationResult,
} from "./codex-executor.js";
import {
  claimArticleTranslationJob,
  commitArticleTranslationSuccess,
  failArticleTranslationJob,
  heartbeatArticleTranslationJob,
  type TranslationJobFaultPoint,
} from "./translation-jobs.js";
import { computeArticleTranslationInputSha256 } from "./workflow.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTICLE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_REVISION_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const RESULT_REVISION_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_IDS = [
  "55555555-5555-4555-8555-555555555551",
  "55555555-5555-4555-8555-555555555552",
  "55555555-5555-4555-8555-555555555553",
] as const;
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const NOW = Date.parse("2026-07-16T02:00:00.000Z");
const SOURCE_BODY = "## Source answer\n\nPublic procurement guidance.\n";
const SOURCES = [{
  id: "official-a",
  url: "https://example.com/official-a",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
}];
const SOURCE_CONTENT_SHA = Buffer.from(computePublishedArticleContentSha256({
  title: "Source title",
  summary: "Source summary.",
  bodyMarkdown: SOURCE_BODY,
  sources: SOURCES,
  locale: "ko",
}), "hex");
const TRANSLATION_INPUT_SHA = computeArticleTranslationInputSha256(
  ARTICLE_ID,
  SOURCE_REVISION_ID,
  SOURCE_CONTENT_SHA,
  "en",
);

let fixture: TestDatabase;
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 101) });

beforeEach(() => {
  fixture = createTestDatabase();
  fixture.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms
    ) VALUES (?, 'reviewer', 'Review Admin', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO articles (
      id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms
    ) VALUES (?, 'source-guide', 'approved', 'ko', ?, 'hermes', 0, 0)
  `).run(ARTICLE_ID, SOURCE_REVISION_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO article_revisions (
      id, article_id, locale, revision_no, title, summary, body_markdown,
      content_sha256, sources_json, source_sha256, initial_review_state,
      created_at_ms, created_by_type, created_by_id
    ) VALUES (?, ?, 'ko', 1, 'Source title', 'Source summary.', ?, ?, ?, ?,
      'approved', 0, 'hermes', 'hermes-source')
  `).run(
    SOURCE_REVISION_ID, ARTICLE_ID, SOURCE_BODY, SOURCE_CONTENT_SHA,
    JSON.stringify(SOURCES), Buffer.alloc(32, 7),
  );
  fixture.db.sqlite.prepare(`
    INSERT INTO article_locale_heads (
      article_id, locale, slug, state, head_revision_id,
      approved_revision_id, reviewed_by_admin_id, reviewed_at_ms,
      approved_by_admin_id, approved_at_ms, row_version, updated_at_ms
    ) VALUES (?, 'ko', 'source-guide', 'approved', ?, ?, ?, 1, ?, 1, 3, 1)
  `).run(ARTICLE_ID, SOURCE_REVISION_ID, SOURCE_REVISION_ID, ADMIN_ID, ADMIN_ID);
  fixture.db.sqlite.prepare(`
    INSERT INTO article_translation_jobs (
      id, article_id, source_revision_id, target_locale, state,
      input_sha256, dedupe_key, attempt_count, available_at_ms,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'en', 'queued', ?, 'translation-job-1', 0, ?, 0, 0)
  `).run(JOB_ID, ARTICLE_ID, SOURCE_REVISION_ID, TRANSLATION_INPUT_SHA, NOW);
});

afterEach(() => fixture.close());

function token(byte: number) {
  return () => Buffer.alloc(32, byte);
}

function ids() {
  const values = [RESULT_REVISION_ID, ...REVIEW_IDS, AUDIT_ID];
  let index = 0;
  return () => values[index++]!;
}

function sourceArtifactSha256(): string {
  return createHash("sha256").update(`${JSON.stringify({
    schemaVersion: 1,
    articleId: ARTICLE_ID,
    revisionId: SOURCE_REVISION_ID,
    locale: "ko",
    title: "Source title",
    summary: "Source summary.",
    bodyMarkdown: SOURCE_BODY,
    sources: SOURCES,
  })}\n`).digest("hex");
}

function successResult(locale: Locale = "en"): CodexTranslationResult {
  const output: CodexTranslationResult["output"] = {
    locale,
    title: "Translated title",
    summary: "Translated professional summary.",
    bodyMarkdown: "## Complete answer\n\nTranslated public guidance.\n",
    sourceIds: ["official-a"],
    reviewerFindings: [{
      code: "language-review",
      severity: "info",
      message: "Professional terminology verified.",
    }],
  };
  return {
    output,
    evidence: {
      cliVersion: "codex-cli 1.2.3",
      model: "fixed-model",
      sourceRevisionId: SOURCE_REVISION_ID,
      sourceLocale: "ko",
      targetLocale: locale,
      sourceSha256: sourceArtifactSha256(),
      schemaSha256: computeCodexTranslationSchemaSha256(),
      passes: [
        { kind: "translation", promptSha256: computeCodexPassPromptSha256("translation"), outputSha256: "31".repeat(32), exitCode: 0 },
        { kind: "review-accuracy", promptSha256: computeCodexPassPromptSha256("review-accuracy"), outputSha256: "32".repeat(32), exitCode: 0 },
        { kind: "review-language", promptSha256: computeCodexPassPromptSha256("review-language"), outputSha256: computeCodexTranslationOutputSha256(output), exitCode: 0 },
      ],
      reviewOutputSha256: ["32".repeat(32), computeCodexTranslationOutputSha256(output)],
    },
  };
}

describe("serialized fenced article translation jobs", () => {
  it("claims at most one running job across two file-backed connections", () => {
    const second = openDatabase(fixture.path);
    try {
      const claim = claimArticleTranslationJob(fixture.db, {
        workerId: "worker-a",
        nowMs: NOW,
      }, { randomBytes: token(1) });
      expect(claim).toMatchObject({
        jobId: JOB_ID,
        articleId: ARTICLE_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        sourceLocale: "ko",
        targetLocale: "en",
        attemptCount: 1,
      });
      expect(claim?.fencingToken).toEqual(Buffer.alloc(32, 1));
      expect(claimArticleTranslationJob(second, {
        workerId: "worker-b",
        nowMs: NOW + 1,
      }, { randomBytes: token(2) })).toBeUndefined();
      expect(second.sqlite.prepare(`
        SELECT state, locked_by, locked_at_ms, heartbeat_at_ms,
          lease_expires_at_ms, attempt_count
        FROM article_translation_jobs WHERE id = ?
      `).get(JOB_ID)).toEqual({
        state: "running",
        locked_by: "worker-a",
        locked_at_ms: NOW,
        heartbeat_at_ms: NOW,
        lease_expires_at_ms: NOW + 120_000,
        attempt_count: 1,
      });
    } finally {
      closeDatabase(second);
    }
  });

  it("renews a live lease and rejects heartbeat at or after expiry", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-a", nowMs: NOW,
    }, { randomBytes: token(3) })!;
    expect(heartbeatArticleTranslationJob(fixture.db, claim, NOW + 30_000)).toBe(true);
    expect(fixture.db.sqlite.prepare(`
      SELECT heartbeat_at_ms, lease_expires_at_ms FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      heartbeat_at_ms: NOW + 30_000,
      lease_expires_at_ms: NOW + 150_000,
    });
    expect(heartbeatArticleTranslationJob(fixture.db, claim, NOW + 150_000)).toBe(false);
  });

  it("recovers a stale lease and fences every late action from the old worker", () => {
    const oldClaim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-old", nowMs: NOW,
    }, { randomBytes: token(4) })!;
    const recovered = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-new", nowMs: NOW + 120_000,
    }, { randomBytes: token(5) })!;
    expect(recovered).toMatchObject({ jobId: JOB_ID, attemptCount: 2, workerId: "worker-new" });
    expect(recovered.fencingToken).toEqual(Buffer.alloc(32, 5));
    expect(heartbeatArticleTranslationJob(fixture.db, oldClaim, NOW + 120_001)).toBe(false);
    expect(failArticleTranslationJob(fixture.db, oldClaim, {
      nowMs: NOW + 120_001,
      errorCode: "LATE_WORKER",
    })).toBe(false);
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, oldClaim, successResult(), {
        nowMs: NOW + 120_001, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({ kind: "fenced" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
  });

  it("rejects completion by the unchanged owner at the exact lease boundary", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-expired", nowMs: NOW,
    }, { randomBytes: token(41) })!;
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, claim, successResult(), {
        nowMs: NOW + 120_000, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({ kind: "fenced" });
    expect(failArticleTranslationJob(fixture.db, claim, {
      nowMs: NOW + 120_000,
      errorCode: "PROCESS_TIMEOUT",
    })).toBe(false);
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM article_translation_jobs WHERE id = ?",
    ).get(JOB_ID)).toEqual({ state: "running" });
  });

  it.each([
    ["output target locale", (value: CodexTranslationResult) => { value.output.locale = "zh-Hans"; }],
    ["output source IDs", (value: CodexTranslationResult) => { value.output.sourceIds = ["wrong-source"]; }],
    ["evidence source revision", (value: CodexTranslationResult) => { value.evidence.sourceRevisionId = RESULT_REVISION_ID; }],
    ["evidence source locale", (value: CodexTranslationResult) => { value.evidence.sourceLocale = "en"; }],
    ["evidence target locale", (value: CodexTranslationResult) => { value.evidence.targetLocale = "zh-Hans"; }],
    ["exact source artifact hash", (value: CodexTranslationResult) => { value.evidence.sourceSha256 = "00".repeat(32); }],
    ["schema hash", (value: CodexTranslationResult) => { value.evidence.schemaSha256 = "00".repeat(32); }],
    ["fixed model", (value: CodexTranslationResult) => { value.evidence.model = "other-valid-model"; }],
    ["pass order", (value: CodexTranslationResult) => {
      value.evidence.passes = [value.evidence.passes[1]!, value.evidence.passes[0]!, value.evidence.passes[2]!];
    }],
    ["pass hash", (value: CodexTranslationResult) => {
      value.evidence.passes[1]!.outputSha256 = "malformed";
    }],
    ["fixed prompt hash", (value: CodexTranslationResult) => {
      value.evidence.passes[0]!.promptSha256 = "00".repeat(32);
    }],
    ["final canonical output hash", (value: CodexTranslationResult) => {
      value.evidence.passes[2]!.outputSha256 = "00".repeat(32);
      value.evidence.reviewOutputSha256 = [
        value.evidence.reviewOutputSha256[0], "00".repeat(32),
      ];
    }],
    ["review hash binding", (value: CodexTranslationResult) => {
      value.evidence.reviewOutputSha256 = ["ff".repeat(32), value.evidence.reviewOutputSha256[1]];
    }],
  ] as const)("rejects mismatched or malformed %s evidence without writes", (_name, mutate) => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-invalid", nowMs: NOW,
    }, { randomBytes: token(42) })!;
    const result = successResult();
    mutate(result);
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, claim, result, {
        nowMs: NOW + 1_000, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({ kind: "invalid-result" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_review_runs").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM article_translation_jobs WHERE id = ?",
    ).get(JOB_ID)).toEqual({ state: "running" });
  });

  it("rechecks newly retained consultation PII inside the completion transaction", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-pii", nowMs: NOW,
    }, { randomBytes: token(43) })!;
    fixture.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('new-private-row', 'new-private-receipt', 'received', 'ko',
        'procurement', 'email', 'undecryptable', 'pii-v1', ?, ?, 'pii-v1',
        0, ?, ?, 9999999999999, 1)
    `).run(
      blindIndex(keyProvider, "phone", "+821077777777"),
      blindIndex(keyProvider, "email", "private@example.com"),
      NOW + 1,
      NOW + 1,
    );
    const unsafe = successResult();
    unsafe.output.summary = "Contact private@example.com";
    const finalHash = computeCodexTranslationOutputSha256(unsafe.output);
    unsafe.evidence.passes[2]!.outputSha256 = finalHash;
    unsafe.evidence.reviewOutputSha256 = [unsafe.evidence.reviewOutputSha256[0], finalHash];
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, claim, unsafe, {
        nowMs: NOW + 2_000, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({ kind: "invalid-result" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_review_runs").get()).toEqual({ count: 0 });
  });

  it("rejects completion when the source head approval was revoked after claim", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-revoked", nowMs: NOW,
    }, { randomBytes: token(44) })!;
    fixture.db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'in_review', approved_revision_id = NULL,
        approved_by_admin_id = NULL, approved_at_ms = NULL,
        row_version = row_version + 1, updated_at_ms = ?
      WHERE article_id = ? AND locale = 'ko'
    `).run(NOW + 1, ARTICLE_ID);
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, claim, successResult(), {
        nowMs: NOW + 2_000, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({ kind: "invalid-result" });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM article_translation_jobs WHERE id = ?",
    ).get(JOB_ID)).toEqual({ state: "running" });
  });

  it("refuses to claim a job whose deterministic input hash was tampered", () => {
    fixture.db.sqlite.prepare(`
      UPDATE article_translation_jobs SET input_sha256 = ? WHERE id = ?
    `).run(Buffer.alloc(32, 99), JOB_ID);
    expect(() => claimArticleTranslationJob(fixture.db, {
      workerId: "worker-tampered", nowMs: NOW,
    }, { randomBytes: token(45) })).toThrow("input hash");
    expect(fixture.db.sqlite.prepare(
      "SELECT state FROM article_translation_jobs WHERE id = ?",
    ).get(JOB_ID)).toEqual({ state: "queued" });
  });

  it("commits review evidence, one immutable revision, locale head, job, and audit atomically without approval", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-a", nowMs: NOW,
    }, { randomBytes: token(6) })!;
    expect(commitArticleTranslationSuccess(
      fixture.db, keyProvider, claim, successResult(), {
        nowMs: NOW + 1_000, expectedModel: "fixed-model", randomUUID: ids(),
      },
    )).toEqual({
      kind: "committed",
      revisionId: RESULT_REVISION_ID,
      state: "in_review",
      rowVersion: 1,
    });

    expect(fixture.db.sqlite.prepare(`
      SELECT locale, revision_no, title, summary, body_markdown,
        source_revision_id, parent_revision_id, initial_review_state,
        created_by_type, created_by_id, model_id
      FROM article_revisions WHERE id = ?
    `).get(RESULT_REVISION_ID)).toEqual({
      locale: "en",
      revision_no: 1,
      title: "Translated title",
      summary: "Translated professional summary.",
      body_markdown: "## Complete answer\n\nTranslated public guidance.\n",
      source_revision_id: SOURCE_REVISION_ID,
      parent_revision_id: null,
      initial_review_state: "in_review",
      created_by_type: "codex",
      created_by_id: JOB_ID,
      model_id: "fixed-model",
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT slug, state, head_revision_id, approved_revision_id,
        published_revision_id, row_version
      FROM article_locale_heads WHERE article_id = ? AND locale = 'en'
    `).get(ARTICLE_ID)).toEqual({
      slug: "source-guide",
      state: "in_review",
      head_revision_id: RESULT_REVISION_ID,
      approved_revision_id: null,
      published_revision_id: null,
      row_version: 1,
    });
    expect(fixture.db.sqlite.prepare(`
      SELECT pass_kind, state, model_id, cli_version, findings_json
      FROM article_review_runs ORDER BY pass_kind
    `).all()).toEqual([
      { pass_kind: "review-1", state: "succeeded", model_id: "fixed-model", cli_version: "codex-cli 1.2.3", findings_json: "[]" },
      { pass_kind: "review-2", state: "succeeded", model_id: "fixed-model", cli_version: "codex-cli 1.2.3", findings_json: JSON.stringify(successResult().output.reviewerFindings) },
      { pass_kind: "translation", state: "succeeded", model_id: "fixed-model", cli_version: "codex-cli 1.2.3", findings_json: "[]" },
    ]);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, result_revision_id, finished_at_ms,
        locked_by, fencing_token, lease_expires_at_ms
      FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      state: "succeeded",
      result_revision_id: RESULT_REVISION_ID,
      finished_at_ms: NOW + 1_000,
      locked_by: null,
      fencing_token: null,
      lease_expires_at_ms: null,
    });
    expect(fixture.db.sqlite.prepare(
      "SELECT state, current_revision_id FROM articles WHERE id = ?",
    ).get(ARTICLE_ID)).toEqual({ state: "approved", current_revision_id: SOURCE_REVISION_ID });
    expect(fixture.db.sqlite.prepare(`
      SELECT actor_type, action, target_id FROM audit_events
    `).get()).toEqual({
      actor_type: "system",
      action: "article.translation.completed",
      target_id: JOB_ID,
    });
  });

  it("fails a claimed job without a revision or review artifact", () => {
    const claim = claimArticleTranslationJob(fixture.db, {
      workerId: "worker-a", nowMs: NOW,
    }, { randomBytes: token(7) })!;
    expect(failArticleTranslationJob(fixture.db, claim, {
      nowMs: NOW + 1_000,
      errorCode: "CODEX_EXIT_NONZERO",
      randomUUID: () => AUDIT_ID,
    })).toBe(true);
    expect(fixture.db.sqlite.prepare(`
      SELECT state, last_error_code, finished_at_ms, locked_by, fencing_token
      FROM article_translation_jobs WHERE id = ?
    `).get(JOB_ID)).toEqual({
      state: "failed",
      last_error_code: "CODEX_EXIT_NONZERO",
      finished_at_ms: NOW + 1_000,
      locked_by: null,
      fencing_token: null,
    });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_review_runs").get()).toEqual({ count: 0 });
  });

  it("rolls every completion write back at each injected fault boundary", () => {
    for (const fault of [
      "after-revision", "after-review-runs", "after-head", "after-job", "after-audit",
    ] as const satisfies readonly TranslationJobFaultPoint[]) {
      fixture.close();
      fixture = createTestDatabase();
      // Re-use the suite seed by reconstructing a fresh fixture is intentionally
      // covered in the dedicated fault helper below.
      seedApprovedQueuedJob(fixture.db);
      const claim = claimArticleTranslationJob(fixture.db, {
        workerId: "worker-fault", nowMs: NOW,
      }, { randomBytes: token(8) })!;
      expect(() => commitArticleTranslationSuccess(
        fixture.db, keyProvider, claim, successResult(), {
          nowMs: NOW + 1_000,
          expectedModel: "fixed-model",
          randomUUID: ids(),
          faultInjector(point) {
            if (point === fault) throw new Error(fault);
          },
        },
      )).toThrow(fault);
      expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
      expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_review_runs").get()).toEqual({ count: 0 });
      expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM article_locale_heads").get()).toEqual({ count: 1 });
      expect(fixture.db.sqlite.prepare(
        "SELECT state FROM article_translation_jobs WHERE id = ?",
      ).get(JOB_ID)).toEqual({ state: "running" });
      expect(fixture.db.sqlite.prepare("SELECT count(*) count FROM audit_events").get()).toEqual({ count: 0 });
    }
  });
});

function seedApprovedQueuedJob(db: ControlDatabase): void {
  db.sqlite.prepare(`
    INSERT INTO admins (id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms)
    VALUES (?, 'reviewer', 'Review Admin', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);
  db.sqlite.prepare(`
    INSERT INTO articles (id, slug, state, source_locale, current_revision_id,
      created_by_type, created_at_ms, updated_at_ms)
    VALUES (?, 'source-guide', 'approved', 'ko', ?, 'hermes', 0, 0)
  `).run(ARTICLE_ID, SOURCE_REVISION_ID);
  db.sqlite.prepare(`
    INSERT INTO article_revisions (id, article_id, locale, revision_no, title,
      summary, body_markdown, content_sha256, sources_json, source_sha256,
      initial_review_state, created_at_ms, created_by_type, created_by_id)
    VALUES (?, ?, 'ko', 1, 'Source title', 'Source summary.', ?, ?, ?, ?,
      'approved', 0, 'hermes', 'hermes-source')
  `).run(SOURCE_REVISION_ID, ARTICLE_ID, SOURCE_BODY, SOURCE_CONTENT_SHA,
    JSON.stringify(SOURCES), Buffer.alloc(32, 7));
  db.sqlite.prepare(`
    INSERT INTO article_locale_heads (article_id, locale, slug, state,
      head_revision_id, approved_revision_id, reviewed_by_admin_id, reviewed_at_ms,
      approved_by_admin_id, approved_at_ms, row_version, updated_at_ms)
    VALUES (?, 'ko', 'source-guide', 'approved', ?, ?, ?, 1, ?, 1, 3, 1)
  `).run(ARTICLE_ID, SOURCE_REVISION_ID, SOURCE_REVISION_ID, ADMIN_ID, ADMIN_ID);
  db.sqlite.prepare(`
    INSERT INTO article_translation_jobs (id, article_id, source_revision_id,
      target_locale, state, input_sha256, dedupe_key, attempt_count,
      available_at_ms, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 'en', 'queued', ?, 'translation-job-1', 0, ?, 0, 0)
  `).run(JOB_ID, ARTICLE_ID, SOURCE_REVISION_ID, TRANSLATION_INPUT_SHA, NOW);
}
