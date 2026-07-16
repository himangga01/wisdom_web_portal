import {
  computePublishedConsentDocumentSha256,
  LOCALES,
  type PublishedConsentBundle,
  type PublishedManifest,
} from "@wisdom/shared";

export function testPublishedConsentBundle(): PublishedConsentBundle {
  return {
    schemaVersion: 1,
    bundleId: "bundle-2026-07-16",
    documents: LOCALES.flatMap((locale) => (["privacy", "marketing"] as const).map((kind) => {
      const semantic = {
        kind,
        locale,
        version: `${kind}-2026-07-16`,
        title: `${kind} ${locale}`,
        bodyMarkdown: kind === "privacy" && locale === "en"
          ? '<script>alert("text only")</script>\n\nExact privacy terms for en.'
          : `Exact ${kind} terms for ${locale}.`,
        retentionMonths: kind === "privacy" ? 12 as const : 24 as const,
      };
      return {
        ...semantic,
        contentSha256: computePublishedConsentDocumentSha256(semantic),
        effectiveAt: "2026-07-16T00:00:00.000Z",
        required: kind === "privacy",
      };
    })),
  };
}

export function testPublishedManifest(): PublishedManifest {
  return {
    schemaVersion: 1,
    entries: [],
    consentBundle: {
      contentFile: "consent-bundle.json",
      contentFileSha256: "a".repeat(64),
    },
  };
}
