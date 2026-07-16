import { describe, expect, it, vi } from "vitest";

import {
  createIndexNowSender,
  createIndexNowKeyCache,
  parseIndexNowSenderConfig,
  resolveIndexNowKeyFromKeychain,
  resolveOptionalIndexNowKey,
  type IndexNowHttpRequest,
} from "./indexnow-sender.js";

const PUBLIC_ORIGIN = "https://www.example.test";

describe("IndexNow sender configuration", () => {
  it("accepts only a same-origin HTTPS key location and bounded Keychain reference", () => {
    expect(parseIndexNowSenderConfig({
      INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
      INDEXNOW_KEY_LOCATION: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
      INDEXNOW_TIMEOUT_MS: "10000",
    }, PUBLIC_ORIGIN)).toEqual({
      endpoint: "https://api.indexnow.org/indexnow",
      keychainService: "com.jihye.portal.indexnow",
      keyLocation: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
      timeoutMs: 10_000,
    });
    expect(() => parseIndexNowSenderConfig({
      INDEXNOW_KEYCHAIN_SERVICE: "service",
      INDEXNOW_KEY_LOCATION: "https://attacker.example/key.txt",
    }, PUBLIC_ORIGIN)).toThrow(/same public origin/i);
    expect(() => parseIndexNowSenderConfig({
      INDEXNOW_KEYCHAIN_SERVICE: "bad service",
      INDEXNOW_KEY_LOCATION: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
    }, PUBLIC_ORIGIN)).toThrow(/service/i);
    expect(() => parseIndexNowSenderConfig({
      INDEXNOW_KEYCHAIN_SERVICE: "service",
      INDEXNOW_KEY_LOCATION: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
      INDEXNOW_TIMEOUT_MS: "999",
    }, PUBLIC_ORIGIN)).toThrow(/timeout/i);
  });

  it("loads the public IndexNow key through a bounded, non-interactive Keychain lookup", () => {
    const execute = vi.fn(() => "abcdef12-ABCDEF34\n");
    expect(resolveIndexNowKeyFromKeychain("com.jihye.portal.indexnow", execute)).toBe(
      "abcdef12-ABCDEF34",
    );
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "com.jihye.portal.indexnow", "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 1_024,
      },
    );
    expect(() => resolveIndexNowKeyFromKeychain("service", () => "short\n")).toThrow(/invalid/i);
    expect(() => resolveIndexNowKeyFromKeychain("service", () => { throw new Error("private diagnostic"); })).toThrow(
      "IndexNow Keychain credential is unavailable",
    );
  });

  it("degrades only IndexNow when its Keychain item is unavailable", () => {
    const logger = { write: vi.fn() };
    const execute = () => { throw new Error("private Keychain diagnostic"); };

    expect(resolveOptionalIndexNowKey("com.jihye.portal.indexnow", logger, execute)).toBeUndefined();
    expect(logger.write).toHaveBeenCalledWith({
      event: "indexnow.unavailable",
      code: "INDEXNOW_KEY_UNAVAILABLE",
    });
    expect(JSON.stringify(logger.write.mock.calls)).not.toContain("private Keychain diagnostic");
  });

  it("recovers the public ownership key in place after a bounded retry", () => {
    const resolve = vi.fn()
      .mockImplementationOnce(() => { throw new Error("temporary Keychain failure"); })
      .mockReturnValueOnce("abcdef12-ABCDEF34");
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const cache = createIndexNowKeyCache({
      service: "com.jihye.portal.indexnow",
      resolve,
      retryBaseMs: 100,
      retryMaxMs: 400,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return callback;
      },
      cancel: vi.fn(),
    });

    cache.start();
    expect(cache.get()).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(100);
    scheduled[0]!.callback();
    expect(cache.get()).toBe("abcdef12-ABCDEF34");
    expect(resolve).toHaveBeenCalledTimes(2);
    cache.stop();
  });
});

describe("official IndexNow batch request", () => {
  it("injects the Keychain key only at send time and posts the exact official JSON shape", async () => {
    let observed: IndexNowHttpRequest | undefined;
    const sender = createIndexNowSender({
      endpoint: "https://api.indexnow.org/indexnow",
      keychainService: "service",
      keyLocation: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
      timeoutMs: 10_000,
    }, "abcdef12-ABCDEF34", {
      request(input) {
        observed = input;
        return Promise.resolve({ status: 202, providerMessageId: "request-202" });
      },
    });
    await expect(sender({
      host: "www.example.test",
      urls: [`${PUBLIC_ORIGIN}/insights`, `${PUBLIC_ORIGIN}/insights/guide`],
    })).resolves.toEqual({ status: 202, providerMessageId: "request-202" });
    expect(observed).toEqual({
      url: "https://api.indexnow.org/indexnow",
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "www.example.test",
        key: "abcdef12-ABCDEF34",
        keyLocation: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
        urlList: [`${PUBLIC_ORIGIN}/insights`, `${PUBLIC_ORIGIN}/insights/guide`],
      }),
      timeoutMs: 10_000,
    });
    expect(JSON.stringify({ host: "www.example.test", urls: [PUBLIC_ORIGIN] })).not.toContain("abcdef12");
  });

  it("rejects host/key-location mismatches before making a request", async () => {
    const request = vi.fn();
    const sender = createIndexNowSender({
      endpoint: "https://api.indexnow.org/indexnow",
      keychainService: "service",
      keyLocation: `${PUBLIC_ORIGIN}/indexnow-key.txt`,
      timeoutMs: 10_000,
    }, "abcdef12-ABCDEF34", { request });
    await expect(sender({
      host: "other.example.test",
      urls: ["https://other.example.test/insights"],
    })).rejects.toThrow("INDEXNOW_HOST_MISMATCH");
    expect(request).not.toHaveBeenCalled();
  });
});
