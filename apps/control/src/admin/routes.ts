import { createHash, randomUUID } from "node:crypto";

import {
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
import { escapeHtml } from "../security/html.js";
import {
  getMarketingWithdrawalConfirmation,
  openMarketingWithdrawalCapability,
  withdrawMarketingConsent,
} from "../withdrawal/service.js";

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

const ADMIN_STYLE = `:root{color-scheme:light}*{box-sizing:border-box}`
  + `body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Segoe UI",Roboto,sans-serif;`
  + `font-size:16px;line-height:1.6;color:#1f2937;background:#f5f5f4}`
  + `header{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;padding:.75rem 1.25rem;`
  + `background:#1f2937;color:#fff}`
  + `header>a{color:#fff;font-weight:700;text-decoration:none}`
  + `header nav{display:flex;flex-wrap:wrap;gap:.75rem}`
  + `header nav a{color:#e5e7eb;text-decoration:none;font-size:.9rem}`
  + `header nav a:hover{color:#fff;text-decoration:underline}`
  + `header form{margin-left:auto}`
  + `main{max-width:60rem;margin:0 auto;padding:1.5rem 1.25rem 4rem}`
  + `h1{font-size:1.5rem;margin:.2rem 0 1rem}h2{font-size:1.15rem;margin:1.5rem 0 .5rem}`
  + `a{color:#1d4ed8}`
  + `table{border-collapse:collapse;width:100%;margin:.5rem 0;background:#fff}`
  + `th,td{border:1px solid #d6d3d1;padding:.5rem .65rem;text-align:left;vertical-align:top}`
  + `th{background:#f3f4f6}`
  + `form{margin:1rem 0}fieldset{margin:1rem 0;border:1px solid #d6d3d1;border-radius:.4rem}`
  + `label{display:block;margin:.6rem 0 .2rem;font-weight:600}`
  + `input,select,textarea{font:inherit;padding:.45rem .55rem;border:1px solid #9ca3af;border-radius:.3rem;max-width:100%}`
  + `button{font:inherit;padding:.5rem .9rem;border:0;border-radius:.3rem;background:#1d4ed8;color:#fff;cursor:pointer}`
  + `button:hover{background:#1e40af}`
  + `pre{background:#fff;border:1px solid #d6d3d1;border-radius:.4rem;padding:.75rem;overflow-x:auto}`
  + `.banner{padding:.75rem 1rem;border-radius:.4rem;margin:0 0 1rem}`
  + `.banner-ok{background:#dcfce7;border:1px solid #86efac}`
  + `.banner-error{background:#fee2e2;border:1px solid #fca5a5}`
  + `.muted{color:#6b7280}`;

// CSP source-expression for the single inline <style> block, so the app-layer
// Content-Security-Policy permits its own styles without depending on the
// upstream (Caddy) header replacing it. Hashes the exact bytes the browser
// sees between the <style> tags.
export const ADMIN_STYLE_CSP_HASH = `'sha256-${createHash("sha256").update(ADMIN_STYLE).digest("base64")}'`;

const GENERIC_AUTH_FAILURE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>로그인 실패</title><style>${ADMIN_STYLE}</style></head><body><main><h1>로그인하지 못했습니다</h1><p>입력하신 정보를 확인할 수 없습니다. 아이디·비밀번호를 다시 확인하시고, 여러 번 실패한 경우 잠시 후 다시 시도해 주세요.</p><a href="/admin/login">로그인 화면으로 돌아가기</a></main></body></html>`;
const MAX_FORM_BYTES = 16 * 1_024;
const MAX_FORM_FIELDS = 32;
const MAX_FORM_FIELD_NAME = 128;
const MAX_FORM_FIELD_VALUE = 4_096;

const ADMIN_NAV = `<nav>`
  + `<a href="/admin/consultations">상담</a> `
  + `<a href="/admin/articles">글</a> `
  + `<a href="/admin/releases">릴리스</a> `
  + `<a href="/admin/notifications">알림</a> `
  + `<a href="/admin/consents">동의문</a> `
  + `<a href="/admin/failures">발송 실패</a> `
  + `<a href="/admin/health">상태</a>`
  + `</nav>`;

function page(title: string, body: string, lang = "ko", csrfToken?: string): string {
  const logout = csrfToken === undefined
    ? ""
    : `<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><button type="submit">로그아웃</button></form>`;
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${ADMIN_STYLE}</style></head><body><header><a href="/admin">지혜 관리자</a>${ADMIN_NAV}${logout}</header><main>${body}</main></body></html>`;
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
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
}

// Shown when Origin/CSRF checks fail or a session has expired mid-edit, so the
// operator understands why a save did not go through and how to recover.
function forbiddenPage(): string {
  return page(
    "요청을 처리할 수 없습니다",
    `<h1>요청을 처리할 수 없습니다</h1><p>페이지가 오래되었거나 로그인 세션이 만료되어 저장하지 못했습니다. `
      + `작성 중이던 내용이 있다면 복사해 두시고, 새로고침하거나 다시 로그인한 뒤 시도해 주세요.</p>`
      + backLink("/admin", "관리자 홈으로 돌아가기"),
  );
}

function actionErrorPage(title: string, kind: string, backHref: string, backLabel: string): string {
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(resultMessage(kind))}</p>${backLink(backHref, backLabel)}`,
  );
}

// Post/Redirect/Get success confirmation: a GET renders a banner when its
// redirect target carried a recognised query flag (e.g. ?saved=1).
const SAVED_BANNERS: Record<string, string> = {
  saved: "저장되었습니다.",
  published: "새 버전을 발행했습니다.",
  rolledback: "이전 발행본으로 롤백했습니다.",
  sent: `테스트 알림을 대기열에 넣었습니다. 발송 결과는 <a href="/admin/failures">발송 실패</a> 화면에서 확인하세요.`,
};

function savedBanner(context: Context<AdminEnvironment>): string {
  for (const [flag, message] of Object.entries(SAVED_BANNERS)) {
    if (context.req.query(flag) === "1") return `<p class="banner banner-ok">${message}</p>`;
  }
  return "";
}

function emptyState(message: string): string {
  return `<p class="muted">${escapeHtml(message)}</p>`;
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

function consultationDetail(
  dependencies: Task4RouteDependencies,
  id: string,
  csrfToken: string,
): string | undefined {
  const row = dependencies.db.sqlite.prepare(`
    SELECT id, receipt_id, status, locale, category, preferred_contact,
           pii_envelope, received_at_ms, row_version
    FROM consultations WHERE id = ?
  `).get(id) as {
    id: string;
    receipt_id: string;
    status: ConsultationStatus;
    locale: string;
    category: string;
    preferred_contact: string;
    pii_envelope: string | null;
    received_at_ms: number;
    row_version: number;
  } | undefined;
  if (!row) return undefined;
  const pii = row.pii_envelope === null
    ? undefined
    : decryptPii(dependencies.keyProvider, row.id, row.pii_envelope);
  const piiMarkup = pii
    ? `<dl><dt>이름</dt><dd>${escapeHtml(pii.name)}</dd><dt>전화</dt><dd>${escapeHtml(pii.phone)}</dd><dt>이메일</dt><dd>${escapeHtml(pii.email ?? "")}</dd><dt>회사</dt><dd>${escapeHtml(pii.company ?? "")}</dd><dt>문의 내용</dt><dd>${escapeHtml(pii.message)}</dd></dl>`
    : "<p class=\"muted\">개인정보는 보유기간이 지나 파기되었습니다.</p>";
  const nextStatuses = allowedNextConsultationStatuses(row.status);
  const statusForm = nextStatuses.length === 0
    ? "<p class=\"muted\">이 상담은 더 이상 상태를 변경할 수 없는 최종 단계입니다.</p>"
    : `<form method="post" action="/admin/consultations/${encodeURIComponent(row.id)}/status"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="rowVersion" value="${row.row_version}"><label for="consultation-status">다음 상태</label><select id="consultation-status" name="status" required><option value="" selected disabled>변경할 상태를 선택하세요</option>${nextStatuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(status)}</option>`).join("")}</select><label><input type="checkbox" name="email" value="1"> 고객에게 이메일 통지</label><label><input type="checkbox" name="hermes" value="1"> 담당자 Hermes 알림</label><button type="submit">상태 변경</button></form>`;
  return `<h1>상담 상세</h1><dl><dt>접수번호</dt><dd>${escapeHtml(row.receipt_id)}</dd><dt>상태</dt><dd>${escapeHtml(row.status)}</dd><dt>언어</dt><dd>${escapeHtml(row.locale)}</dd><dt>분야</dt><dd>${escapeHtml(row.category)}</dd><dt>접수 시각</dt><dd>${escapeHtml(formatSeoulTime(row.received_at_ms))}</dd></dl>${piiMarkup}${statusForm}`;
}

function registerAdminRoutes(app: Hono<AdminEnvironment>, dependencies: Task4RouteDependencies): void {
  app.get("/admin/login", (context) => context.html(page("관리자 로그인", `<h1>관리자 로그인</h1><form method="post" action="/admin/login"><label for="login-username">아이디</label><input id="login-username" name="username" autocomplete="username" autofocus required><label for="login-password">비밀번호</label><input id="login-password" type="password" name="password" autocomplete="current-password" required><button type="submit">다음</button></form>`)));

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
    return context.html(page("2단계 인증", `<h1>2단계 인증</h1><p class="muted">인증 앱의 6자리 코드 또는 백업용 복구 코드를 입력하세요.</p><form method="post" action="/admin/mfa"><label for="mfa-username">아이디</label><input id="mfa-username" name="username" autocomplete="username" required><label for="mfa-method">코드 종류</label><select id="mfa-method" name="method"><option value="totp">인증 앱 코드</option><option value="recovery">복구 코드</option></select><label for="mfa-code">코드</label><input id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required><input type="hidden" name="csrf" value="${escapeHtml(parsed.csrf)}"><button type="submit">로그인</button></form>`));
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
    const body = counts.length === 0
      ? emptyState("접수된 상담이 없습니다.")
      : `<ul>${counts.map((row) => `<li><a href="/admin/consultations">${escapeHtml(row.status)}: ${row.count}</a></li>`).join("")}</ul>`;
    return context.html(page("대시보드", `<h1>대시보드</h1>${savedBanner(context)}${body}`, "ko", auth.csrfToken));
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
    const body = rows.length === 0
      ? emptyState("등록된 글이 없습니다.")
      : `<ul>${rows.map((row) =>
        `<li><a href="/admin/articles/${encodeURIComponent(row.id)}">${escapeHtml(row.title)}</a> / ${escapeHtml(row.locale)} / ${escapeHtml(row.state)} / v${row.row_version} <span class="muted">${escapeHtml(formatSeoulTime(row.updated_at_ms))}</span></li>`
      ).join("")}</ul>`;
    return context.html(page("글 관리", `<h1>글 관리</h1>${savedBanner(context)}${body}`, "ko", auth.csrfToken));
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
    const actionForms = (head: typeof heads[number]): string => {
      const actions: Array<{ action: string; label: string; confirm?: string }> = [];
      if (head.state === "draft") actions.push(
        { action: "review", label: "검토 요청" },
        { action: "reject", label: "반려", confirm: "반려하면 이 언어본을 다시 되돌릴 수 없음을 확인합니다." },
      );
      if (head.state === "in_review") actions.push(
        { action: "return", label: "초안으로 되돌리기" },
        { action: "approve", label: "언어본 승인" },
        { action: "reject", label: "반려", confirm: "반려하면 이 언어본을 다시 되돌릴 수 없음을 확인합니다." },
      );
      if (head.state === "approved") actions.push({ action: "review", label: "검토 재개" });
      const slugForm = head.state === "draft" || head.state === "in_review"
        ? `<form method="post" action="/admin/articles/${encodeURIComponent(article.id)}/locales/${encodeURIComponent(head.locale)}/slug"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><input type="hidden" name="rowVersion" value="${head.row_version}"><label>공개 주소(slug)</label><input name="slug" value="${escapeHtml(head.slug)}" maxlength="96" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" title="소문자·숫자·하이픈만 사용하세요 (예: visa-guide)" required><button type="submit">주소 저장</button></form>`
        : "";
      return slugForm + actions.map(({ action, label, confirm }) => {
        const confirmField = confirm === undefined
          ? ""
          : `<label><input type="checkbox" required> ${escapeHtml(confirm)}</label>`;
        return `<form method="post" action="/admin/articles/${encodeURIComponent(article.id)}/locales/${encodeURIComponent(head.locale)}/${action}"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><input type="hidden" name="rowVersion" value="${head.row_version}">${confirmField}<button type="submit">${escapeHtml(label)}</button></form>`;
      }).join("");
    };
    const targetLocales = (["ko", "en", "zh-Hans", "zh-Hant"] as const)
      .filter((locale) => locale !== article.source_locale)
      .map((locale) => `<option value="${escapeHtml(locale)}">${escapeHtml(locale)}</option>`)
      .join("");
    const sourceHead = heads.find(({ locale }) => locale === article.source_locale);
    const translate = sourceHead && ["approved", "published"].includes(sourceHead.state)
      ? `<form method="post" action="/admin/articles/${encodeURIComponent(article.id)}/translations"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><input type="hidden" name="rowVersion" value="${sourceHead.row_version}"><label for="translate-target">번역 언어</label><select id="translate-target" name="targetLocale">${targetLocales}</select><button type="submit">번역 요청</button></form>`
      : "";
    const revisionItems = revisions.map((revision, index) => {
      const previous = revisions.slice(index + 1).find(({ locale }) => locale === revision.locale);
      const diff = previous
        ? ` <a href="/admin/articles/${encodeURIComponent(article.id)}/revisions/${encodeURIComponent(revision.id)}/diff?against=${encodeURIComponent(previous.id)}">#${previous.revision_no}과 비교</a>`
        : "";
      return `<li>${escapeHtml(revision.locale)} #${revision.revision_no} ${escapeHtml(revision.title)} (${escapeHtml(revision.created_by_type)}) <span class="muted">${escapeHtml(formatSeoulTime(revision.created_at_ms))}</span>${diff}</li>`;
    }).join("");
    return context.html(page("글 상세", `<h1>${escapeHtml(sourceHead?.title ?? article.id)}</h1>${savedBanner(context)}<p>원문 언어: ${escapeHtml(article.source_locale)}</p>${translate}<h2>언어본</h2>${heads.map((head) => `<section><h3>${escapeHtml(head.locale)} / ${escapeHtml(head.state)}</h3><p>${escapeHtml(head.title)}</p><p>${escapeHtml(head.summary)}</p><h4>본문 (Markdown)</h4><pre>${escapeHtml(head.body_markdown)}</pre><h4>출처</h4><pre>${escapeHtml(head.sources_json)}</pre>${actionForms(head)}</section>`).join("")}<h2>리비전 이력</h2><ul>${revisionItems}</ul>`, "ko", auth.csrfToken));
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
    return context.html(page("리비전 비교", `<h1>리비전 비교</h1><h2>이전</h2><pre>${escapeHtml(`${previous.title}\n${previous.summary}\n\n${previous.body_markdown}`)}</pre><h2>현재</h2><pre>${escapeHtml(`${current.title}\n${current.summary}\n\n${current.body_markdown}`)}</pre>`, "ko", auth.csrfToken));
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
    const eligibleList = eligible.length === 0
      ? emptyState("발행 대상 승인 글이 없습니다. 정책만 발행됩니다.")
      : `<ul>${eligible.map((row) => `<li>${escapeHtml(row.locale)} / ${escapeHtml(row.title)} / ${escapeHtml(row.slug)} / ${escapeHtml(row.head_revision_id)}</li>`).join("")}</ul>`;
    const blockedList = blocked.length === 0
      ? emptyState("제외된 글이 없습니다.")
      : `<ul>${blocked.map((row) => `<li>${escapeHtml(row.locale)} / ${escapeHtml(row.title)} / ${escapeHtml(row.state)}</li>`).join("")}</ul>`;
    return context.html(page("발행 미리보기", `<h1>발행 미리보기</h1><p>모든 릴리스에는 현재 활성 개인정보·마케팅 동의문 묶음이 함께 봉인됩니다. 발행 대상 글이 없으면 정책만 발행할 수 있습니다.</p><h2>발행 대상</h2>${eligibleList}<h2>제외 대상</h2>${blockedList}<form method="post" action="/admin/publish"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><label><input type="checkbox" name="confirmation" value="publish-approved" required> 공개 사이트를 새 버전으로 교체하는 것을 확인합니다.</label><button type="submit">${publishLabel}</button></form>`, "ko", auth.csrfToken));
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
    const releaseList = rows.length === 0
      ? emptyState("발행된 릴리스가 없습니다.")
      : `<ul>${rows.map((row) => `<li>${escapeHtml(row.version)} / ${escapeHtml(row.state)} <span class="muted">${escapeHtml(formatSeoulTime(row.created_at_ms))}</span> <code>${escapeHtml(row.manifest_sha256.toString("hex"))}</code>${row.state === "retired" ? `<form method="post" action="/admin/releases/${encodeURIComponent(row.id)}/rollback"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><label><input type="checkbox" name="confirmation" value="rollback-retained-release" required> 이 릴리스로 롤백하며, 검토 중(in_review)인 글이 이전 발행본으로 덮어써질 수 있음을 확인합니다.</label><button type="submit">검증 후 롤백</button></form>` : ""}</li>`).join("")}</ul>`;
    return context.html(page("발행 릴리스", `<h1>발행 릴리스</h1>${savedBanner(context)}<p><a href="/admin/publish/preview">승인 글 미리보기</a></p>${releaseList}`, "ko", auth.csrfToken));
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
    // Fetch one extra row to detect whether a next page exists without a count query.
    const fetched = dependencies.db.sqlite.prepare(`
      SELECT id, receipt_id, status, locale, category, received_at_ms
      FROM consultations ORDER BY received_at_ms DESC, id LIMIT 21 OFFSET ?
    `).all((pageNumber - 1) * 20) as Array<Record<string, string | number>>;
    const hasNext = fetched.length > 20;
    const rows = fetched.slice(0, 20);
    const table = rows.length === 0
      ? emptyState("표시할 상담이 없습니다.")
      : `<table><thead><tr><th>접수번호</th><th>상태</th><th>언어</th><th>분야</th><th>접수 시각</th></tr></thead><tbody>${rows.map((row) => `<tr><td><a href="/admin/consultations/${encodeURIComponent(String(row.id))}">${escapeHtml(String(row.receipt_id))}</a></td><td>${escapeHtml(String(row.status))}</td><td>${escapeHtml(String(row.locale))}</td><td>${escapeHtml(String(row.category))}</td><td>${escapeHtml(formatSeoulTime(Number(row.received_at_ms)))}</td></tr>`).join("")}</tbody></table>`;
    const pager = `<p>${pageNumber > 1 ? `<a href="/admin/consultations?page=${pageNumber - 1}">« 이전</a>` : ""}${pageNumber > 1 && hasNext ? " · " : ""}${hasNext ? `<a href="/admin/consultations?page=${pageNumber + 1}">다음 »</a>` : ""}</p>`;
    return context.html(page("상담 목록", `<h1>상담 목록</h1>${savedBanner(context)}${table}${pager}`, "ko", auth.csrfToken));
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
    const emailEnabled = emailRow?.enabled === 1 ? " checked" : "";
    const hermesRow = rows.find((row) => row.channel === "hermes-telegram");
    const hermesEnabled = hermesRow?.enabled === 1 ? " checked" : "";
    const emailPayloadMode = emailRow?.payload_mode === "full-inquiry" ? "full-inquiry" : "receipt-only";
    const channelLabel = (value: unknown): string =>
      value === "email" ? "이메일" : value === "hermes-telegram" ? "Hermes(텔레그램)" : String(value);
    const statusTable = `<table><thead><tr><th>채널</th><th>사용 여부</th><th>발송 방식</th><th>SMTP 구성</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(channelLabel(row.channel))}</td><td>${row.enabled === 1 ? "사용" : "사용 안 함"}</td><td>${escapeHtml(String(row.payload_mode ?? "-"))}</td><td>${typeof row.secret_ref === "string" && row.secret_ref.length > 0 ? "구성됨" : "-"}</td></tr>`).join("")}</tbody></table>`;
    const emailForm = `<h2>이메일 알림</h2><form method="post" action="/admin/notifications"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><input type="hidden" name="channel" value="email"><label><input type="checkbox" name="enabled" value="1"${emailEnabled}> 이메일 알림 사용</label><label for="email-payload">발송 방식</label><select id="email-payload" name="payloadMode"><option value="receipt-only"${emailPayloadMode === "receipt-only" ? " selected" : ""}>접수 확인만</option><option value="full-inquiry"${emailPayloadMode === "full-inquiry" ? " selected" : ""}>전체 문의 내용</option></select><fieldset><legend>SMTP TLS 설정</legend><label>보내는 서버(Host)</label><input name="smtpHost" value="${escapeHtml(smtp?.host ?? "")}" maxlength="253"><label>포트</label><input name="smtpPort" inputmode="numeric" value="${escapeHtml(smtp?.port ?? 465)}" readonly><label>보내는 주소(From)</label><input name="smtpFrom" type="email" value="${escapeHtml(smtp?.from ?? "")}" maxlength="254"><label>받는 주소(운영자)</label><input name="smtpTo" type="email" value="${escapeHtml(smtp?.to ?? "")}" maxlength="254"><label>TLS 방식</label><select name="smtpTlsMode"><option value="implicit-tls">Implicit TLS</option></select><label>키체인 참조</label><input name="smtpSecretRef" value="${escapeHtml(smtp?.secretRef ?? "")}" placeholder="keychain:wisdom-smtp" maxlength="137"><small class="muted">비밀번호를 직접 입력하지 않습니다. macOS 키체인에 저장한 항목 이름(예: keychain:wisdom-smtp)만 참조합니다.</small></fieldset><label><input type="checkbox" name="fullInquiryApproved" value="yes"> 전체 문의 내용 발송 승인</label><button type="submit">이메일 설정 저장</button></form>`;
    const hermesForm = `<h2>Hermes(텔레그램) 알림</h2><form method="post" action="/admin/notifications"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><input type="hidden" name="channel" value="hermes-telegram"><label><input type="checkbox" name="enabled" value="1"${hermesEnabled}> Hermes 알림 사용</label><button type="submit">Hermes 설정 저장</button></form>`;
    const testForm = `<h2>테스트 발송</h2><form method="post" action="/admin/notifications/test"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><label for="test-channel">채널</label><select id="test-channel" name="channel"><option value="email">이메일</option><option value="hermes-telegram">Hermes(텔레그램)</option></select><button type="submit">테스트 알림 보내기</button></form>`;
    return context.html(page("알림 설정", `<h1>알림 설정</h1>${savedBanner(context)}<h2>현재 설정</h2>${statusTable}${emailForm}${hermesForm}${testForm}`, "ko", auth.csrfToken));
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
    return context.html(page("동의문 버전", `<h1>동의문 버전</h1>${bundle ? `<p>활성 묶음: ${escapeHtml(bundle.bundleId)}</p><ul>${bundle.documents.map((document) => `<li>${escapeHtml(document.kind)} / ${escapeHtml(document.locale)} / ${escapeHtml(document.version)}</li>`).join("")}</ul>` : emptyState("완전한 활성 동의문 묶음이 없습니다.")}`, "ko", auth.csrfToken));
  });

  app.get("/admin/failures", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, channel, event_type, attempt_count, last_error_code
      FROM notification_outbox WHERE state = 'failed' ORDER BY updated_at_ms DESC
    `).all() as Array<Record<string, unknown>>;
    const failureList = rows.length === 0
      ? emptyState("실패한 발송이 없습니다.")
      : `<ul>${rows.map((row) => `<li>${escapeHtml(row.id)} / ${escapeHtml(row.channel)} / ${escapeHtml(row.last_error_code)}<form method="post" action="/admin/failures/${encodeURIComponent(String(row.id))}/requeue"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><button type="submit">재발송</button></form></li>`).join("")}</ul>`;
    return context.html(page("발송 실패", `<h1>발송 실패</h1>${savedBanner(context)}${failureList}`, "ko", auth.csrfToken));
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
    return context.html(page("시스템 상태", `<h1>시스템 상태</h1><p>${ready ? "데이터베이스와 동의문이 정상입니다." : "점검이 필요합니다."}</p><p>Database: ${ready ? "ready" : "not ready"}</p><h2>발송 대기열</h2><pre>${escapeHtml(JSON.stringify(queue, null, 2))}</pre>`, "ko", auth.csrfToken), ready ? 200 : 503);
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
        return context.html(page(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale), 410);
      }
      return context.html(page(copy.title, `<h1>${copy.title}</h1><p>${copy.description}</p><form method="post" action="${escapeHtml(route)}"><input type="hidden" name="confirmation" value="${escapeHtml(result.confirmationValue)}"><button type="submit">${copy.button}</button></form>`, locale));
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
        return context.html(page(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale), 400);
      }
      context.header("Set-Cookie", "__Host-wisdom-marketing-withdraw=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return context.html(page(copy.successTitle, `<h1>${copy.successTitle}</h1><p>${copy.success}</p>`, locale));
    });
  }

  app.get("/marketing/withdraw/:token", (context) => {
    const result = openMarketingWithdrawalCapability(dependencies.db, dependencies.withdrawalSecret, {
      token: context.req.param("token"),
      publicOrigin: dependencies.publicOrigin,
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") return context.html(page("잘못된 링크", "<h1>철회 링크가 올바르지 않거나 만료되었습니다.</h1>"), 404);
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
