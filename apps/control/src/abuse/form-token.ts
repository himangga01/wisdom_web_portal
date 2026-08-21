import { timingSafeEqual } from "node:crypto";

import { localeSchema, type Locale } from "@wisdom/shared";

import { isConsentReleaseId } from "../consent/release-authority.js";
import { keyedDigest, type KeyProvider } from "../crypto/index.js";

export interface FormTokenBinding {
  locale: Locale;
  releaseId: string;
  bundleId: string;
  manifestSha256: string;
  privacyVersion: string;
  marketingVersion: string;
}

interface FormTokenPayload extends FormTokenBinding {
  v: 2;
  keyId: string;
  issuedAtMs: number;
  nonce: string;
}

export type FormTokenExpectedBinding = Pick<
  FormTokenBinding,
  "locale" | "privacyVersion" | "marketingVersion"
> & Partial<Pick<FormTokenBinding, "releaseId" | "bundleId" | "manifestSha256">>;

const MINIMUM_FILL_MS = 2_000;
const MAXIMUM_AGE_MS = 2 * 60 * 60 * 1_000;

export function issueFormToken(
  provider: KeyProvider,
  binding: FormTokenBinding,
  issuedAtMs: number,
  nonce: string,
): string {
  if (!nonce) throw new Error("Form token nonce is required");
  const payload: FormTokenPayload = {
    v: 2,
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
    payload.v !== 2 ||
    !locale.success ||
    typeof payload.keyId !== "string" ||
    typeof payload.releaseId !== "string" ||
    !isConsentReleaseId(payload.releaseId) ||
    typeof payload.bundleId !== "string" ||
    payload.bundleId.length < 1 ||
    payload.bundleId.length > 128 ||
    payload.bundleId !== payload.bundleId.trim() ||
    typeof payload.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.manifestSha256) ||
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
  expected: FormTokenExpectedBinding,
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
    payload.marketingVersion !== expected.marketingVersion ||
    (expected.releaseId !== undefined && payload.releaseId !== expected.releaseId) ||
    (expected.bundleId !== undefined && payload.bundleId !== expected.bundleId) ||
    (expected.manifestSha256 !== undefined && payload.manifestSha256 !== expected.manifestSha256)
  ) {
    throw new Error("Form token consent binding does not match");
  }
  const age = nowMs - payload.issuedAtMs;
  if (age < MINIMUM_FILL_MS || age >= MAXIMUM_AGE_MS) {
    throw new Error("Form token age is invalid");
  }
  return payload;
}
