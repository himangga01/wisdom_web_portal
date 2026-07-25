import type { HtmlEscapedString } from "hono/utils/html";

// Admin UI components are synchronous — all data is passed as props, no async
// component fetches — so a rendered JSX element is already an HTML string
// (hono/jsx's HtmlEscapedString). These helpers centralise that contract during
// the incremental migration from string templates to JSX components.

type RenderedElement = HtmlEscapedString | Promise<HtmlEscapedString>;

export function renderToHtml(node: RenderedElement): string {
  // hono/jsx types every element as possibly-async, and `String(aPromise)` would
  // quietly put "[object Promise]" on the operator's screen. Fail loudly instead
  // so an accidentally async component is caught by the tests, not in production.
  if (typeof (node as { then?: unknown }).then === "function") {
    throw new Error("Admin UI components must render synchronously");
  }
  return String(node);
}

export function renderDocument(node: RenderedElement): string {
  return `<!doctype html>${renderToHtml(node)}`;
}
