import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthDigestPurpose =
  | "recovery-code"
  | "preauth-challenge"
  | "preauth-csrf"
  | "session-token"
  | "session-csrf"
  | "login-username"
  | "login-source";

export function authDigest(
  secret: Uint8Array,
  purpose: AuthDigestPurpose,
  ...parts: readonly string[]
): Buffer {
  if (secret.byteLength < 32) throw new Error("Authentication digest secret must contain at least 32 bytes");
  const hmac = createHmac("sha256", secret);
  hmac.update(`wisdom:admin-${purpose}:v1`, "utf8");
  for (const part of parts) hmac.update("\0", "utf8").update(part, "utf8");
  return hmac.digest();
}

export function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
