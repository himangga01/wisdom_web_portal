import { describe, expect, it } from "vitest";

import {
  computePublishedConsentDocumentSha256,
  publishedConsentBundleSchema,
  type PublishedConsentDocument,
} from "./index.js";

const locales = ["ko", "en", "zh-Hans", "zh-Hant"] as const;

function document(
  locale: (typeof locales)[number],
  kind: "privacy" | "marketing",
): PublishedConsentDocument {
  const value = {
    kind,
    locale,
    version: `${kind}-2026-07-16`,
    title: `${kind} ${locale}`,
    bodyMarkdown: `<script>alert("${locale}")</script>\n\nExact ${kind} body for ${locale}.`,
    effectiveAt: "2026-07-16T00:00:00.000Z",
    retentionMonths: kind === "privacy" ? 12 as const : 24 as const,
    required: kind === "privacy",
  };
  return { ...value, contentSha256: computePublishedConsentDocumentSha256(value) };
}

function bundle() {
  return {
    schemaVersion: 1 as const,
    bundleId: "bundle-2026-07-16",
    documents: locales.flatMap((locale) => [
      document(locale, "privacy"),
      document(locale, "marketing"),
    ]),
  };
}

describe("published consent bundle", () => {
  it("accepts exactly one immutable privacy and marketing document per launch locale", () => {
    expect(publishedConsentBundleSchema.parse(bundle())).toEqual(bundle());
  });

  it.each([
    (value: ReturnType<typeof bundle>) => ({ ...value, documents: value.documents.slice(1) }),
    (value: ReturnType<typeof bundle>) => ({ ...value, documents: [...value.documents, value.documents[0]!] }),
    (value: ReturnType<typeof bundle>) => ({
      ...value,
      documents: value.documents.map((item, index) => index === 0
        ? { ...item, retentionMonths: 24 }
        : item),
    }),
    (value: ReturnType<typeof bundle>) => ({
      ...value,
      documents: value.documents.map((item, index) => index === 0
        ? { ...item, contentSha256: "0".repeat(64) }
        : item),
    }),
    (value: ReturnType<typeof bundle>) => ({
      ...value,
      documents: value.documents.map((item, index) => index === 0
        ? { ...item, effectiveAt: "2026-07-17T00:00:00.000Z" }
        : item),
    }),
  ])("fails closed when the active eight-document contract is incomplete or inconsistent", (mutate) => {
    expect(publishedConsentBundleSchema.safeParse(mutate(bundle())).success).toBe(false);
  });
});
