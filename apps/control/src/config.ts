import { parseEnvironment, type EnvironmentSource } from "@wisdom/shared";

import { createStaticKeyProvider, type KeyMaterial, type KeyProvider } from "./crypto/index.js";

export interface ControlConfig {
  nodeEnv: "development" | "test" | "production";
  databasePath: string;
  host: "127.0.0.1";
  port: number;
  allowedOrigins: string[];
  enforceOrigin: boolean;
  keyProvider: KeyProvider;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CONTROL_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parseOrigins(value: string | undefined, production: boolean): string[] {
  const origins = value?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  const unique = [...new Set(origins)];
  for (const origin of unique) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("PUBLIC_ORIGINS must contain valid origins");
    }
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("PUBLIC_ORIGINS must contain origins without paths or credentials");
    }
    if (production && url.protocol !== "https:") {
      throw new Error("PUBLIC_ORIGINS must use HTTPS in production");
    }
  }
  if (production && unique.length === 0) {
    throw new Error("PUBLIC_ORIGINS is required in production");
  }
  return unique;
}

function parsePreviousKeys(value: string | undefined): KeyMaterial[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PII_PREVIOUS_KEYS_JSON must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PII_PREVIOUS_KEYS_JSON must be an object");
  }
  return Object.entries(parsed).map(([id, secret]) => {
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Every previous PII key must contain at least 32 bytes");
    }
    return { id, secret: Buffer.from(secret, "utf8") };
  });
}

export function parseControlConfig(source: EnvironmentSource): ControlConfig {
  const shared = parseEnvironment(source);
  const host = source.CONTROL_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("CONTROL_HOST must remain on IPv4 loopback");
  const allowedOrigins = parseOrigins(source.PUBLIC_ORIGINS, shared.nodeEnv === "production");
  const controlHmacSecret = source.CONTROL_HMAC_SECRET ?? (
    shared.nodeEnv === "test" ? "test-only-control-hmac-secret-00001" : undefined
  );
  if (!controlHmacSecret || Buffer.byteLength(controlHmacSecret, "utf8") < 32) {
    throw new Error("CONTROL_HMAC_SECRET must contain at least 32 bytes");
  }
  if (shared.nodeEnv === "production" && controlHmacSecret.startsWith("test-only-")) {
    throw new Error("CONTROL_HMAC_SECRET cannot use a test-only production value");
  }
  if (shared.nodeEnv === "production" && controlHmacSecret === shared.piiEncryptionKey) {
    throw new Error("CONTROL_HMAC_SECRET must be independent from PII_ENCRYPTION_KEY");
  }
  const activeId = source.PII_ACTIVE_KEY_ID === undefined ? "pii-v1" : source.PII_ACTIVE_KEY_ID;
  const keyProvider = createStaticKeyProvider({
    id: activeId,
    secret: Buffer.from(shared.piiEncryptionKey, "utf8"),
  }, parsePreviousKeys(source.PII_PREVIOUS_KEYS_JSON), Buffer.from(controlHmacSecret, "utf8"));
  return {
    nodeEnv: shared.nodeEnv,
    databasePath: shared.databasePath,
    host: "127.0.0.1",
    port: parsePort(source.CONTROL_PORT),
    allowedOrigins,
    enforceOrigin: shared.nodeEnv === "production" || allowedOrigins.length > 0,
    keyProvider,
  };
}
