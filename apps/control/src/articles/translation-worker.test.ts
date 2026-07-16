import { describe, expect, it, vi } from "vitest";

import { CodexExecutionError, type CodexTranslationResult } from "./codex-executor.js";
import type { TranslationJobClaim } from "./translation-jobs.js";
import { processArticleTranslationCycle } from "./translation-worker.js";

const claim = {
  jobId: "33333333-3333-4333-8333-333333333333",
  articleId: "11111111-1111-4111-8111-111111111111",
  sourceRevisionId: "22222222-2222-4222-8222-222222222222",
  sourceLocale: "ko",
  targetLocale: "en",
  inputSha256: Buffer.alloc(32, 1),
  attemptCount: 1,
  workerId: "worker-test",
  fencingToken: Buffer.alloc(32, 2),
  leaseExpiresAtMs: 120_000,
  source: {
    articleId: "11111111-1111-4111-8111-111111111111",
    revisionId: "22222222-2222-4222-8222-222222222222",
    locale: "ko",
    title: "Source",
    summary: "Summary",
    bodyMarkdown: "## Source\n",
    sources: [{
      id: "official",
      url: "https://example.com/official",
      sourceTimestamp: "2026-07-16T00:00:00.000Z",
    }],
  },
} satisfies TranslationJobClaim;

const result = {
  output: {
    locale: "en",
    title: "Target",
    summary: "Target summary",
    bodyMarkdown: "## Target\n",
    sourceIds: ["official"],
    reviewerFindings: [],
  },
  evidence: {
    cliVersion: "codex-cli 1.2.3",
    model: "fixed-model",
    sourceRevisionId: claim.sourceRevisionId,
    sourceLocale: "ko",
    targetLocale: "en",
    sourceSha256: "11".repeat(32),
    schemaSha256: "22".repeat(32),
    passes: [],
    reviewOutputSha256: ["33".repeat(32), "44".repeat(32)],
  },
} as unknown as CodexTranslationResult;

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    claim: vi.fn(() => claim as TranslationJobClaim | undefined),
    heartbeat: vi.fn(() => true),
    execute: vi.fn(async () => result),
    commit: vi.fn(() => ({
      kind: "committed" as const,
      revisionId: "44444444-4444-4444-8444-444444444444",
      state: "in_review" as const,
      rowVersion: 1,
    })),
    fail: vi.fn(() => true),
    now: vi.fn(() => 1_000),
    scheduleHeartbeat: vi.fn(() => "timer"),
    cancelHeartbeat: vi.fn(),
    ...overrides,
  };
}

describe("article translation worker cycle", () => {
  it("returns idle without starting Codex when no job can be claimed", async () => {
    const current = dependencies({ claim: vi.fn(() => undefined) });
    await expect(processArticleTranslationCycle(current)).resolves.toEqual({ kind: "idle" });
    expect(current.execute).not.toHaveBeenCalled();
    expect(current.scheduleHeartbeat).not.toHaveBeenCalled();
  });

  it("executes one claim, renews through a bounded heartbeat, and commits without auto-approval", async () => {
    const current = dependencies();
    await expect(processArticleTranslationCycle(current)).resolves.toEqual({
      kind: "succeeded",
      jobId: claim.jobId,
      revisionId: "44444444-4444-4444-8444-444444444444",
      state: "in_review",
    });
    expect(current.execute).toHaveBeenCalledWith(claim.source, "en");
    expect(current.scheduleHeartbeat).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(current.cancelHeartbeat).toHaveBeenCalledWith("timer");
    expect(current.commit).toHaveBeenCalledWith(claim, result, 1_000);
    expect(current.fail).not.toHaveBeenCalled();
  });

  it("converts hardened Codex errors and invalid commits into redacted terminal codes", async () => {
    const codexFailure = dependencies({
      execute: vi.fn(async () => { throw new CodexExecutionError("OUTPUT_SOURCES_MISMATCH"); }),
    });
    await expect(processArticleTranslationCycle(codexFailure)).resolves.toEqual({
      kind: "failed", jobId: claim.jobId, errorCode: "OUTPUT_SOURCES_MISMATCH",
    });
    expect(codexFailure.fail).toHaveBeenCalledWith(claim, "OUTPUT_SOURCES_MISMATCH", 1_000);

    const invalidCommit = dependencies({ commit: vi.fn(() => ({ kind: "invalid-result" as const })) });
    await expect(processArticleTranslationCycle(invalidCommit)).resolves.toEqual({
      kind: "failed", jobId: claim.jobId, errorCode: "OUTPUT_INVALID",
    });
    expect(invalidCommit.fail).toHaveBeenCalledWith(claim, "OUTPUT_INVALID", 1_000);

    const unknown = dependencies({ execute: vi.fn(async () => { throw new Error("private diagnostic"); }) });
    await expect(processArticleTranslationCycle(unknown)).resolves.toEqual({
      kind: "failed", jobId: claim.jobId, errorCode: "PROCESS_FAILED",
    });
    expect(JSON.stringify(unknown.fail.mock.calls)).not.toContain("private diagnostic");
  });

  it("never commits or fails after the heartbeat reports that the worker was fenced", async () => {
    const current = dependencies({
      heartbeat: vi.fn(() => false),
      scheduleHeartbeat: vi.fn((callback: () => void) => {
        callback();
        return "timer";
      }),
    });
    await expect(processArticleTranslationCycle(current)).resolves.toEqual({
      kind: "fenced", jobId: claim.jobId,
    });
    expect(current.commit).not.toHaveBeenCalled();
    expect(current.fail).not.toHaveBeenCalled();
  });
});
