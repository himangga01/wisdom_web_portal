import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { KeyMaterial, KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";

interface TotpEnvelopeV1 {
  v: 1;
  alg: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function counterAt(nowMs: number): number {
  return Math.floor(nowMs / 30_000);
}

function codeAtCounter(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha256", secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = ((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000);
  return binary.toString().padStart(6, "0");
}

export function totpCode(secret: Uint8Array, nowMs: number): string {
  if (secret.byteLength < 20) throw new Error("TOTP secret must contain at least 20 bytes");
  return codeAtCounter(secret, counterAt(nowMs));
}

export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastCounter?: number,
): number | undefined {
  if (secret.byteLength < 20 || !/^\d{6}$/.test(code)) return undefined;
  const supplied = Buffer.from(code, "ascii");
  const current = counterAt(nowMs);
  for (const counter of [current - 1, current, current + 1]) {
    if (counter < 0 || (lastCounter !== undefined && counter <= lastCounter)) continue;
    const expected = Buffer.from(codeAtCounter(secret, counter), "ascii");
    if (timingSafeEqual(supplied, expected)) return counter;
  }
  return undefined;
}

function deriveTotpKey(material: KeyMaterial): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(material.secret),
    Buffer.from("wisdom-control:v1", "utf8"),
    Buffer.from(`wisdom:admin-totp:v1:${material.id}`, "utf8"),
    32,
  ));
}

function totpAad(adminId: string): Buffer {
  return Buffer.from(`wisdom:admin-totp:v1:${adminId}`, "utf8");
}

export function encryptAdminTotpSecret(
  provider: KeyProvider,
  adminId: string,
  secret: Uint8Array,
): string {
  if (secret.byteLength < 20) throw new Error("TOTP secret must contain at least 20 bytes");
  const material = provider.active();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveTotpKey(material), iv, { authTagLength: 16 });
  cipher.setAAD(totpAad(adminId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: "A256GCM",
    keyId: material.id,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  } satisfies TotpEnvelopeV1);
}

function parseEnvelope(serialized: string): TotpEnvelopeV1 {
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid TOTP envelope");
  const envelope = value as Partial<TotpEnvelopeV1>;
  const keys = Object.keys(value);
  const expected = ["alg", "ciphertext", "iv", "keyId", "tag", "v"];
  if (
    keys.sort().join("\0") !== expected.join("\0") ||
    envelope.v !== 1 ||
    envelope.alg !== "A256GCM" ||
    typeof envelope.keyId !== "string" ||
    !KEY_ID_PATTERN.test(envelope.keyId) ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.tag !== "string"
  ) {
    throw new Error("Unsupported TOTP envelope");
  }
  for (const encoded of [envelope.iv, envelope.ciphertext, envelope.tag]) {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) {
      throw new Error("Invalid TOTP envelope encoding");
    }
  }
  if (Buffer.from(envelope.iv, "base64url").byteLength !== 12 || Buffer.from(envelope.tag, "base64url").byteLength !== 16) {
    throw new Error("Invalid TOTP envelope parameters");
  }
  return envelope as TotpEnvelopeV1;
}

export function decryptAdminTotpSecret(
  provider: KeyProvider,
  adminId: string,
  serialized: string,
): Buffer {
  const envelope = parseEnvelope(serialized);
  const material = provider.get(envelope.keyId);
  if (!material) throw new Error("TOTP envelope key is unavailable");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveTotpKey(material),
    Buffer.from(envelope.iv, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(totpAad(adminId));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

interface AdminTotpRow {
  totp_secret_envelope: string | null;
  totp_last_counter: number | null;
}

export function consumeAdminTotp(
  db: ControlDatabase,
  provider: KeyProvider,
  adminId: string,
  code: string,
  nowMs: number,
): boolean {
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const row = db.sqlite.prepare(`
      SELECT totp_secret_envelope, totp_last_counter FROM admins
      WHERE id = ? AND status = 'active'
    `).get(adminId) as AdminTotpRow | undefined;
    if (!row?.totp_secret_envelope) {
      db.sqlite.exec("COMMIT");
      return false;
    }
    let counter: number | undefined;
    try {
      const secret = decryptAdminTotpSecret(provider, adminId, row.totp_secret_envelope);
      counter = verifyTotp(secret, code, nowMs, row.totp_last_counter ?? undefined);
    } catch {
      counter = undefined;
    }
    if (counter === undefined) {
      db.sqlite.exec("COMMIT");
      return false;
    }
    const result = db.sqlite.prepare(`
      UPDATE admins SET totp_last_counter = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'active'
        AND (totp_last_counter IS NULL OR totp_last_counter < ?)
    `).run(counter, nowMs, adminId, counter);
    db.sqlite.exec("COMMIT");
    return result.changes === 1;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}
