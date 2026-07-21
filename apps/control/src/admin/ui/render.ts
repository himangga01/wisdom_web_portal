import type { HtmlEscapedString } from "hono/utils/html";

// Admin UI components are synchronous — all data is passed as props, no async
// component fetches — so a rendered JSX element is already an HTML string
// (hono/jsx's HtmlEscapedString). These helpers centralise that contract during
// the incremental migration from string templates to JSX components.

type RenderedElement = HtmlEscapedString | Promise<HtmlEscapedString>;

export function renderToHtml(node: RenderedElement): string {
  return String(node);
}

export function renderDocument(node: RenderedElement): string {
  return `<!doctype html>${renderToHtml(node)}`;
}
