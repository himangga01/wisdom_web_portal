import { decryptPii, type KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import {
  createHermesNotificationAdapter,
  createSmtpNotificationAdapter,
} from "./adapters.js";
import { isAllowedSmtpHostname } from "./smtp-security.js";
import type { NotificationAdapter } from "./worker.js";

interface NotificationSettingRow {
  channel: "email" | "hermes-telegram";
  provider: string | null;
  payload_mode: "receipt-only" | "full-inquiry" | null;
  secret_ref: string | null;
  config_json: string | null;
}

export interface SmtpCredentials {
  user: string;
  password: string;
}

interface ConfiguredAdapterOptions {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  hermesEndpoint: URL;
  hermesSecret: Uint8Array;
  secretResolver: (reference: string) => SmtpCredentials;
  smtpFactory?: typeof createSmtpNotificationAdapter;
  hermesFactory?: typeof createHermesNotificationAdapter;
}

function smtpConfiguration(serialized: string | null): {
  host: string;
  port: number;
  secure: true;
  from: string;
  to: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(serialized ?? "null");
  } catch {
    throw new Error("Enabled SMTP notification configuration is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Enabled SMTP notification configuration is incomplete");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.host !== "string" || !isAllowedSmtpHostname(record.host) ||
    record.port !== 465 ||
    record.secure !== true ||
    typeof record.from !== "string" || !record.from ||
    typeof record.to !== "string" || !record.to
  ) {
    throw new Error("Enabled SMTP notification configuration requires complete TLS settings");
  }
  return {
    host: record.host,
    port: Number(record.port),
    secure: true,
    from: record.from,
    to: record.to,
  };
}

export function loadConfiguredNotificationAdapters(
  options: ConfiguredAdapterOptions,
): Partial<Record<"email" | "hermes-telegram", NotificationAdapter>> {
  const settings = options.db.sqlite.prepare(`
    SELECT channel, provider, payload_mode, secret_ref, config_json
    FROM notification_settings WHERE enabled = 1 ORDER BY channel
  `).all() as NotificationSettingRow[];
  const adapters: Partial<Record<"email" | "hermes-telegram", NotificationAdapter>> = {};
  for (const setting of settings) {
    try {
      if (setting.channel === "email") {
        if (setting.provider !== "smtp") throw new Error("Enabled email notifications require SMTP");
        const smtp = smtpConfiguration(setting.config_json);
        const credentials = setting.secret_ref ? options.secretResolver(setting.secret_ref) : undefined;
        if (credentials && (!credentials.user || !credentials.password)) {
          throw new Error("SMTP secret reference did not resolve complete credentials");
        }
        const payloadMode = setting.payload_mode ?? "receipt-only";
        adapters.email = (options.smtpFactory ?? createSmtpNotificationAdapter)({
          smtp: { ...smtp, ...(credentials ?? {}) },
          payloadMode,
          fullInquiryApproved: payloadMode === "full-inquiry",
          decryptPii: (consultationId, envelope) =>
            decryptPii(options.keyProvider, consultationId, envelope),
        });
      } else {
        if (setting.provider !== "hermes") throw new Error("Enabled Hermes notifications require Hermes provider");
        adapters["hermes-telegram"] = (options.hermesFactory ?? createHermesNotificationAdapter)({
          endpoint: options.hermesEndpoint,
          secret: options.hermesSecret,
        });
      }
    } catch {
      // A broken Keychain/config entry must not stall the other channel. The
      // channel-local adapter turns its own claimed item into the normal retry flow.
      adapters[setting.channel] = {
        async deliver(): Promise<never> {
          throw new Error("Notification channel configuration unavailable");
        },
      };
    }
  }
  return adapters;
}
