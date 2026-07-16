import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  canonicalPublishedArticleContentBytes,
  computePublishedArticleContentSha256,
} from "./article-content.js";

const sourceA = {
  id: "a",
  url: "https://a.example/source",
  sourceTimestamp: "2026-07-16T00:00:00.000Z",
};
const sourceB = {
  id: "b",
  url: "https://b.example/source",
  sourceTimestamp: "2026-07-16T01:00:00.000Z",
};

describe("published article semantic content authority", () => {
  it("uses one exact field order, normalized Markdown, and source-id ordering", () => {
    const input = {
      locale: "en" as const,
      sources: [sourceB, sourceA],
      bodyMarkdown: "## Body\r\n",
      summary: "Summary",
      title: "Guide",
    };
    const expectedJson = JSON.stringify({
      title: "Guide",
      summary: "Summary",
      bodyMarkdown: "## Body\n",
      sources: [sourceA, sourceB],
      locale: "en",
    });

    expect(canonicalPublishedArticleContentBytes(input)).toEqual(utf8ToBytes(expectedJson));
    expect(computePublishedArticleContentSha256(input)).toBe(
      "9b9d607ae9e59d55c94978ca3b1525879ea5c8535578845bea82764c9cbb9c66",
    );
    expect(input.sources).toEqual([sourceB, sourceA]);
  });

  it("normalizes Unicode in semantic text before hashing", () => {
    const base = {
      locale: "en" as const,
      title: "Cafe\u0301 guide",
      summary: "Re\u0301sume\u0301",
      bodyMarkdown: "Cafe\u0301\n",
      sources: [sourceA],
    };
    expect(computePublishedArticleContentSha256(base)).toBe(
      computePublishedArticleContentSha256({
        ...base,
        title: "Caf\u00e9 guide",
        summary: "R\u00e9sum\u00e9",
        bodyMarkdown: "Caf\u00e9\n",
      }),
    );
  });

  it("rejects ambiguous, unsafe, or non-strict semantic payloads", () => {
    const valid = {
      locale: "ko" as const,
      title: "Guide",
      summary: "Summary",
      bodyMarkdown: "## Body\n",
      sources: [sourceA],
    };
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, bodyMarkdown: "<script>alert(1)</script>" },
      { ...valid, sources: [sourceA, sourceA] },
      { ...valid, sources: [sourceA, { ...sourceB, url: sourceA.url }] },
      { ...valid, sources: [{ ...sourceA, url: "http://a.example/source" }] },
      { ...valid, locale: "fr" },
    ]) expect(() => canonicalPublishedArticleContentBytes(invalid)).toThrow();
  });
});
