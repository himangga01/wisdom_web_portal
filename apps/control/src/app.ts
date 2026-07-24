import { randomUUID as nodeRandomUUID } from "node:crypto";

import {
  apiErrorSchema,
  consultationRequestSchema,
  localeSchema,
  type ApiError,
} from "@wisdom/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { bucketAddress } from "./abuse/client-ip.js";
import { issueFormToken } from "./abuse/form-token.js";
import { resolveClientIp } from "./abuse/rate-limit.js";
import { classifyPageviewPath, referrerOriginFrom } from "./analytics/paths.js";
import {
  pageviewRateLimited,
  recordPageview,
  type AnalyticsDatabase,
} from "./analytics/store.js";
import { registerHermesArticleRoutes } from "./articles/hermes-http.js";
import {
  publicConsentDocumentsFromBundle,
  type ConsentAuthorityResolver,
} from "./consent/service.js";
import {
  acceptConsultation,
  type IntakeFaultPoint,
} from "./consultations/service.js";
import { keyedDigest, type KeyProvider } from "./crypto/index.js";
import { isDatabaseReady, type ControlDatabase } from "./db/client.js";
import {
  ADMIN_STYLE_CSP_HASH,
  registerTask4Routes,
  type AdminArticlePublicationActions,
} from "./admin/routes.js";

const MAX_BODY_BYTES = 32_768;
const PAGEVIEW_MAX_BODY_BYTES = 1_024;
// Deliberately small UA screen: catches the overwhelming majority of declared
// crawlers and automation without a parser dependency. Upgrade to `isbot` only
// if junk traffic is actually observed.
const BOT_UA_PATTERN = /bot|crawler|spider|scrap|headless|preview|monitor|lighthouse|python-requests|curl|wget|pingdom/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/;
const CONSENT_READ_WINDOW_MS = 60_000;
const CONSENT_READ_LIMIT = 60;
const CONSENT_READ_MAX_SUBJECTS = 4_096;

interface ControlEnvironment {
  Variables: {
    requestId: string;
  };
}

export interface RedactedLogEvent {
  requestId: string;
  method: string;
  route: string;
  code: string;
}

export interface RedactedLogger {
  write(event: RedactedLogEvent): void;
}

export interface ControlAppDependencies {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  allowedOrigins: readonly string[];
  enforceOrigin: boolean;
  now?: () => number;
  randomUUID?: () => string;
  peerAddress?: (context: Context<ControlEnvironment>) => string;
  logger?: RedactedLogger;
  faultInjector?: (point: IntakeFaultPoint) => void;
  publicOrigin?: string;
  adminOrigin?: string;
  authSecret?: Uint8Array;
  withdrawalSecret?: Uint8Array;
  dummyPasswordHash?: string;
  hermesHmacSecret?: Uint8Array;
  articlePublication?: AdminArticlePublicationActions;
  indexNowKey?: string;
  indexNowKeyProvider?: () => string | undefined;
  consentAuthorityResolver?: ConsentAuthorityResolver;
  analyticsDb?: AnalyticsDatabase;
}

class PayloadTooLargeError extends Error {}

const pageviewSchema = z.object({
  p: z.string().min(1).max(512),
  r: z.string().max(2_048).optional().default(""),
}).strict();

const submissionSchema = z.object({
  consultation: consultationRequestSchema,
  antiAbuse: z.object({
    formToken: z.string().min(1),
    website: z.string().max(200),
  }).strict(),
}).strict();

function defaultLogger(): RedactedLogger {
  return {
    write(event) {
      console.error(JSON.stringify(event));
    },
  };
}

function isLoopbackPeer(value: string): boolean {
  const peer = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (peer === "::1" || peer === "0:0:0:0:0:0:0:1") return true;
  if (peer.startsWith("::ffff:")) return isLoopbackPeer(peer.slice("::ffff:".length));
  const octets = peer.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet)) && octets[0] === "127";
}

function effectiveRequestOrigin(
  context: Context<ControlEnvironment>,
  dependencies: ControlAppDependencies,
): string | undefined {
  const peer = dependencies.peerAddress?.(context) ?? "unknown";
  if (isLoopbackPeer(peer)) {
    const forwardedHost = context.req.header("x-forwarded-host");
    const forwardedProto = context.req.header("x-forwarded-proto");
    if (forwardedHost !== undefined || forwardedProto !== undefined) {
      if (
        !forwardedHost ||
        !forwardedProto ||
        !/^[A-Za-z0-9.:[\]-]+(?::\d{1,5})?$/.test(forwardedHost) ||
        !["http", "https"].includes(forwardedProto)
      ) return undefined;
      try {
        return new URL(`${forwardedProto}://${forwardedHost}`).origin;
      } catch {
        return undefined;
      }
    }
  }
  try {
    return new URL(context.req.url).origin;
  } catch {
    return undefined;
  }
}

function isSensitivePath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/") ||
    path === "/internal/v1/article-drafts" ||
    path === "/indexnow-key.txt" ||
    path === "/marketing/withdraw" || path.startsWith("/marketing/withdraw/") ||
    /^\/(?:en|zh-hans|zh-hant)\/marketing\/withdraw(?:\/|$)/.test(path);
}

function redactedRoute(path: string): string {
  if (/^\/marketing\/withdraw\/[^/]+$/.test(path)) return "/marketing/withdraw/:token";
  if (/^\/admin\/consultations\/[^/]+\/status$/.test(path)) return "/admin/consultations/:id/status";
  if (/^\/admin\/consultations\/[^/]+$/.test(path)) return "/admin/consultations/:id";
  if (/^\/admin\/failures\/[^/]+\/requeue$/.test(path)) return "/admin/failures/:id/requeue";
  return path;
}

function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String);
    const field = path[0] === "consultation" ? path[1] : path[0];
    const key = field || "_form";
    (result[key] ??= []).push(issue.message);
  }
  return result;
}

function apiError(
  context: Context<ControlEnvironment>,
  status: 400 | 403 | 409 | 413 | 415 | 422 | 428 | 429 | 503,
  code: string,
  message: string,
  errors?: Record<string, string[]>,
) {
  const body: ApiError = {
    code,
    message,
    requestId: context.get("requestId"),
    ...(errors ? { fieldErrors: errors } : {}),
  };
  apiErrorSchema.parse(body);
  return context.json(body, status);
}

async function readBodyWithLimit(request: Request, limitBytes = MAX_BODY_BYTES): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limitBytes) {
    throw new PayloadTooLargeError();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createControlApp(dependencies: ControlAppDependencies) {
  const app = new Hono<ControlEnvironment>();
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const logger = dependencies.logger ?? defaultLogger();
  const resolveConsentAuthority = dependencies.consentAuthorityResolver ?? (() => undefined);
  const consentReadBuckets = new Map<string, { count: number; expiresAtMs: number }>();
  if (dependencies.indexNowKey !== undefined
    && !/^[A-Za-z0-9-]{8,128}$/.test(dependencies.indexNowKey)) {
    throw new Error("IndexNow public key is invalid");
  }
  if (dependencies.indexNowKey !== undefined && dependencies.indexNowKeyProvider !== undefined) {
    throw new Error("Configure only one IndexNow public key source");
  }

  const safeLog = (event: RedactedLogEvent): void => {
    try {
      logger.write(event);
    } catch {
      // A logging failure must not expose or alter the request path.
    }
  };

  app.use("*", async (context, next) => {
    context.set("requestId", randomUUID());
    await next();
    context.res.headers.set("Cache-Control", "no-store");
    context.res.headers.set("X-Request-Id", context.get("requestId"));
  });

  app.use("*", async (context, next) => {
    await next();
    if (!isSensitivePath(context.req.path)) return;
    context.res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    context.res.headers.set("Referrer-Policy", "no-referrer");
    context.res.headers.set("X-Content-Type-Options", "nosniff");
    context.res.headers.set("X-Frame-Options", "DENY");
    context.res.headers.set(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'self' ${ADMIN_STYLE_CSP_HASH}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  if (dependencies.publicOrigin !== undefined || dependencies.adminOrigin !== undefined) {
    if (!dependencies.publicOrigin || !dependencies.adminOrigin) {
      throw new Error("Both public and administrator origins are required for host routing");
    }
    app.use("*", async (context, next) => {
      if (context.req.path === "/internal/v1/article-drafts") {
        await next();
        return;
      }
      const origin = effectiveRequestOrigin(context, dependencies);
      if (origin !== dependencies.publicOrigin && origin !== dependencies.adminOrigin) {
        return context.text("Misdirected Request", 421);
      }
      const adminPath = context.req.path === "/admin" || context.req.path.startsWith("/admin/");
      const withdrawalPath = context.req.path === "/marketing/withdraw" ||
        context.req.path.startsWith("/marketing/withdraw/") ||
        /^\/(?:en|zh-hans|zh-hant)\/marketing\/withdraw(?:\/|$)/.test(context.req.path);
      const publicApiPath = context.req.path.startsWith("/api/");
      const publicOwnershipPath = context.req.path === "/indexnow-key.txt";
      if (
        (adminPath && origin !== dependencies.adminOrigin) ||
        ((withdrawalPath || publicApiPath || publicOwnershipPath) && origin !== dependencies.publicOrigin)
      ) {
        return context.text("Not Found", 404);
      }
      await next();
    });
  }

  app.onError((_error, context) => {
    safeLog({
      requestId: context.get("requestId"),
      method: context.req.method,
      route: redactedRoute(context.req.path),
      code: "STORAGE_UNAVAILABLE",
    });
    return apiError(
      context,
      503,
      "STORAGE_UNAVAILABLE",
      "The consultation service is temporarily unavailable.",
    );
  });

  app.get("/health/live", (context) => context.json({ status: "ok" }, 200));

  app.get("/health/ready", (context) => {
    let consentReady = false;
    try {
      consentReady = resolveConsentAuthority() !== undefined;
    } catch {
      consentReady = false;
    }
    const ready = isDatabaseReady(dependencies.db)
      && consentReady
      && dependencies.keyProvider.active().secret.byteLength >= 32;
    return ready
      ? context.json({ status: "ready" }, 200)
      : apiError(context, 503, "NOT_READY", "The service is not ready.");
  });

  const indexNowKeyProvider = dependencies.indexNowKeyProvider ?? (
    dependencies.indexNowKey ? () => dependencies.indexNowKey : undefined
  );
  if (indexNowKeyProvider) {
    app.get("/indexnow-key.txt", (context) => {
      let indexNowKey: string | undefined;
      try {
        indexNowKey = indexNowKeyProvider();
      } catch {
        return context.text("Not Found", 404);
      }
      if (!indexNowKey || !/^[A-Za-z0-9-]{8,128}$/.test(indexNowKey)) {
        return context.text("Not Found", 404);
      }
      context.header("Content-Type", "text/plain; charset=utf-8");
      context.header("X-Robots-Tag", "noindex, nofollow, noarchive");
      return context.body(indexNowKey, 200);
    });
  }

  app.get("/api/v1/consent-documents", (context) => {
    const requestNowMs = now();
    const peer = dependencies.peerAddress?.(context) ?? "unknown";
    const clientIp = resolveClientIp(peer, context.req.header("x-forwarded-for"));
    const subject = keyedDigest(
      dependencies.keyProvider,
      "abuse",
      `wisdom:consent-read:v1\0${bucketAddress(clientIp)}`,
    ).toString("hex");
    const cleanupCandidates: Array<[string, { count: number; expiresAtMs: number }]> = [];
    for (const entry of consentReadBuckets) {
      cleanupCandidates.push(entry);
      if (cleanupCandidates.length >= 64) break;
    }
    for (const [key, bucket] of cleanupCandidates) {
      consentReadBuckets.delete(key);
      if (bucket.expiresAtMs > requestNowMs) consentReadBuckets.set(key, bucket);
    }
    let bucket = consentReadBuckets.get(subject);
    if (bucket?.expiresAtMs !== undefined && bucket.expiresAtMs <= requestNowMs) {
      consentReadBuckets.delete(subject);
      bucket = undefined;
    }
    if (!bucket && consentReadBuckets.size >= CONSENT_READ_MAX_SUBJECTS) {
      context.header("Retry-After", String(Math.ceil(CONSENT_READ_WINDOW_MS / 1_000)));
      return apiError(context, 429, "CONSENT_READ_RATE_LIMITED", "Too many consent document requests.");
    }
    if (!bucket) {
      bucket = { count: 0, expiresAtMs: requestNowMs + CONSENT_READ_WINDOW_MS };
      consentReadBuckets.set(subject, bucket);
    }
    if (bucket.count >= CONSENT_READ_LIMIT) {
      context.header("Retry-After", String(Math.max(
        1,
        Math.ceil((bucket.expiresAtMs - requestNowMs) / 1_000),
      )));
      return apiError(context, 429, "CONSENT_READ_RATE_LIMITED", "Too many consent document requests.");
    }
    bucket.count += 1;
    const locale = localeSchema.safeParse(context.req.query("locale"));
    if (!locale.success) {
      return apiError(context, 400, "INVALID_LOCALE", "A supported locale is required.");
    }
    let authority;
    try {
      authority = resolveConsentAuthority();
    } catch {
      authority = undefined;
    }
    const documents = authority
      ? publicConsentDocumentsFromBundle(authority.bundle, locale.data)
      : undefined;
    if (!documents) {
      return apiError(
        context,
        503,
        "CONSENT_DOCUMENTS_UNAVAILABLE",
        "Active consent documents are unavailable.",
      );
    }
    const issuedAtMs = requestNowMs;
    const formToken = issueFormToken(dependencies.keyProvider, {
      locale: locale.data,
      privacyVersion: documents.documents.privacy.version,
      marketingVersion: documents.documents.marketing.version,
    }, issuedAtMs, randomUUID());
    return context.json({ ...documents, formToken }, 200);
  });

  // Unauthenticated pageview beacon. Every outcome — recorded, invalid,
  // bot-filtered, opted out, rate limited — answers 204 so junk senders learn
  // nothing about what was kept. Only allowlisted published paths are counted.
  app.post("/api/v1/pageview", async (context) => {
    const drop = () => context.body(null, 204);
    const analyticsDb = dependencies.analyticsDb;
    if (!analyticsDb) return drop();
    if (dependencies.enforceOrigin) {
      const origin = context.req.header("origin");
      if (!origin || !dependencies.allowedOrigins.includes(origin)) return drop();
    }
    // An explicit opt-out signal is honoured even though neither carries legal
    // force here: it is the cookie-free "objection means" the CNIL audience-
    // measurement exemption asks for.
    if (context.req.header("sec-gpc") === "1" || context.req.header("dnt") === "1") return drop();
    const purpose = context.req.header("sec-purpose") ?? context.req.header("purpose") ?? "";
    if (/prefetch|prerender/i.test(purpose)) return drop();
    const userAgent = context.req.header("user-agent")?.trim() ?? "";
    if (userAgent === "" || BOT_UA_PATTERN.test(userAgent)) return drop();
    const contentType = context.req.header("content-type")?.toLowerCase();
    if (!contentType || !/^application\/json(?:\s*;|$)/.test(contentType)) return drop();

    let untrusted: unknown;
    try {
      untrusted = JSON.parse(await readBodyWithLimit(context.req.raw, PAGEVIEW_MAX_BODY_BYTES));
    } catch {
      return drop();
    }
    const parsed = pageviewSchema.safeParse(untrusted);
    if (!parsed.success) return drop();
    const classified = classifyPageviewPath(parsed.data.p);
    if (!classified) return drop();

    const nowMs = now();
    const peer = dependencies.peerAddress?.(context) ?? "unknown";
    const clientIp = resolveClientIp(peer, context.req.header("x-forwarded-for"));
    if (pageviewRateLimited(analyticsDb, nowMs, clientIp)) return drop();
    recordPageview(analyticsDb, {
      nowMs,
      address: clientIp,
      userAgent,
      path: classified.path,
      locale: classified.locale,
      // The beacon's Origin header IS the origin the page was served from, so
      // it is the exact "self" to collapse into direct traffic.
      referrerOrigin: referrerOriginFrom(
        parsed.data.r,
        context.req.header("origin") ?? dependencies.publicOrigin,
      ),
    });
    return drop();
  });

  app.post("/api/v1/consultations", async (context) => {
    const contentType = context.req.header("content-type")?.toLowerCase();
    if (!contentType || !/^application\/json(?:\s*;|$)/.test(contentType)) {
      return apiError(context, 415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
    }
    if (dependencies.enforceOrigin) {
      const origin = context.req.header("origin");
      if (!origin || !dependencies.allowedOrigins.includes(origin)) {
        return apiError(context, 403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed.");
      }
    }
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) {
      return apiError(
        context,
        428,
        "IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header is required.",
      );
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return apiError(
        context,
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "The Idempotency-Key header is invalid.",
      );
    }

    let serialized: string;
    try {
      serialized = await readBodyWithLimit(context.req.raw);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return apiError(context, 413, "PAYLOAD_TOO_LARGE", "The request body exceeds 32 KiB.");
      }
      return apiError(context, 400, "INVALID_JSON", "The JSON body is invalid.");
    }
    let untrusted: unknown;
    try {
      untrusted = JSON.parse(serialized);
    } catch {
      return apiError(context, 400, "INVALID_JSON", "The JSON body is invalid.");
    }
    const parsed = submissionSchema.safeParse(untrusted);
    if (!parsed.success) {
      return apiError(
        context,
        422,
        "VALIDATION_FAILED",
        "The consultation request is invalid.",
        fieldErrors(parsed.error),
      );
    }
    if (parsed.data.antiAbuse.website !== "") {
      return apiError(context, 400, "INVALID_SUBMISSION", "The consultation submission is invalid.");
    }

    const nowMs = now();
    const peer = dependencies.peerAddress?.(context) ?? "unknown";
    const clientIp = resolveClientIp(peer, context.req.header("x-forwarded-for"));
    const result = acceptConsultation(dependencies.db, dependencies.keyProvider, {
      consultation: parsed.data.consultation,
      formToken: parsed.data.antiAbuse.formToken,
      idempotencyKey,
      requestId: context.get("requestId"),
      clientIp,
      nowMs,
    }, {
      resolveConsentAuthority,
      randomUUID,
      ...(dependencies.faultInjector ? { faultInjector: dependencies.faultInjector } : {}),
    });

    switch (result.kind) {
      case "created":
        return context.body(result.responseJson, 201, { "Content-Type": "application/json" });
      case "replay":
        context.header("Idempotent-Replayed", "true");
        return context.body(result.responseJson, result.status as ContentfulStatusCode, {
          "Content-Type": "application/json",
        });
      case "conflict":
        return apiError(context, 409, "IDEMPOTENCY_KEY_CONFLICT", "The idempotency key was used for another request.");
      case "invalid-submission":
        return apiError(context, 400, "INVALID_SUBMISSION", "The consultation submission is invalid.");
      case "stale-form-token":
        return apiError(context, 409, "FORM_TOKEN_STALE", "The form session has expired. Reload the form and try again.");
      case "stale-consent":
        return apiError(context, 409, "CONSENT_VERSION_STALE", "Consent documents have changed. Reload the form and try again.");
      case "consent-unavailable":
        return apiError(context, 503, "CONSENT_DOCUMENTS_UNAVAILABLE", "Published consent documents are unavailable.");
      case "rate-limited":
        context.header("Retry-After", String(result.retryAfterSeconds));
        return apiError(context, 429, "RATE_LIMITED", "Too many consultation requests. Try again later.");
    }
  });

  if (dependencies.hermesHmacSecret) {
    registerHermesArticleRoutes(app, {
      db: dependencies.db,
      keyProvider: dependencies.keyProvider,
      hermesSecret: dependencies.hermesHmacSecret,
      now,
      randomUUID,
      peerAddress: dependencies.peerAddress ?? (() => "unknown"),
    });
  }

  const task4Dependencies = [
    dependencies.publicOrigin,
    dependencies.adminOrigin,
    dependencies.authSecret,
    dependencies.withdrawalSecret,
    dependencies.dummyPasswordHash,
  ];
  if (task4Dependencies.some((value) => value !== undefined)) {
    if (
      !dependencies.publicOrigin ||
      !dependencies.adminOrigin ||
      !dependencies.authSecret ||
      !dependencies.withdrawalSecret ||
      !dependencies.dummyPasswordHash
    ) {
      throw new Error("Complete administrator and withdrawal dependencies are required");
    }
    registerTask4Routes(app, {
      db: dependencies.db,
      keyProvider: dependencies.keyProvider,
      publicOrigin: dependencies.publicOrigin,
      adminOrigin: dependencies.adminOrigin,
      authSecret: dependencies.authSecret,
      withdrawalSecret: dependencies.withdrawalSecret,
      dummyPasswordHash: dependencies.dummyPasswordHash,
      now,
      peerAddress: dependencies.peerAddress ?? (() => "unknown"),
      ...(dependencies.articlePublication
        ? { articlePublication: dependencies.articlePublication }
        : {}),
      ...(dependencies.analyticsDb ? { analyticsDb: dependencies.analyticsDb } : {}),
    });
  }

  return app;
}
