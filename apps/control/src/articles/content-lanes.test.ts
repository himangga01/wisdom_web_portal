import { describe, expect, it, vi } from "vitest";

import { initializeContentWorkerLanes } from "./content-lanes.js";

function lane() {
  return { start: vi.fn(), stop: vi.fn(() => Promise.resolve()) };
}

describe("independent content worker lanes", () => {
  it("starts IndexNow even when Codex translation initialization fails", async () => {
    const indexNow = lane();
    const logger = { write: vi.fn() };
    const lanes = initializeContentWorkerLanes({
      createTranslation: () => { throw new Error("private Codex diagnostic"); },
      createIndexNow: () => indexNow,
      logger,
    });

    lanes.start();
    expect(indexNow.start).toHaveBeenCalledOnce();
    expect(logger.write).toHaveBeenCalledWith({
      event: "content.worker.lane-unavailable",
      lane: "translation",
      code: "LANE_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(logger.write.mock.calls)).not.toContain("private Codex diagnostic");
    await lanes.stop();
    expect(indexNow.stop).toHaveBeenCalledOnce();
  });

  it("starts translation even when IndexNow initialization fails", async () => {
    const translation = lane();
    const logger = { write: vi.fn() };
    const lanes = initializeContentWorkerLanes({
      createTranslation: () => translation,
      createIndexNow: () => { throw new Error("private IndexNow diagnostic"); },
      logger,
    });

    lanes.start();
    expect(translation.start).toHaveBeenCalledOnce();
    expect(logger.write).toHaveBeenCalledWith({
      event: "content.worker.lane-unavailable",
      lane: "indexnow",
      code: "LANE_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(logger.write.mock.calls)).not.toContain("private IndexNow diagnostic");
    await lanes.stop();
  });

  it("continues starting remaining lanes when one start call fails", async () => {
    const translation = lane();
    translation.start.mockImplementation(() => { throw new Error("private start diagnostic"); });
    const indexNow = lane();
    const logger = { write: vi.fn() };
    const lanes = initializeContentWorkerLanes({
      createTranslation: () => translation,
      createIndexNow: () => indexNow,
      logger,
    });

    lanes.start();
    expect(indexNow.start).toHaveBeenCalledOnce();
    expect(logger.write).toHaveBeenCalledWith({
      event: "content.worker.lane-unavailable",
      lane: "translation",
      code: "LANE_START_FAILED",
    });
    await lanes.stop();
  });

  it("retries a failed factory with bounded delay and starts it after recovery", async () => {
    const translation = lane();
    const factory = vi.fn()
      .mockImplementationOnce(() => { throw new Error("temporary failure"); })
      .mockReturnValueOnce(translation);
    const scheduled: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
    const cancel = vi.fn();
    const lanes = initializeContentWorkerLanes({
      createTranslation: factory,
      createIndexNow: () => null,
      schedule: (callback, delayMs) => {
        const handle = {};
        scheduled.push({ callback, delayMs, handle });
        return handle;
      },
      cancel,
      retryBaseMs: 100,
      retryMaxMs: 400,
    });

    lanes.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(100);
    scheduled[0]!.callback();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(translation.start).toHaveBeenCalledOnce();
    await lanes.stop();
    expect(translation.stop).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});
