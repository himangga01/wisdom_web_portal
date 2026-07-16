export interface ContentWorkerLane {
  start(): void;
  stop(): Promise<void>;
}

type LaneName = "translation" | "indexnow";

interface LaneLogger {
  write(event: {
    event: "content.worker.lane-unavailable";
    lane: LaneName;
    code: "LANE_INITIALIZATION_FAILED" | "LANE_START_FAILED" | "LANE_STOP_FAILED";
  }): void;
}

export interface InitializeContentWorkerLanesOptions {
  createTranslation(): ContentWorkerLane | null | undefined;
  createIndexNow(): ContentWorkerLane | null | undefined;
  logger?: LaneLogger;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export function initializeContentWorkerLanes(
  options: InitializeContentWorkerLanesOptions,
) {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  });
  const cancel = options.cancel ?? ((handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>));
  const retryBaseMs = options.retryBaseMs ?? 5_000;
  const retryMaxMs = options.retryMaxMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 100
    || !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs
    || retryMaxMs > 60 * 60_000
  ) throw new Error("Content lane retry bounds are invalid");
  const safeLog = (lane: LaneName, code: Parameters<LaneLogger["write"]>[0]["code"]): void => {
    try {
      options.logger?.write({ event: "content.worker.lane-unavailable", lane, code });
    } catch {
      // Logging cannot couple independent worker lanes.
    }
  };
  interface LaneState {
    name: LaneName;
    factory: () => ContentWorkerLane | null | undefined;
    worker: ContentWorkerLane | undefined;
    retryHandle: unknown | undefined;
    failureCount: number;
    disabled: boolean;
  };
  const entries: LaneState[] = [
    { name: "translation", factory: options.createTranslation, worker: undefined, retryHandle: undefined, failureCount: 0, disabled: false },
    { name: "indexnow", factory: options.createIndexNow, worker: undefined, retryHandle: undefined, failureCount: 0, disabled: false },
  ];
  let running = false;

  const scheduleRetry = (state: LaneState): void => {
    if (!running || state.disabled || state.retryHandle !== undefined) return;
    state.failureCount += 1;
    const delayMs = Math.min(
      retryBaseMs * (2 ** Math.min(state.failureCount - 1, 20)),
      retryMaxMs,
    );
    state.retryHandle = schedule(() => {
      state.retryHandle = undefined;
      activate(state);
    }, delayMs);
  };

  const activate = (state: LaneState): void => {
    if (!running || state.disabled || state.worker) return;
    let worker: ContentWorkerLane | null | undefined;
    try {
      worker = state.factory();
    } catch {
      safeLog(state.name, "LANE_INITIALIZATION_FAILED");
      scheduleRetry(state);
      return;
    }
    if (worker === null) {
      state.disabled = true;
      return;
    }
    if (!worker) {
      safeLog(state.name, "LANE_INITIALIZATION_FAILED");
      scheduleRetry(state);
      return;
    }
    try {
      worker.start();
      state.worker = worker;
      state.failureCount = 0;
    } catch {
      safeLog(state.name, "LANE_START_FAILED");
      try {
        void worker.stop().catch(() => safeLog(state.name, "LANE_STOP_FAILED"));
      } catch {
        safeLog(state.name, "LANE_STOP_FAILED");
      }
      scheduleRetry(state);
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      for (const state of entries) activate(state);
    },
    async stop(): Promise<void> {
      running = false;
      await Promise.all(entries.map(async (state) => {
        if (state.retryHandle !== undefined) {
          cancel(state.retryHandle);
          state.retryHandle = undefined;
        }
        const worker = state.worker;
        state.worker = undefined;
        try {
          await worker?.stop();
        } catch {
          safeLog(state.name, "LANE_STOP_FAILED");
        }
      }));
    },
  };
}
