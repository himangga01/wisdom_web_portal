import { describe, expect, it } from "vitest";

import * as sharedModule from "./index.js";
import type { MarketingConsent, PrivacyConsent } from "./index.js";

interface RuntimeSchema {
  parse(input: unknown): unknown;
}

const shared = sharedModule as unknown as Record<string, unknown>;

function publicSchema(name: string): RuntimeSchema {
  const candidate = shared[name];
  expect(candidate, `${name} must be exported by @wisdom/shared`).toBeDefined();
  return candidate as RuntimeSchema;
}

describe("@wisdom/shared public consent contracts", () => {
  it("exports named privacy and marketing consent schemas with inferred types", () => {
    const privacyConsent: PrivacyConsent = {
      version: "2026-07-15",
      accepted: true,
    };
    const marketingConsent: MarketingConsent = {
      version: "2026-07-15",
      accepted: false,
    };

    expect(publicSchema("privacyConsentSchema").parse(privacyConsent)).toEqual(privacyConsent);
    expect(publicSchema("marketingConsentSchema").parse(marketingConsent)).toEqual(
      marketingConsent,
    );
  });
});
