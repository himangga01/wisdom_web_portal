import { type Context, type Hono } from "hono";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { acceptHermesArticleDraft, isLoopbackAddress } from "./hermes-intake.js";

const MAX_BODY_BYTES = 256 * 1_024;

interface HermesHttpEnvironment {
  Variables: { requestId: string };
}

export interface HermesArticleHttpDependencies {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  hermesSecret: Uint8Array;
  now: () => number;
  randomUUID: () => string;
  peerAddress: (context: Context<HermesHttpEnvironment>) => string;
}

class BodyTooLargeError extends Error {}

const PROXY_IDENTITY_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-pseudo-ipv4",
  "client-ip",
  "do-connecting-ip",
  "fastly-client-ip",
  "fly-client-ip",
  "forwarded",
  "true-client-ip",
  "x-appengine-user-ip",
  "x-azure-clientip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-envoy-external-address",
  "x-real-ip",
]);

function hasProxyIdentityHeader(headers: Headers): boolean {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("x-forwarded-") || PROXY_IDENTITY_HEADERS.has(normalized)) {
      return true;
    }
  }
  return false;
}

async function readRawBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function error(
  context: Context<HermesHttpEnvironment>,
  status: 400 | 401 | 409 | 413 | 415 | 422,
  code: string,
) {
  return context.json({ code, requestId: context.get("requestId") }, status);
}

export function registerHermesArticleRoutes(
  app: Hono<HermesHttpEnvironment>,
  dependencies: HermesArticleHttpDependencies,
): void {
  app.post("/internal/v1/article-drafts", async (context) => {
    const peerAddress = dependencies.peerAddress(context);
    if (!isLoopbackAddress(peerAddress) || hasProxyIdentityHeader(context.req.raw.headers)) {
      return context.text("Not Found", 404);
    }
    const contentType = context.req.header("content-type")?.toLowerCase();
    if (!contentType || !/^application\/json(?:\s*;|$)/.test(contentType)) {
      return error(context, 415, "UNSUPPORTED_MEDIA_TYPE");
    }
    const timestamp = context.req.header("x-hermes-timestamp");
    const nonce = context.req.header("x-hermes-nonce");
    const idempotencyKey = context.req.header("idempotency-key");
    const signature = context.req.header("x-hermes-signature");
    if (!timestamp || !nonce || !idempotencyKey || !signature) {
      return error(context, 401, "HERMES_AUTHENTICATION_REQUIRED");
    }
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBody(context.req.raw);
    } catch (cause) {
      if (cause instanceof BodyTooLargeError) return error(context, 413, "PAYLOAD_TOO_LARGE");
      return error(context, 400, "INVALID_BODY");
    }
    const result = acceptHermesArticleDraft({
      db: dependencies.db,
      keyProvider: dependencies.keyProvider,
      hermesSecret: dependencies.hermesSecret,
      nowMs: dependencies.now(),
      requestId: context.get("requestId"),
      randomUUID: dependencies.randomUUID,
    }, {
      method: context.req.method,
      route: context.req.path,
      peerAddress,
      timestamp,
      nonce,
      idempotencyKey,
      signature,
      rawBody,
    });
    switch (result.kind) {
      case "created":
        return context.body(result.responseJson, 201, { "Content-Type": "application/json" });
      case "replay":
        context.header("Idempotent-Replayed", "true");
        return context.body(result.responseJson, 201, { "Content-Type": "application/json" });
      case "forbidden":
        return context.text("Not Found", 404);
      case "stale":
      case "invalid-signature":
        return error(context, 401, "HERMES_AUTHENTICATION_FAILED");
      case "nonce-replay":
        return error(context, 409, "HERMES_NONCE_REPLAYED");
      case "conflict":
        return error(context, 409, "IDEMPOTENCY_KEY_CONFLICT");
      case "payload-too-large":
        return error(context, 413, "PAYLOAD_TOO_LARGE");
      case "invalid-json":
        return error(context, 400, "INVALID_JSON");
      case "validation-failed":
        return error(context, 422, "VALIDATION_FAILED");
      case "pii-rejected":
        return error(context, 422, "CONTENT_REJECTED");
    }
  });
}
