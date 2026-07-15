export interface NotificationRunnerLogEvent {
  event: "notification.worker.error";
  code: "WORKER_CYCLE_FAILED";
}

interface NotificationWorkerRunnerOptions {
  loadAdapters: () => unknown;
  processNext: (adapters: unknown) => Promise<{ kind: string }>;
  logger?: { write(event: NotificationRunnerLogEvent): void };
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  idleDelayMs?: number;
  activeDelayMs?: number;
  errorDelayMs?: number;
}

export function createNotificationWorkerRunner(options: NotificationWorkerRunnerOptions) {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const activeDelayMs = options.activeDelayMs ?? 25;
  const errorDelayMs = options.errorDelayMs ?? 5_000;
  let running = false;
  let timer: unknown;
  let inFlight: Promise<{ kind: string }> | undefined;

  const safeErrorLog = (): void => {
    try {
      options.logger?.write({ event: "notification.worker.error", code: "WORKER_CYCLE_FAILED" });
    } catch {
      // Logging cannot keep the worker alive or expose provider input.
    }
  };

  const runOnce = async (): Promise<{ kind: string }> => {
    try {
      const adapters = options.loadAdapters();
      return await options.processNext(adapters);
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
