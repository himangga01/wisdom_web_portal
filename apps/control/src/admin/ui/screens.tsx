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

export function loginBodyHtml(): string {
  return renderToHtml(
    <>
      <h1>관리자 로그인</h1>
      <form method="post" action="/admin/login">
        <label for="login-username">아이디</label>
        <input id="login-username" name="username" autocomplete="username" autofocus required />
        <label for="login-password">비밀번호</label>
        <input id="login-password" type="password" name="password" autocomplete="current-password" required />
        <button type="submit">다음</button>
      </form>
    </>,
  );
}

export function mfaBodyHtml(csrf: string): string {
  return renderToHtml(
    <>
      <h1>2단계 인증</h1>
      <p class="muted">인증 앱의 6자리 코드 또는 백업용 복구 코드를 입력하세요.</p>
      <form method="post" action="/admin/mfa">
        <label for="mfa-username">아이디</label>
        <input id="mfa-username" name="username" autocomplete="username" required />
        <label for="mfa-method">코드 종류</label>
        <select id="mfa-method" name="method">
          <option value="totp">인증 앱 코드</option>
          <option value="recovery">복구 코드</option>
        </select>
        <label for="mfa-code">코드</label>
        <input id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required />
        <input type="hidden" name="csrf" value={csrf} />
        <button type="submit">로그인</button>
      </form>
    </>,
  );
}

export function revisionDiffBodyHtml(previous: string, current: string): string {
  return renderToHtml(
    <>
      <h1>리비전 비교</h1>
      <h2>이전</h2>
      <pre>{previous}</pre>
      <h2>현재</h2>
      <pre>{current}</pre>
    </>,
  );
}

export interface PreviewEligibleRow { locale: string; title: string; slug: string; headRevisionId: string }
export interface PreviewBlockedRow { locale: string; title: string; state: string }

export function publishPreviewBodyHtml(
  eligible: readonly PreviewEligibleRow[],
  blocked: readonly PreviewBlockedRow[],
  publishLabel: string,
  csrf: string,
): string {
  return renderToHtml(
    <>
      <h1>발행 미리보기</h1>
      <p>모든 릴리스에는 현재 활성 개인정보·마케팅 동의문 묶음이 함께 봉인됩니다. 발행 대상 글이 없으면 정책만 발행할 수 있습니다.</p>
      <h2>발행 대상</h2>
      {eligible.length === 0 ? <EmptyState>발행 대상 승인 글이 없습니다. 정책만 발행됩니다.</EmptyState> : (
        <ul>
          {eligible.map((row) => (
            <li>{row.locale}{" / "}{row.title}{" / "}{row.slug}{" / "}{row.headRevisionId}</li>
          ))}
        </ul>
      )}
      <h2>제외 대상</h2>
      {blocked.length === 0 ? <EmptyState>제외된 글이 없습니다.</EmptyState> : (
        <ul>
          {blocked.map((row) => <li>{row.locale}{" / "}{row.title}{" / "}{row.state}</li>)}
        </ul>
      )}
      <form method="post" action="/admin/publish">
        <input type="hidden" name="csrf" value={csrf} />
        <label>
          <input type="checkbox" name="confirmation" value="publish-approved" required />{" "}
          공개 사이트를 새 버전으로 교체하는 것을 확인합니다.
        </label>
        <button type="submit">{publishLabel}</button>
      </form>
    </>,
  );
}

export interface ReleaseRow {
  id: string;
  version: string;
  state: string;
  createdAt: string;
  manifestHex: string;
  retired: boolean;
}

export function releasesBodyHtml(rows: readonly ReleaseRow[], csrf: string, banner: string): string {
  return renderToHtml(
    <Screen heading="발행 릴리스" banner={banner}>
      <p><a href="/admin/publish/preview">승인 글 미리보기</a></p>
      {rows.length === 0 ? <EmptyState>발행된 릴리스가 없습니다.</EmptyState> : (
        <ul>
          {rows.map((row) => (
            <li>
              {row.version}{" / "}{row.state}{" "}
              <span class="muted">{row.createdAt}</span>{" "}
              <code>{row.manifestHex}</code>
              {row.retired ? (
                <form method="post" action={`/admin/releases/${encodeURIComponent(row.id)}/rollback`}>
                  <input type="hidden" name="csrf" value={csrf} />
                  <label>
                    <input type="checkbox" name="confirmation" value="rollback-retained-release" required />{" "}
                    이 릴리스로 롤백하며, 검토 중(in_review)인 글이 이전 발행본으로 덮어써질 수 있음을 확인합니다.
                  </label>
                  <button type="submit">검증 후 롤백</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Screen>,
  );
}
