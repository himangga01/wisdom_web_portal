import { randomUUID } from "node:crypto";

import {
  CONSULTATION_STATUSES,
  localeSchema,
  consultationStatusSchema,
  type ArticleState,
  type ConsultationStatus,
  type Locale,
  type NotificationChannel,
} from "@wisdom/shared";
import { Hono, type Context } from "hono";

import { resolveClientIp } from "../abuse/rate-limit.js";
import {
  analyticsTotals,
  autoGranularity,
  bucketSeries,
  daySpan,
  isCalendarDay,
  localeSplit,
  shiftDay,
  siteSeries,
  topPages,
  topReferrers,
  type Granularity,
} from "../analytics/queries.js";
import { seoulDay, type AnalyticsDatabase } from "../analytics/store.js";
import {
  beginAdminLogin,
  completeAdminMfa,
  type AdminAuthContext,
} from "../auth/service.js";
import { clearAdminPreAuthCookie } from "../auth/preauth.js";
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
import { findConsultationIdsByContact } from "../consultations/service.js";
import {
  changeArticleLocaleState,
  changeArticleLocaleSlug,
  enqueueArticleTranslation,
  type ArticleReviewState,
} from "../articles/workflow.js";
import { decryptPii, type KeyProvider } from "../crypto/index.js";
import { isDatabaseReady, type ControlDatabase } from "../db/client.js";
import { requeueFailedNotification } from "../notifications/outbox.js";
import { isAllowedSmtpHostname } from "../notifications/smtp-security.js";
import {
  getMarketingWithdrawalConfirmation,
  openMarketingWithdrawalCapability,
  withdrawMarketingConsent,
} from "../withdrawal/service.js";
import { payloadModeLabel, preferredContactLabel } from "./ui/labels.js";
import { renderAdminPage, renderPlainPage } from "./ui/Layout.js";
import {
  SAVED_BANNER_FLAGS,
  backLinkHtml,
  errorBodyHtml,
  savedBannerHtml,
} from "./ui/primitives.js";
import {
  type ArticleActionForm,
  type ArticleHeadView,
  type ArticleRevisionItem,
  type ConsultationListRow,
  articleDetailBodyHtml,
  articlesBodyHtml,
  consentsBodyHtml,
  consultationDetailBodyHtml,
  consultationsBodyHtml,
  analyticsBodyHtml,
  dashboardBodyHtml,
  failuresBodyHtml,
  healthBodyHtml,
  loginBodyHtml,
  mfaBodyHtml,
  notificationSettingsBodyHtml,
  publishPreviewBodyHtml,
  releasesBodyHtml,
  revisionDiffBodyHtml,
  withdrawalConfirmBodyHtml,
} from "./ui/screens.js";

interface AdminEnvironment {
  Variables: { requestId: string };
}

export interface Task4RouteDependencies extends AdminAuthContext {
  publicOrigin: string;
  adminOrigin: string;
  withdrawalSecret: Uint8Array;
  now: () => number;
  peerAddress: (context: Context<AdminEnvironment>) => string;
  articlePublication?: AdminArticlePublicationActions;
  analyticsDb?: AnalyticsDatabase;
}

export interface AdminArticlePublicationActionInput {
  actorAdminId: string;
  requestId: string;
  nowMs: number;
}

export interface AdminArticlePublicationResult {
  releaseId: string;
  version: string;
  manifestSha256: string;
}

export interface AdminArticlePublicationActions {
  publish(input: AdminArticlePublicationActionInput): Promise<AdminArticlePublicationResult>;
  rollback(
    input: AdminArticlePublicationActionInput & { releaseId: string },
  ): Promise<AdminArticlePublicationResult>;
}

export { ADMIN_STYLE_CSP_HASH } from "./ui/styles.js";

const GENERIC_AUTH_FAILURE = renderPlainPage(
  "로그인 실패",
  `<h1>로그인하지 못했습니다</h1><p>입력하신 정보를 확인할 수 없습니다. 아이디·비밀번호를 다시 확인하시고, 여러 번 실패한 경우 잠시 후 다시 시도해 주세요.</p><a href="/admin/login">로그인 화면으로 돌아가기</a>`,
);
const MAX_FORM_BYTES = 16 * 1_024;
const MAX_FORM_FIELDS = 32;
const MAX_FORM_FIELD_NAME = 128;
const MAX_FORM_FIELD_VALUE = 4_096;

function page(title: string, body: string, lang = "ko", csrfToken?: string): string {
  return renderAdminPage(title, body, lang, csrfToken);
}

const SEOUL_TIME = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Human-readable KST timestamp for admin screens (the office operates in Seoul).
function formatSeoulTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "";
  return `${SEOUL_TIME.format(new Date(epochMs))} (KST)`;
}

// Maps internal action result kinds to a Korean explanation for the operator.
const RESULT_MESSAGES: Record<string, string> = {
  conflict: "다른 화면에서 이미 변경되어 저장하지 못했습니다. 목록에서 최신 상태를 확인한 뒤 다시 시도해 주세요.",
  "invalid-transition": "지금 상태에서는 요청한 변경을 할 수 없습니다. 최신 상태를 확인해 주세요.",
  "state-blocked": "다른 작업이 진행 중이라 지금은 변경할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  "slug-conflict": "같은 주소(slug)를 쓰는 글이 이미 있습니다. 다른 값을 사용해 주세요.",
  "pii-rejected": "개인정보로 보이는 내용이 포함되어 처리를 중단했습니다. 내용을 확인해 주세요.",
  "source-not-approved": "원문이 아직 승인되지 않아 번역을 요청할 수 없습니다. 먼저 원문을 승인해 주세요.",
  "target-exists": "이미 존재하는 대상이라 다시 만들 수 없습니다.",
};

function resultMessage(kind: string): string {
  return RESULT_MESSAGES[kind] ?? "요청을 처리하지 못했습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.";
}

function backLink(href: string, label: string): string {
  return backLinkHtml(href, label);
}

// Shown when Origin/CSRF checks fail or a session has expired mid-edit, so the
// operator understands why a save did not go through and how to recover.
function forbiddenPage(): string {
  return page(
    "요청을 처리할 수 없습니다",
    errorBodyHtml(
      "요청을 처리할 수 없습니다",
      "페이지가 오래되었거나 로그인 세션이 만료되어 저장하지 못했습니다. 작성 중이던 내용이 있다면 복사해 두시고, 새로고침하거나 다시 로그인한 뒤 시도해 주세요.",
      "/admin",
      "관리자 홈으로 돌아가기",
    ),
  );
}

function actionErrorPage(title: string, kind: string, backHref: string, backLabel: string): string {
  return page(title, errorBodyHtml(title, resultMessage(kind), backHref, backLabel));
}

// Post/Redirect/Get success confirmation: a GET renders a banner when its
// redirect target carried a recognised query flag (e.g. ?saved=1).
function savedBanner(context: Context<AdminEnvironment>): string {
  for (const flag of SAVED_BANNER_FLAGS) {
    if (context.req.query(flag) === "1") return savedBannerHtml(flag);
  }
  return "";
}

function cookieValue(header: string, name: string): string | undefined {
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    return trimmed.slice(name.length + 1);
  }
  return undefined;
}

function parsePairCookie(header: string, name: string): { token: string; csrf: string } | undefined {
  const value = cookieValue(header, name);
  if (!value) return undefined;
  const [token, csrf, extra] = value.split(".");
  if (!token || !csrf || extra !== undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) return undefined;
  return { token, csrf };
}

async function formValues(
  context: Context<AdminEnvironment>,
): Promise<Record<string, string> | Response> {
  const mediaType = (context.req.header("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    return context.html(page("지원하지 않는 요청", "<h1>지원하지 않는 형식의 요청입니다</h1>"), 415);
  }
  const contentLength = context.req.header("content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_FORM_BYTES)
  ) {
    return context.html(page("요청이 너무 큼", "<h1>요청 크기가 너무 큽니다</h1>"), 413);
  }
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_FORM_BYTES) {
        await reader.cancel();
        return context.html(page("요청이 너무 큼", "<h1>요청 크기가 너무 큽니다</h1>"), 413);
      }
      chunks.push(next.value);
    }
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total),
    );
  } catch {
    return context.html(page("잘못된 요청", "<h1>요청 형식이 올바르지 않습니다</h1>"), 400);
  }
  const values: Record<string, string> = {};
  let fields = 0;
  for (const [key, value] of new URLSearchParams(serialized)) {
    fields += 1;
    if (
      fields > MAX_FORM_FIELDS ||
      key.length === 0 || key.length > MAX_FORM_FIELD_NAME ||
      value.length > MAX_FORM_FIELD_VALUE ||
      Object.hasOwn(values, key)
    ) {
      return context.html(page("잘못된 요청", "<h1>요청 형식이 올바르지 않습니다</h1>"), 400);
    }
    values[key] = value;
  }
  return values;
}

function strictOrigin(context: Context<AdminEnvironment>, expected: string): boolean {
  return context.req.header("origin") === expected;
}

interface StoredSmtpConfiguration {
  host: string;
  port: number;
  secure: true;
  from: string;
  to: string;
  secretRef: string;
}

function validMailbox(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/[\r\n]/.test(value);
}

function validKeychainReference(value: string): boolean {
  return /^keychain:[A-Za-z0-9._-]{1,128}$/.test(value);
}

function smtpConfigurationFromStored(
  configJson: string | null | undefined,
  secretRef: string | null | undefined,
): StoredSmtpConfiguration | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson ?? "null");
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const config = parsed as Record<string, unknown>;
  if (
    typeof config.host !== "string" || !isAllowedSmtpHostname(config.host) ||
    config.port !== 465 ||
    config.secure !== true ||
    typeof config.from !== "string" || !validMailbox(config.from) ||
    typeof config.to !== "string" || !validMailbox(config.to) ||
    typeof secretRef !== "string" || !validKeychainReference(secretRef)
  ) return undefined;
  return {
    host: config.host,
    port: Number(config.port),
    secure: true,
    from: config.from,
    to: config.to,
    secretRef,
  };
}

function smtpConfigurationFromForm(
  form: Record<string, string>,
): { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; value: StoredSmtpConfiguration } {
  if (form.smtpPassword !== undefined || form.smtpCredential !== undefined) return { kind: "invalid" };
  const fields = [
    form.smtpHost,
    form.smtpPort,
    form.smtpFrom,
    form.smtpTo,
    form.smtpTlsMode,
    form.smtpSecretRef,
  ];
  if (fields.every((value) => value === undefined || value === "")) return { kind: "absent" };
  const port = Number(form.smtpPort);
  if (
    typeof form.smtpHost !== "string" || !isAllowedSmtpHostname(form.smtpHost) ||
    port !== 465 ||
    typeof form.smtpFrom !== "string" || !validMailbox(form.smtpFrom) ||
    typeof form.smtpTo !== "string" || !validMailbox(form.smtpTo) ||
    form.smtpTlsMode !== "implicit-tls" ||
    typeof form.smtpSecretRef !== "string" || !validKeychainReference(form.smtpSecretRef)
  ) return { kind: "invalid" };
  return {
    kind: "valid",
    value: {
      host: form.smtpHost,
      port,
      secure: true,
      from: form.smtpFrom,
      to: form.smtpTo,
      secretRef: form.smtpSecretRef,
    },
  };
}

function protectedSession(
  context: Context<AdminEnvironment>,
  dependencies: Task4RouteDependencies,
  renew = true,
): ResolvedAdminSession | Response {
  const session = resolveAdminSession(
    dependencies.db,
    dependencies.authSecret,
    context.req.header("cookie") ?? "",
    dependencies.now(),
    { renew },
  );
  return session ?? context.redirect(`${dependencies.adminOrigin}/admin/login`, 303);
}

async function protectedPost(
  context: Context<AdminEnvironment>,
  dependencies: Task4RouteDependencies,
): Promise<{ session: ResolvedAdminSession; form: Record<string, string> } | Response> {
  if (!strictOrigin(context, dependencies.adminOrigin)) {
    return context.html(forbiddenPage(), 403);
  }
  const resolved = protectedSession(context, dependencies, false);
  if (resolved instanceof Response) return resolved;
  const form = await formValues(context);
  if (form instanceof Response) return form;
  if (!verifyAdminCsrf(
    dependencies.authSecret,
    resolved.sessionToken,
    resolved.csrfHash,
    form.csrf ?? "",
  )) {
    return context.html(forbiddenPage(), 403);
  }
  resolveAdminSession(
    dependencies.db,
    dependencies.authSecret,
    context.req.header("cookie") ?? "",
    dependencies.now(),
  );
  return { session: resolved, form };
}

function mapConsultationRow(row: Record<string, string | number>): ConsultationListRow {
  return {
    id: String(row.id),
    receiptId: String(row.receipt_id),
    status: String(row.status),
    locale: String(row.locale),
    category: String(row.category),
    receivedAt: formatSeoulTime(Number(row.received_at_ms)),
  };
}

function consultationDetail(
  dependencies: Task4RouteDependencies,
  id: string,
  csrfToken: string,
): string | undefined {
  const row = dependencies.db.sqlite.prepare(`
    SELECT id, receipt_id, status, locale, category, preferred_contact,
           marketing_accepted, marketing_withdrawn_at_ms, retention_expires_at_ms,
           pii_envelope, purged_at_ms, received_at_ms, row_version
    FROM consultations WHERE id = ?
  `).get(id) as {
    id: string;
    receipt_id: string;
    status: ConsultationStatus;
    locale: string;
    category: string;
    preferred_contact: string;
    marketing_accepted: number;
    marketing_withdrawn_at_ms: number | null;
    retention_expires_at_ms: number;
    pii_envelope: string | null;
    purged_at_ms: number | null;
    received_at_ms: number;
    row_version: number;
  } | undefined;
  if (!row) return undefined;
  const purged = row.purged_at_ms !== null;
  const pii = row.pii_envelope === null
    ? undefined
    : decryptPii(dependencies.keyProvider, row.id, row.pii_envelope);
  const nextStatuses = allowedNextConsultationStatuses(row.status);
  const terminalStatuses = nextStatuses.filter((status) => status === "closed" || status === "spam");
  const marketingState = row.marketing_accepted !== 1
    ? "미동의"
    : row.marketing_withdrawn_at_ms !== null
      ? `철회됨 (${formatSeoulTime(row.marketing_withdrawn_at_ms)})`
      : "동의";
  const channelEnabled = (channel: string): boolean => (dependencies.db.sqlite.prepare(
    "SELECT enabled FROM notification_settings WHERE channel = ?",
  ).get(channel) as { enabled: number } | undefined)?.enabled === 1;
  const notifications = (dependencies.db.sqlite.prepare(`
    SELECT channel, state, sent_at_ms, last_error_code, attempt_count
    FROM notification_outbox WHERE consultation_id = ? ORDER BY created_at_ms
  `).all(row.id) as Array<{
    channel: string; state: string; sent_at_ms: number | null; last_error_code: string | null; attempt_count: number;
  }>).map((entry) => ({
    channel: entry.channel,
    state: entry.state,
    attemptCount: entry.attempt_count,
    ...(entry.sent_at_ms === null ? {} : { sentAt: formatSeoulTime(entry.sent_at_ms) }),
    ...(entry.last_error_code === null ? {} : { lastErrorCode: entry.last_error_code }),
  }));
  const statusHistory = (dependencies.db.sqlite.prepare(`
    SELECT metadata_json, created_at_ms FROM audit_events
    WHERE target_type = 'consultation' AND target_id = ? AND action = 'consultation.status.changed'
    ORDER BY created_at_ms
  `).all(row.id) as Array<{ metadata_json: string | null; created_at_ms: number }>).flatMap((entry) => {
    let meta: { fromStatus?: unknown; toStatus?: unknown };
    try {
      meta = (JSON.parse(entry.metadata_json ?? "null") ?? {}) as typeof meta;
    } catch {
      return [];
    }
    if (typeof meta.fromStatus !== "string" || typeof meta.toStatus !== "string") return [];
    return [{ fromStatus: meta.fromStatus, toStatus: meta.toStatus, at: formatSeoulTime(entry.created_at_ms) }];
  });
  return consultationDetailBodyHtml({
    id: row.id,
    receiptId: row.receipt_id,
    status: row.status,
    locale: row.locale,
    category: row.category,
    preferredContact: preferredContactLabel(row.preferred_contact),
    marketingState,
    retentionExpiresAt: formatSeoulTime(row.retention_expires_at_ms),
    purged,
    emailChannelEnabled: channelEnabled("email"),
    hermesChannelEnabled: channelEnabled("hermes-telegram"),
    receivedAt: formatSeoulTime(row.received_at_ms),
    notifications,
    statusHistory,
    ...(pii
      ? { pii: { name: pii.name, phone: pii.phone, email: pii.email ?? "", company: pii.company ?? "", message: pii.message } }
      : {}),
    ...(nextStatuses.length === 0
      ? {}
      : { statusForm: { csrfToken, rowVersion: row.row_version, nextStatuses, terminalStatuses } }),
  });
}

function registerAdminRoutes(app: Hono<AdminEnvironment>, dependencies: Task4RouteDependencies): void {
  app.get("/admin/login", (context) => context.html(page("관리자 로그인", loginBodyHtml())));

  app.post("/admin/login", async (context) => {
    if (!strictOrigin(context, dependencies.adminOrigin)) {
      return context.html(forbiddenPage(), 403);
    }
    const form = await formValues(context);
    if (form instanceof Response) return form;
    if ((form.username?.length ?? 0) > 128 || (form.password?.length ?? 0) > 1_024) {
      return context.html(GENERIC_AUTH_FAILURE, 400);
    }
    const peer = dependencies.peerAddress(context);
    const source = resolveClientIp(peer, context.req.header("x-forwarded-for"));
    const result = await beginAdminLogin(dependencies, {
      username: form.username ?? "",
      password: form.password ?? "",
      source,
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") return context.html(GENERIC_AUTH_FAILURE, 401);
    context.header("Set-Cookie", result.cookie);
    return context.redirect(`${dependencies.adminOrigin}/admin/mfa`, 303);
  });

  app.get("/admin/mfa", (context) => {
    const parsed = parsePairCookie(context.req.header("cookie") ?? "", "__Host-wisdom-preauth");
    if (!parsed) return context.redirect(`${dependencies.adminOrigin}/admin/login`, 303);
    return context.html(page("2단계 인증", mfaBodyHtml(parsed.csrf)));
  });

  app.post("/admin/mfa", async (context) => {
    if (!strictOrigin(context, dependencies.adminOrigin)) {
      return context.html(forbiddenPage(), 403);
    }
    const parsed = parsePairCookie(context.req.header("cookie") ?? "", "__Host-wisdom-preauth");
    const form = await formValues(context);
    if (form instanceof Response) return form;
    if (!parsed || (form.method !== "totp" && form.method !== "recovery")) {
      return context.html(GENERIC_AUTH_FAILURE, 401);
    }
    if (
      (form.username?.length ?? 0) > 128 ||
      (form.code?.length ?? 0) > 128 ||
      (form.csrf?.length ?? 0) > 128
    ) return context.html(GENERIC_AUTH_FAILURE, 400);
    const peer = dependencies.peerAddress(context);
    const result = completeAdminMfa(dependencies, {
      username: form.username ?? "",
      source: resolveClientIp(peer, context.req.header("x-forwarded-for")),
      challengeToken: parsed.token,
      csrfToken: form.csrf ?? "",
      method: form.method,
      code: form.code ?? "",
      nowMs: dependencies.now(),
      requestId: context.get("requestId"),
    });
    if (result.kind === "invalid") return context.html(GENERIC_AUTH_FAILURE, 401);
    context.header("Set-Cookie", result.cookie);
    context.header("Set-Cookie", clearAdminPreAuthCookie(), { append: true });
    return context.redirect(`${dependencies.adminOrigin}/admin`, 303);
  });

  app.post("/admin/logout", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    revokeAdminSession(dependencies.db, dependencies.authSecret, auth.session.sessionToken, dependencies.now());
    context.header("Set-Cookie", clearAdminSessionCookie());
    return context.redirect(`${dependencies.adminOrigin}/admin/login`, 303);
  });

  app.get("/admin", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const counts = dependencies.db.sqlite.prepare(`
      SELECT status, count(*) count FROM consultations GROUP BY status ORDER BY status
    `).all() as Array<{ status: string; count: number }>;
    return context.html(page("대시보드", dashboardBodyHtml(counts, savedBanner(context)), "ko", auth.csrfToken));
  });

  app.get("/admin/analytics", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const analyticsDb = dependencies.analyticsDb;
    if (!analyticsDb) {
      return context.html(page(
        "방문 통계",
        "<h1>방문 통계</h1><p>통계 저장소가 구성되지 않았습니다.</p>",
        "ko",
        auth.csrfToken,
      ), 503);
    }
    const today = seoulDay(dependencies.now());
    const requestedFrom = context.req.query("from");
    const requestedTo = context.req.query("to");
    const rangePreset = context.req.query("range");
    let activePreset: "7d" | "30d" | "90d" | "custom";
    let from: string;
    let to: string;
    if (requestedFrom && requestedTo
      && isCalendarDay(requestedFrom) && isCalendarDay(requestedTo)
      && requestedFrom <= requestedTo) {
      activePreset = "custom";
      to = requestedTo <= today ? requestedTo : today;
      // Clamp unbounded custom ranges so one query cannot scan years of rows.
      from = daySpan(requestedFrom, to) > 400 ? shiftDay(to, -399) : requestedFrom;
    } else {
      activePreset = rangePreset === "90d" ? "90d" : rangePreset === "30d" ? "30d" : "7d";
      const days = activePreset === "90d" ? 90 : activePreset === "30d" ? 30 : 7;
      to = today;
      from = shiftDay(today, -(days - 1));
    }
    const requestedGranularity = context.req.query("g");
    const granularity: Granularity =
      requestedGranularity === "day" || requestedGranularity === "week" || requestedGranularity === "month"
        ? requestedGranularity
        : autoGranularity(daySpan(from, to));
    const metric = context.req.query("metric") === "visitors" ? "visitors" as const : "views" as const;
    return context.html(page("방문 통계", analyticsBodyHtml({
      from,
      to,
      granularity,
      metric,
      activePreset,
      totals: analyticsTotals(analyticsDb, from, to),
      buckets: bucketSeries(siteSeries(analyticsDb, from, to), granularity),
      topPages: topPages(analyticsDb, from, to),
      referrers: topReferrers(analyticsDb, from, to),
      locales: localeSplit(analyticsDb, from, to),
    }), "ko", auth.csrfToken));
  });

  app.get("/admin/articles", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT article.id, article.source_locale, head.locale, head.slug,
        head.state, head.row_version, revision.title, head.updated_at_ms
      FROM articles article
      JOIN article_locale_heads head ON head.article_id = article.id
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      ORDER BY head.updated_at_ms DESC, article.id, head.locale
      LIMIT 500
    `).all() as Array<{
      id: string;
      source_locale: Locale;
      locale: Locale;
      slug: string;
      state: ArticleState;
      row_version: number;
      title: string;
      updated_at_ms: number;
    }>;
    return context.html(page("글 관리", articlesBodyHtml(rows, formatSeoulTime, savedBanner(context)), "ko", auth.csrfToken));
  });

  app.get("/admin/articles/:id", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const article = dependencies.db.sqlite.prepare(`
      SELECT id, source_locale, created_at_ms, updated_at_ms
      FROM articles WHERE id = ?
    `).get(context.req.param("id")) as {
      id: string; source_locale: Locale; created_at_ms: number; updated_at_ms: number;
    } | undefined;
    if (!article) return context.html(page("글을 찾을 수 없음", "<h1>글을 찾을 수 없습니다</h1>"), 404);
    const heads = dependencies.db.sqlite.prepare(`
      SELECT head.locale, head.slug, head.state, head.row_version,
        head.head_revision_id, revision.title, revision.summary,
        revision.body_markdown, revision.sources_json,
        revision.created_at_ms, revision.created_by_type
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      WHERE head.article_id = ? ORDER BY head.locale
    `).all(article.id) as Array<{
      locale: Locale;
      slug: string;
      state: ArticleState;
      row_version: number;
      head_revision_id: string;
      title: string;
      summary: string;
      body_markdown: string;
      sources_json: string;
      created_at_ms: number;
      created_by_type: string;
    }>;
    const revisions = dependencies.db.sqlite.prepare(`
      SELECT id, locale, revision_no, title, created_at_ms, created_by_type
      FROM article_revisions WHERE article_id = ?
      ORDER BY locale, revision_no DESC
    `).all(article.id) as Array<{
      id: string; locale: Locale; revision_no: number; title: string;
      created_at_ms: number; created_by_type: string;
    }>;
    const actionsFor = (state: ArticleState): ArticleActionForm[] => {
      if (state === "draft") return [
        { action: "review", label: "검토 요청" },
        { action: "reject", label: "반려", confirm: "반려하면 이 언어본을 다시 되돌릴 수 없음을 확인합니다." },
      ];
      if (state === "in_review") return [
        { action: "return", label: "초안으로 되돌리기" },
        { action: "approve", label: "언어본 승인" },
        { action: "reject", label: "반려", confirm: "반려하면 이 언어본을 다시 되돌릴 수 없음을 확인합니다." },
      ];
      if (state === "approved") return [{ action: "review", label: "검토 재개" }];
      return [];
    };
    const headViews: ArticleHeadView[] = heads.map((head) => ({
      locale: head.locale,
      state: head.state,
      title: head.title,
      summary: head.summary,
      bodyMarkdown: head.body_markdown,
      sourcesJson: head.sources_json,
      rowVersion: head.row_version,
      ...(head.state === "draft" || head.state === "in_review" ? { slug: head.slug } : {}),
      actions: actionsFor(head.state),
    }));
    const targetLocales = (["ko", "en", "zh-Hans", "zh-Hant"] as const)
      .filter((locale) => locale !== article.source_locale);
    const sourceHead = heads.find(({ locale }) => locale === article.source_locale);
    const translate = sourceHead && ["approved", "published"].includes(sourceHead.state)
      ? { rowVersion: sourceHead.row_version, targetLocales }
      : undefined;
    const revisionViews: ArticleRevisionItem[] = revisions.map((revision, index) => {
      const previous = revisions.slice(index + 1).find(({ locale }) => locale === revision.locale);
      return {
        locale: revision.locale,
        revisionNo: revision.revision_no,
        title: revision.title,
        createdByType: revision.created_by_type,
        createdAt: formatSeoulTime(revision.created_at_ms),
        ...(previous
          ? {
            diff: {
              href: `/admin/articles/${encodeURIComponent(article.id)}/revisions/${encodeURIComponent(revision.id)}/diff?against=${encodeURIComponent(previous.id)}`,
              label: `#${previous.revision_no}과 비교`,
            },
          }
          : {}),
      };
    });
    return context.html(page("글 상세", articleDetailBodyHtml({
      articleId: article.id,
      heading: sourceHead?.title ?? article.id,
      sourceLocale: article.source_locale,
      banner: savedBanner(context),
      csrf: auth.csrfToken,
      ...(translate ? { translate } : {}),
      heads: headViews,
      revisions: revisionViews,
    }), "ko", auth.csrfToken));
  });

  app.get("/admin/articles/:id/revisions/:revisionId/diff", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const against = context.req.query("against") ?? "";
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, locale, title, summary, body_markdown
      FROM article_revisions
      WHERE article_id = ? AND id IN (?, ?)
      ORDER BY id
    `).all(context.req.param("id"), context.req.param("revisionId"), against) as Array<{
      id: string; locale: Locale; title: string; summary: string; body_markdown: string;
    }>;
    const current = rows.find(({ id }) => id === context.req.param("revisionId"));
    const previous = rows.find(({ id }) => id === against);
    if (!current || !previous || current.locale !== previous.locale) {
      return context.html(page("리비전 비교를 찾을 수 없음", "<h1>리비전 비교를 찾을 수 없습니다</h1>"), 404);
    }
    return context.html(page("리비전 비교", revisionDiffBodyHtml(
      `${previous.title}\n${previous.summary}\n\n${previous.body_markdown}`,
      `${current.title}\n${current.summary}\n\n${current.body_markdown}`,
    ), "ko", auth.csrfToken));
  });

  const articleStateActions: Readonly<Record<string, ArticleReviewState>> = {
    review: "in_review",
    return: "draft",
    approve: "approved",
    reject: "rejected",
  };
  app.post("/admin/articles/:id/locales/:locale/slug", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const locale = localeSchema.safeParse(context.req.param("locale"));
    const rowVersion = Number(auth.form.rowVersion);
    if (!locale.success || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
      return context.html(page("주소를 변경할 수 없음", "<h1>주소 입력이 올바르지 않습니다</h1><p class=\"muted\">소문자·숫자·하이픈만 사용할 수 있습니다.</p>"), 422);
    }
    const result = changeArticleLocaleSlug(dependencies.db, {
      articleId: context.req.param("id"),
      locale: locale.data,
      slug: auth.form.slug ?? "",
      expectedRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
    });
    if (result.kind === "updated" || result.kind === "unchanged") {
      return context.redirect(`${dependencies.adminOrigin}/admin/articles/${encodeURIComponent(context.req.param("id"))}?saved=1`, 303);
    }
    return context.html(actionErrorPage(
      "글 주소를 변경하지 못했습니다",
      result.kind,
      `/admin/articles/${encodeURIComponent(context.req.param("id"))}`,
      "글 상세로 돌아가기",
    ), result.httpStatus);
  });
  app.post("/admin/articles/:id/locales/:locale/:action", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const locale = localeSchema.safeParse(context.req.param("locale"));
    const targetState = articleStateActions[context.req.param("action")];
    const rowVersion = Number(auth.form.rowVersion);
    if (!locale.success || !targetState || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
      return context.html(page("잘못된 요청", "<h1>글 작업 요청이 올바르지 않습니다</h1>"), 422);
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
    if (result.kind === "updated" || result.kind === "unchanged") {
      return context.redirect(`${dependencies.adminOrigin}/admin/articles/${encodeURIComponent(context.req.param("id"))}?saved=1`, 303);
    }
    return context.html(actionErrorPage(
      "글 상태를 변경하지 못했습니다",
      result.kind,
      `/admin/articles/${encodeURIComponent(context.req.param("id"))}`,
      "글 상세로 돌아가기",
    ), result.httpStatus);
  });

  app.post("/admin/articles/:id/translations", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const targetLocale = localeSchema.safeParse(auth.form.targetLocale);
    const rowVersion = Number(auth.form.rowVersion);
    if (!targetLocale.success || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
      return context.html(page("잘못된 요청", "<h1>번역 요청이 올바르지 않습니다</h1>"), 422);
    }
    const result = enqueueArticleTranslation(dependencies.db, dependencies.keyProvider, {
      articleId: context.req.param("id"),
      targetLocale: targetLocale.data,
      expectedSourceRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
    });
    if (["queued", "requeued", "existing"].includes(result.kind)) {
      return context.redirect(`${dependencies.adminOrigin}/admin/articles/${encodeURIComponent(context.req.param("id"))}?saved=1`, 303);
    }
    return context.html(actionErrorPage(
      "번역을 요청하지 못했습니다",
      result.kind,
      `/admin/articles/${encodeURIComponent(context.req.param("id"))}`,
      "글 상세로 돌아가기",
    ), result.httpStatus);
  });

  app.get("/admin/publish/preview", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT head.article_id, head.locale, head.slug, head.state,
        head.head_revision_id, revision.title, revision.summary,
        CASE
          WHEN head.locale = article.source_locale THEN 1
          WHEN revision.source_revision_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM article_locale_heads source_head
            WHERE source_head.article_id = head.article_id
              AND source_head.locale = article.source_locale
              AND source_head.state IN ('approved','published')
              AND source_head.head_revision_id = revision.source_revision_id
              AND source_head.approved_revision_id = revision.source_revision_id
          ) THEN 1
          ELSE 0
        END AS source_binding_valid
      FROM article_locale_heads head
      JOIN article_revisions revision ON revision.id = head.head_revision_id
      JOIN articles article ON article.id = head.article_id
      ORDER BY head.article_id, head.locale
    `).all() as Array<{
      article_id: string;
      locale: Locale;
      slug: string;
      state: ArticleState;
      head_revision_id: string;
      title: string;
      summary: string;
      source_binding_valid: 0 | 1;
    }>;
    const eligible = rows.filter(({ state, source_binding_valid: sourceBindingValid }) => (
      (state === "approved" || state === "published") && sourceBindingValid === 1
    ));
    const blocked = rows.filter(({ state, source_binding_valid: sourceBindingValid }) => (
      (state !== "approved" && state !== "published") || sourceBindingValid !== 1
    ));
    const publishLabel = eligible.length === 0
      ? "검증 후 정책만 발행"
      : "검증 후 승인 글과 정책 발행";
    return context.html(page("발행 미리보기", publishPreviewBodyHtml(
      eligible.map((row) => ({ locale: row.locale, title: row.title, slug: row.slug, headRevisionId: row.head_revision_id })),
      blocked.map((row) => ({ locale: row.locale, title: row.title, state: row.state })),
      publishLabel,
      auth.csrfToken,
    ), "ko", auth.csrfToken));
  });

  app.post("/admin/publish", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    if (auth.form.confirmation !== "publish-approved") {
      return context.html(page("확인이 필요합니다", "<h1>확인이 필요합니다</h1><p>발행하려면 확인 체크박스를 선택해 주세요.</p>" + backLink("/admin/publish/preview", "발행 미리보기로 돌아가기")), 422);
    }
    if (!dependencies.articlePublication) {
      return context.html(page("발행을 사용할 수 없음", "<h1>발행이 구성되지 않았습니다</h1>"), 503);
    }
    try {
      await dependencies.articlePublication.publish({
        actorAdminId: auth.session.adminId,
        requestId: context.get("requestId"),
        nowMs: dependencies.now(),
      });
    } catch {
      return context.html(page(
        "발행 실패",
        '<h1>공개본은 변경되지 않았습니다</h1><p><code>PUBLICATION_FAILED</code></p><p>검증된 공개 릴리스 포인터는 그대로 유지됩니다. 릴리스 상태를 점검한 뒤 발행 미리보기에서 다시 시도해 주세요.</p><p><a href="/admin/publish/preview">발행 미리보기로 돌아가기</a> · <a href="/admin/releases">릴리스 보기</a></p>',
        "ko",
        auth.session.csrfToken,
      ), 503);
    }
    return context.redirect(`${dependencies.adminOrigin}/admin/releases?published=1`, 303);
  });

  app.get("/admin/releases", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, version, state, manifest_sha256, verified_at_ms,
        activated_at_ms, rolled_back_at_ms, created_at_ms
      FROM releases ORDER BY created_at_ms DESC, id DESC LIMIT 100
    `).all() as Array<{
      id: string;
      version: string;
      state: string;
      manifest_sha256: Buffer;
      verified_at_ms: number | null;
      activated_at_ms: number | null;
      rolled_back_at_ms: number | null;
      created_at_ms: number;
    }>;
    const releaseRows = rows.map((row) => ({
      id: row.id,
      version: row.version,
      state: row.state,
      createdAt: formatSeoulTime(row.created_at_ms),
      manifestHex: row.manifest_sha256.toString("hex"),
      retired: row.state === "retired",
    }));
    return context.html(
      page("발행 릴리스", releasesBodyHtml(releaseRows, auth.csrfToken, savedBanner(context)), "ko", auth.csrfToken),
    );
  });

  app.post("/admin/releases/:id/rollback", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    if (auth.form.confirmation !== "rollback-retained-release") {
      return context.html(page("확인이 필요합니다", "<h1>확인이 필요합니다</h1><p>롤백하려면 확인 체크박스를 선택해 주세요.</p>" + backLink("/admin/releases", "릴리스로 돌아가기")), 422);
    }
    if (!dependencies.articlePublication) {
      return context.html(page("롤백을 사용할 수 없음", "<h1>롤백이 구성되지 않았습니다</h1>"), 503);
    }
    try {
      await dependencies.articlePublication.rollback({
        releaseId: context.req.param("id"),
        actorAdminId: auth.session.adminId,
        requestId: context.get("requestId"),
        nowMs: dependencies.now(),
      });
    } catch {
      return context.html(page(
        "롤백 실패",
        '<h1>공개본은 변경되지 않았습니다</h1><p><code>ROLLBACK_FAILED</code></p><p>현재 검증된 공개 릴리스 포인터는 그대로 유지됩니다. 보존된 릴리스를 다시 확인한 뒤 시도해 주세요.</p><p><a href="/admin/releases">릴리스로 돌아가기</a></p>',
        "ko",
        auth.session.csrfToken,
      ), 503);
    }
    return context.redirect(`${dependencies.adminOrigin}/admin/releases?rolledback=1`, 303);
  });

  app.get("/admin/consultations", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const requested = Number(context.req.query("page") ?? "1");
    const pageNumber = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
    const statusFilter = consultationStatusSchema.safeParse(context.req.query("status")).success
      ? (context.req.query("status") as string)
      : "";

    // Fetch one extra row to detect whether a next page exists without a count query.
    const fetched = (statusFilter
      ? dependencies.db.sqlite.prepare(`
          SELECT id, receipt_id, status, locale, category, received_at_ms
          FROM consultations WHERE status = ? ORDER BY received_at_ms DESC, id LIMIT 21 OFFSET ?
        `).all(statusFilter, (pageNumber - 1) * 20)
      : dependencies.db.sqlite.prepare(`
          SELECT id, receipt_id, status, locale, category, received_at_ms
          FROM consultations ORDER BY received_at_ms DESC, id LIMIT 21 OFFSET ?
        `).all((pageNumber - 1) * 20)) as Array<Record<string, string | number>>;

    return context.html(page("상담 목록", consultationsBodyHtml({
      rows: fetched.slice(0, 20).map(mapConsultationRow),
      pageNumber,
      hasNext: fetched.length > 20,
      statusFilter,
      statuses: CONSULTATION_STATUSES,
      csrfToken: auth.csrfToken,
      banner: savedBanner(context),
    }), "ko", auth.csrfToken));
  });

  // Contact search is POST so the raw phone/email never lands in a GET URL,
  // browser history, or an upstream access log. A malformed value fails
  // normalization inside findConsultationIdsByContact (a ZodError); that is
  // reported as a format hint rather than surfacing as a 503.
  app.post("/admin/consultations/search", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const kind = auth.form.searchKind === "email" ? "email" : "phone";
    const value = String(auth.form.q ?? "").slice(0, 254).trim();

    let rows: ConsultationListRow[] = [];
    let capped = false;
    let invalid = false;
    if (value !== "") {
      let ids: string[] = [];
      try {
        ids = findConsultationIdsByContact(dependencies.db, dependencies.keyProvider, kind, value);
      } catch (error) {
        if (error instanceof Error && error.name === "ZodError") {
          invalid = true;
        } else {
          throw error;
        }
      }
      capped = ids.length > 50;
      rows = ids.slice(0, 50).flatMap((id) => {
        const row = dependencies.db.sqlite.prepare(`
          SELECT id, receipt_id, status, locale, category, received_at_ms FROM consultations WHERE id = ?
        `).get(id) as Record<string, string | number> | undefined;
        return row ? [mapConsultationRow(row)] : [];
      });
    }

    return context.html(page("상담 목록", consultationsBodyHtml({
      rows,
      pageNumber: 1,
      hasNext: false,
      statusFilter: "",
      statuses: CONSULTATION_STATUSES,
      csrfToken: auth.session.csrfToken,
      banner: "",
      search: { kind, value, capped, invalid },
    }), "ko", auth.session.csrfToken));
  });

  app.get("/admin/consultations/:id", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const body = consultationDetail(dependencies, context.req.param("id"), auth.csrfToken);
    return body === undefined
      ? context.html(page("찾을 수 없음", "<h1>상담을 찾을 수 없습니다</h1>"), 404)
      : context.html(page("상담 상세", body, "ko", auth.csrfToken));
  });

  app.post("/admin/consultations/:id/status", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const status = consultationStatusSchema.safeParse(auth.form.status);
    const rowVersion = Number(auth.form.rowVersion);
    if (!status.success || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
      return context.html(page("잘못된 요청", "<h1>상태 변경 요청이 올바르지 않습니다</h1>"), 422);
    }
    // Terminal transitions cannot be undone; require an explicit confirmation.
    if ((status.data === "closed" || status.data === "spam") && auth.form.confirmTerminal !== "yes") {
      return context.html(page(
        "확인이 필요합니다",
        "<h1>확인이 필요합니다</h1><p>종결·스팸으로 바꾸면 되돌릴 수 없습니다. 확인 체크박스를 선택해 주세요.</p>"
          + backLink(`/admin/consultations/${encodeURIComponent(context.req.param("id"))}`, "상담 상세로 돌아가기"),
      ), 422);
    }
    const channels: NotificationChannel[] = [];
    if (auth.form.email === "1") channels.push("email");
    if (auth.form.hermes === "1") channels.push("hermes-telegram");
    const result = changeConsultationStatus(dependencies.db, {
      consultationId: context.req.param("id"),
      targetStatus: status.data,
      expectedRowVersion: rowVersion,
      actorAdminId: auth.session.adminId,
      requestId: context.get("requestId"),
      nowMs: dependencies.now(),
      notificationChannels: channels,
    });
    if (result.kind === "updated" || result.kind === "unchanged") {
      return context.redirect(`${dependencies.adminOrigin}/admin/consultations/${encodeURIComponent(context.req.param("id"))}?saved=1`, 303);
    }
    return context.html(actionErrorPage(
      "상담 상태를 변경하지 못했습니다",
      result.kind,
      `/admin/consultations/${encodeURIComponent(context.req.param("id"))}`,
      "상담 상세로 돌아가기",
    ), result.httpStatus);
  });

  app.get("/admin/notifications", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT channel, enabled, provider, payload_mode, config_json, secret_ref, updated_at_ms
      FROM notification_settings ORDER BY channel
    `).all() as Array<Record<string, unknown>>;
    const emailRow = rows.find((row) => row.channel === "email");
    const smtp = smtpConfigurationFromStored(
      typeof emailRow?.config_json === "string" ? emailRow.config_json : undefined,
      typeof emailRow?.secret_ref === "string" ? emailRow.secret_ref : undefined,
    );
    const hermesRow = rows.find((row) => row.channel === "hermes-telegram");
    const emailPayloadMode = emailRow?.payload_mode === "full-inquiry" ? "full-inquiry" : "receipt-only";
    const channelLabel = (value: unknown): string =>
      value === "email" ? "이메일" : value === "hermes-telegram" ? "Hermes(텔레그램)" : String(value);
    const statusRows = rows.map((row) => ({
      channelLabel: channelLabel(row.channel),
      enabled: row.enabled === 1,
      payloadMode: row.payload_mode == null ? "-" : payloadModeLabel(String(row.payload_mode)),
      smtpConfigured: typeof row.secret_ref === "string" && row.secret_ref.length > 0,
    }));
    return context.html(page("알림 설정", notificationSettingsBodyHtml({
      banner: savedBanner(context),
      csrf: auth.csrfToken,
      statusRows,
      email: {
        enabled: emailRow?.enabled === 1,
        payloadMode: emailPayloadMode,
        host: smtp?.host ?? "",
        port: smtp?.port ?? 465,
        from: smtp?.from ?? "",
        to: smtp?.to ?? "",
        secretRef: smtp?.secretRef ?? "",
      },
      hermesEnabled: hermesRow?.enabled === 1,
    }), "ko", auth.csrfToken));
  });

  app.post("/admin/notifications", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    if (!['email', 'hermes-telegram'].includes(auth.form.channel ?? "")) {
      return context.html(page("잘못된 설정", "<h1>알림 설정 값이 올바르지 않습니다</h1>"), 422);
    }
    const channel = auth.form.channel as "email" | "hermes-telegram";
    if (
      channel === "email" &&
      auth.form.payloadMode !== undefined &&
      !["receipt-only", "full-inquiry"].includes(auth.form.payloadMode)
    ) {
      return context.html(page("잘못된 설정", "<h1>이메일 발송 방식이 올바르지 않습니다</h1>"), 422);
    }
    const payloadMode = channel === "email" ? auth.form.payloadMode ?? "receipt-only" : null;
    const existing = dependencies.db.sqlite.prepare(`
      SELECT config_json, secret_ref FROM notification_settings WHERE channel = 'email'
    `).get() as { config_json: string | null; secret_ref: string | null } | undefined;
    const submittedSmtp = channel === "email"
      ? smtpConfigurationFromForm(auth.form)
      : { kind: "absent" as const };
    if (submittedSmtp.kind === "invalid") {
      return context.html(page("잘못된 설정", "<h1>SMTP TLS 설정이 올바르지 않습니다</h1>"), 422);
    }
    const smtp = channel === "email"
      ? submittedSmtp.kind === "valid"
        ? submittedSmtp.value
        : smtpConfigurationFromStored(existing?.config_json, existing?.secret_ref)
      : undefined;
    const enabled = auth.form.enabled === "1";
    if (channel === "email" && enabled && smtp === undefined) {
      return context.html(page("잘못된 설정", "<h1>SMTP TLS 설정을 모두 입력해야 합니다</h1>"), 422);
    }
    if (payloadMode === "full-inquiry") {
      if (auth.form.fullInquiryApproved !== "yes" || smtp === undefined) {
        return context.html(page("승인 필요", "<h1>전체 문의 내용을 발송하려면 명시적 승인과 완전한 SMTP TLS 설정이 필요합니다</h1>"), 422);
      }
    }
    const configJson = channel === "email" && smtp !== undefined
      ? JSON.stringify({
        host: smtp.host,
        port: smtp.port,
        secure: true,
        from: smtp.from,
        to: smtp.to,
      })
      : channel === "email" ? existing?.config_json ?? "{}" : "{}";
    const secretRef = channel === "email" && smtp !== undefined
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
        enabled ? 1 : 0,
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
          enabled,
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
    return context.redirect(`${dependencies.adminOrigin}/admin/notifications?saved=1`, 303);
  });

  app.post("/admin/notifications/test", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const consultation = dependencies.db.sqlite.prepare(`
      SELECT id FROM consultations ORDER BY received_at_ms DESC LIMIT 1
    `).get() as { id: string } | undefined;
    if (!consultation) return context.html(page("테스트 발송 불가", "<h1>최근 상담이 없어 테스트 발송을 만들 수 없습니다</h1>"), 409);
    const channel = auth.form.channel === "hermes-telegram" ? "hermes-telegram" : "email";
    dependencies.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const deliveryId = randomUUID();
      dependencies.db.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, payload_json, state,
          attempt_count, available_at_ms, purpose, delivery_cycle,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'test', 1, ?, ?)
      `).run(
        deliveryId, consultation.id, channel, `notification.test.${randomUUID()}`,
        JSON.stringify({ test: true }),
        dependencies.now(), dependencies.now(), dependencies.now(),
      );
      dependencies.db.sqlite.prepare(`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, target_type, target_id,
          request_id, metadata_json, created_at_ms
        ) VALUES (?, 'admin', ?, 'notification.test.queued',
          'notification', ?, ?, ?, ?)
      `).run(
        randomUUID(), auth.session.adminId, deliveryId, context.get("requestId"),
        JSON.stringify({ channel }), dependencies.now(),
      );
      dependencies.db.sqlite.exec("COMMIT");
    } catch (error) {
      if (dependencies.db.sqlite.inTransaction) dependencies.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    return context.redirect(`${dependencies.adminOrigin}/admin/notifications?sent=1`, 303);
  });

  app.get("/admin/consents", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const bundle = getActiveConsentBundle(dependencies.db);
    return context.html(page("동의문 버전", consentsBodyHtml(bundle), "ko", auth.csrfToken));
  });

  app.get("/admin/failures", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    // Failed deliveries plus deliveries cancelled by an operator-fixable setup
    // problem (a disabled channel, a missing adapter). Lifecycle cancellations
    // (purge, withdrawal, retention) are expected and stay hidden.
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, channel, state, updated_at_ms, last_error_code
      FROM notification_outbox
      WHERE state = 'failed'
        OR (state = 'cancelled' AND last_error_code IN
          ('CHANNEL_DISABLED', 'ADAPTER_UNAVAILABLE', 'WITHDRAWAL_CONFIGURATION_MISSING'))
      ORDER BY updated_at_ms DESC LIMIT 200
    `).all() as Array<Record<string, unknown>>;
    const failures = rows.map((row) => ({
      id: String(row.id),
      channel: String(row.channel),
      state: String(row.state),
      at: formatSeoulTime(Number(row.updated_at_ms)),
      lastErrorCode: String(row.last_error_code),
      requeueable: row.state === "failed",
    }));
    return context.html(
      page("발송 실패", failuresBodyHtml(failures, auth.csrfToken, savedBanner(context)), "ko", auth.csrfToken),
    );
  });

  app.post("/admin/failures/:id/requeue", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const requeued = requeueFailedNotification(
      dependencies.db,
      context.req.param("id"),
      dependencies.now(),
      {
        actorAdminId: auth.session.adminId,
        requestId: context.get("requestId"),
      },
    );
    return requeued
      ? context.redirect(`${dependencies.adminOrigin}/admin/failures?saved=1`, 303)
      : context.html(page("재발송 불가", "<h1>실패 상태가 아닌 알림입니다</h1>"), 409);
  });

  app.get("/admin/health", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const ready = isDatabaseReady(dependencies.db) && getActiveConsentBundle(dependencies.db) !== undefined;
    const queue = dependencies.db.sqlite.prepare(`
      SELECT state, count(*) count FROM notification_outbox GROUP BY state ORDER BY state
    `).all() as Array<Record<string, unknown>>;
    return context.html(page("시스템 상태", healthBodyHtml(ready, queue), "ko", auth.csrfToken), ready ? 200 : 503);
  });
}

function localeRoute(path: string): string {
  return path;
}

type WithdrawalLocale = "ko" | "en" | "zh-Hans" | "zh-Hant";

const WITHDRAWAL_COPY = {
  ko: {
    title: "마케팅 수신 동의 철회",
    description: "선택적 마케팅 정보 수신을 중단할 수 있습니다.",
    button: "수신 동의 철회",
    invalidTitle: "유효하지 않은 철회 요청",
    invalid: "철회 요청이 유효하지 않거나 만료되었습니다.",
    successTitle: "동의 철회가 완료되었습니다",
    success: "선택적 마케팅 정보 수신 동의가 철회되었습니다.",
  },
  en: {
    title: "Withdraw marketing consent",
    description: "You can stop optional marketing communications.",
    button: "Withdraw consent",
    invalidTitle: "Invalid withdrawal request",
    invalid: "The withdrawal request is invalid or expired.",
    successTitle: "Marketing consent withdrawn",
    success: "Your optional marketing consent has been withdrawn.",
  },
  "zh-Hans": {
    title: "撤回营销信息接收同意",
    description: "您可以停止接收可选营销信息。",
    button: "撤回同意",
    invalidTitle: "无效的撤回请求",
    invalid: "撤回请求无效或已过期。",
    successTitle: "营销信息接收同意已撤回",
    success: "您对可选营销信息的接收同意已撤回。",
  },
  "zh-Hant": {
    title: "撤回行銷資訊接收同意",
    description: "您可以停止接收選擇性行銷資訊。",
    button: "撤回同意",
    invalidTitle: "無效的撤回請求",
    invalid: "撤回請求無效或已過期。",
    successTitle: "行銷資訊接收同意已撤回",
    success: "您對選擇性行銷資訊的接收同意已撤回。",
  },
} as const;

function withdrawalLocaleForRoute(route: string): WithdrawalLocale {
  if (route.startsWith("/en/")) return "en";
  if (route.startsWith("/zh-hans/")) return "zh-Hans";
  if (route.startsWith("/zh-hant/")) return "zh-Hant";
  return "ko";
}

function registerWithdrawalRoutes(app: Hono<AdminEnvironment>, dependencies: Task4RouteDependencies): void {
  const cleanRoutes = [
    "/marketing/withdraw/confirm",
    "/en/marketing/withdraw/confirm",
    "/zh-hans/marketing/withdraw/confirm",
    "/zh-hant/marketing/withdraw/confirm",
  ];
  for (const route of cleanRoutes) {
    app.get(localeRoute(route), (context) => {
      const landingToken = cookieValue(
        context.req.header("cookie") ?? "",
        "__Host-wisdom-marketing-withdraw",
      ) ?? "";
      const result = getMarketingWithdrawalConfirmation(dependencies.db, dependencies.withdrawalSecret, {
        landingToken,
        nowMs: dependencies.now(),
      });
      const locale = result.kind === "invalid" ? withdrawalLocaleForRoute(route) : result.locale;
      const copy = WITHDRAWAL_COPY[locale];
      if (result.kind === "invalid") {
        return context.html(renderPlainPage(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale), 410);
      }
      return context.html(renderPlainPage(
        copy.title,
        withdrawalConfirmBodyHtml(copy.title, copy.description, copy.button, route, result.confirmationValue),
        locale,
      ));
    });
    app.post(localeRoute(route), async (context) => {
      const locale = withdrawalLocaleForRoute(route);
      const copy = WITHDRAWAL_COPY[locale];
      if (!strictOrigin(context, dependencies.publicOrigin)) {
        return context.html(forbiddenPage(), 403);
      }
      const landingToken = cookieValue(
        context.req.header("cookie") ?? "",
        "__Host-wisdom-marketing-withdraw",
      ) ?? "";
      const form = await formValues(context);
      if (form instanceof Response) return form;
      const result = withdrawMarketingConsent(dependencies.db, dependencies.withdrawalSecret, {
        landingToken,
        confirmationValue: form.confirmation ?? "",
        nowMs: dependencies.now(),
        requestId: context.get("requestId"),
      });
      if (result.kind === "invalid") {
        return context.html(renderPlainPage(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale), 400);
      }
      context.header("Set-Cookie", "__Host-wisdom-marketing-withdraw=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return context.html(renderPlainPage(copy.successTitle, `<h1>${copy.successTitle}</h1><p>${copy.success}</p>`, locale));
    });
  }

  app.get("/marketing/withdraw/:token", (context) => {
    const result = openMarketingWithdrawalCapability(dependencies.db, dependencies.withdrawalSecret, {
      token: context.req.param("token"),
      publicOrigin: dependencies.publicOrigin,
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") return context.html(renderPlainPage("잘못된 링크", "<h1>철회 링크가 올바르지 않거나 만료되었습니다.</h1>"), 404);
    context.header("Set-Cookie", result.cookie);
    return context.redirect(result.location, 303);
  });
}

export function registerTask4Routes(
  app: Hono<AdminEnvironment>,
  dependencies: Task4RouteDependencies,
): void {
  registerAdminRoutes(app, dependencies);
  registerWithdrawalRoutes(app, dependencies);
}
