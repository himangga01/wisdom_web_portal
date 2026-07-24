import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

import {
  parseEnvironment,
  parseSearchVerificationConfig,
  type EnvironmentSource,
} from "@wisdom/shared";

import { createStaticKeyProvider, type KeyMaterial, type KeyProvider } from "./crypto/index.js";
import { isFrozenAdminPasswordHash } from "./auth/password.js";
import type { PublicationReleaseConfig } from "./articles/publication-release.js";
import {
  parseIndexNowSenderConfig,
  type IndexNowSenderConfig,
} from "./articles/indexnow-sender.js";

export interface ControlConfig {
  nodeEnv: "development" | "test" | "production";
  databasePath: string;
  analyticsDatabasePath: string;
  host: "127.0.0.1";
  port: number;
  publicOrigin: string | undefined;
  adminOrigin: string | undefined;
  allowedOrigins: string[];
  enforceOrigin: boolean;
  keyProvider: KeyProvider;
  authSecret: Buffer;
  withdrawalSecret: Buffer;
  hermesHmacSecret: Buffer;
  dummyPasswordHash: string;
  hermesEndpoint: URL;
  emailPayloadMode: "receipt-only" | "full-inquiry";
  publication: PublicationReleaseConfig | undefined;
  indexNow: IndexNowSenderConfig | undefined;
}

const TEST_DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY";

const PUBLIC_CONTENT_ROUTES = [
  "/",
  "/about",
  "/services",
  "/services/procurement",
  "/services/credibility",
  "/services/safety-esg",
  "/services/business-certification",
  "/services/licensing-entity",
  "/services/immigration-visa",
  "/process",
  "/insights",
  "/consultation",
  "/location",
  "/privacy",
  "/marketing/withdraw",
] as const;

const REQUIRED_PUBLICATION_ROUTES = ["", "/en", "/zh-hans", "/zh-hant"].flatMap(
  (prefix) => PUBLIC_CONTENT_ROUTES.map((route) => route === "/" ? (prefix || "/") : `${prefix}${route}`),
);

function publicationPath(
  source: EnvironmentSource,
  name: "PUBLIC_RELEASE_ROOT" | "PUBLIC_CURRENT_LINK" | "SITE_SOURCE_ROOT" | "NODE_BINARY" | "NPM_BINARY",
): string {
  const value = source[name];
  if (!value || /[\0\r\n]/u.test(value) || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute single-line path`);
  }
  return value;
}

function parsePublicationConfig(
  source: EnvironmentSource,
  production: boolean,
  publicOrigin: string | undefined,
): PublicationReleaseConfig | undefined {
  const names = [
    "PUBLIC_RELEASE_ROOT",
    "PUBLIC_CURRENT_LINK",
    "SITE_SOURCE_ROOT",
    "NODE_BINARY",
    "NPM_BINARY",
  ] as const;
  const configured = names.some((name) => source[name] !== undefined);
  if (!production && !configured) return undefined;
  if (!publicOrigin) throw new Error("PUBLIC_ORIGIN is required for publication");
  const releaseRoot = publicationPath(source, "PUBLIC_RELEASE_ROOT");
  const currentLink = publicationPath(source, "PUBLIC_CURRENT_LINK");
  const siteSourceRoot = publicationPath(source, "SITE_SOURCE_ROOT");
  const nodeBinary = publicationPath(source, "NODE_BINARY");
  const npmBinary = publicationPath(source, "NPM_BINARY");
  const searchVerification = parseSearchVerificationConfig({
    ...(source.NAVER_SITE_VERIFICATION_META !== undefined
      ? { NAVER_SITE_VERIFICATION_META: source.NAVER_SITE_VERIFICATION_META }
      : {}),
    ...(source.NAVER_SITE_VERIFICATION_FILE !== undefined
      ? { NAVER_SITE_VERIFICATION_FILE: source.NAVER_SITE_VERIFICATION_FILE }
      : {}),
  });
  if (new Set([releaseRoot, currentLink, siteSourceRoot]).size !== 3) {
    throw new Error("Publication roots and current link must be distinct");
  }
  if (nodeBinary === npmBinary) throw new Error("NODE_BINARY and NPM_BINARY must be distinct");
  const buildTimeoutMs = source.PUBLICATION_BUILD_TIMEOUT_MS === undefined
    ? 5 * 60_000
    : Number(source.PUBLICATION_BUILD_TIMEOUT_MS);
  if (!Number.isSafeInteger(buildTimeoutMs) || buildTimeoutMs < 1_000 || buildTimeoutMs > 30 * 60_000) {
    throw new Error("PUBLICATION_BUILD_TIMEOUT_MS must be between 1000 and 1800000");
  }
  return Object.freeze({
    releaseRoot,
    currentLink,
    siteSourceRoot,
    nodeBinary,
    npmBinary,
    buildTimeoutMs,
    requiredCoreRoutes: Object.freeze([...REQUIRED_PUBLICATION_ROUTES]),
    forbiddenCanaries: Object.freeze(["DRAFT_PRIVATE_CANARY", "CONSULTATION_PRIVATE_CANARY"]),
    publicOrigin,
    ...(searchVerification.naverMetaToken
      ? { naverSiteVerificationMeta: searchVerification.naverMetaToken }
      : {}),
    ...(searchVerification.naverFile
      ? { naverSiteVerificationFile: searchVerification.naverFile.filename }
      : {}),
  });
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CONTROL_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function parseOrigin(name: "PUBLIC_ORIGIN" | "ADMIN_ORIGIN", value: string | undefined, production: boolean) {
  if (value === undefined) {
    if (production) throw new Error(`${name} is required in production`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid origin`);
  }
  if (url.origin !== value || url.username || url.password) {
    throw new Error(`${name} must be an exact origin without path or credentials`);
  }
  if (production && url.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  return value;
}

function parseHermesEndpoint(value: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(value ?? "http://127.0.0.1:8788/notify");
  } catch {
    throw new Error("HERMES_ENDPOINT must be a valid URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  const loopback = ipVersion === 4
    ? hostname.split(".")[0] === "127"
    : ipVersion === 6 && hostname === "::1";
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("HERMES_ENDPOINT must use a literal loopback address");
  }
  return url;
}

function requiredSecret(name: string, value: string | undefined, testDefault: string | undefined): string {
  const resolved = value ?? testDefault;
  if (!resolved || Buffer.byteLength(resolved, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return resolved;
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
  const production = shared.nodeEnv === "production";
  const host = source.CONTROL_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("CONTROL_HOST must remain on IPv4 loopback");
  const publicOrigin = parseOrigin("PUBLIC_ORIGIN", source.PUBLIC_ORIGIN, production);
  const adminOrigin = parseOrigin("ADMIN_ORIGIN", source.ADMIN_ORIGIN, production);
  if (publicOrigin !== undefined && publicOrigin === adminOrigin) {
    throw new Error("PUBLIC_ORIGIN and ADMIN_ORIGIN must be distinct");
  }
  if (
    production &&
    publicOrigin !== undefined &&
    adminOrigin !== undefined &&
    new URL(publicOrigin).hostname === new URL(adminOrigin).hostname
  ) {
    throw new Error("PUBLIC_ORIGIN and ADMIN_ORIGIN must use distinct hostnames");
  }
  const controlHmacSecret = requiredSecret(
    "CONTROL_HMAC_SECRET",
    source.CONTROL_HMAC_SECRET,
    shared.nodeEnv === "test" ? "test-only-control-hmac-secret-00001" : undefined,
  );
  const hermesHmacSecret = requiredSecret(
    "HERMES_HMAC_SECRET",
    source.HERMES_HMAC_SECRET,
    shared.nodeEnv === "test" ? "test-only-hermes-hmac-secret-000001" : undefined,
  );
  const dummyPasswordHash = source.ADMIN_DUMMY_PASSWORD_HASH ?? (
    shared.nodeEnv === "test" ? TEST_DUMMY_PASSWORD_HASH : undefined
  );
  if (!dummyPasswordHash) throw new Error("ADMIN_DUMMY_PASSWORD_HASH is required");
  if (!isFrozenAdminPasswordHash(dummyPasswordHash)) {
    throw new Error("ADMIN_DUMMY_PASSWORD_HASH must use the frozen Argon2id password policy");
  }
  const previousKeys = parsePreviousKeys(source.PII_PREVIOUS_KEYS_JSON);
  if (production) {
    const independent = [
      shared.adminSessionSecret,
      shared.piiEncryptionKey,
      shared.withdrawalTokenSecret,
      controlHmacSecret,
      hermesHmacSecret,
      ...previousKeys.map((key) => Buffer.from(key.secret).toString("utf8")),
    ];
    if (new Set(independent).size !== independent.length) {
      throw new Error("Production secrets must be independent");
    }
    if (independent.some((secret) => secret.startsWith("test-only-"))) {
      throw new Error("Production secrets cannot use test-only values");
    }
  }
  const activeId = source.PII_ACTIVE_KEY_ID === undefined ? "pii-v1" : source.PII_ACTIVE_KEY_ID;
  const keyProvider = createStaticKeyProvider({
    id: activeId,
    secret: Buffer.from(shared.piiEncryptionKey, "utf8"),
  }, previousKeys, Buffer.from(controlHmacSecret, "utf8"));
  const publication = parsePublicationConfig(source, production, publicOrigin);
  const indexNowConfigured = source.INDEXNOW_KEYCHAIN_SERVICE !== undefined
    || source.INDEXNOW_KEY_LOCATION !== undefined
    || source.INDEXNOW_TIMEOUT_MS !== undefined;
  const indexNow = publication || indexNowConfigured
    ? parseIndexNowSenderConfig(source, publicOrigin ?? "")
    : undefined;
  const analyticsOverride = source.ANALYTICS_DATABASE_PATH?.trim();
  const analyticsDatabasePath = analyticsOverride && analyticsOverride.length > 0
    ? analyticsOverride
    : shared.databasePath === ":memory:"
      ? ":memory:"
      : join(dirname(shared.databasePath), "analytics.db");
  return {
    nodeEnv: shared.nodeEnv,
    databasePath: shared.databasePath,
    analyticsDatabasePath,
    host: "127.0.0.1",
    port: parsePort(source.CONTROL_PORT),
    publicOrigin,
    adminOrigin,
    allowedOrigins: publicOrigin === undefined ? [] : [publicOrigin],
    enforceOrigin: production || publicOrigin !== undefined,
    keyProvider,
    authSecret: Buffer.from(shared.adminSessionSecret, "utf8"),
    withdrawalSecret: Buffer.from(shared.withdrawalTokenSecret, "utf8"),
    hermesHmacSecret: Buffer.from(hermesHmacSecret, "utf8"),
    dummyPasswordHash,
    hermesEndpoint: parseHermesEndpoint(source.HERMES_ENDPOINT),
    emailPayloadMode: shared.emailPayloadMode,
    publication,
    indexNow,
  };
}
