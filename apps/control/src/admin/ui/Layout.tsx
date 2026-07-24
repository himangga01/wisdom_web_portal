import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";

import { renderDocument } from "./render.js";
import { ADMIN_STYLE } from "./styles.js";

const AdminDocument: FC<PropsWithChildren<{ title: string; lang: string }>> = ({ title, lang, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title}</title>
      <style>{raw(ADMIN_STYLE)}</style>
    </head>
    <body>{children}</body>
  </html>
);

const AdminNav: FC = () => (
  <nav>
    <a href="/admin/consultations">상담</a>{" "}
    <a href="/admin/analytics">통계</a>{" "}
    <a href="/admin/articles">글</a>{" "}
    <a href="/admin/releases">릴리스</a>{" "}
    <a href="/admin/notifications">알림</a>{" "}
    <a href="/admin/consents">동의문</a>{" "}
    <a href="/admin/failures">발송 실패</a>{" "}
    <a href="/admin/health">상태</a>
  </nav>
);

// Full administrator chrome: brand, navigation, and (when signed in) a sign-out
// control. `bodyHtml` is injected raw during the incremental migration; screens
// are converted to JSX children over subsequent phases.
export function renderAdminPage(
  title: string,
  bodyHtml: string,
  lang = "ko",
  csrfToken?: string,
): string {
  return renderDocument(
    <AdminDocument title={title} lang={lang}>
      <header>
        <a href="/admin">지혜 관리자</a>
        <AdminNav />
        {csrfToken === undefined ? null : (
          <form method="post" action="/admin/logout">
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit">로그아웃</button>
          </form>
        )}
      </header>
      <main>{raw(bodyHtml)}</main>
    </AdminDocument>,
  );
}

// Customer-facing / chromeless pages (marketing withdrawal, sign-in failure):
// same document shell and styling but no administrator navigation.
export function renderPlainPage(title: string, bodyHtml: string, lang = "ko"): string {
  return renderDocument(
    <AdminDocument title={title} lang={lang}>
      <main>{raw(bodyHtml)}</main>
    </AdminDocument>,
  );
}
