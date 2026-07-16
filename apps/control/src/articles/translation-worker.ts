import {
  CodexExecutionError,
  type CodexTranslationResult,
  type CodexTranslationSource,
} from "./codex-executor.js";
import type {
  CommitTranslationResult,
  TranslationJobClaim,
} from "./translation-jobs.js";

export const ARTICLE_TRANSLATION_HEARTBEAT_MS = 30_000;

export interface ArticleTranslationWorkerDependencies {
  claim(): TranslationJobClaim | undefined;
  heartbeat(claim: TranslationJobClaim, nowMs: number): boolean;
  execute(
    source: CodexTranslationSource,
    targetLocale: TranslationJobClaim["targetLocale"],
  ): Promise<CodexTranslationResult>;
  commit(
    claim: TranslationJobClaim,
    result: CodexTranslationResult,
    nowMs: number,
  ): CommitTranslationResult;
  fail(claim: TranslationJobClaim, errorCode: string, nowMs: number): boolean;
  now(): number;
  scheduleHeartbeat(callback: () => void, intervalMs: number): unknown;
  cancelHeartbeat(handle: unknown): void;
}

export type ArticleTranslationCycleResult =
  | { kind: "idle" }
  | {
      kind: "succeeded";
      jobId: string;
      revisionId: string;
      state: "in_review";
    }
  | { kind: "failed"; jobId: string; errorCode: string }
  | { kind: "fenced"; jobId: string };

function safeCodexErrorCode(error: unknown): string {
  return error instanceof CodexExecutionError ? error.code : "PROCESS_FAILED";
}

export async function processArticleTranslationCycle(
  dependencies: ArticleTranslationWorkerDependencies,
): Promise<ArticleTranslationCycleResult> {
  const claim = dependencies.claim();
  if (!claim) return { kind: "idle" };

  let fenced = false;
  const heartbeat = (): void => {
    if (fenced) return;
    try {
      if (!dependencies.heartbeat(claim, dependencies.now())) fenced = true;
    } catch {
      fenced = true;
    }
  };
  const heartbeatHandle = dependencies.scheduleHeartbeat(
    heartbeat,
    ARTICLE_TRANSLATION_HEARTBEAT_MS,
  );
  try {
    if (fenced) return { kind: "fenced", jobId: claim.jobId };
    const result = await dependencies.execute(claim.source, claim.targetLocale);
    if (fenced) return { kind: "fenced", jobId: claim.jobId };
    // Renew synchronously before the commit, covering delayed event-loop timers.
    heartbeat();
    if (fenced) return { kind: "fenced", jobId: claim.jobId };
    const committed = dependencies.commit(claim, result, dependencies.now());
    if (committed.kind === "committed") {
      return {
        kind: "succeeded",
        jobId: claim.jobId,
        revisionId: committed.revisionId,
        state: committed.state,
      };
    }
    if (committed.kind === "fenced") return { kind: "fenced", jobId: claim.jobId };
    const errorCode = committed.kind === "target-conflict"
      ? "TARGET_LOCALE_CONFLICT"
      : "OUTPUT_INVALID";
    return dependencies.fail(claim, errorCode, dependencies.now())
      ? { kind: "failed", jobId: claim.jobId, errorCode }
      : { kind: "fenced", jobId: claim.jobId };
  } catch (error) {
    if (fenced) return { kind: "fenced", jobId: claim.jobId };
    const errorCode = safeCodexErrorCode(error);
    return dependencies.fail(claim, errorCode, dependencies.now())
      ? { kind: "failed", jobId: claim.jobId, errorCode }
      : { kind: "fenced", jobId: claim.jobId };
  } finally {
    dependencies.cancelHeartbeat(heartbeatHandle);
  }
}

export interface ArticleTranslationRunnerOptions {
  processNext(): Promise<ArticleTranslationCycleResult>;
  logger?: { write(event: { event: "article.worker.error"; code: "WORKER_CYCLE_FAILED" }): void };
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  idleDelayMs?: number;
  activeDelayMs?: number;
  errorDelayMs?: number;
}

export function createArticleTranslationWorkerRunner(options: ArticleTranslationRunnerOptions) {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>));
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const activeDelayMs = options.activeDelayMs ?? 25;
  const errorDelayMs = options.errorDelayMs ?? 5_000;
  let running = false;
  let timer: unknown;
  let inFlight: Promise<ArticleTranslationCycleResult> | undefined;

  const safeErrorLog = (): void => {
    try {
      options.logger?.write({ event: "article.worker.error", code: "WORKER_CYCLE_FAILED" });
    } catch {
      // Logging cannot stop the worker or expose a process diagnostic.
    }
  };
  const runOnce = async (): Promise<ArticleTranslationCycleResult> => {
    try {
      return await options.processNext();
    } catch {
      safeErrorLog();
      return { kind: "failed", jobId: "unclaimed", errorCode: "WORKER_CYCLE_FAILED" };
    }
  };
  const scheduleCycle = (delayMs: number): void => {
    timer = schedule(() => {
      inFlight = runOnce();
      void inFlight.then((result) => {
        inFlight = undefined;
        if (!running) return;
        scheduleCycle(
          result.kind === "idle"
            ? idleDelayMs
            : result.kind === "failed" && result.errorCode === "WORKER_CYCLE_FAILED"
              ? errorDelayMs
              : activeDelayMs,
        );
      });
    }, delayMs);
  };
  return {
    runOnce,
    start(): void {
      if (running) return;
      running = true;
      scheduleCycle(0);
    },
    async stop(): Promise<void> {
      running = false;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      if (inFlight) await inFlight;
    },
  };
}
