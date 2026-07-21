import { timingSafeEqual } from "node:crypto";

import { localeSchema, type Locale } from "@wisdom/shared";

import { keyedDigest, type KeyProvider } from "../crypto/index.js";

export interface FormTokenBinding {
  locale: Locale;
  privacyVersion: string;
  marketingVersion: string;
}

interface FormTokenPayload extends FormTokenBinding {
  v: 1;
  keyId: string;
  issuedAtMs: number;
  nonce: string;
}

const MINIMUM_FILL_MS = 2_000;
const MAXIMUM_AGE_MS = 2 * 60 * 60 * 1_000;

export const FORM_TOKEN_EXPIRED = "FORM_TOKEN_EXPIRED";

export class FormTokenExpiredError extends Error {
  readonly code = FORM_TOKEN_EXPIRED;

  constructor() {
    super("Form token has expired");
  }
}

export function issueFormToken(
  provider: KeyProvider,
  binding: FormTokenBinding,
  issuedAtMs: number,
  nonce: string,
): string {
  if (!nonce) throw new Error("Form token nonce is required");
  const payload: FormTokenPayload = {
    v: 1,
    keyId: provider.active().id,
    ...binding,
    issuedAtMs,
    nonce,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${keyedDigest(provider, "form-token", encoded).toString("base64url")}`;
}

function parsePayload(encoded: string): FormTokenPayload {
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid form token");
  }
  const payload = value as Partial<FormTokenPayload>;
  const locale = localeSchema.safeParse(payload.locale);
  if (
    payload.v !== 1 ||
    !locale.success ||
    typeof payload.keyId !== "string" ||
    typeof payload.privacyVersion !== "string" ||
    typeof payload.marketingVersion !== "string" ||
    typeof payload.issuedAtMs !== "number" ||
    !Number.isSafeInteger(payload.issuedAtMs) ||
    typeof payload.nonce !== "string" ||
    !payload.nonce
  ) {
    throw new Error("Invalid form token");
  }
  return payload as FormTokenPayload;
}

export function verifyFormToken(
  provider: KeyProvider,
  token: string,
  expected: FormTokenBinding,
  nowMs: number,
): FormTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid form token");
  const payload = parsePayload(parts[0]);
  const supplied = Buffer.from(parts[1], "base64url");
  const expectedSignature = keyedDigest(provider, "form-token", parts[0], payload.keyId);
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
    throw new Error("Invalid form token signature");
  }
  if (
    payload.locale !== expected.locale ||
    payload.privacyVersion !== expected.privacyVersion ||
    payload.marketingVersion !== expected.marketingVersion
  ) {
    throw new Error("Form token consent binding does not match");
  }
  const age = nowMs - payload.issuedAtMs;
  if (age >= MAXIMUM_AGE_MS) {
    throw new FormTokenExpiredError();
  }
  if (age < MINIMUM_FILL_MS) {
    throw new Error("Form token age is invalid");
  }
  return payload;
}
