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
        테스트 알림을 대기열에 넣었습니다. 발송에 실패했거나 채널 설정 문제로 취소된 경우에만 <a href="/admin/failures">발송 실패</a> 화면에 표시됩니다.
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

// String-returning wrappers so remaining string-template call sites in routes.ts
// can compose these components.
export function backLinkHtml(href: string, label: string): string {
  return renderToHtml(<BackLink href={href} label={label} />);
}

export function errorBodyHtml(heading: string, message: string, backHref: string, backLabel: string): string {
  return renderToHtml(<ErrorBody heading={heading} message={message} backHref={backHref} backLabel={backLabel} />);
}
