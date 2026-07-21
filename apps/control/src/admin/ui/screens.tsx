import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";

import { EmptyState } from "./primitives.js";
import { renderToHtml } from "./render.js";

// Wraps a screen heading + optional success banner around the body. `banner` is
// pre-rendered HTML (from savedBanner); "" renders nothing.
const Screen: FC<PropsWithChildren<{ heading: string; banner?: string }>> = ({ heading, banner, children }) => (
  <>
    <h1>{heading}</h1>
    {banner ? raw(banner) : null}
    {children}
  </>
);

export function dashboardBodyHtml(
  counts: readonly { status: string; count: number }[],
  banner: string,
): string {
  return renderToHtml(
    <Screen heading="대시보드" banner={banner}>
      {counts.length === 0 ? <EmptyState>접수된 상담이 없습니다.</EmptyState> : (
        <ul>
          {counts.map((row) => (
            <li><a href="/admin/consultations">{row.status}: {row.count}</a></li>
          ))}
        </ul>
      )}
    </Screen>,
  );
}

export interface ArticleListRow {
  id: string;
  locale: string;
  state: string;
  row_version: number;
  title: string;
  updated_at_ms: number;
}

export function articlesBodyHtml(
  rows: readonly ArticleListRow[],
  formatTime: (ms: number) => string,
  banner: string,
): string {
  return renderToHtml(
    <Screen heading="글 관리" banner={banner}>
      {rows.length === 0 ? <EmptyState>등록된 글이 없습니다.</EmptyState> : (
        <ul>
          {rows.map((row) => (
            <li>
              <a href={`/admin/articles/${encodeURIComponent(row.id)}`}>{row.title}</a>
              {` / ${row.locale} / ${row.state} / v${row.row_version} `}
              <span class="muted">{formatTime(row.updated_at_ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </Screen>,
  );
}

export function consentsBodyHtml(
  bundle: { bundleId: string; documents: readonly { kind: string; locale: string; version: string }[] } | undefined,
): string {
  return renderToHtml(
    <Screen heading="동의문 버전">
      {bundle === undefined ? <EmptyState>완전한 활성 동의문 묶음이 없습니다.</EmptyState> : (
        <>
          <p>활성 묶음: {bundle.bundleId}</p>
          <ul>
            {bundle.documents.map((document) => (
              <li>{document.kind} / {document.locale} / {document.version}</li>
            ))}
          </ul>
        </>
      )}
    </Screen>,
  );
}

export interface FailureRow {
  id: string;
  channel: string;
  lastErrorCode: string;
}

export function failuresBodyHtml(rows: readonly FailureRow[], csrfToken: string, banner: string): string {
  return renderToHtml(
    <Screen heading="발송 실패" banner={banner}>
      {rows.length === 0 ? <EmptyState>실패한 발송이 없습니다.</EmptyState> : (
        <ul>
          {rows.map((row) => (
            <li>
              {row.id} / {row.channel} / {row.lastErrorCode}
              <form method="post" action={`/admin/failures/${encodeURIComponent(row.id)}/requeue`}>
                <input type="hidden" name="csrf" value={csrfToken} />
                <button type="submit">재발송</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </Screen>,
  );
}

export function healthBodyHtml(
  ready: boolean,
  queue: readonly Record<string, unknown>[],
): string {
  return renderToHtml(
    <Screen heading="시스템 상태">
      <p>{ready ? "데이터베이스와 동의문이 정상입니다." : "점검이 필요합니다."}</p>
      <p>Database: {ready ? "ready" : "not ready"}</p>
      <h2>발송 대기열</h2>
      <pre>{JSON.stringify(queue, null, 2)}</pre>
    </Screen>,
  );
}
