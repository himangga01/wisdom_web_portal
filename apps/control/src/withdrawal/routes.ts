import { Hono, type Context } from "hono";

import { escapeHtml } from "../security/html.js";
import type { AdminRouteDependencies } from "../admin/types.js";
import {
  getMarketingWithdrawalConfirmation,
  openMarketingWithdrawalCapability,
  withdrawMarketingConsent,
} from "./service.js";
import { WITHDRAWAL_STYLES, WITHDRAWAL_STYLES_PATH } from "./styles.js";

interface AdminEnvironment {
  Variables: { requestId: string };
}

const MAX_FORM_BYTES = 16 * 1024;
const MAX_FORM_FIELDS = 32;
const MAX_FORM_FIELD_NAME = 128;
const MAX_FORM_FIELD_VALUE = 4_096;

function page(
  title: string,
  body: string,
  lang = "en",
  tone: "default" | "success" | "error" = "default",
): string {
  return `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="${WITHDRAWAL_STYLES_PATH}"></head><body><main class="withdrawal-card withdrawal-card--${tone}">${body}</main></body></html>`;
}

function cookieValue(header: string, name: string): string | undefined {
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return undefined;
}

async function formValues(
  context: Context<AdminEnvironment>,
): Promise<Record<string, string> | Response> {
  const mediaType = (context.req.header("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    return context.html(page("Unsupported request", "<h1>Unsupported request</h1>"), 415);
  }
  const contentLength = context.req.header("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_FORM_BYTES)) {
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
      fields > MAX_FORM_FIELDS || key.length === 0 || key.length > MAX_FORM_FIELD_NAME ||
      value.length > MAX_FORM_FIELD_VALUE || Object.hasOwn(values, key)
    ) return context.html(page("Invalid request", "<h1>Invalid request</h1>"), 400);
    values[key] = value;
  }
  return values;
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

export function registerWithdrawalRoutes(
  app: Hono<AdminEnvironment>,
  dependencies: AdminRouteDependencies,
): void {
  app.get(WITHDRAWAL_STYLES_PATH, (context) => {
    return context.body(WITHDRAWAL_STYLES, 200, {
      "Content-Type": "text/css; charset=utf-8",
    });
  });

  const routes = [
    "/marketing/withdraw/confirm",
    "/en/marketing/withdraw/confirm",
    "/zh-hans/marketing/withdraw/confirm",
    "/zh-hant/marketing/withdraw/confirm",
  ];
  for (const route of routes) {
    app.get(route, (context) => {
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
        return context.html(page(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale, "error"), 410);
      }
      return context.html(page(copy.title, `<h1>${copy.title}</h1><p>${copy.description}</p><form method="post" action="${escapeHtml(route)}"><input type="hidden" name="confirmation" value="${escapeHtml(result.confirmationValue)}"><button type="submit">${copy.button}</button></form>`, locale));
    });
    app.post(route, async (context) => {
      const locale = withdrawalLocaleForRoute(route);
      const copy = WITHDRAWAL_COPY[locale];
      if (context.req.header("origin") !== dependencies.publicOrigin) {
        return context.html(page("Forbidden", "<h1>Forbidden</h1>", "en", "error"), 403);
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
        return context.html(page(copy.invalidTitle, `<h1>${copy.invalid}</h1>`, locale, "error"), 400);
      }
      context.header("Set-Cookie", "__Host-wisdom-marketing-withdraw=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      return context.html(page(copy.successTitle, `<h1>${copy.successTitle}</h1><p>${copy.success}</p>`, locale, "success"));
    });
  }

  app.get("/marketing/withdraw/:token", (context) => {
    const result = openMarketingWithdrawalCapability(dependencies.db, dependencies.withdrawalSecret, {
      token: context.req.param("token"),
      publicOrigin: dependencies.publicOrigin,
      nowMs: dependencies.now(),
    });
    if (result.kind === "invalid") {
      return context.html(page("Invalid link", "<h1>This withdrawal link is invalid or expired.</h1>", "en", "error"), 404);
    }
    context.header("Set-Cookie", result.cookie);
    return context.redirect(result.location, 303);
  });
}
