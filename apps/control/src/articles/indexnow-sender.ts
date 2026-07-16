import { execFileSync } from "node:child_process";

import type { EnvironmentSource } from "@wisdom/shared";

import type { IndexNowJsonSender } from "./indexnow-outbox.js";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export interface IndexNowSenderConfig {
  endpoint: typeof INDEXNOW_ENDPOINT;
  keychainService: string;
  keyLocation: string;
  timeoutMs: number;
}

export interface IndexNowHttpRequest {
  url: string;
  method: "POST";
  headers: { "content-type": "application/json; charset=utf-8" };
  body: string;
  timeoutMs: number;
}

export interface IndexNowHttpResponse {
  status: number;
  providerMessageId?: string;
}

export interface IndexNowSenderDependencies {
  request(input: IndexNowHttpRequest): Promise<IndexNowHttpResponse>;
}

function requiredSingleLine(source: EnvironmentSource, name: string): string {
  const value = source[name];
  if (!value || /[\0\r\n]/u.test(value)) throw new Error(`${name} is required`);
  return value;
}

export function parseIndexNowSenderConfig(
  source: EnvironmentSource,
  publicOrigin: string,
): IndexNowSenderConfig {
  const origin = new URL(publicOrigin);
  if (origin.origin !== publicOrigin || origin.protocol !== "https:") {
    throw new Error("IndexNow public origin must be an exact HTTPS origin");
  }
  const keychainService = requiredSingleLine(source, "INDEXNOW_KEYCHAIN_SERVICE");
  if (!KEYCHAIN_SERVICE_PATTERN.test(keychainService)) {
    throw new Error("INDEXNOW_KEYCHAIN_SERVICE must be a valid Keychain service name");
  }
  const keyLocation = requiredSingleLine(source, "INDEXNOW_KEY_LOCATION");
  let location: URL;
  try {
    location = new URL(keyLocation);
  } catch {
    throw new Error("INDEXNOW_KEY_LOCATION must be a valid URL");
  }
  if (location.origin !== publicOrigin
    || location.href !== keyLocation
    || location.pathname !== "/indexnow-key.txt"
    || location.search || location.hash || location.username || location.password) {
    throw new Error("INDEXNOW_KEY_LOCATION must be the same public origin /indexnow-key.txt URL");
  }
  const timeoutMs = source.INDEXNOW_TIMEOUT_MS === undefined
    ? 10_000
    : Number(source.INDEXNOW_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error("INDEXNOW_TIMEOUT_MS must be between 1000 and 30000");
  }
  return Object.freeze({
    endpoint: INDEXNOW_ENDPOINT,
    keychainService,
    keyLocation,
    timeoutMs,
  });
}

export type IndexNowKeychainCommand = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    maxBuffer: number;
  },
) => string;

const defaultKeychainCommand: IndexNowKeychainCommand = (file, args, options) =>
  execFileSync(file, [...args], options);

export function resolveIndexNowKeyFromKeychain(
  service: string,
  execute: IndexNowKeychainCommand = defaultKeychainCommand,
): string {
  if (!KEYCHAIN_SERVICE_PATTERN.test(service)) {
    throw new Error("IndexNow Keychain service reference is invalid");
  }
  let value: string;
  try {
    value = execute(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 1_024,
      },
    ).trim();
  } catch {
    throw new Error("IndexNow Keychain credential is unavailable");
  }
  if (!INDEXNOW_KEY_PATTERN.test(value)) {
    throw new Error("IndexNow Keychain credential is invalid");
  }
  return value;
}

export function resolveOptionalIndexNowKey(
  service: string,
  logger: {
    write(event: {
      event: "indexnow.unavailable";
      code: "INDEXNOW_KEY_UNAVAILABLE";
    }): void;
  } | undefined,
  execute: IndexNowKeychainCommand = defaultKeychainCommand,
): string | undefined {
  try {
    return resolveIndexNowKeyFromKeychain(service, execute);
  } catch {
    try {
      logger?.write({
        event: "indexnow.unavailable",
        code: "INDEXNOW_KEY_UNAVAILABLE",
      });
    } catch {
      // Optional search discovery must not fail the consultation service.
    }
    return undefined;
  }
}

export interface IndexNowKeyCacheOptions {
  service: string;
  resolve?: (service: string) => string;
  logger?: {
    write(event: {
      event: "indexnow.unavailable";
      code: "INDEXNOW_KEY_UNAVAILABLE";
    }): void;
  };
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export function createIndexNowKeyCache(options: IndexNowKeyCacheOptions) {
  const resolve = options.resolve ?? resolveIndexNowKeyFromKeychain;
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
    !KEYCHAIN_SERVICE_PATTERN.test(options.service)
    || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 100
    || !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs
    || retryMaxMs > 60 * 60_000
  ) throw new Error("IndexNow key cache configuration is invalid");
  let key: string | undefined;
  let retryHandle: unknown | undefined;
  let failureCount = 0;
  let running = false;

  const safeUnavailableLog = (): void => {
    try {
      options.logger?.write({
        event: "indexnow.unavailable",
        code: "INDEXNOW_KEY_UNAVAILABLE",
      });
    } catch {
      // Search discovery logging cannot affect the consultation service.
    }
  };
  const attempt = (): void => {
    if (!running || key !== undefined) return;
    try {
      const resolved = resolve(options.service);
      if (!INDEXNOW_KEY_PATTERN.test(resolved)) throw new Error("IndexNow key is invalid");
      key = resolved;
      failureCount = 0;
      return;
    } catch {
      safeUnavailableLog();
    }
    failureCount += 1;
    const delayMs = Math.min(
      retryBaseMs * (2 ** Math.min(failureCount - 1, 20)),
      retryMaxMs,
    );
    retryHandle = schedule(() => {
      retryHandle = undefined;
      attempt();
    }, delayMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      attempt();
    },
    get(): string | undefined {
      return key;
    },
    stop(): void {
      running = false;
      if (retryHandle !== undefined) {
        cancel(retryHandle);
        retryHandle = undefined;
      }
    },
  };
}

async function defaultHttpRequest(input: IndexNowHttpRequest): Promise<IndexNowHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: "error",
      signal: controller.signal,
    });
    const providerMessageId = response.headers.get("x-request-id") ?? undefined;
    await response.body?.cancel();
    return {
      status: response.status,
      ...(providerMessageId ? { providerMessageId: providerMessageId.slice(0, 128) } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createIndexNowSender(
  config: IndexNowSenderConfig,
  key: string,
  dependencies: IndexNowSenderDependencies = { request: defaultHttpRequest },
): IndexNowJsonSender {
  if (!INDEXNOW_KEY_PATTERN.test(key)) throw new Error("IndexNow key is invalid");
  const keyLocation = new URL(config.keyLocation);
  if (config.endpoint !== INDEXNOW_ENDPOINT || keyLocation.protocol !== "https:") {
    throw new Error("IndexNow sender configuration is invalid");
  }
  return async (payload) => {
    if (payload.host !== keyLocation.hostname) throw new Error("INDEXNOW_HOST_MISMATCH");
    const body = JSON.stringify({
      host: payload.host,
      key,
      keyLocation: config.keyLocation,
      urlList: payload.urls,
    });
    if (Buffer.byteLength(body, "utf8") > 512 * 1_024) {
      throw new Error("INDEXNOW_REQUEST_TOO_LARGE");
    }
    return await dependencies.request({
      url: config.endpoint,
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
      timeoutMs: config.timeoutMs,
    });
  };
}
