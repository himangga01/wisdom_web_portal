import {
  computePublishedArticleContentSha256,
  type PublishedArticleDocument,
} from "@wisdom/shared";
import { describe, expect, it } from "vitest";

import {
  ARTICLE_REQUIRED_ANSWER_SECTION_IDS,
  SERVICE_REQUIRED_ANSWER_SECTION_IDS,
  assertArticlePublicationQuality,
  assertServicePublicationQuality,
  buildServicePublication,
} from "./quality-gate.js";

const articleWithoutHash: Omit<PublishedArticleDocument, "contentSha256"> = {
  schemaVersion: 1,
  articleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  locale: "en",
  slug: "reviewed-guide",
  revisionId: "11111111-1111-4111-8111-111111111111",
  route: "/en/insights/reviewed-guide",
  title: "Reviewed guide",
  summary: "A reviewed and sourced guide for a defined administrative question.",
  bodyMarkdown: "## What to confirm\n\nConfirm the current requirements before filing.\n",
  bodyHtml: "<h2>What to confirm</h2>\n<p>Confirm the current requirements before filing.</p>",
  revisionCreatedAt: "2026-07-01T00:00:00.000Z",
  approvedAt: "2026-07-02T00:00:00.000Z",
  firstPublishedAt: "2026-07-03T00:00:00.000Z",
  modifiedAt: "2026-07-04T00:00:00.000Z",
  reviewer: { name: "Jihye Kang", role: "Administrative Attorney" },
  sources: [{
    id: "official-source",
    url: "https://www.gov.kr/",
    sourceTimestamp: "2026-06-30T00:00:00.000Z",
  }],
};
const article: PublishedArticleDocument = {
  ...articleWithoutHash,
  contentSha256: computePublishedArticleContentSha256({
    title: articleWithoutHash.title,
    summary: articleWithoutHash.summary,
    bodyMarkdown: articleWithoutHash.bodyMarkdown,
    sources: articleWithoutHash.sources,
    locale: articleWithoutHash.locale,
  }),
};

describe("search publication quality gate", () => {
  it("builds complete, deterministic localized service evidence", () => {
    const publication = buildServicePublication("en", "procurement");

    expect(publication.answerSections.map(({ id }) => id))
      .toEqual(SERVICE_REQUIRED_ANSWER_SECTION_IDS);
    expect(publication.title).toContain(publication.h1);
    expect(publication.description).toBe(publication.summary);
    expect(publication.reviewer.name).toBe("Jihye Kang");
    expect(publication.reviewer.role).toBe("Representative Administrative Attorney");
    expect(publication.revisionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(publication.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(publication.sources).toEqual([
      expect.objectContaining({ url: "https://www.pps.go.kr/" }),
    ]);
    expect(() => assertServicePublicationQuality(publication)).not.toThrow();
    expect(buildServicePublication("en", "procurement")).toEqual(publication);
  });

  it.each([
    (value: ReturnType<typeof buildServicePublication>) => ({ ...value, title: "" }),
    (value: ReturnType<typeof buildServicePublication>) => ({ ...value, sources: [] }),
    (value: ReturnType<typeof buildServicePublication>) => ({
      ...value,
      answerSections: value.answerSections.filter(({ id }) => id !== "preparation"),
    }),
    (value: ReturnType<typeof buildServicePublication>) => ({
      ...value,
      contentSha256: "0".repeat(64),
    }),
  ])("rejects an incomplete or unapproved service publication", (mutate) => {
    const publication = buildServicePublication("en", "procurement");
    expect(() => assertServicePublicationQuality(mutate(publication)))
      .toThrow("SERVICE_CONTENT_QUALITY_FAILED");
  });

  it("requires reviewed article evidence and a visible answer section", () => {
    expect(ARTICLE_REQUIRED_ANSWER_SECTION_IDS).toEqual(["answer"]);
    expect(() => assertArticlePublicationQuality(article)).not.toThrow();

    for (const invalid of [
      { ...article, reviewer: { ...article.reviewer, name: "" } },
      { ...article, sources: [] },
      { ...article, bodyMarkdown: "No reviewed heading.", bodyHtml: "<p>No reviewed heading.</p>" },
      { ...article, contentSha256: "not-a-hash" },
    ]) {
      expect(() => assertArticlePublicationQuality(invalid))
        .toThrow("ARTICLE_CONTENT_QUALITY_FAILED");
    }
  });
});
