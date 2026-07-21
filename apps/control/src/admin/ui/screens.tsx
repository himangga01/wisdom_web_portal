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

export interface ConsultationListRow {
  id: string;
  receiptId: string;
  status: string;
  locale: string;
  category: string;
  receivedAt: string;
}

export function consultationsBodyHtml(
  rows: readonly ConsultationListRow[],
  pageNumber: number,
  hasNext: boolean,
  banner: string,
): string {
  return renderToHtml(
    <Screen heading="상담 목록" banner={banner}>
      {rows.length === 0 ? <EmptyState>표시할 상담이 없습니다.</EmptyState> : (
        <table>
          <thead>
            <tr><th>접수번호</th><th>상태</th><th>언어</th><th>분야</th><th>접수 시각</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td><a href={`/admin/consultations/${encodeURIComponent(row.id)}`}>{row.receiptId}</a></td>
                <td>{row.status}</td>
                <td>{row.locale}</td>
                <td>{row.category}</td>
                <td>{row.receivedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        {pageNumber > 1 ? <a href={`/admin/consultations?page=${pageNumber - 1}`}>« 이전</a> : null}
        {pageNumber > 1 && hasNext ? " · " : ""}
        {hasNext ? <a href={`/admin/consultations?page=${pageNumber + 1}`}>다음 »</a> : null}
      </p>
    </Screen>,
  );
}

export interface ConsultationDetailProps {
  id: string;
  receiptId: string;
  status: string;
  locale: string;
  category: string;
  receivedAt: string;
  pii?: { name: string; phone: string; email: string; company: string; message: string };
  statusForm?: { csrfToken: string; rowVersion: number; nextStatuses: readonly string[] };
}

export function consultationDetailBodyHtml(props: ConsultationDetailProps): string {
  return renderToHtml(
    <>
      <h1>상담 상세</h1>
      <dl>
        <dt>접수번호</dt><dd>{props.receiptId}</dd>
        <dt>상태</dt><dd>{props.status}</dd>
        <dt>언어</dt><dd>{props.locale}</dd>
        <dt>분야</dt><dd>{props.category}</dd>
        <dt>접수 시각</dt><dd>{props.receivedAt}</dd>
      </dl>
      {props.pii === undefined ? (
        <p class="muted">개인정보는 보유기간이 지나 파기되었습니다.</p>
      ) : (
        <dl>
          <dt>이름</dt><dd>{props.pii.name}</dd>
          <dt>전화</dt><dd>{props.pii.phone}</dd>
          <dt>이메일</dt><dd>{props.pii.email}</dd>
          <dt>회사</dt><dd>{props.pii.company}</dd>
          <dt>문의 내용</dt><dd>{props.pii.message}</dd>
        </dl>
      )}
      {props.statusForm === undefined ? (
        <p class="muted">이 상담은 더 이상 상태를 변경할 수 없는 최종 단계입니다.</p>
      ) : (
        <form method="post" action={`/admin/consultations/${encodeURIComponent(props.id)}/status`}>
          <input type="hidden" name="csrf" value={props.statusForm.csrfToken} />
          <input type="hidden" name="rowVersion" value={props.statusForm.rowVersion} />
          <label for="consultation-status">다음 상태</label>
          <select id="consultation-status" name="status" required>
            <option value="" selected disabled>변경할 상태를 선택하세요</option>
            {props.statusForm.nextStatuses.map((status) => <option value={status}>{status}</option>)}
          </select>
          <label><input type="checkbox" name="email" value="1" /> 고객에게 이메일 통지</label>
          <label><input type="checkbox" name="hermes" value="1" /> 담당자 Hermes 알림</label>
          <button type="submit">상태 변경</button>
        </form>
      )}
    </>,
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
