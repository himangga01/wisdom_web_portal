import { describe, expect, it } from "vitest";

import {
  ArticleMarkdownValidationError,
  normalizeValidateAndRenderArticleMarkdown,
} from "./article-markdown.js";

describe("article Markdown authority", () => {
  it("normalizes Unicode and line endings and renders deterministic sanitized HTML", () => {
    const decomposed = "\uFEFF\r\n## Guide\r\n\r\nCafe\u0301\r\n\r\n";
    const composed = "## Guide\n\nCaf\u00e9\n";

    const first = normalizeValidateAndRenderArticleMarkdown(decomposed);
    const second = normalizeValidateAndRenderArticleMarkdown(composed);

    expect(first).toEqual(second);
    expect(first).toEqual({
      bodyMarkdown: "## Guide\n\nCaf\u00e9\n",
      bodyHtml: "<h2>Guide</h2>\n<p>Caf\u00e9</p>",
    });
  });

  it("supports a small article-safe Markdown surface and credential-free HTTPS links", () => {
    const result = normalizeValidateAndRenderArticleMarkdown(`
## Guide

> Reviewed guidance.

- First
- **Second** and *emphasis*

[Official source](https://example.com/path?q=1#section)

\`\`\`text
safe <literal>
\`\`\`
`);

    expect(result.bodyHtml).toContain("<blockquote>");
    expect(result.bodyHtml).toContain("<ul>");
    expect(result.bodyHtml).toContain("<strong>Second</strong>");
    expect(result.bodyHtml).toContain("<em>emphasis</em>");
    expect(result.bodyHtml).toContain('href="https://example.com/path?q=1#section"');
    expect(result.bodyHtml).toContain("safe &#x3C;literal>");
    expect(result.bodyHtml).not.toMatch(/<script|<img|javascript:/i);
  });

  it("uses the Markdown AST to require H2 sections and reject body H1 headings", () => {
    expect(() => normalizeValidateAndRenderArticleMarkdown(
      "# Page title\n\n## Answer\n\nReviewed guidance.",
    )).toThrowError(expect.objectContaining({ code: "malformed-structure" }));
    expect(() => normalizeValidateAndRenderArticleMarkdown(
      "Reviewed guidance without a section heading.",
    )).toThrowError(expect.objectContaining({ code: "malformed-structure" }));

    const emphasized = normalizeValidateAndRenderArticleMarkdown(
      "## **Important answer**\n\nReviewed guidance.",
    );
    expect(emphasized.bodyHtml).toContain("<h2><strong>Important answer</strong></h2>");
    expect(emphasized.bodyHtml).not.toContain("<h1");
  });

  it.each([
    "Before <script>alert(1)</script> after",
    "<div>raw block</div>",
    "Before <span>raw inline</span> after",
  ])("rejects raw HTML: %s", (bodyMarkdown) => {
    expect(() => normalizeValidateAndRenderArticleMarkdown(bodyMarkdown)).toThrowError(
      expect.objectContaining({ code: "raw-html" }),
    );
  });

  it.each([
    "![alt](https://example.com/image.png)",
    "![alt][image]\n\n[image]: https://example.com/image.png",
    "![alt](data:image/png;base64,AAAA)",
  ])("rejects images: %s", (bodyMarkdown) => {
    expect(() => normalizeValidateAndRenderArticleMarkdown(bodyMarkdown)).toThrowError(
      expect.objectContaining({ code: "image" }),
    );
  });

  it.each([
    "[insecure](http://example.com)",
    "[email](mailto:office@example.com)",
    "[script](javascript:alert(1))",
    "[relative](/private)",
    "[protocol relative](//example.com/path)",
    "[credentials](https://user:secret@example.com/path)",
    "[reference][source]\n\n[source]: http://example.com",
  ])("rejects links that are not credential-free HTTPS URLs: %s", (bodyMarkdown) => {
    expect(() => normalizeValidateAndRenderArticleMarkdown(bodyMarkdown)).toThrowError(
      expect.objectContaining({ code: "unsafe-link" }),
    );
  });

  it.each(["safe\u0000unsafe", "safe\u001bunsafe", "safe\u202eunsafe"])(
    "rejects control and bidirectional override characters",
    (bodyMarkdown) => {
      expect(() => normalizeValidateAndRenderArticleMarkdown(bodyMarkdown)).toThrowError(
        expect.objectContaining({ code: "control-character" }),
      );
    },
  );

  it.each([
    "```text\nunclosed fence\n",
    "[missing reference][source]\n",
  ])("rejects malformed Markdown structure", (bodyMarkdown) => {
    expect(() => normalizeValidateAndRenderArticleMarkdown(bodyMarkdown)).toThrowError(
      expect.objectContaining({ code: "malformed-structure" }),
    );
  });

  it("accepts closed fences and resolved HTTPS references", () => {
    expect(normalizeValidateAndRenderArticleMarkdown(
      "## References\n\n```text\nclosed\n```\n\n[reference][source]\n\n[source]: https://example.com/source\n",
    ).bodyHtml).toContain('href="https://example.com/source"');
  });

  it("rejects empty, oversized source, and oversized rendered HTML", () => {
    expect(() => normalizeValidateAndRenderArticleMarkdown("\r\n\r\n")).toThrowError(
      expect.objectContaining({ code: "empty" }),
    );
    expect(() => normalizeValidateAndRenderArticleMarkdown("\uAC00".repeat(80 * 1_024 + 1))).toThrowError(
      expect.objectContaining({ code: "source-too-large" }),
    );
    expect(() => normalizeValidateAndRenderArticleMarkdown(
      `## Expanded\n\n${"&".repeat(200_000)}`,
    )).toThrowError(
      expect.objectContaining({ code: "rendered-too-large" }),
    );
  });

  it("exports a typed validation error without echoing rejected content", () => {
    try {
      normalizeValidateAndRenderArticleMarkdown("<script>private payload</script>");
      expect.fail("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ArticleMarkdownValidationError);
      expect((error as Error).message).not.toContain("private payload");
    }
  });
});
