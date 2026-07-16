import { createHash } from "node:crypto";

export const INDEXNOW_MAX_PAYLOAD_BYTES = 256 * 1_024;
export const INDEXNOW_MAX_URLS = 10_000;
export const INDEXNOW_MAX_URL_LENGTH = 4_096;

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type IndexNowPayloadValidationCode =
  | "INDEXNOW_ORIGIN_INVALID"
  | "INDEXNOW_URLS_EMPTY"
  | "INDEXNOW_URL_COUNT_EXCEEDED"
  | "INDEXNOW_URL_INVALID"
  | "INDEXNOW_HTTPS_REQUIRED"
  | "INDEXNOW_URL_ORIGIN_INVALID"
  | "INDEXNOW_URL_DUPLICATE"
  | "INDEXNOW_URL_LENGTH_EXCEEDED"
  | "INDEXNOW_PAYLOAD_BYTES_EXCEEDED";

export class IndexNowPayloadValidationError extends Error {
  constructor(readonly code: IndexNowPayloadValidationCode) {
    super(code);
  }
}

export interface CanonicalIndexNowPayload {
  host: string;
  urlSetSha256: string;
  urls: string[];
}

export interface CreatedIndexNowPayload {
  payload: CanonicalIndexNowPayload;
  payloadJson: string;
}

function fail(code: IndexNowPayloadValidationCode): never {
  throw new IndexNowPayloadValidationError(code);
}

function parseOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return fail("INDEXNOW_ORIGIN_INVALID");
  }
  if (origin.protocol !== "https:"
    || origin.origin !== value
    || origin.username !== ""
    || origin.password !== ""
    || origin.port !== ""
    || origin.hostname !== origin.hostname.toLowerCase()
    || !HOST_PATTERN.test(origin.hostname)) {
    fail("INDEXNOW_ORIGIN_INVALID");
  }
  return origin;
}

function hasCredentialsSyntax(value: string): boolean {
  const separator = value.indexOf("://");
  if (separator < 0) return false;
  const authority = value.slice(separator + 3).split(/[\\/?#]/u, 1)[0] ?? "";
  return authority.includes("@");
}

export function createIndexNowPayload(input: {
  publicOrigin?: string;
  urls: readonly string[];
}): CreatedIndexNowPayload {
  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    fail("INDEXNOW_URLS_EMPTY");
  }
  if (input.urls.length > INDEXNOW_MAX_URLS) {
    fail("INDEXNOW_URL_COUNT_EXCEEDED");
  }

  let expectedOrigin = input.publicOrigin ? parseOrigin(input.publicOrigin) : undefined;
  const canonicalUrls: string[] = [];
  const unique = new Set<string>();
  for (const value of input.urls) {
    if (typeof value !== "string" || value.length === 0) fail("INDEXNOW_URL_INVALID");
    if (value.length > INDEXNOW_MAX_URL_LENGTH) fail("INDEXNOW_URL_LENGTH_EXCEEDED");
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) fail("INDEXNOW_URL_INVALID");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return fail("INDEXNOW_URL_INVALID");
    }
    if (url.username !== ""
      || url.password !== ""
      || hasCredentialsSyntax(value)
      || value.includes("#")) {
      fail("INDEXNOW_URL_INVALID");
    }
    if (url.protocol !== "https:") fail("INDEXNOW_HTTPS_REQUIRED");
    if (!expectedOrigin) expectedOrigin = parseOrigin(url.origin);
    if (url.origin !== expectedOrigin.origin) fail("INDEXNOW_URL_ORIGIN_INVALID");
    const canonical = url.href;
    if (canonical.length > INDEXNOW_MAX_URL_LENGTH) fail("INDEXNOW_URL_LENGTH_EXCEEDED");
    if (unique.has(canonical)) fail("INDEXNOW_URL_DUPLICATE");
    unique.add(canonical);
    canonicalUrls.push(canonical);
  }
  canonicalUrls.sort();
  const urlSetSha256 = createHash("sha256")
    .update(canonicalUrls.join("\n"))
    .digest("hex");
  const payload: CanonicalIndexNowPayload = {
    host: expectedOrigin!.hostname,
    urlSetSha256,
    urls: canonicalUrls,
  };
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > INDEXNOW_MAX_PAYLOAD_BYTES) {
    fail("INDEXNOW_PAYLOAD_BYTES_EXCEEDED");
  }
  return { payload, payloadJson };
}

export function parseIndexNowPayloadJson(
  payloadJson: string,
): CanonicalIndexNowPayload | undefined {
  if (Buffer.byteLength(payloadJson, "utf8") > INDEXNOW_MAX_PAYLOAD_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3
    || keys[0] !== "host"
    || keys[1] !== "urlSetSha256"
    || keys[2] !== "urls"
    || typeof record.host !== "string"
    || record.host !== record.host.toLowerCase()
    || !HOST_PATTERN.test(record.host)
    || typeof record.urlSetSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.urlSetSha256)
    || !Array.isArray(record.urls)) {
    return undefined;
  }
  const recordUrls = record.urls as unknown[];

  let created: CreatedIndexNowPayload;
  try {
    created = createIndexNowPayload({
      publicOrigin: `https://${record.host}`,
      urls: recordUrls as readonly string[],
    });
  } catch (error) {
    if (error instanceof IndexNowPayloadValidationError) return undefined;
    throw error;
  }
  if (created.payload.host !== record.host
    || created.payload.urlSetSha256 !== record.urlSetSha256
    || created.payload.urls.length !== recordUrls.length
    || created.payload.urls.some((url, index) => url !== recordUrls[index])) {
    return undefined;
  }
  return created.payload;
}
