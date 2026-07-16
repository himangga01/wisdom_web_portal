import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const MAX_SOURCE_BYTES = 240 * 1_024;
const MAX_RENDERED_BYTES = 512 * 1_024;

export type ArticleMarkdownValidationCode =
  | "invalid-type"
  | "empty"
  | "source-too-large"
  | "rendered-too-large"
  | "control-character"
  | "malformed-structure"
  | "raw-html"
  | "image"
  | "unsafe-link";

export class ArticleMarkdownValidationError extends Error {
  readonly code: ArticleMarkdownValidationCode;

  constructor(code: ArticleMarkdownValidationCode, message: string) {
    super(message);
    this.name = "ArticleMarkdownValidationError";
    this.code = code;
  }
}

export interface NormalizedArticleMarkdown {
  bodyMarkdown: string;
  bodyHtml: string;
}

interface MarkdownSyntaxNode {
  type: string;
  url?: unknown;
  identifier?: unknown;
  value?: unknown;
  children?: MarkdownSyntaxNode[];
}

const ARTICLE_SANITIZE_SCHEMA: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  ...defaultSchema,
  tagNames: [
    "a",
    "blockquote",
    "br",
    "code",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "ul",
  ],
  attributes: {
    a: ["href", "title"],
    code: [["className", /^language-[a-z0-9][a-z0-9-]{0,31}$/]],
    ol: ["start"],
  },
  protocols: { href: ["https"] },
};

const articleProcessor = unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeSanitize, ARTICLE_SANITIZE_SCHEMA)
  .use(rehypeStringify);

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function fail(code: ArticleMarkdownValidationCode, message: string): never {
  throw new ArticleMarkdownValidationError(code, message);
}

function normalizeMarkdown(input: string): string {
  if (typeof input !== "string") fail("invalid-type", "Article Markdown must be a string");
  const normalized = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .replace(/^[\t ]+$/gm, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  if (normalized.trim().length === 0) fail("empty", "Article Markdown must not be empty");
  const canonical = `${normalized}\n`;
  if (utf8ByteLength(canonical) > MAX_SOURCE_BYTES) {
    fail("source-too-large", "Article Markdown exceeds the source byte limit");
  }
  return canonical;
}

function validateCharacters(markdown: string): void {
  for (const character of markdown) {
    if (character !== "\n" && character !== "\t" && /\p{Cc}/u.test(character)) {
      fail("control-character", "Article Markdown contains a control character");
    }
    if (/[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(character)) {
      fail("control-character", "Article Markdown contains an invisible control character");
    }
  }
}

function validateFencedCodeBlocks(markdown: string): void {
  let active: { marker: "`" | "~"; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    if (!active) {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (opening) active = { marker: opening[0] as "`" | "~", length: opening.length };
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line)?.[1];
    if (closing?.[0] === active.marker && closing.length >= active.length) active = undefined;
  }
  if (active) fail("malformed-structure", "Article Markdown contains an unclosed code fence");
}

function validateHttpsLink(url: unknown): void {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    fail("unsafe-link", "Article links must use HTTPS");
  }
  if (
    !/^https:\/\/[^\s\\/?#]+(?:[/?#][^\s\\<>"'`]*)?$/u.test(url)
    || /%(?![a-f0-9]{2})/iu.test(url)
  ) {
    fail("unsafe-link", "Article links must be valid HTTPS URLs");
  }
  const authority = url.slice("https://".length).split(/[/?#]/u, 1)[0]!;
  if (authority.includes("@")) {
    fail("unsafe-link", "Article links must be credential-free HTTPS URLs");
  }
}

function normalizeReferenceIdentifier(value: string): string {
  return value.trim().replace(/[\t\n ]+/g, " ").toLowerCase();
}

function collectDefinitions(node: MarkdownSyntaxNode, definitions: Set<string>): void {
  if (node.type === "definition" && typeof node.identifier === "string") {
    const identifier = normalizeReferenceIdentifier(node.identifier);
    if (definitions.has(identifier)) {
      fail("malformed-structure", "Article Markdown contains a duplicate reference definition");
    }
    definitions.add(identifier);
  }
  for (const child of node.children ?? []) collectDefinitions(child, definitions);
}

function validateSyntaxTree(node: MarkdownSyntaxNode, definitions: ReadonlySet<string>): void {
  if (node.type === "html") fail("raw-html", "Raw HTML is not allowed in article Markdown");
  if (node.type === "image" || node.type === "imageReference") {
    fail("image", "Images are not allowed in article Markdown");
  }
  if (node.type === "link" || node.type === "definition") validateHttpsLink(node.url);
  if (node.type === "linkReference" && typeof node.identifier === "string") {
    if (!definitions.has(normalizeReferenceIdentifier(node.identifier))) {
      fail("malformed-structure", "Article Markdown contains an unresolved reference");
    }
  }
  if (node.type === "text" && typeof node.value === "string") {
    for (const match of node.value.matchAll(/\[[^\]\n]+\]\[([^\]\n]+)\]/gu)) {
      const identifier = match[1];
      if (identifier && !definitions.has(normalizeReferenceIdentifier(identifier))) {
        fail("malformed-structure", "Article Markdown contains an unresolved reference");
      }
    }
  }
  for (const child of node.children ?? []) validateSyntaxTree(child, definitions);
}

export function normalizeValidateAndRenderArticleMarkdown(input: string): NormalizedArticleMarkdown {
  const bodyMarkdown = normalizeMarkdown(input);
  validateCharacters(bodyMarkdown);
  validateFencedCodeBlocks(bodyMarkdown);
  const markdownTree = articleProcessor.parse(bodyMarkdown);
  const definitions = new Set<string>();
  collectDefinitions(markdownTree as MarkdownSyntaxNode, definitions);
  validateSyntaxTree(markdownTree as MarkdownSyntaxNode, definitions);
  const htmlTree = articleProcessor.runSync(markdownTree);
  const bodyHtml = String(articleProcessor.stringify(htmlTree));
  if (utf8ByteLength(bodyHtml) > MAX_RENDERED_BYTES) {
    fail("rendered-too-large", "Rendered article HTML exceeds the byte limit");
  }
  return { bodyMarkdown, bodyHtml };
}
