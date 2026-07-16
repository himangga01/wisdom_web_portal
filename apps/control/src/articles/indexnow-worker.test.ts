import { describe, expect, it, vi } from "vitest";

import { createIndexNowDeliveryWorkerRunner } from "./indexnow-worker.js";

describe("IndexNow periodic delivery runner", () => {
  it("runs one delivery at a time and selects bounded idle and active delays", async () => {
    const results = [
      { kind: "idle" as const },
      { kind: "sent" as const, outboxId: "outbox-1", status: 202 },
    ];
    const processNext = vi.fn(async () => results.shift() ?? { kind: "idle" as const });
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const runner = createIndexNowDeliveryWorkerRunner({
      processNext,
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return scheduled.length;
      },
      cancel: vi.fn(),
    });

    runner.start();
    expect(scheduled[0]?.delayMs).toBe(0);
    scheduled.shift()!.callback();
    await vi.waitFor(() => expect(scheduled[0]?.delayMs).toBe(1_000));
    scheduled.shift()!.callback();
    await vi.waitFor(() => expect(scheduled[0]?.delayMs).toBe(25));
    expect(processNext).toHaveBeenCalledTimes(2);
    await runner.stop();
  });

  it("redacts thrown diagnostics, backs off, and waits for in-flight delivery on stop", async () => {
    let finish: (() => void) | undefined;
    const processNext = vi.fn(() => new Promise<never>((_resolve, reject) => {
      finish = () => reject(new Error("private IndexNow response body"));
    }));
    const logs: unknown[] = [];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cancel = vi.fn();
    const runner = createIndexNowDeliveryWorkerRunner({
      processNext,
      logger: { write: (event) => logs.push(event) },
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs });
        return "timer";
      },
      cancel,
    });

    runner.start();
    scheduled.shift()!.callback();
    await vi.waitFor(() => expect(processNext).toHaveBeenCalledTimes(1));
    const stopping = runner.stop();
    finish!();
    await stopping;
    expect(cancel).toHaveBeenCalledWith("timer");
    expect(logs).toEqual([{
      event: "indexnow.worker.error",
      code: "WORKER_CYCLE_FAILED",
    }]);
    expect(JSON.stringify(logs)).not.toContain("private IndexNow response body");
    expect(scheduled).toHaveLength(0);
  });
});
