import { randomUUID } from "node:crypto";

import {
  consultationStatusSchema,
  localeSchema,
  type AdminApiErrorCode,
  type ArticleState,
  type ConsultationStatus,
  type Locale,
  type NotificationChannel,
} from "@wisdom/shared";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { resolveClientIp } from "../abuse/rate-limit.js";
import {
  changeArticleLocaleSlug,
  changeArticleLocaleState,
  enqueueArticleTranslation,
  type ArticleReviewState,
} from "../articles/workflow.js";
import {
  createPublicationBatchPlan,
  PublicationActivationSettlementError,
} from "../articles/publication-release.js";
import { beginAdminLogin, completeAdminMfa } from "../auth/service.js";
import {
  clearAdminPreAuthCookie,
  resolveAdminPreAuthChallenge,
} from "../auth/preauth.js";
import {
  clearAdminSessionCookie,
  resolveAdminSession,
  revokeAdminSession,
  verifyAdminCsrf,
  type ResolvedAdminSession,
} from "../auth/session.js";
import { getActiveConsentBundle } from "../consent/service.js";
import {
  allowedNextConsultationStatuses,
  changeConsultationStatus,
} from "../consultations/workflow.js";
import { decryptPii } from "../crypto/index.js";
import { isDatabaseReady } from "../db/client.js";
import { requeueFailedNotification } from "../notifications/outbox.js";
import { isAllowedSmtpHostname } from "../notifications/smtp-security.js";
import type { AdminRouteDependencies } from "./types.js";

interface AdminEnvironment {
  Variables: { requestId: string };
}

type ApiContext = Context<AdminEnvironment>;
type JsonObject = Record<string, unknown>;
type FailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 503;

const MAX_JSON_BYTES = 16 * 1024;
const ARTICLE_PAGE_SIZE = 50;
const ARTICLE_REVISION_PAGE_SIZE = 50;
const CONSULTATION_PAGE_SIZE = 20;
const FAILURE_PAGE_SIZE = 50;
const RELEASE_PAGE_SIZE = 25;
const PUBLISH_PREVIEW_PAGE_SIZE = 100;

function noStore(context: ApiContext): void {
  context.header("Cache-Control", "no-store");
  context.header("X-Robots-Tag", "noindex, nofollow, noarchive");
}

function success<T>(context: ApiContext, data: T, status: ContentfulStatusCode = 200): Response {
  noStore(context);
  return context.json({ data }, status);
}

function publicationFailure(
  context: ApiContext,
  error: unknown,
  action: "게시" | "롤백",
): Response {
  if (error instanceof PublicationActivationSettlementError) {
    if (error.outcome.kind === "reverted") {
      return failure(
        context,
        503,
        "OPERATION_UNAVAILABLE",
        `${action} 작업은 완료되지 않았고 이전 공개 릴리스로 복구되었습니다.`,
      );
    }
    return failure(
      context,
      503,
      "OPERATION_UNAVAILABLE",
      `${action} 작업이 중단되었습니다. 운영 복구가 필요합니다. activation: ${error.outcome.activationId}`,
    );
  }
  return failure(
    context,
    503,
    "OPERATION_UNAVAILABLE",
    `${action}하지 못했습니다. 발행 상태를 다시 확인하세요.`,
  );
}

function failure(
  context: ApiContext,
  status: FailureStatus,
  code: AdminApiErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
): Response {
  noStore(context);
  return context.json({
    error: {
      code,
      message,
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  }, status);
}

function cookiePair(header: string, name: string): { token: string; csrf: string } | undefined {
  for (const segment of header.split(";")) {
    const value = segment.trim();
    if (!value.startsWith(`${name}=`)) continue;
    const [token, csrf, extra] = value.slice(name.length + 1).split(".");
    if (
      extra !== undefined || !token || !csrf ||
      !/^[A-Za-z0-9_-]{43}$/u.test(token) || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)
    ) return undefined;
    return { token, csrf };
  }
  return undefined;
}

async function jsonBody(context: ApiContext): Promise<JsonObject | Response> {
  const mediaType = (context.req.header("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return failure(context, 415, "INVALID_REQUEST", "JSON 요청만 허용됩니다.");
  }
  const declaredLength = context.req.header("content-length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_JSON_BYTES)) {
    return failure(context, 413, "INVALID_REQUEST", "요청 본문이 너무 큽니다.");
  }
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        return failure(context, 413, "INVALID_REQUEST", "요청 본문이 너무 큽니다.");
      }
      chunks.push(next.value);
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total),
    );
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as JsonObject;
  } catch {
    return failure(context, 400, "INVALID_REQUEST", "요청 형식이 올바르지 않습니다.");
  }
}

function sessionDto(session: ResolvedAdminSession) {
  return {
    stage: "authenticated" as const,
    adminId: session.adminId,
    csrfToken: session.csrfToken,
    expiresAtMs: session.expiresAtMs,
    idleExpiresAtMs: session.idleExpiresAtMs,
  };
}

function requireSession(
  context: ApiContext,
  dependencies: AdminRouteDependencies,
  renew = true,
): ResolvedAdminSession | Response {
  const session = resolveAdminSession(
    dependencies.db,
    dependencies.authSecret,
    context.req.header("cookie") ?? "",
    dependencies.now(),
    { renew },
  );
  return session ?? failure(context, 401, "AUTH_REQUIRED", "관리자 로그인이 필요합니다.");
}

async function requireMutation(
  context: ApiContext,
  dependencies: AdminRouteDependencies,
): Promise<{ session: ResolvedAdminSession; body: JsonObject } | Response> {
  if (context.req.header("origin") !== dependencies.adminOrigin) {
    return failure(context, 403, "FORBIDDEN", "요청 출처를 확인할 수 없습니다.");
  }
  const session = requireSession(context, dependencies, false);
  if (session instanceof Response) return session;
  const csrf = context.req.header("x-csrf-token") ?? "";
  if (!verifyAdminCsrf(
    dependencies.authSecret,
    session.sessionToken,
    session.csrfHash,
    csrf,
  )) return failure(context, 403, "FORBIDDEN", "요청을 확인할 수 없습니다.");
  const body = await jsonBody(context);
  if (body instanceof Response) return body;
  const currentSession = resolveAdminSession(
    dependencies.db,
    dependencies.authSecret,
    context.req.header("cookie") ?? "",
    dependencies.now(),
  );
  return currentSession
    ? { session: currentSession, body }
    : failure(context, 401, "AUTH_REQUIRED", "관리자 로그인이 필요합니다.");
}

function requestedPage(value: string | undefined, pageSize: number, total: number): number {
  if (!value || !/^\d{1,9}$/u.test(value)) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, Math.max(1, Math.ceil(total / pageSize)));
}

function page(pageNumber: number, pageSize: number, total: number) {
  return {
    page: pageNumber,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function stringValue(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

interface StoredSmtpConfiguration {
  host: string;
  port: 465;
  from: string;
  to: string;
  secretRef: string;
}

function validMailbox(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && !/[\r\n]/u.test(value);
}

function validKeychainReference(value: string): boolean {
  return /^keychain:[A-Za-z0-9._-]{1,128}$/u.test(value);
}

function storedSmtp(configJson: unknown, secretRef: unknown): StoredSmtpConfiguration | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof configJson === "string" ? configJson : "null");
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const config = parsed as JsonObject;
  if (
    typeof config.host !== "string" || !isAllowedSmtpHostname(config.host) ||
    config.port !== 465 || config.secure !== true ||
    typeof config.from !== "string" || !validMailbox(config.from) ||
    typeof config.to !== "string" || !validMailbox(config.to) ||
    typeof secretRef !== "string" || !validKeychainReference(secretRef)
  ) return undefined;
  return { host: config.host, port: 465, from: config.from, to: config.to, secretRef };
}

function submittedSmtp(value: unknown): StoredSmtpConfiguration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as JsonObject;
  const allowedKeys = new Set(["host", "port", "from", "to", "secretRef"]);
  if (
    Object.keys(config).some((key) => !allowedKeys.has(key)) ||
    typeof config.host !== "string" || !isAllowedSmtpHostname(config.host) ||
    config.port !== 465 ||
    typeof config.from !== "string" || !validMailbox(config.from) ||
    typeof config.to !== "string" || !validMailbox(config.to) ||
    typeof config.secretRef !== "string" || !validKeychainReference(config.secretRef)
  ) return undefined;
  return {
    host: config.host,
    port: 465,
    from: config.from,
    to: config.to,
    secretRef: config.secretRef,
  };
}

function workflowFailure(context: ApiContext, result: { kind: string; httpStatus: number }): Response {
  if (result.httpStatus === 404) return failure(context, 404, "NOT_FOUND", "대상을 찾을 수 없습니다.");
  if (result.httpStatus === 409) {
    return failure(context, 409, "ROW_VERSION_CONFLICT", "다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.");
  }
  return failure(context, 422, "INVALID_REQUEST", `요청을 처리할 수 없습니다: ${result.kind}`);
}

function publicationScope(
  dependencies: AdminRouteDependencies,
  mode: "next-batch" | "policy-only" = "next-batch",
): {
  fingerprint: string;
  total: number;
  eligibleTotal: number;
  blockedTotal: number;
  batchCount: number;
  remainingAfterBatch: number;
  mode: "next-batch" | "policy-only";
  selectedKeys: ReadonlySet<string>;
} {
  const plan = createPublicationBatchPlan(dependencies.db, mode);
  let total = 0;
  let blockedTotal = 0;
  const rows = dependencies.db.sqlite.prepare(`
    SELECT head.article_id, head.locale, head.slug, head.state, head.head_revision_id,
      head.approved_revision_id, head.row_version,
      revision.content_sha256, revision.source_revision_id,
      CASE WHEN head.locale = article.source_locale THEN 1
        WHEN revision.source_revision_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM article_locale_heads source_head
          WHERE source_head.article_id = head.article_id
            AND source_head.locale = article.source_locale
            AND source_head.state IN ('approved','published')
            AND source_head.head_revision_id = revision.source_revision_id
            AND source_head.approved_revision_id = revision.source_revision_id
        ) THEN 1 ELSE 0 END AS source_binding_valid
    FROM article_locale_heads head
    JOIN article_revisions revision ON revision.id = head.head_revision_id
    JOIN articles article ON article.id = head.article_id
    ORDER BY head.article_id, head.locale
  `).iterate() as Iterable<{
    article_id: string; locale: Locale; slug: string; state: ArticleState;
    head_revision_id: string; approved_revision_id: string | null;
    row_version: number; content_sha256: Buffer; source_revision_id: string | null;
    source_binding_valid: 0 | 1;
  }>;
  for (const row of rows) {
    total += 1;
    const eligible = (row.state === "approved" || row.state === "published") &&
      row.source_binding_valid === 1;
    if (!eligible) blockedTotal += 1;
  }
  return {
    fingerprint: plan.fingerprint,
    total,
    eligibleTotal: plan.eligibleTotal,
    blockedTotal,
    batchCount: plan.batchCount,
    remainingAfterBatch: plan.remainingAfterBatch,
    mode: plan.mode,
    selectedKeys: new Set(plan.promotions.map(
      (promotion) => `${promotion.articleId}\0${promotion.locale}`,
    )),
  };
}

export function registerAdminApiRoutes(
  app: Hono<AdminEnvironment>,
  dependencies: AdminRouteDependencies,
): void {
  const pendingConfirmations = new Map<string, {
    action: "publish" | "rollback";
    target: string;
    adminId: string;
    sessionToken: string;
    expiresAtMs: number;
  }>();
  const issueConfirmation = (
    session: ResolvedAdminSession,
    action: "publish" | "rollback",
    target: string,
  ): string => {
    const now = dependencies.now();
    for (const [token, value] of pendingConfirmations) {
      if (value.expiresAtMs <= now) pendingConfirmations.delete(token);
    }
    while (pendingConfirmations.size >= 256) {
      const token = pendingConfirmations.keys().next().value as string | undefined;
      if (!token) break;
      pendingConfirmations.delete(token);
    }
    const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
    pendingConfirmations.set(token, {
      action,
      target,
      adminId: session.adminId,
      sessionToken: session.sessionToken,
      expiresAtMs: now + 120_000,
    });
    return token;
  };
  const consumeConfirmation = (
    token: unknown,
    session: ResolvedAdminSession,
    action: "publish" | "rollback",
    target: string,
  ): boolean => {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/u.test(token)) return false;
    const pending = pendingConfirmations.get(token);
    pendingConfirmations.delete(token);
    return pending !== undefined && pending.expiresAtMs > dependencies.now() &&
      pending.action === action && pending.target === target &&
      pending.adminId === session.adminId && pending.sessionToken === session.sessionToken;
  };

  app.get("/admin/api/v1/session", (context) => {
    const session = requireSession(context, dependencies);
    return session instanceof Response ? session : success(context, sessionDto(session));
  });

  app.post("/admin/api/v1/auth/login", async (context) => {
    if (context.req.header("origin") !== dependencies.adminOrigin) {
      return failure(context, 403, "FORBIDDEN", "요청 출처를 확인할 수 없습니다.");
    }
    const body = await jsonBody(context);
    if (body instanceof Response) return body;
    const username = stringValue(body.username, 128);
    const password = stringValue(body.password, 1_024);
    if (username === undefined || password === undefined) {
      return failure(context, 400, "INVALID_REQUEST", "아이디와 비밀번호를 확인하세요.");
    }
    const peer = dependencies.peerAddress(context);
    const result = await beginAdminLogin(dependencies, {
      username,
      password,
      source: resolveClientIp(peer, context.req.header("x-forwarded-for")),
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") {
      return failure(context, 401, "AUTH_INVALID", "로그인 정보를 확인할 수 없습니다.");
    }
    context.header("Set-Cookie", result.cookie);
    return success(context, { stage: "mfa" as const, csrfToken: result.csrfToken }, 202);
  });

  app.get("/admin/api/v1/auth/preauth", (context) => {
    const pair = cookiePair(context.req.header("cookie") ?? "", "__Host-wisdom-preauth");
    if (pair && resolveAdminPreAuthChallenge(
      dependencies.db,
      dependencies.authSecret,
      pair.token,
      pair.csrf,
      dependencies.now(),
    )) return success(context, { stage: "mfa" as const, csrfToken: pair.csrf });
    context.header("Set-Cookie", clearAdminPreAuthCookie());
    return failure(context, 401, "AUTH_REQUIRED", "다시 로그인하세요.");
  });

  app.post("/admin/api/v1/auth/preauth/reset", async (context) => {
    if (context.req.header("origin") !== dependencies.adminOrigin) {
      return failure(context, 403, "FORBIDDEN", "요청 출처를 확인할 수 없습니다.");
    }
    const pair = cookiePair(context.req.header("cookie") ?? "", "__Host-wisdom-preauth");
    const body = await jsonBody(context);
    if (body instanceof Response) return body;
    if (!pair || context.req.header("x-csrf-token") !== pair.csrf || Object.keys(body).length !== 0) {
      return failure(context, 403, "FORBIDDEN", "요청을 확인할 수 없습니다.");
    }
    context.header("Set-Cookie", clearAdminPreAuthCookie());
    noStore(context);
    return context.body(null, 204);
  });

  app.post("/admin/api/v1/auth/mfa", async (context) => {
    if (context.req.header("origin") !== dependencies.adminOrigin) {
      return failure(context, 403, "FORBIDDEN", "요청 출처를 확인할 수 없습니다.");
    }
    const pair = cookiePair(context.req.header("cookie") ?? "", "__Host-wisdom-preauth");
    const body = await jsonBody(context);
    if (body instanceof Response) return body;
    const username = stringValue(body.username, 128);
    const code = stringValue(body.code, 128);
    const method = body.method === "totp" || body.method === "recovery" ? body.method : undefined;
    const suppliedCsrf = context.req.header("x-csrf-token") ?? "";
    if (!pair || !username || !code || !method || suppliedCsrf !== pair.csrf) {
      return failure(context, 401, "AUTH_INVALID", "인증 정보를 확인할 수 없습니다.");
    }
    const peer = dependencies.peerAddress(context);
    const result = completeAdminMfa(dependencies, {
      username,
      source: resolveClientIp(peer, context.req.header("x-forwarded-for")),
      challengeToken: pair.token,
      csrfToken: suppliedCsrf,
      method,
      code,
      nowMs: dependencies.now(),
      requestId: context.get("requestId"),
    });
    if (result.kind === "invalid") {
      if (!resolveAdminPreAuthChallenge(
        dependencies.db,
        dependencies.authSecret,
        pair.token,
        pair.csrf,
        dependencies.now(),
      )) {
        context.header("Set-Cookie", clearAdminPreAuthCookie());
        return failure(context, 401, "AUTH_REQUIRED", "다시 로그인하세요.");
      }
      return failure(context, 401, "AUTH_INVALID", "인증 정보를 확인할 수 없습니다.");
    }
    context.header("Set-Cookie", result.cookie);
    context.header("Set-Cookie", clearAdminPreAuthCookie(), { append: true });
    const session = resolveAdminSession(
      dependencies.db,
      dependencies.authSecret,
      result.cookie,
      dependencies.now(),
      { renew: false },
    );
    if (!session) return failure(context, 401, "AUTH_INVALID", "세션을 만들 수 없습니다.");
    return success(context, sessionDto(session));
  });

  app.post("/admin/api/v1/auth/logout", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    revokeAdminSession(
      dependencies.db,
      dependencies.authSecret,
      auth.session.sessionToken,
      dependencies.now(),
    );
    context.header("Set-Cookie", clearAdminSessionCookie());
    noStore(context);
    return context.body(null, 204);
  });

  app.get("/admin/api/v1/dashboard", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const counts = dependencies.db.sqlite.prepare(`
      SELECT status, count(*) count FROM consultations GROUP BY status ORDER BY status
    `).all() as Array<{ status: string; count: number }>;
    return success(context, { counts });
  });

  app.get("/admin/api/v1/consultations", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const total = (dependencies.db.sqlite.prepare(
      "SELECT count(*) count FROM consultations",
    ).get() as { count: number }).count;
    const pageNumber = requestedPage(context.req.query("page"), CONSULTATION_PAGE_SIZE, total);
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, receipt_id, status, locale, category, received_at_ms
      FROM consultations ORDER BY received_at_ms DESC, id LIMIT ? OFFSET ?
    `).all(CONSULTATION_PAGE_SIZE, (pageNumber - 1) * CONSULTATION_PAGE_SIZE) as Array<{
      id: string; receipt_id: string; status: ConsultationStatus; locale: string;
      category: string; received_at_ms: number;
    }>;
    return success(context, {
      items: rows.map((row) => ({
        id: row.id,
        receiptId: row.receipt_id,
        status: row.status,
        locale: row.locale,
        category: row.category,
        receivedAtMs: row.received_at_ms,
      })),
      page: page(pageNumber, CONSULTATION_PAGE_SIZE, total),
    });
  });

  app.get("/admin/api/v1/consultations/:id", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const row = dependencies.db.sqlite.prepare(`
      SELECT id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, received_at_ms, retention_expires_at_ms, purged_at_ms,
        row_version
      FROM consultations WHERE id = ?
    `).get(context.req.param("id")) as {
      id: string; receipt_id: string; status: ConsultationStatus; locale: string;
      category: string; preferred_contact: string; pii_envelope: string | null;
      received_at_ms: number; retention_expires_at_ms: number;
      purged_at_ms: number | null; row_version: number;
    } | undefined;
    if (!row) return failure(context, 404, "NOT_FOUND", "상담을 찾을 수 없습니다.");
    const piiAvailability = row.purged_at_ms !== null
      ? "purged"
      : row.retention_expires_at_ms <= dependencies.now()
        ? "expired"
        : "available";
    const pii = piiAvailability !== "available" || row.pii_envelope === null
      ? null
      : decryptPii(dependencies.keyProvider, row.id, row.pii_envelope);
    return success(context, {
      id: row.id,
      receiptId: row.receipt_id,
      status: row.status,
      locale: row.locale,
      category: row.category,
      preferredContact: row.preferred_contact,
      receivedAtMs: row.received_at_ms,
      rowVersion: row.row_version,
      pii,
      piiAvailability,
      nextStatuses: allowedNextConsultationStatuses(row.status),
    });
  });

  app.post("/admin/api/v1/consultations/:id/status", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const status = consultationStatusSchema.safeParse(auth.body.status);
    const rowVersion = positiveInteger(auth.body.rowVersion);
    if (!status.success || rowVersion === undefined) {
      return failure(context, 422, "INVALID_REQUEST", "상태와 버전을 확인하세요.");
    }
    const channels: NotificationChannel[] = [];
    if (auth.body.email === true) channels.push("email");
    if (auth.body.hermes === true) channels.push("hermes-telegram");
    const result = changeConsultationStatus(dependencies.db, {
      consultationId: context.req.param("id"),
      targetStatus: status.data,
      expectedRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
      notificationChannels: channels,
    });
    return result.kind === "updated" || result.kind === "unchanged"
      ? success(context, result)
      : workflowFailure(context, result);
  });

  app.get("/admin/api/v1/articles", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const total = (dependencies.db.sqlite.prepare(
      "SELECT count(*) count FROM article_locale_heads",
    ).get() as { count: number }).count;
    const pageNumber = requestedPage(context.req.query("page"), ARTICLE_PAGE_SIZE, total);
    const rows = dependencies.db.sqlite.prepare(`
      SELECT article.id, article.source_locale, head.locale, head.slug,
        head.state, head.row_version, revision.title, head.updated_at_ms
      FROM articles article
      JOIN article_locale_heads head ON head.article_id = article.id
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      ORDER BY head.updated_at_ms DESC, article.id, head.locale LIMIT ? OFFSET ?
    `).all(ARTICLE_PAGE_SIZE, (pageNumber - 1) * ARTICLE_PAGE_SIZE) as Array<{
      id: string; source_locale: Locale; locale: Locale; slug: string; state: ArticleState;
      row_version: number; title: string; updated_at_ms: number;
    }>;
    return success(context, {
      items: rows.map((row) => ({
        id: row.id,
        sourceLocale: row.source_locale,
        locale: row.locale,
        slug: row.slug,
        state: row.state,
        rowVersion: row.row_version,
        title: row.title,
        updatedAtMs: row.updated_at_ms,
      })),
      page: page(pageNumber, ARTICLE_PAGE_SIZE, total),
    });
  });

  app.get("/admin/api/v1/articles/:id", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const article = dependencies.db.sqlite.prepare(`
      SELECT id, source_locale, created_at_ms, updated_at_ms FROM articles WHERE id = ?
    `).get(context.req.param("id")) as {
      id: string; source_locale: Locale; created_at_ms: number; updated_at_ms: number;
    } | undefined;
    if (!article) return failure(context, 404, "NOT_FOUND", "문서를 찾을 수 없습니다.");
    const revisionTotal = (dependencies.db.sqlite.prepare(
      "SELECT count(*) count FROM article_revisions WHERE article_id = ?",
    ).get(article.id) as { count: number }).count;
    const revisionPage = requestedPage(
      context.req.query("revisionPage"),
      ARTICLE_REVISION_PAGE_SIZE,
      revisionTotal,
    );
    const heads = dependencies.db.sqlite.prepare(`
      SELECT head.locale, head.slug, head.state, head.row_version, head.head_revision_id,
        revision.title, revision.summary, revision.body_markdown, revision.sources_json,
        revision.created_at_ms, revision.created_by_type
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      WHERE head.article_id = ? ORDER BY head.locale
    `).all(article.id) as Array<{
      locale: Locale; slug: string; state: ArticleState; row_version: number;
      head_revision_id: string; title: string; summary: string; body_markdown: string;
      sources_json: string; created_at_ms: number; created_by_type: string;
    }>;
    const revisions = dependencies.db.sqlite.prepare(`
      SELECT revision.id, revision.locale, revision.revision_no, revision.title,
        revision.created_at_ms, revision.created_by_type,
        previous.id previous_id, previous.revision_no previous_no
      FROM article_revisions revision
      LEFT JOIN article_revisions previous
        ON previous.article_id = revision.article_id
       AND previous.locale = revision.locale
       AND previous.revision_no = revision.revision_no - 1
      WHERE revision.article_id = ?
      ORDER BY revision.locale, revision.revision_no DESC LIMIT ? OFFSET ?
    `).all(
      article.id,
      ARTICLE_REVISION_PAGE_SIZE,
      (revisionPage - 1) * ARTICLE_REVISION_PAGE_SIZE,
    ) as Array<{
      id: string; locale: Locale; revision_no: number; title: string; created_at_ms: number;
      created_by_type: string; previous_id: string | null; previous_no: number | null;
    }>;
    return success(context, {
      id: article.id,
      sourceLocale: article.source_locale,
      createdAtMs: article.created_at_ms,
      updatedAtMs: article.updated_at_ms,
      heads: heads.map((head) => ({
        locale: head.locale,
        slug: head.slug,
        state: head.state,
        rowVersion: head.row_version,
        headRevisionId: head.head_revision_id,
        title: head.title,
        summary: head.summary,
        bodyMarkdown: head.body_markdown,
        sourcesJson: head.sources_json,
        createdAtMs: head.created_at_ms,
        createdByType: head.created_by_type,
      })),
      revisions: revisions.map((revision) => ({
        id: revision.id,
        locale: revision.locale,
        revisionNo: revision.revision_no,
        title: revision.title,
        createdAtMs: revision.created_at_ms,
        createdByType: revision.created_by_type,
        previousRevisionId: revision.previous_id,
        previousRevisionNo: revision.previous_no,
      })),
      revisionPage: page(revisionPage, ARTICLE_REVISION_PAGE_SIZE, revisionTotal),
    });
  });

  app.get("/admin/api/v1/articles/:id/revisions/:revisionId/diff", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const against = context.req.query("against") ?? "";
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, locale, title, summary, body_markdown FROM article_revisions
      WHERE article_id = ? AND id IN (?, ?) ORDER BY id
    `).all(context.req.param("id"), context.req.param("revisionId"), against) as Array<{
      id: string; locale: Locale; title: string; summary: string; body_markdown: string;
    }>;
    const current = rows.find((row) => row.id === context.req.param("revisionId"));
    const previous = rows.find((row) => row.id === against);
    if (!current || !previous || current.locale !== previous.locale) {
      return failure(context, 404, "NOT_FOUND", "비교할 리비전을 찾을 수 없습니다.");
    }
    return success(context, {
      locale: current.locale,
      previous: {
        id: previous.id,
        title: previous.title,
        summary: previous.summary,
        bodyMarkdown: previous.body_markdown,
      },
      current: {
        id: current.id,
        title: current.title,
        summary: current.summary,
        bodyMarkdown: current.body_markdown,
      },
    });
  });

  const articleActions: Readonly<Record<string, ArticleReviewState>> = {
    review: "in_review",
    return: "draft",
    approve: "approved",
    reject: "rejected",
  };
  app.post("/admin/api/v1/articles/:id/locales/:locale/slug", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const locale = localeSchema.safeParse(context.req.param("locale"));
    const rowVersion = positiveInteger(auth.body.rowVersion);
    const slug = stringValue(auth.body.slug, 96);
    if (!locale.success || rowVersion === undefined || slug === undefined) {
      return failure(context, 422, "INVALID_REQUEST", "슬러그와 버전을 확인하세요.");
    }
    const result = changeArticleLocaleSlug(dependencies.db, {
      articleId: context.req.param("id"),
      locale: locale.data,
      slug,
      expectedRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
    });
    return result.kind === "updated" || result.kind === "unchanged"
      ? success(context, result)
      : workflowFailure(context, result);
  });

  app.post("/admin/api/v1/articles/:id/locales/:locale/:action", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const locale = localeSchema.safeParse(context.req.param("locale"));
    const targetState = articleActions[context.req.param("action")];
    const rowVersion = positiveInteger(auth.body.rowVersion);
    if (!locale.success || !targetState || rowVersion === undefined) {
      return failure(context, 422, "INVALID_REQUEST", "문서 상태 요청을 확인하세요.");
    }
    const result = changeArticleLocaleState(dependencies.db, {
      articleId: context.req.param("id"),
      locale: locale.data,
      targetState,
      expectedRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
    });
    return result.kind === "updated" || result.kind === "unchanged"
      ? success(context, result)
      : workflowFailure(context, result);
  });

  app.post("/admin/api/v1/articles/:id/translations", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const targetLocale = localeSchema.safeParse(auth.body.targetLocale);
    const rowVersion = positiveInteger(auth.body.rowVersion);
    if (!targetLocale.success || rowVersion === undefined) {
      return failure(context, 422, "INVALID_REQUEST", "번역 대상과 버전을 확인하세요.");
    }
    const result = enqueueArticleTranslation(dependencies.db, dependencies.keyProvider, {
      articleId: context.req.param("id"),
      targetLocale: targetLocale.data,
      expectedSourceRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
    });
    return ["queued", "requeued", "existing"].includes(result.kind)
      ? success(context, result)
      : workflowFailure(context, result);
  });

  app.get("/admin/api/v1/publish/preview", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const rawMode = context.req.query("mode");
    const mode = rawMode === undefined || rawMode === "next-batch"
      ? "next-batch"
      : rawMode === "policy-only"
        ? "policy-only"
        : undefined;
    if (!mode) return failure(context, 422, "INVALID_REQUEST", "게시 모드를 확인하세요.");
    const scope = publicationScope(dependencies, mode);
    const pageNumber = requestedPage(
      context.req.query("page"),
      PUBLISH_PREVIEW_PAGE_SIZE,
      scope.total,
    );
    const rows = dependencies.db.sqlite.prepare(`
      SELECT head.article_id, head.locale, head.slug, head.state, head.head_revision_id,
        revision.title, revision.summary,
        CASE WHEN head.locale = article.source_locale THEN 1
          WHEN revision.source_revision_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM article_locale_heads source_head
            WHERE source_head.article_id = head.article_id
              AND source_head.locale = article.source_locale
              AND source_head.state IN ('approved','published')
              AND source_head.head_revision_id = revision.source_revision_id
              AND source_head.approved_revision_id = revision.source_revision_id
          ) THEN 1 ELSE 0 END AS source_binding_valid
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      JOIN articles article ON article.id = head.article_id
      ORDER BY head.article_id, head.locale LIMIT ? OFFSET ?
    `).all(
      PUBLISH_PREVIEW_PAGE_SIZE,
      (pageNumber - 1) * PUBLISH_PREVIEW_PAGE_SIZE,
    ) as Array<{
      article_id: string; locale: Locale; slug: string; state: ArticleState;
      head_revision_id: string; title: string; summary: string; source_binding_valid: 0 | 1;
    }>;
    const items = rows.map((row) => ({
      articleId: row.article_id,
      locale: row.locale,
      slug: row.slug,
      state: row.state,
      headRevisionId: row.head_revision_id,
      title: row.title,
      summary: row.summary,
      sourceBindingValid: row.source_binding_valid === 1,
    }));
    return success(context, {
      eligible: items.filter((item) =>
        scope.selectedKeys.has(`${item.articleId}\0${item.locale}`) &&
        item.sourceBindingValid),
      blocked: items.filter((item) =>
        (item.state !== "approved" && item.state !== "published") || !item.sourceBindingValid),
      eligibleTotal: scope.eligibleTotal,
      blockedTotal: scope.blockedTotal,
      batchCount: scope.batchCount,
      remainingAfterBatch: scope.remainingAfterBatch,
      mode: scope.mode,
      fingerprint: scope.fingerprint,
      page: page(pageNumber, PUBLISH_PREVIEW_PAGE_SIZE, scope.total),
    });
  });

  app.post("/admin/api/v1/publish/confirm", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const mode = auth.body.mode === "next-batch" || auth.body.mode === "policy-only"
      ? auth.body.mode
      : undefined;
    const fingerprint = stringValue(auth.body.fingerprint, 64);
    const currentFingerprint = mode
      ? publicationScope(dependencies, mode).fingerprint
      : undefined;
    if (!mode || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint) || fingerprint !== currentFingerprint) {
      return failure(context, 409, "ROW_VERSION_CONFLICT", "게시 미리보기가 변경되었습니다. 다시 확인하세요.");
    }
    return success(context, {
      confirmationToken: issueConfirmation(auth.session, "publish", `${mode}:${fingerprint}`),
      expiresInMs: 120_000,
    });
  });

  app.post("/admin/api/v1/publish", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const mode = auth.body.mode === "next-batch" || auth.body.mode === "policy-only"
      ? auth.body.mode
      : undefined;
    const fingerprint = stringValue(auth.body.fingerprint, 64);
    if (!mode || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
      return failure(context, 422, "INVALID_REQUEST", "게시 미리보기 식별자를 확인하세요.");
    }
    if (!consumeConfirmation(
      auth.body.confirmationToken,
      auth.session,
      "publish",
      `${mode}:${fingerprint}`,
    )) return failure(context, 422, "CONFIRMATION_REQUIRED", "게시 확인이 만료되었거나 유효하지 않습니다.");
    if (publicationScope(dependencies, mode).fingerprint !== fingerprint) {
      return failure(context, 409, "ROW_VERSION_CONFLICT", "게시 대상이 변경되었습니다. 다시 확인하세요.");
    }
    if (!dependencies.articlePublication) {
      return failure(context, 503, "OPERATION_UNAVAILABLE", "게시 기능이 구성되지 않았습니다.");
    }
    try {
      return success(context, await dependencies.articlePublication.publish({
        actorAdminId: auth.session.adminId,
        requestId: context.get("requestId"),
        nowMs: dependencies.now(),
        mode,
        expectedFingerprint: fingerprint,
      }));
    } catch (error) {
      return publicationFailure(context, error, "게시");
    }
  });

  app.get("/admin/api/v1/releases", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const total = (dependencies.db.sqlite.prepare(
      "SELECT count(*) count FROM releases",
    ).get() as { count: number }).count;
    const pageNumber = requestedPage(context.req.query("page"), RELEASE_PAGE_SIZE, total);
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, version, state, manifest_sha256, verified_at_ms, activated_at_ms,
        rolled_back_at_ms, created_at_ms FROM releases
      ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?
    `).all(RELEASE_PAGE_SIZE, (pageNumber - 1) * RELEASE_PAGE_SIZE) as Array<{
      id: string; version: string; state: string; manifest_sha256: Buffer;
      verified_at_ms: number | null; activated_at_ms: number | null;
      rolled_back_at_ms: number | null; created_at_ms: number;
    }>;
    return success(context, {
      items: rows.map((row) => ({
        id: row.id,
        version: row.version,
        state: row.state,
        manifestSha256: row.manifest_sha256.toString("hex"),
        verifiedAtMs: row.verified_at_ms,
        activatedAtMs: row.activated_at_ms,
        rolledBackAtMs: row.rolled_back_at_ms,
        createdAtMs: row.created_at_ms,
      })),
      page: page(pageNumber, RELEASE_PAGE_SIZE, total),
    });
  });

  app.post("/admin/api/v1/releases/:id/rollback/confirm", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const releaseId = context.req.param("id");
    const release = dependencies.db.sqlite.prepare(
      "SELECT version, state FROM releases WHERE id = ?",
    ).get(releaseId) as { version: string; state: string } | undefined;
    if (!release || release.state !== "retired") {
      return failure(context, 404, "NOT_FOUND", "롤백 가능한 릴리스를 찾을 수 없습니다.");
    }
    return success(context, {
      confirmationToken: issueConfirmation(auth.session, "rollback", releaseId),
      expiresInMs: 120_000,
      version: release.version,
    });
  });

  app.post("/admin/api/v1/releases/:id/rollback", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const releaseId = context.req.param("id");
    if (!consumeConfirmation(auth.body.confirmationToken, auth.session, "rollback", releaseId)) {
      return failure(context, 422, "CONFIRMATION_REQUIRED", "롤백 확인이 만료되었거나 유효하지 않습니다.");
    }
    if (!dependencies.articlePublication) {
      return failure(context, 503, "OPERATION_UNAVAILABLE", "롤백 기능이 구성되지 않았습니다.");
    }
    try {
      return success(context, await dependencies.articlePublication.rollback({
        releaseId,
        actorAdminId: auth.session.adminId,
        requestId: context.get("requestId"),
        nowMs: dependencies.now(),
      }));
    } catch (error) {
      return publicationFailure(context, error, "롤백");
    }
  });

  app.get("/admin/api/v1/notifications", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT channel, enabled, provider, payload_mode, config_json, secret_ref, updated_at_ms
      FROM notification_settings ORDER BY channel
    `).all() as Array<{
      channel: NotificationChannel; enabled: 0 | 1; provider: string;
      payload_mode: string | null; config_json: string | null; secret_ref: string | null;
      updated_at_ms: number;
    }>;
    return success(context, {
      settings: rows.map((row) => {
        const smtp = row.channel === "email" ? storedSmtp(row.config_json, row.secret_ref) : undefined;
        return {
          channel: row.channel,
          enabled: row.enabled === 1,
          provider: row.provider,
          payloadMode: row.payload_mode,
          updatedAtMs: row.updated_at_ms,
          smtpConfigured: smtp !== undefined,
          ...(smtp ? { smtp } : {}),
        };
      }),
    });
  });

  app.post("/admin/api/v1/notifications", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const channel = auth.body.channel === "email" || auth.body.channel === "hermes-telegram"
      ? auth.body.channel
      : undefined;
    if (!channel || typeof auth.body.enabled !== "boolean") {
      return failure(context, 422, "INVALID_REQUEST", "알림 채널 설정을 확인하세요.");
    }
    const allowedKeys = channel === "email"
      ? new Set(["channel", "enabled", "payloadMode", "fullInquiryApproved", "smtp"])
      : new Set(["channel", "enabled"]);
    if (Object.keys(auth.body).some((key) => !allowedKeys.has(key))) {
      return failure(context, 422, "INVALID_REQUEST", "허용되지 않은 알림 설정 필드가 있습니다.");
    }
    if (
      channel === "email" &&
      auth.body.payloadMode !== "receipt-only" &&
      auth.body.payloadMode !== "full-inquiry"
    ) {
      return failure(context, 422, "INVALID_REQUEST", "이메일 전송 범위를 확인하세요.");
    }
    const payloadMode = channel === "email"
      ? auth.body.payloadMode === "full-inquiry" ? "full-inquiry" : "receipt-only"
      : null;
    const existing = dependencies.db.sqlite.prepare(
      "SELECT config_json, secret_ref FROM notification_settings WHERE channel = 'email'",
    ).get() as { config_json: string | null; secret_ref: string | null } | undefined;
    const smtp = channel === "email"
      ? auth.body.smtp === undefined
        ? storedSmtp(existing?.config_json, existing?.secret_ref)
        : submittedSmtp(auth.body.smtp)
      : undefined;
    if (channel === "email" && auth.body.smtp !== undefined && smtp === undefined) {
      return failure(context, 422, "INVALID_REQUEST", "SMTP TLS 설정을 확인하세요.", {
        smtp: "호스트, 465 포트, 메일 주소와 Keychain 참조를 확인하세요.",
      });
    }
    if (channel === "email" && auth.body.enabled && !smtp) {
      return failure(context, 422, "INVALID_REQUEST", "이메일 활성화에는 SMTP 설정이 필요합니다.");
    }
    if (channel === "email" && auth.body.enabled && payloadMode === "full-inquiry" && auth.body.fullInquiryApproved !== true) {
      return failure(context, 422, "INVALID_REQUEST", "전체 문의 전송은 명시적 승인이 필요합니다.");
    }
    const configJson = channel === "email" && smtp
      ? JSON.stringify({ host: smtp.host, port: 465, secure: true, from: smtp.from, to: smtp.to })
      : channel === "email" ? existing?.config_json ?? "{}" : "{}";
    const secretRef = channel === "email" && smtp
      ? smtp.secretRef
      : channel === "email" ? existing?.secret_ref ?? null : null;
    dependencies.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      dependencies.db.sqlite.prepare(`
        INSERT INTO notification_settings (
          channel, enabled, provider, payload_mode, config_json, secret_ref,
          updated_at_ms, updated_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET enabled = excluded.enabled,
          provider = excluded.provider, payload_mode = excluded.payload_mode,
          config_json = excluded.config_json, secret_ref = excluded.secret_ref,
          updated_at_ms = excluded.updated_at_ms,
          updated_by_admin_id = excluded.updated_by_admin_id
      `).run(
        channel,
        auth.body.enabled ? 1 : 0,
        channel === "email" ? "smtp" : "hermes",
        payloadMode,
        configJson,
        secretRef,
        dependencies.now(),
        auth.session.adminId,
      );
      dependencies.db.sqlite.prepare(`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, target_type, target_id,
          request_id, metadata_json, created_at_ms
        ) VALUES (?, 'admin', ?, 'notification.settings.updated',
          'notification-setting', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        auth.session.adminId,
        channel,
        context.get("requestId"),
        JSON.stringify({
          enabled: auth.body.enabled,
          payloadMode,
          ...(channel === "email" ? { smtpConfigured: smtp !== undefined } : {}),
        }),
        dependencies.now(),
      );
      dependencies.db.sqlite.exec("COMMIT");
    } catch (error) {
      if (dependencies.db.sqlite.inTransaction) dependencies.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return success(context, { saved: true });
  });

  app.post("/admin/api/v1/notifications/test", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const channel = auth.body.channel === "hermes-telegram" ? "hermes-telegram" :
      auth.body.channel === "email" ? "email" : undefined;
    if (!channel) return failure(context, 422, "INVALID_REQUEST", "알림 채널을 확인하세요.");
    const setting = dependencies.db.sqlite.prepare(
      "SELECT enabled FROM notification_settings WHERE channel = ?",
    ).get(channel) as { enabled: 0 | 1 } | undefined;
    if (setting?.enabled !== 1) {
      return failure(
        context,
        409,
        "NOTIFICATION_CHANNEL_DISABLED",
        "비활성 알림 채널은 테스트할 수 없습니다.",
      );
    }
    const consultation = dependencies.db.sqlite.prepare(
      "SELECT id FROM consultations ORDER BY received_at_ms DESC LIMIT 1",
    ).get() as { id: string } | undefined;
    if (!consultation) return failure(context, 409, "INVALID_REQUEST", "테스트할 상담이 없습니다.");
    const deliveryId = randomUUID();
    dependencies.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      dependencies.db.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, payload_json, state,
          attempt_count, available_at_ms, purpose, delivery_cycle,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'test', 1, ?, ?)
      `).run(
        deliveryId,
        consultation.id,
        channel,
        `notification.test.${randomUUID()}`,
        JSON.stringify({ test: true }),
        dependencies.now(),
        dependencies.now(),
        dependencies.now(),
      );
      dependencies.db.sqlite.prepare(`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, target_type, target_id,
          request_id, metadata_json, created_at_ms
        ) VALUES (?, 'admin', ?, 'notification.test.queued',
          'notification', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        auth.session.adminId,
        deliveryId,
        context.get("requestId"),
        JSON.stringify({ channel }),
        dependencies.now(),
      );
      dependencies.db.sqlite.exec("COMMIT");
    } catch (error) {
      if (dependencies.db.sqlite.inTransaction) dependencies.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return success(context, { deliveryId });
  });

  app.get("/admin/api/v1/consents", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const bundle = getActiveConsentBundle(dependencies.db);
    const databaseCandidate = bundle ? {
      bundleId: bundle.bundleId,
      documents: bundle.documents.map((document) => ({
        kind: document.kind,
        locale: document.locale,
        version: document.version,
      })),
    } : null;
    const authority = dependencies.consentAuthorityResolver?.();
    const publicAuthority = authority?.source === "release"
      ? {
          releaseId: authority.releaseId,
          bundleId: authority.bundle.bundleId,
        }
      : null;
    return success(context, {
      databaseCandidate,
      publicAuthority,
      inSync: databaseCandidate !== null &&
        publicAuthority !== null &&
        databaseCandidate.bundleId === publicAuthority.bundleId,
    });
  });

  app.get("/admin/api/v1/failures", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const total = (dependencies.db.sqlite.prepare(
      "SELECT count(*) count FROM notification_outbox WHERE state = 'failed'",
    ).get() as { count: number }).count;
    const pageNumber = requestedPage(context.req.query("page"), FAILURE_PAGE_SIZE, total);
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, channel, event_type, attempt_count, last_error_code
      FROM notification_outbox WHERE state = 'failed'
      ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?
    `).all(FAILURE_PAGE_SIZE, (pageNumber - 1) * FAILURE_PAGE_SIZE) as Array<{
      id: string; channel: NotificationChannel; event_type: string;
      attempt_count: number; last_error_code: string | null;
    }>;
    return success(context, {
      items: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        eventType: row.event_type,
        attemptCount: row.attempt_count,
        lastErrorCode: row.last_error_code,
      })),
      page: page(pageNumber, FAILURE_PAGE_SIZE, total),
    });
  });

  app.post("/admin/api/v1/failures/:id/requeue", async (context) => {
    const auth = await requireMutation(context, dependencies);
    if (auth instanceof Response) return auth;
    const requeued = requeueFailedNotification(
      dependencies.db,
      context.req.param("id"),
      dependencies.now(),
      { actorAdminId: auth.session.adminId, requestId: context.get("requestId") },
    );
    return requeued
      ? success(context, { requeued: true })
      : failure(context, 409, "INVALID_REQUEST", "실패 상태인 알림이 아닙니다.");
  });

  app.get("/admin/api/v1/health", (context) => {
    const session = requireSession(context, dependencies);
    if (session instanceof Response) return session;
    const ready = isDatabaseReady(dependencies.db) && getActiveConsentBundle(dependencies.db) !== undefined;
    const queues = dependencies.db.sqlite.prepare(`
      SELECT state, count(*) count FROM notification_outbox GROUP BY state ORDER BY state
    `).all() as Array<{ state: string; count: number }>;
    return success(context, { ready, queues });
  });

  app.all("/admin/api/*", (context) => (
    failure(context, 404, "NOT_FOUND", "관리자 API 경로를 찾을 수 없습니다.")
  ));
}
