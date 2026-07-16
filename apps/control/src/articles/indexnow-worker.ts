import type { IndexNowDeliveryResult } from "./indexnow-outbox.js";

export interface IndexNowDeliveryWorkerRunnerOptions {
  processNext(): Promise<IndexNowDeliveryResult>;
  logger?: {
    write(event: {
      event: "indexnow.worker.error";
      code: "WORKER_CYCLE_FAILED";
    }): void;
  };
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  idleDelayMs?: number;
  activeDelayMs?: number;
  errorDelayMs?: number;
}

type IndexNowRunnerResult = IndexNowDeliveryResult | { kind: "error" };

export function createIndexNowDeliveryWorkerRunner(
  options: IndexNowDeliveryWorkerRunnerOptions,
) {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>));
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const activeDelayMs = options.activeDelayMs ?? 25;
  const errorDelayMs = options.errorDelayMs ?? 5_000;
  let running = false;
  let timer: unknown;
  let inFlight: Promise<IndexNowRunnerResult> | undefined;

  const safeErrorLog = (): void => {
    try {
      options.logger?.write({
        event: "indexnow.worker.error",
        code: "WORKER_CYCLE_FAILED",
      });
    } catch {
      // Logging cannot stop delivery or expose provider diagnostics.
    }
  };
  const runOnce = async (): Promise<IndexNowRunnerResult> => {
    try {
      return await options.processNext();
    } catch {
      safeErrorLog();
      return { kind: "error" };
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
            : result.kind === "error"
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
