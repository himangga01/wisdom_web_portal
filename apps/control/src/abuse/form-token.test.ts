import { describe, expect, it } from "vitest";

import { createStaticKeyProvider } from "../crypto/index.js";
import { issueFormToken, verifyFormToken } from "./form-token.js";

const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 7) });
const binding = {
  locale: "en" as const,
  releaseId: "release-2026-07-25",
  bundleId: "bundle-2026-07-25",
  manifestSha256: "a".repeat(64),
  privacyVersion: "privacy-v1",
  marketingVersion: "marketing-v1",
};

describe("signed consultation form token", () => {
  it("enforces future, two-second minimum and two-hour maximum boundaries", () => {
    const issuedAtMs = 10_000;
    const token = issueFormToken(provider, binding, issuedAtMs, "nonce-1");

    for (const nowMs of [9_999, 11_999, 7_210_000]) {
      expect(() => verifyFormToken(provider, token, binding, nowMs), String(nowMs)).toThrow();
    }
    expect(verifyFormToken(provider, token, binding, 12_000)).toMatchObject(binding);
    expect(verifyFormToken(provider, token, binding, 7_209_999)).toMatchObject(binding);
  });

  it("rejects tampering, wrong consent bindings and missing rotation keys", () => {
    const token = issueFormToken(provider, binding, 10_000, "nonce-1");
    expect(() => verifyFormToken(provider, `${token}x`, binding, 12_000)).toThrow();
    expect(() => verifyFormToken(provider, token, { ...binding, privacyVersion: "privacy-v2" }, 12_000)).toThrow();
    expect(() => verifyFormToken(provider, token, { ...binding, releaseId: "release-other" }, 12_000)).toThrow();
    expect(() => verifyFormToken(provider, token, { ...binding, bundleId: "bundle-other" }, 12_000)).toThrow();
    expect(() => verifyFormToken(provider, token, {
      ...binding,
      manifestSha256: "b".repeat(64),
    }, 12_000)).toThrow();
    expect(() => verifyFormToken(
      createStaticKeyProvider({ id: "pii-v2", secret: Buffer.alloc(32, 8) }),
      token,
      binding,
      12_000,
    )).toThrow();
  });
});
