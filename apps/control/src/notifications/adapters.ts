import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import nodemailer from "nodemailer";

import type { ConsultationPii } from "../crypto/index.js";
import { escapeHtml } from "../security/html.js";
import {
  assertPublicSmtpResolution,
  isAllowedSmtpHostname,
  type SmtpLookupAddress,
} from "./smtp-security.js";

const OUTBOX_LEASE_MS = 2 * 60 * 1_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;

function providerTimeoutMs(configured?: number): number {
  const timeoutMs = configured ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs >= OUTBOX_LEASE_MS) {
    throw new Error("Provider I/O timeout must be a positive integer below the outbox lease");
  }
  return timeoutMs;
}

async function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${provider} provider I/O timeout`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface NotificationMetadata {
  deliveryId: string;
  consultationId: string;
  purpose: "transactional" | "marketing" | "test";
  eventType: string;
  receiptId: string;
  category: string;
  locale: string;
  status: string;
  receivedAt: string;
  adminUrl: string;
  piiEnvelope: string;
  withdrawalUrl?: string;
}

export interface NotificationDeliveryResult {
  providerMessageId: string;
}

export interface PreparedNotificationDelivery {
  deliver(input: NotificationMetadata): Promise<NotificationDeliveryResult>;
}

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: string;
  user?: string;
  password?: string;
}

interface SmtpAdapterOptions {
  smtp: SmtpSettings;
  payloadMode: "receipt-only" | "full-inquiry";
  fullInquiryApproved?: boolean;
  decryptPii: (consultationId: string, envelope: string) => ConsultationPii;
  sendMail?: (mail: Record<string, unknown>) => Promise<{ messageId?: string }>;
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<SmtpLookupAddress[]>;
  providerTimeoutMs?: number;
}

function validateTlsSmtp(settings: SmtpSettings): void {
  if (
    !isAllowedSmtpHostname(settings.host) ||
    settings.port !== 465 ||
    settings.secure !== true ||
    !settings.from ||
    !settings.to
  ) {
    throw new Error("Complete secure TLS SMTP configuration is required");
  }
}

function stableMessageId(deliveryId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(deliveryId)) throw new Error("Invalid notification delivery ID");
  return `<${deliveryId}@wisdom.local>`;
}

const MARKETING_COPY = {
  ko: {
    subject: "[지혜행정사사무소] 마케팅 정보 수신 동의 안내",
    accepted: "지혜행정사사무소의 선택적 마케팅 정보 수신에 동의하셨습니다.",
    receipt: "접수번호",
    withdraw: "수신 동의 철회",
  },
  en: {
    subject: "[JIHYE] Marketing communication consent",
    accepted: "You accepted optional marketing communications from JIHYE Administrative Attorney.",
    receipt: "Receipt",
    withdraw: "Withdraw consent",
  },
  "zh-Hans": {
    subject: "[智慧行政士事务所] 营销信息接收同意通知",
    accepted: "您已同意接收智慧行政士事务所的可选营销信息。",
    receipt: "受理编号",
    withdraw: "撤回同意",
  },
  "zh-Hant": {
    subject: "[智慧行政士事務所] 行銷資訊接收同意通知",
    accepted: "您已同意接收智慧行政士事務所的選擇性行銷資訊。",
    receipt: "受理編號",
    withdraw: "撤回同意",
  },
} as const;

function marketingCopy(locale: string): (typeof MARKETING_COPY)[keyof typeof MARKETING_COPY] {
  return locale in MARKETING_COPY
    ? MARKETING_COPY[locale as keyof typeof MARKETING_COPY]
    : MARKETING_COPY.en;
}

export function createSmtpNotificationAdapter(options: SmtpAdapterOptions) {
  const timeoutMs = providerTimeoutMs(options.providerTimeoutMs);
  const prepare = async (): Promise<PreparedNotificationDelivery> => {
    validateTlsSmtp(options.smtp);
    if (options.payloadMode === "full-inquiry" && options.fullInquiryApproved !== true) {
      throw new Error("Full-inquiry email delivery requires the explicit administrator gate");
    }
    const deadline = performance.now() + timeoutMs;
    const lookup = options.lookup ?? (async (hostname, lookupOptions) =>
      await dnsLookup(hostname, lookupOptions) as SmtpLookupAddress[]);
    const resolved = await withProviderTimeout(
      lookup(options.smtp.host, { all: true, verbatim: true }),
      timeoutMs,
      "SMTP",
    );
    const pinnedAddress = assertPublicSmtpResolution(resolved);
    return {
      async deliver(input: NotificationMetadata): Promise<NotificationDeliveryResult> {
      let recipient = options.smtp.to;
      let lines = [
        `Receipt: ${escapeHtml(input.receiptId)}`,
        `Category: ${escapeHtml(input.category)}`,
        `Locale: ${escapeHtml(input.locale)}`,
        `Status: ${escapeHtml(input.status)}`,
        `Received: ${escapeHtml(input.receivedAt)}`,
        `Admin: ${escapeHtml(input.adminUrl)}`,
      ];
      if (input.purpose === "marketing") {
        if (!input.withdrawalUrl) throw new Error("Customer marketing email requires a withdrawal URL");
        const withdrawalUrl = new URL(input.withdrawalUrl);
        if (withdrawalUrl.protocol !== "https:") throw new Error("Customer withdrawal URL must use HTTPS");
        const pii = options.decryptPii(input.consultationId, input.piiEnvelope);
        if (typeof pii.email !== "string" || !/^\S+@\S+\.\S+$/.test(pii.email)) {
          throw new Error("Customer marketing email requires a valid consented email address");
        }
        recipient = pii.email;
        const copy = marketingCopy(input.locale);
        lines = [
          copy.accepted,
          `${copy.receipt}: ${escapeHtml(input.receiptId)}`,
          `${copy.withdraw}: ${escapeHtml(input.withdrawalUrl)}`,
        ];
      } else if (input.purpose === "transactional" && options.payloadMode === "full-inquiry") {
        const pii = options.decryptPii(input.consultationId, input.piiEnvelope);
        for (const key of ["name", "phone", "email", "company", "message"] as const) {
          if (pii[key] !== undefined) lines.push(`${key}: ${escapeHtml(pii[key])}`);
        }
      }
      const mail = {
        from: options.smtp.from,
        to: recipient,
        subject: input.purpose === "marketing"
          ? `${marketingCopy(input.locale).subject} ${input.receiptId}`
          : `[JIHYE] Consultation ${input.receiptId}`,
        messageId: stableMessageId(input.deliveryId),
        text: lines.join("\n"),
        html: `<pre>${lines.join("\n")}</pre>`,
      };
      let closeTransport: (() => void) | undefined;
      const sendMail = options.sendMail ?? ((message: Record<string, unknown>) => {
        const transport = nodemailer.createTransport({
          host: pinnedAddress,
          port: options.smtp.port,
          secure: options.smtp.secure,
          tls: { servername: options.smtp.host },
          connectionTimeout: timeoutMs,
          greetingTimeout: timeoutMs,
          socketTimeout: timeoutMs,
          ...(options.smtp.user && options.smtp.password
            ? { auth: { user: options.smtp.user, pass: options.smtp.password } }
            : {}),
        });
        closeTransport = () => { transport.close(); };
        return transport.sendMail(message) as Promise<{ messageId?: string }>;
      });
      try {
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs <= 0) throw new Error("SMTP provider I/O timeout");
        const result = await withProviderTimeout(sendMail(mail), remainingMs, "SMTP");
        return { providerMessageId: String(result.messageId ?? input.deliveryId) };
      } finally {
        closeTransport?.();
      }
      },
    };
  };
  return {
    prepare,
    async deliver(input: NotificationMetadata): Promise<NotificationDeliveryResult> {
      return await (await prepare()).deliver(input);
    },
  };
}

interface HermesAdapterOptions {
  endpoint: URL;
  secret: Uint8Array;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  providerTimeoutMs?: number;
}

function assertLoopbackEndpoint(endpoint: URL): void {
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const version = isIP(hostname);
  const loopback = version === 4
    ? hostname.split(".")[0] === "127"
    : version === 6 && hostname === "::1";
  if (!loopback || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Hermes endpoint must use a literal loopback address");
  }
}

export function createHermesNotificationAdapter(options: HermesAdapterOptions) {
  assertLoopbackEndpoint(options.endpoint);
  if (options.secret.byteLength < 32) throw new Error("Hermes HMAC secret must contain at least 32 bytes");
  const timeoutMs = providerTimeoutMs(options.providerTimeoutMs);
  return {
    async deliver(input: NotificationMetadata): Promise<NotificationDeliveryResult> {
      const timestamp = String((options.now ?? Date.now)());
      const nonce = (options.nonce ?? (() => crypto.randomUUID()))();
      const body = JSON.stringify({
        eventType: input.eventType,
        receiptId: input.receiptId,
        category: input.category,
        locale: input.locale,
        status: input.status,
        receivedAt: input.receivedAt,
        adminUrl: input.adminUrl,
      });
      const canonical = [
        "POST",
        options.endpoint.pathname + options.endpoint.search,
        timestamp,
        nonce,
        input.deliveryId,
        body,
      ].join("\n");
      const signature = createHmac("sha256", options.secret).update(canonical).digest("base64url");
      const response = await (options.fetch ?? fetch)(options.endpoint.href, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "x-wisdom-timestamp": timestamp,
          "x-wisdom-nonce": nonce,
          "x-wisdom-delivery-id": input.deliveryId,
          "x-wisdom-signature": signature,
        },
        body,
      });
      if (!response.ok) throw new Error(`Hermes provider returned HTTP ${response.status}`);
      const parsed = await response.json() as { providerMessageId?: unknown };
      return { providerMessageId: String(parsed.providerMessageId ?? input.deliveryId) };
    },
  };
}
