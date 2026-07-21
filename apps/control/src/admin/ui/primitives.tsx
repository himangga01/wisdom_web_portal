import type { FC, PropsWithChildren } from "hono/jsx";

import { renderToHtml } from "./render.js";

export const EmptyState: FC<PropsWithChildren> = ({ children }) => (
  <p class="muted">{children}</p>
);

export const BackLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <p><a href={href}>{label}</a></p>
);

export const Banner: FC<PropsWithChildren<{ tone: "ok" | "error" }>> = ({ tone, children }) => (
  <p class={`banner banner-${tone}`}>{children}</p>
);

const ErrorBody: FC<{ heading: string; message: string; backHref: string; backLabel: string }> = ({
  heading,
  message,
  backHref,
  backLabel,
}) => (
  <>
    <h1>{heading}</h1>
    <p>{message}</p>
    <BackLink href={backHref} label={backLabel} />
  </>
);

// Ordered Post/Redirect/Get success flags; the first present query flag wins.
export const SAVED_BANNER_FLAGS = ["saved", "published", "rolledback", "sent"] as const;
export type SavedBannerFlag = (typeof SAVED_BANNER_FLAGS)[number];

export function savedBannerHtml(flag: SavedBannerFlag): string {
  const banner = flag === "sent"
    ? (
      <Banner tone="ok">
        테스트 알림을 대기열에 넣었습니다. 발송 결과는 <a href="/admin/failures">발송 실패</a> 화면에서 확인하세요.
      </Banner>
    )
    : (
      <Banner tone="ok">
        {{
          saved: "저장되었습니다.",
          published: "새 버전을 발행했습니다.",
          rolledback: "이전 발행본으로 롤백했습니다.",
        }[flag]}
      </Banner>
    );
  return renderToHtml(banner);
}

// String-returning wrappers so existing string-template call sites in routes.ts
// can adopt components incrementally before the whole file becomes JSX.
export function emptyStateHtml(message: string): string {
  return renderToHtml(<EmptyState>{message}</EmptyState>);
}

export function backLinkHtml(href: string, label: string): string {
  return renderToHtml(<BackLink href={href} label={label} />);
}

export function errorBodyHtml(heading: string, message: string, backHref: string, backLabel: string): string {
  return renderToHtml(<ErrorBody heading={heading} message={message} backHref={backHref} backLabel={backLabel} />);
}
