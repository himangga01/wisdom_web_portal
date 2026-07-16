import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

type SitemapErrorCode =
  | "PUBLICATION_SITEMAP_DTD_FORBIDDEN"
  | "PUBLICATION_SITEMAP_XML_INVALID";

class SitemapParseError extends Error {
  constructor(readonly code: SitemapErrorCode) {
    super(code);
  }
}

interface OpenElement {
  local: string;
  uri: string;
  text: string;
}

function fail(code: SitemapErrorCode): never {
  throw new SitemapParseError(code);
}

function attributes(tag: SaxesTagNS): SaxesAttributeNS[] {
  return Object.values(tag.attributes);
}

function requireNoAttributes(tag: SaxesTagNS): void {
  if (attributes(tag).length !== 0) fail("PUBLICATION_SITEMAP_XML_INVALID");
}

function validateRoot(tag: SaxesTagNS): void {
  if (tag.local !== "urlset" || tag.prefix !== "" || tag.uri !== SITEMAP_NAMESPACE) {
    fail("PUBLICATION_SITEMAP_XML_INVALID");
  }
  const actual = new Map(attributes(tag).map((attribute) => [attribute.name, attribute.value]));
  const allowed = new Set(["xmlns", "xmlns:xhtml"]);
  if ([...actual.keys()].some((name) => !allowed.has(name))
    || actual.get("xmlns") !== SITEMAP_NAMESPACE
    || (actual.has("xmlns:xhtml") && actual.get("xmlns:xhtml") !== XHTML_NAMESPACE)) {
    fail("PUBLICATION_SITEMAP_XML_INVALID");
  }
}

function validateAlternate(tag: SaxesTagNS): void {
  if (!tag.isSelfClosing || tag.prefix !== "xhtml" || tag.uri !== XHTML_NAMESPACE) {
    fail("PUBLICATION_SITEMAP_XML_INVALID");
  }
  const actual = new Map(attributes(tag).map((attribute) => [attribute.name, attribute.value]));
  if (actual.size !== 3
    || actual.get("rel") !== "alternate"
    || !actual.get("hreflang")
    || !actual.get("href")) {
    fail("PUBLICATION_SITEMAP_XML_INVALID");
  }
}

export function parsePublicationSitemapUrls(bytes: Buffer): string[] {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PUBLICATION_SITEMAP_XML_INVALID");
  }

  const parser = new SaxesParser({
    xmlns: true,
    fragment: false,
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  const stack: OpenElement[] = [];
  const urls: string[] = [];
  let sawDeclaration = false;
  let sawRoot = false;
  let currentUrlLocCount = 0;

  parser.on("xmldecl", (declaration) => {
    sawDeclaration = true;
    if (declaration.version !== "1.0"
      || declaration.encoding?.toUpperCase() !== "UTF-8"
      || declaration.standalone !== undefined) {
      fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
  });
  parser.on("doctype", () => fail("PUBLICATION_SITEMAP_DTD_FORBIDDEN"));
  parser.on("processinginstruction", () => fail("PUBLICATION_SITEMAP_XML_INVALID"));
  parser.on("cdata", () => fail("PUBLICATION_SITEMAP_XML_INVALID"));
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (!parent) {
      if (sawRoot) fail("PUBLICATION_SITEMAP_XML_INVALID");
      validateRoot(tag);
      sawRoot = true;
    } else if (parent.local === "urlset" && parent.uri === SITEMAP_NAMESPACE) {
      if (tag.local !== "url" || tag.prefix !== "" || tag.uri !== SITEMAP_NAMESPACE) {
        fail("PUBLICATION_SITEMAP_XML_INVALID");
      }
      requireNoAttributes(tag);
      currentUrlLocCount = 0;
    } else if (parent.local === "url" && parent.uri === SITEMAP_NAMESPACE) {
      if (tag.uri === SITEMAP_NAMESPACE && tag.prefix === "" && tag.local === "loc") {
        requireNoAttributes(tag);
        currentUrlLocCount += 1;
        if (currentUrlLocCount > 1) fail("PUBLICATION_SITEMAP_XML_INVALID");
      } else if (tag.uri === SITEMAP_NAMESPACE && tag.prefix === "" && tag.local === "lastmod") {
        requireNoAttributes(tag);
      } else if (tag.local === "link" && tag.uri === XHTML_NAMESPACE) {
        validateAlternate(tag);
      } else {
        fail("PUBLICATION_SITEMAP_XML_INVALID");
      }
    } else {
      fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
    stack.push({ local: tag.local, uri: tag.uri, text: "" });
  });
  parser.on("text", (text) => {
    const current = stack.at(-1);
    if (!current) {
      if (text.trim()) fail("PUBLICATION_SITEMAP_XML_INVALID");
      return;
    }
    if (current.uri === SITEMAP_NAMESPACE
      && (current.local === "loc" || current.local === "lastmod")) {
      current.text += text;
    } else if (text.trim()) {
      fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
  });
  parser.on("closetag", (tag) => {
    const current = stack.pop();
    if (!current || current.local !== tag.local || current.uri !== tag.uri) {
      fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
    if (current.uri === SITEMAP_NAMESPACE && current.local === "loc") {
      urls.push(current.text.trim());
    } else if (current.uri === SITEMAP_NAMESPACE && current.local === "lastmod") {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(current.text.trim())) {
        fail("PUBLICATION_SITEMAP_XML_INVALID");
      }
    } else if (current.uri === SITEMAP_NAMESPACE && current.local === "url") {
      if (currentUrlLocCount !== 1) fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
  });

  try {
    parser.write(xml).close();
    if (!sawDeclaration || !sawRoot || stack.length !== 0) {
      fail("PUBLICATION_SITEMAP_XML_INVALID");
    }
  } catch (error) {
    if (error instanceof SitemapParseError) throw new Error(error.code);
    throw new Error("PUBLICATION_SITEMAP_XML_INVALID");
  }
  return urls;
}
