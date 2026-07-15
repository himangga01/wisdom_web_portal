import { randomUUID } from "node:crypto";

import {
  consultationStatusSchema,
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
import { changeConsultationStatus } from "../consultations/workflow.js";
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
}

const GENERIC_AUTH_FAILURE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><main><h1>Sign-in failed</h1><p>The credentials could not be verified.</p><a href="/admin/login">Try again</a></main></body></html>`;
const MAX_FORM_BYTES = 16 * 1_024;
const MAX_FORM_FIELDS = 32;
const MAX_FORM_FIELD_NAME = 128;
const MAX_FORM_FIELD_VALUE = 4_096;

function page(title: string, body: string, lang = "en", csrfToken?: string): string {
  const logout = csrfToken === undefined
    ? ""
    : `<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><button type="submit">Sign out</button></form>`;
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><header><a href="/admin">JIHYE Admin</a><nav><a href="/admin/consultations">Consultations</a> <a href="/admin/notifications">Notifications</a> <a href="/admin/consents">Consents</a> <a href="/admin/failures">Failures</a> <a href="/admin/health">Health</a></nav>${logout}</header><main>${body}</main></body></html>`;
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
    return context.html(page("Unsupported request", "<h1>Unsupported request</h1>"), 415);
  }
  const contentLength = context.req.header("content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_FORM_BYTES)
  ) {
    return context.html(page("Request too large", "<h1>Request too large</h1>"), 413);
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
        return context.html(page("Request too large", "<h1>Request too large</h1>"), 413);
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
    return context.html(page("Invalid request", "<h1>Invalid request</h1>"), 400);
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
      return context.html(page("Invalid request", "<h1>Invalid request</h1>"), 400);
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
    return context.html(page("Forbidden", "<h1>Forbidden</h1>"), 403);
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
    return context.html(page("Forbidden", "<h1>Forbidden</h1>"), 403);
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
    status: string;
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
    ? `<dl><dt>Name</dt><dd>${escapeHtml(pii.name)}</dd><dt>Phone</dt><dd>${escapeHtml(pii.phone)}</dd><dt>Email</dt><dd>${escapeHtml(pii.email ?? "")}</dd><dt>Company</dt><dd>${escapeHtml(pii.company ?? "")}</dd><dt>Message</dt><dd>${escapeHtml(pii.message)}</dd></dl>`
    : "<p>Personal data has been purged.</p>";
  return `<h1>Consultation detail</h1><dl><dt>Receipt</dt><dd>${escapeHtml(row.receipt_id)}</dd><dt>Status</dt><dd>${escapeHtml(row.status)}</dd><dt>Locale</dt><dd>${escapeHtml(row.locale)}</dd><dt>Category</dt><dd>${escapeHtml(row.category)}</dd><dt>Received</dt><dd>${escapeHtml(new Date(row.received_at_ms).toISOString())}</dd></dl>${piiMarkup}<form method="post" action="/admin/consultations/${encodeURIComponent(row.id)}/status"><input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="rowVersion" value="${row.row_version}"><select name="status"><option>received</option><option>acknowledged</option><option>in_progress</option><option>closed</option><option>spam</option></select><label><input type="checkbox" name="email" value="1"> Email notification</label><label><input type="checkbox" name="hermes" value="1"> Hermes notification</label><button type="submit">Update status</button></form>`;
}

function registerAdminRoutes(app: Hono<AdminEnvironment>, dependencies: Task4RouteDependencies): void {
  app.get("/admin/login", (context) => context.html(page("Administrator sign in", `<h1>Administrator sign in</h1><form method="post" action="/admin/login"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Continue</button></form>`)));

  app.post("/admin/login", async (context) => {
    if (!strictOrigin(context, dependencies.adminOrigin)) {
      return context.html(page("Forbidden", "<h1>Forbidden</h1>"), 403);
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
    return context.html(page("Multi-factor authentication", `<h1>Multi-factor authentication</h1><form method="post" action="/admin/mfa"><label>Username <input name="username" autocomplete="username" required></label><label>Method <select name="method"><option value="totp">Authenticator code</option><option value="recovery">Recovery code</option></select></label><label>Code <input name="code" autocomplete="one-time-code" required></label><input type="hidden" name="csrf" value="${escapeHtml(parsed.csrf)}"><button type="submit">Sign in</button></form>`));
  });

  app.post("/admin/mfa", async (context) => {
    if (!strictOrigin(context, dependencies.adminOrigin)) {
      return context.html(page("Forbidden", "<h1>Forbidden</h1>"), 403);
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
    return context.html(page("Dashboard", `<h1>Dashboard</h1><ul>${counts.map((row) => `<li>${escapeHtml(row.status)}: ${row.count}</li>`).join("")}</ul>`, "en", auth.csrfToken));
  });

  app.get("/admin/consultations", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const requested = Number(context.req.query("page") ?? "1");
    const pageNumber = Number.isSafeInteger(requested) && requested > 0 ? requested : 1;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, receipt_id, status, locale, category, received_at_ms
      FROM consultations ORDER BY received_at_ms DESC, id LIMIT 20 OFFSET ?
    `).all((pageNumber - 1) * 20) as Array<Record<string, string | number>>;
    return context.html(page("Consultations", `<h1>Consultations</h1><table><thead><tr><th>Receipt</th><th>Status</th><th>Locale</th><th>Category</th></tr></thead><tbody>${rows.map((row) => `<tr><td><a href="/admin/consultations/${encodeURIComponent(String(row.id))}">${escapeHtml(row.receipt_id)}</a></td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.locale)}</td><td>${escapeHtml(row.category)}</td></tr>`).join("")}</tbody></table>`, "en", auth.csrfToken));
  });

  app.get("/admin/consultations/:id", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const body = consultationDetail(dependencies, context.req.param("id"), auth.csrfToken);
    return body === undefined
      ? context.html(page("Not found", "<h1>Not found</h1>"), 404)
      : context.html(page("Consultation detail", body, "en", auth.csrfToken));
  });

  app.post("/admin/consultations/:id/status", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const status = consultationStatusSchema.safeParse(auth.form.status);
    const rowVersion = Number(auth.form.rowVersion);
    if (!status.success || !Number.isSafeInteger(rowVersion) || rowVersion < 1) {
      return context.html(page("Invalid status update", "<h1>Invalid status update</h1>"), 422);
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
      return context.redirect(`${dependencies.adminOrigin}/admin/consultations/${encodeURIComponent(context.req.param("id"))}`, 303);
    }
    return context.html(
      page(result.kind === "conflict" ? "Conflict" : "Status not changed", `<h1>${result.kind === "conflict" ? "Conflict" : "Status not changed"}</h1>`),
      result.httpStatus,
    );
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
    const publicRows = rows.map(({ config_json: _config, secret_ref: secret, ...row }) => ({
      ...row,
      smtpConfigured: typeof secret === "string" && secret.length > 0,
    }));
    const emailEnabled = emailRow?.enabled === 1 ? " checked" : "";
    const emailPayloadMode = emailRow?.payload_mode === "full-inquiry" ? "full-inquiry" : "receipt-only";
    return context.html(page("Notification settings", `<h1>Notification settings</h1><pre>${escapeHtml(JSON.stringify(publicRows, null, 2))}</pre><form method="post" action="/admin/notifications"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><select name="channel"><option value="email">Email</option><option value="hermes-telegram">Hermes Telegram</option></select><label><input type="checkbox" name="enabled" value="1"${emailEnabled}> Enabled</label><select name="payloadMode"><option value="receipt-only"${emailPayloadMode === "receipt-only" ? " selected" : ""}>Receipt only</option><option value="full-inquiry"${emailPayloadMode === "full-inquiry" ? " selected" : ""}>Full inquiry</option></select><fieldset><legend>SMTP TLS configuration</legend><label>Host <input name="smtpHost" value="${escapeHtml(smtp?.host ?? "")}" maxlength="253"></label><label>Port <input name="smtpPort" inputmode="numeric" value="${escapeHtml(smtp?.port ?? 465)}" readonly></label><label>From <input name="smtpFrom" type="email" value="${escapeHtml(smtp?.from ?? "")}" maxlength="254"></label><label>Owner recipient <input name="smtpTo" type="email" value="${escapeHtml(smtp?.to ?? "")}" maxlength="254"></label><label>TLS mode <select name="smtpTlsMode"><option value="implicit-tls">Implicit TLS</option></select></label><label>Keychain reference <input name="smtpSecretRef" value="${escapeHtml(smtp?.secretRef ?? "")}" placeholder="keychain:wisdom-smtp" maxlength="137"></label></fieldset><label><input type="checkbox" name="fullInquiryApproved" value="yes"> Approve full inquiry</label><button type="submit">Save</button></form><form method="post" action="/admin/notifications/test"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><select name="channel"><option value="email">Email</option><option value="hermes-telegram">Hermes Telegram</option></select><button type="submit">Queue test notification</button></form>`, "en", auth.csrfToken));
  });

  app.post("/admin/notifications", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    if (!['email', 'hermes-telegram'].includes(auth.form.channel ?? "")) {
      return context.html(page("Invalid settings", "<h1>Invalid settings</h1>"), 422);
    }
    const channel = auth.form.channel as "email" | "hermes-telegram";
    if (
      channel === "email" &&
      auth.form.payloadMode !== undefined &&
      !["receipt-only", "full-inquiry"].includes(auth.form.payloadMode)
    ) {
      return context.html(page("Invalid settings", "<h1>Invalid email payload mode</h1>"), 422);
    }
    const payloadMode = channel === "email" ? auth.form.payloadMode ?? "receipt-only" : null;
    const existing = dependencies.db.sqlite.prepare(`
      SELECT config_json, secret_ref FROM notification_settings WHERE channel = 'email'
    `).get() as { config_json: string | null; secret_ref: string | null } | undefined;
    const submittedSmtp = channel === "email"
      ? smtpConfigurationFromForm(auth.form)
      : { kind: "absent" as const };
    if (submittedSmtp.kind === "invalid") {
      return context.html(page("Invalid settings", "<h1>Invalid SMTP TLS configuration</h1>"), 422);
    }
    const smtp = channel === "email"
      ? submittedSmtp.kind === "valid"
        ? submittedSmtp.value
        : smtpConfigurationFromStored(existing?.config_json, existing?.secret_ref)
      : undefined;
    const enabled = auth.form.enabled === "1";
    if (channel === "email" && enabled && smtp === undefined) {
      return context.html(page("Invalid settings", "<h1>Complete SMTP TLS configuration is required.</h1>"), 422);
    }
    if (payloadMode === "full-inquiry") {
      if (auth.form.fullInquiryApproved !== "yes" || smtp === undefined) {
        return context.html(page("Explicit approval required", "<h1>Explicit approval and complete TLS SMTP configuration are required.</h1>"), 422);
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
    return context.redirect(`${dependencies.adminOrigin}/admin/notifications`, 303);
  });

  app.post("/admin/notifications/test", async (context) => {
    const auth = await protectedPost(context, dependencies);
    if (auth instanceof Response) return auth;
    const consultation = dependencies.db.sqlite.prepare(`
      SELECT id FROM consultations ORDER BY received_at_ms DESC LIMIT 1
    `).get() as { id: string } | undefined;
    if (!consultation) return context.html(page("No consultation", "<h1>No consultation available</h1>"), 409);
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
    return context.redirect(`${dependencies.adminOrigin}/admin/notifications`, 303);
  });

  app.get("/admin/consents", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const bundle = getActiveConsentBundle(dependencies.db);
    return context.html(page("Consent versions", `<h1>Consent versions</h1>${bundle ? `<p>Active bundle: ${escapeHtml(bundle.bundleId)}</p><ul>${bundle.documents.map((document) => `<li>${escapeHtml(document.kind)} / ${escapeHtml(document.locale)} / ${escapeHtml(document.version)}</li>`).join("")}</ul>` : "<p>No complete active bundle.</p>"}`, "en", auth.csrfToken));
  });

  app.get("/admin/failures", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const rows = dependencies.db.sqlite.prepare(`
      SELECT id, channel, event_type, attempt_count, last_error_code
      FROM notification_outbox WHERE state = 'failed' ORDER BY updated_at_ms DESC
    `).all() as Array<Record<string, unknown>>;
    return context.html(page("Notification failures", `<h1>Notification failures</h1><ul>${rows.map((row) => `<li>${escapeHtml(row.id)} / ${escapeHtml(row.channel)} / ${escapeHtml(row.last_error_code)}<form method="post" action="/admin/failures/${encodeURIComponent(String(row.id))}/requeue"><input type="hidden" name="csrf" value="${escapeHtml(auth.csrfToken)}"><button type="submit">Requeue</button></form></li>`).join("")}</ul>`, "en", auth.csrfToken));
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
      ? context.redirect(`${dependencies.adminOrigin}/admin/failures`, 303)
      : context.html(page("Not requeued", "<h1>Notification was not failed.</h1>"), 409);
  });

  app.get("/admin/health", (context) => {
    const auth = protectedSession(context, dependencies);
    if (auth instanceof Response) return auth;
    const ready = isDatabaseReady(dependencies.db) && getActiveConsentBundle(dependencies.db) !== undefined;
    const queue = dependencies.db.sqlite.prepare(`
      SELECT state, count(*) count FROM notification_outbox GROUP BY state ORDER BY state
    `).all() as Array<Record<string, unknown>>;
    return context.html(page("Health", `<h1>Health</h1><p>Database: ${ready ? "ready" : "not ready"}</p><pre>${escapeHtml(JSON.stringify(queue, null, 2))}</pre>`, "en", auth.csrfToken), ready ? 200 : 503);
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
  app.get("/marketing/withdraw/:token", (context) => {
    const result = openMarketingWithdrawalCapability(dependencies.db, dependencies.withdrawalSecret, {
      token: context.req.param("token"),
      publicOrigin: dependencies.publicOrigin,
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") return context.html(page("Invalid link", "<h1>This withdrawal link is invalid or expired.</h1>"), 404);
    context.header("Set-Cookie", result.cookie);
    return context.redirect(result.location, 303);
  });

  const cleanRoutes = [
    "/marketing/withdraw",
    "/en/marketing/withdraw",
    "/zh-hans/marketing/withdraw",
    "/zh-hant/marketing/withdraw",
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
        return context.html(page("Forbidden", "<h1>Forbidden</h1>"), 403);
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
}

export function registerTask4Routes(
  app: Hono<AdminEnvironment>,
  dependencies: Task4RouteDependencies,
): void {
  registerAdminRoutes(app, dependencies);
  registerWithdrawalRoutes(app, dependencies);
}
