import type { FC, PropsWithChildren } from "hono/jsx";

import { renderToHtml } from "./render.js";

export const EmptyState: FC<PropsWithChildren> = ({ children }) => (
  <p class="muted">{children}</p>
);

export const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <p><a href={href}>{label}</a></p>
);

// String-returning wrappers so existing string-template call sites in routes.ts
// can adopt components incrementally before the whole file becomes JSX.
export function emptyStateHtml(message: string): string {
  return renderToHtml(<EmptyState>{message}</EmptyState>);
}

export function backLinkHtml(href: string, label: string): string {
  return renderToHtml(<BackLink href={href} label={label} />);
}
