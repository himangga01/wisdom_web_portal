import { describe, expect, it } from "vitest";

import {
  blindIndex,
  blindIndexCandidates,
  createStaticKeyProvider,
  decryptPii,
  encryptPii,
  keyedDigest,
} from "./index.js";

const pii = {
  name: "Hong Gildong",
  phone: "+821012345678",
  email: "Client@Example.COM",
  company: "Wisdom Co.",
  message: "Please review our public procurement registration plan.",
};

const active = { id: "pii-v2", secret: Buffer.alloc(32, 2) };
const previous = { id: "pii-v1", secret: Buffer.alloc(32, 1) };

function flipFirstEncodedByte(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64url");
}

describe("versioned consultation cryptography", () => {
  it("rejects every active or previous key ID the envelope grammar cannot parse", () => {
    for (const id of ["pii v1", " pii-v1", "pii-v1 ", "pii/v1", "x".repeat(65)] as const) {
      expect(() => createStaticKeyProvider({ id, secret: Buffer.alloc(32, 1) }), id).toThrow(/key id/i);
      expect(() => createStaticKeyProvider(active, [{ id, secret: Buffer.alloc(32, 1) }]), id).toThrow(/key id/i);
    }
    expect(() => createStaticKeyProvider({ id: "A.z_9-1", secret: Buffer.alloc(32, 1) })).not.toThrow();
  });

  it("round-trips a versioned AES-256-GCM envelope with random IVs", () => {
    const provider = createStaticKeyProvider(active, [previous]);
    const first = encryptPii(provider, "consultation-1", pii);
    const second = encryptPii(provider, "consultation-1", pii);

    expect(first).not.toBe(second);
    expect(JSON.parse(first)).toMatchObject({ v: 1, alg: "A256GCM", keyId: "pii-v2" });
    expect(decryptPii(provider, "consultation-1", first)).toEqual(pii);
  });

  it("rejects ciphertext/tag tampering, wrong AAD and unavailable keys", () => {
    const provider = createStaticKeyProvider(active, [previous]);
    const serialized = encryptPii(provider, "consultation-1", pii);
    const envelope = JSON.parse(serialized) as {
      ciphertext: string;
      tag: string;
      keyId: string;
    };

    for (const field of ["ciphertext", "tag"] as const) {
      const tampered = { ...envelope, [field]: flipFirstEncodedByte(envelope[field]) };
      expect(() => decryptPii(provider, "consultation-1", JSON.stringify(tampered)), field).toThrow();
    }
    expect(() => decryptPii(provider, "consultation-2", encryptPii(provider, "consultation-1", pii))).toThrow();

    const oldProvider = createStaticKeyProvider(previous);
    const oldEnvelope = encryptPii(oldProvider, "consultation-1", pii);
    expect(decryptPii(provider, "consultation-1", oldEnvelope)).toEqual(pii);
    expect(() => decryptPii(createStaticKeyProvider(active), "consultation-1", oldEnvelope)).toThrow();
  });

  it("rejects non-canonical or extensible envelope shapes before decryption", () => {
    const provider = createStaticKeyProvider(active);
    const valid = JSON.parse(encryptPii(provider, "consultation-1", pii)) as Record<string, unknown>;

    for (const invalid of [
      { ...valid, extra: "metadata" },
      { ...valid, keyId: "" },
      { ...valid, iv: "not+base64/url" },
      { ...valid, iv: Buffer.alloc(11).toString("base64url") },
      { ...valid, tag: Buffer.alloc(15).toString("base64url") },
      { ...valid, ciphertext: `${String(valid.ciphertext)}=` },
    ]) {
      expect(() => decryptPii(provider, "consultation-1", JSON.stringify(invalid))).toThrow();
    }
  });

  it("normalizes exact blind indexes and separates every HMAC purpose", () => {
    const provider = createStaticKeyProvider(active);
    expect(blindIndex(provider, "email", " Client@Example.COM ")).toEqual(
      blindIndex(provider, "email", "client@example.com"),
    );
    expect(blindIndex(provider, "phone", "+82 (10) 1234-5678")).toEqual(
      blindIndex(provider, "phone", "+821012345678"),
    );
    expect(blindIndex(provider, "email", "+821012345678")).not.toEqual(
      blindIndex(provider, "phone", "+821012345678"),
    );
    expect(keyedDigest(provider, "idempotency", "same-value")).not.toEqual(
      keyedDigest(provider, "request-fingerprint", "same-value"),
    );
    expect(() => blindIndex(provider, "phone", "010/1234/5678")).toThrow();
  });

  it("builds active and previous blind-index candidates with their key IDs", () => {
    const provider = createStaticKeyProvider(active, [previous], Buffer.alloc(32, 10));
    const candidates = blindIndexCandidates(provider, "phone", "+82 (10) 1234-5678");

    expect(candidates).toEqual([
      { keyId: "pii-v2", index: blindIndex(provider, "phone", "+821012345678", "pii-v2") },
      { keyId: "pii-v1", index: blindIndex(provider, "phone", "+821012345678", "pii-v1") },
    ]);
  });

  it("keeps encryption rooted in PII keys and every HMAC purpose rooted independently", () => {
    const hmacA = Buffer.alloc(32, 10);
    const hmacB = Buffer.alloc(32, 11);
    const providerA = createStaticKeyProvider(active, [], hmacA);
    const providerB = createStaticKeyProvider(active, [], hmacB);
    const envelope = encryptPii(providerA, "consultation-1", pii);

    expect(decryptPii(providerB, "consultation-1", envelope)).toEqual(pii);
    expect(blindIndex(providerA, "email", "client@example.com")).not.toEqual(
      blindIndex(providerB, "email", "client@example.com"),
    );

    const differentPiiSameId = { id: active.id, secret: Buffer.alloc(32, 12) };
    const providerC = createStaticKeyProvider(differentPiiSameId, [], hmacA);
    expect(blindIndex(providerA, "email", "client@example.com")).toEqual(
      blindIndex(providerC, "email", "client@example.com"),
    );
    expect(() => decryptPii(providerC, "consultation-1", envelope)).toThrow();
  });
});
