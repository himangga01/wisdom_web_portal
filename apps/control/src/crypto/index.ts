import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { normalizePhone } from "@wisdom/shared";

export interface KeyMaterial {
  id: string;
  secret: Uint8Array;
}

export interface KeyProvider {
  active(): KeyMaterial;
  get(id: string): KeyMaterial | undefined;
  all(): readonly KeyMaterial[];
  hmacRoot(): Uint8Array;
}

export interface ConsultationPii {
  name: string;
  phone: string;
  email?: string;
  company?: string;
  message: string;
}

interface EnvelopeV1 {
  v: 1;
  alg: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const PURPOSES = [
  "encryption",
  "blind-index",
  "idempotency",
  "request-fingerprint",
  "abuse",
  "form-token",
] as const;
export type KeyPurpose = (typeof PURPOSES)[number];

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function copyMaterial(material: KeyMaterial): KeyMaterial {
  if (!KEY_ID_PATTERN.test(material.id)) throw new Error("Key ID must use the encrypted-envelope grammar");
  if (material.secret.byteLength < 32) throw new Error("Key material must contain at least 32 bytes");
  return { id: material.id, secret: Buffer.from(material.secret) };
}

export function createStaticKeyProvider(
  active: KeyMaterial,
  previous: readonly KeyMaterial[] = [],
  hmacRoot: Uint8Array = active.secret,
): KeyProvider {
  const entries = [active, ...previous].map(copyMaterial);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new Error("Duplicate key ID");
  if (hmacRoot.byteLength < 32) throw new Error("HMAC root must contain at least 32 bytes");
  const copiedHmacRoot = Buffer.from(hmacRoot);
  const activeId = active.id;
  return {
    active: () => byId.get(activeId)!,
    get: (id) => byId.get(id),
    all: () => entries,
    hmacRoot: () => Buffer.from(copiedHmacRoot),
  };
}

function deriveKey(provider: KeyProvider, material: KeyMaterial, purpose: KeyPurpose): Buffer {
  const root = purpose === "encryption" ? material.secret : provider.hmacRoot();
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(root),
    Buffer.from("wisdom-control:v1", "utf8"),
    Buffer.from(`wisdom:${purpose}:v1:${material.id}`, "utf8"),
    32,
  ));
}

function aad(consultationId: string): Buffer {
  return Buffer.from(`wisdom:consultation-pii:v1:${consultationId}`, "utf8");
}

function plaintext(pii: ConsultationPii): Buffer {
  return Buffer.from(JSON.stringify({
    name: pii.name,
    phone: pii.phone,
    email: pii.email ?? null,
    company: pii.company ?? null,
    message: pii.message,
  }), "utf8");
}

export function encryptPii(
  provider: KeyProvider,
  consultationId: string,
  pii: ConsultationPii,
): string {
  const material = provider.active();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(provider, material, "encryption"), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(consultationId));
  const ciphertext = Buffer.concat([cipher.update(plaintext(pii)), cipher.final()]);
  const envelope: EnvelopeV1 = {
    v: 1,
    alg: "A256GCM",
    keyId: material.id,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(serialized: string): EnvelopeV1 {
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid encrypted envelope");
  }
  const envelope = value as Partial<EnvelopeV1>;
  const expectedKeys = new Set(["v", "alg", "keyId", "iv", "ciphertext", "tag"]);
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => !expectedKeys.has(key)) ||
    envelope.v !== 1 ||
    envelope.alg !== "A256GCM" ||
    typeof envelope.keyId !== "string" ||
    !KEY_ID_PATTERN.test(envelope.keyId) ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.tag !== "string"
  ) {
    throw new Error("Unsupported encrypted envelope");
  }
  const encodedValues = [envelope.iv, envelope.ciphertext, envelope.tag];
  if (encodedValues.some((encoded) =>
    !/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded
  )) {
    throw new Error("Invalid encrypted envelope encoding");
  }
  if (Buffer.from(envelope.iv, "base64url").length !== 12 || Buffer.from(envelope.tag, "base64url").length !== 16) {
    throw new Error("Invalid encrypted envelope parameters");
  }
  return envelope as EnvelopeV1;
}

export function decryptPii(
  provider: KeyProvider,
  consultationId: string,
  serialized: string,
): ConsultationPii {
  const envelope = parseEnvelope(serialized);
  const material = provider.get(envelope.keyId);
  if (!material) throw new Error("Encrypted envelope key is unavailable");
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted envelope parameters");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(provider, material, "encryption"), iv, {
    authTagLength: 16,
  });
  decipher.setAAD(aad(consultationId));
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const value = JSON.parse(decoded) as Record<string, unknown>;
  if (
    typeof value.name !== "string" ||
    typeof value.phone !== "string" ||
    !(typeof value.email === "string" || value.email === null) ||
    !(typeof value.company === "string" || value.company === null) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid encrypted PII payload");
  }
  return {
    name: value.name,
    phone: value.phone,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.company === "string" ? { company: value.company } : {}),
    message: value.message,
  };
}

function normalizeExact(kind: "phone" | "email", value: string): string {
  return kind === "phone" ? normalizePhone(value) : value.trim().normalize("NFKC").toLowerCase();
}

export function blindIndex(
  provider: KeyProvider,
  kind: "phone" | "email",
  value: string,
  keyId = provider.active().id,
): Buffer {
  const material = provider.get(keyId);
  if (!material) throw new Error("Blind-index key is unavailable");
  return createHmac("sha256", deriveKey(provider, material, "blind-index"))
    .update(`wisdom:bidx:v1\0${kind}\0${normalizeExact(kind, value)}`, "utf8")
    .digest();
}

export interface BlindIndexCandidate {
  keyId: string;
  index: Buffer;
}

export function blindIndexCandidates(
  provider: KeyProvider,
  kind: "phone" | "email",
  value: string,
): BlindIndexCandidate[] {
  return provider.all().map((material) => ({
    keyId: material.id,
    index: blindIndex(provider, kind, value, material.id),
  }));
}

export function keyedDigest(
  provider: KeyProvider,
  purpose: Exclude<KeyPurpose, "encryption" | "blind-index">,
  value: string | Uint8Array,
  keyId = provider.active().id,
): Buffer {
  const material = provider.get(keyId);
  if (!material) throw new Error(`${purpose} key is unavailable`);
  return createHmac("sha256", deriveKey(provider, material, purpose)).update(value).digest();
}
