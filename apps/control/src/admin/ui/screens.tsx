import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";

import {
  articleStateLabel,
  categoryLabel,
  channelLabel,
  consentKindLabel,
  consultationStatusLabel,
  createdByTypeLabel,
  localeLabel,
  notificationErrorLabel,
  notificationStateLabel,
  releaseStateLabel,
} from "./labels.js";
import { LineChart } from "./charts.js";
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
            <li><a href={`/admin/consultations?status=${encodeURIComponent(row.status)}`}>{consultationStatusLabel(row.status)}: {row.count}</a></li>
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
              {" / "}{localeLabel(row.locale)}{" / "}{articleStateLabel(row.state)}{" / v"}{row.row_version}{" "}
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
              <li>{consentKindLabel(document.kind)} / {localeLabel(document.locale)} / {document.version}</li>
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
  state: string;
  at: string;
  lastErrorCode: string;
  requeueable: boolean;
}

export function failuresBodyHtml(rows: readonly FailureRow[], csrfToken: string, banner: string): string {
  return renderToHtml(
    <Screen heading="발송 실패" banner={banner}>
      {rows.length === 0 ? <EmptyState>실패하거나 설정 문제로 취소된 발송이 없습니다.</EmptyState> : (
        <table>
          <thead>
            <tr><th>채널</th><th>상태</th><th>시각</th><th>오류</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td>{channelLabel(row.channel)}</td>
                <td>{notificationStateLabel(row.state)}</td>
                <td>{row.at}</td>
                <td>{notificationErrorLabel(row.lastErrorCode)}</td>
                <td>
                  {row.requeueable ? (
                    <form method="post" action={`/admin/failures/${encodeURIComponent(row.id)}/requeue`}>
                      <input type="hidden" name="csrf" value={csrfToken} />
                      <button type="submit">재발송</button>
                    </form>
                  ) : <a href="/admin/notifications">채널 설정 확인</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

export interface ConsultationListView {
  rows: readonly ConsultationListRow[];
  pageNumber: number;
  hasNext: boolean;
  statusFilter: string;
  statuses: readonly string[];
  csrfToken: string;
  banner: string;
  // Present only when rendering contact-search results (a POST response), so the
  // raw phone/email never travels in a GET URL or the pagination links.
  search?: {
    kind: "phone" | "email";
    value: string;
    capped: boolean;
    invalid: boolean;
  };
}

function pageHref(view: ConsultationListView, page: number): string {
  const params = new URLSearchParams();
  if (view.statusFilter) params.set("status", view.statusFilter);
  params.set("page", String(page));
  return `/admin/consultations?${params.toString()}`;
}

const ConsultationTable: FC<{ rows: readonly ConsultationListRow[] }> = ({ rows }) => (
  <table>
    <thead>
      <tr><th>접수번호</th><th>상태</th><th>언어</th><th>분야</th><th>접수 시각</th></tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr>
          <td><a href={`/admin/consultations/${encodeURIComponent(row.id)}`}>{row.receiptId}</a></td>
          <td>{consultationStatusLabel(row.status)}</td>
          <td>{localeLabel(row.locale)}</td>
          <td>{categoryLabel(row.category)}</td>
          <td>{row.receivedAt}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export function consultationsBodyHtml(view: ConsultationListView): string {
  const search = view.search;
  return renderToHtml(
    <Screen heading="상담 목록" banner={view.banner}>
      <h2>상태로 거르기</h2>
      <form method="get" action="/admin/consultations">
        <label for="filter-status">상태 필터</label>
        <select id="filter-status" name="status">
          <option value="" selected={view.statusFilter === ""}>전체</option>
          {view.statuses.map((status) => (
            <option value={status} selected={status === view.statusFilter}>{consultationStatusLabel(status)}</option>
          ))}
        </select>
        <button type="submit">필터 적용</button>
      </form>
      <h2>연락처로 찾기</h2>
      <form method="post" action="/admin/consultations/search">
        <input type="hidden" name="csrf" value={view.csrfToken} />
        <label for="search-kind">검색 대상</label>
        <select id="search-kind" name="searchKind">
          <option value="phone" selected={search?.kind === "phone"}>전화</option>
          <option value="email" selected={search?.kind === "email"}>이메일</option>
        </select>
        <label for="search-q">검색어</label>
        <input id="search-q" name="q" value={search?.value ?? ""} placeholder="정확히 일치하는 전화/이메일" maxlength={254} required />
        <button type="submit">검색</button>
        <p class="muted">전화·이메일이 정확히 일치하는 상담만 찾습니다. 부분 검색은 지원하지 않습니다.</p>
      </form>
      {search ? (
        <>
          <p><a href="/admin/consultations">« 전체 목록 보기</a></p>
          {search.invalid ? (
            <EmptyState>검색어 형식을 확인하세요. 전화번호는 숫자 8~20자리로 입력합니다.</EmptyState>
          ) : view.rows.length === 0 ? (
            <EmptyState>일치하는 상담이 없습니다.</EmptyState>
          ) : (
            <>
              {search.capped ? <p class="muted">일치 항목이 많아 최근 50건만 표시합니다.</p> : <></>}
              <ConsultationTable rows={view.rows} />
            </>
          )}
        </>
      ) : (
        <>
          {view.rows.length === 0 ? (
            <EmptyState>표시할 상담이 없습니다.</EmptyState>
          ) : (
            <ConsultationTable rows={view.rows} />
          )}
          <p>
            {view.pageNumber > 1 ? <a href={pageHref(view, view.pageNumber - 1)}>« 이전</a> : <></>}
            {view.pageNumber > 1 && view.hasNext ? " · " : ""}
            {view.hasNext ? <a href={pageHref(view, view.pageNumber + 1)}>다음 »</a> : <></>}
          </p>
        </>
      )}
    </Screen>,
  );
}

export interface ConsultationNotification {
  channel: string;
  state: string;
  sentAt?: string;
  lastErrorCode?: string;
  attemptCount: number;
}
export interface ConsultationStatusHistoryItem {
  fromStatus: string;
  toStatus: string;
  at: string;
}
export interface ConsultationDetailProps {
  id: string;
  receiptId: string;
  status: string;
  locale: string;
  category: string;
  receivedAt: string;
  preferredContact: string;
  marketingState: string;
  retentionExpiresAt: string;
  purged: boolean;
  emailChannelEnabled: boolean;
  hermesChannelEnabled: boolean;
  pii?: { name: string; phone: string; email: string; company: string; message: string };
  statusForm?: { csrfToken: string; rowVersion: number; nextStatuses: readonly string[]; terminalStatuses: readonly string[] };
  notifications: readonly ConsultationNotification[];
  statusHistory: readonly ConsultationStatusHistoryItem[];
}

const ChannelNote: FC<{ enabled: boolean }> = ({ enabled }) => (
  enabled ? <></> : <span class="muted"> (현재 채널이 꺼져 있어 발송되지 않습니다)</span>
);

export function consultationDetailBodyHtml(props: ConsultationDetailProps): string {
  return renderToHtml(
    <>
      <h1>상담 상세</h1>
      <dl>
        <dt>접수번호</dt><dd>{props.receiptId}</dd>
        <dt>상태</dt><dd>{consultationStatusLabel(props.status)}</dd>
        <dt>언어</dt><dd>{localeLabel(props.locale)}</dd>
        <dt>분야</dt><dd>{categoryLabel(props.category)}</dd>
        <dt>접수 시각</dt><dd>{props.receivedAt}</dd>
        {props.purged ? <></> : (
          <>
            <dt>희망 연락 방법</dt><dd>{props.preferredContact}</dd>
            <dt>마케팅 동의</dt><dd>{props.marketingState}</dd>
            <dt>파기 예정일</dt><dd>{props.retentionExpiresAt}</dd>
          </>
        )}
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
      {props.purged ? (
        // A purged consultation keeps only its receipt/status header; its status
        // form and processing history are hidden so the screen does not contradict
        // the "파기됨" declaration or invite notifying a recipient-less record.
        <p class="muted">파기된 상담은 상태 변경과 처리 이력을 표시하지 않습니다.</p>
      ) : (
        <>
          {props.statusForm === undefined ? (
            <p class="muted">이 상담은 더 이상 상태를 변경할 수 없는 최종 단계입니다.</p>
          ) : (
            <form method="post" action={`/admin/consultations/${encodeURIComponent(props.id)}/status`}>
              <input type="hidden" name="csrf" value={props.statusForm.csrfToken} />
              <input type="hidden" name="rowVersion" value={props.statusForm.rowVersion} />
              <label for="consultation-status">다음 상태</label>
              <select id="consultation-status" name="status" required>
                <option value="" selected disabled>변경할 상태를 선택하세요</option>
                {props.statusForm.nextStatuses.map((status) => (
                  <option value={status}>{consultationStatusLabel(status)}</option>
                ))}
              </select>
              {props.statusForm.terminalStatuses.length === 0 ? <></> : (
                <label>
                  <input type="checkbox" name="confirmTerminal" value="yes" />{" "}
                  종결·스팸으로 바꾸면 되돌릴 수 없음을 확인합니다.
                </label>
              )}
              <label>
                <input type="checkbox" name="email" value="1" /> 접수 알림 메일 받기(운영자)
                <ChannelNote enabled={props.emailChannelEnabled} />
              </label>
              <label>
                <input type="checkbox" name="hermes" value="1" /> 담당자 Hermes 알림
                <ChannelNote enabled={props.hermesChannelEnabled} />
              </label>
              <button type="submit">상태 변경</button>
            </form>
          )}
          <h2>알림 이력</h2>
          {props.notifications.length === 0 ? <EmptyState>이 상담에 대해 발송한 알림이 없습니다.</EmptyState> : (
            <table>
              <thead>
                <tr><th>채널</th><th>상태</th><th>발송 시각</th><th>시도</th><th>오류</th></tr>
              </thead>
              <tbody>
                {props.notifications.map((row) => (
                  <tr>
                    <td>{channelLabel(row.channel)}</td>
                    <td>{notificationStateLabel(row.state)}</td>
                    <td>{row.sentAt ?? "-"}</td>
                    <td>{row.attemptCount}</td>
                    <td>{row.lastErrorCode ? notificationErrorLabel(row.lastErrorCode) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>상태 변경 이력</h2>
          {props.statusHistory.length === 0 ? <EmptyState>기록된 상태 변경이 없습니다.</EmptyState> : (
            <table>
              <thead>
                <tr><th>변경</th><th>시각</th></tr>
              </thead>
              <tbody>
                {props.statusHistory.map((row) => (
                  <tr>
                    <td>{consultationStatusLabel(row.fromStatus)} → {consultationStatusLabel(row.toStatus)}</td>
                    <td>{row.at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
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

export function withdrawalConfirmBodyHtml(
  title: string,
  description: string,
  buttonLabel: string,
  route: string,
  confirmationValue: string,
): string {
  return renderToHtml(
    <>
      <h1>{title}</h1>
      <p>{description}</p>
      <form method="post" action={route}>
        <input type="hidden" name="confirmation" value={confirmationValue} />
        <button type="submit">{buttonLabel}</button>
      </form>
    </>,
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
            <li>{localeLabel(row.locale)}{" / "}{row.title}{" / "}{row.slug}{" / "}{row.headRevisionId}</li>
          ))}
        </ul>
      )}
      <h2>제외 대상</h2>
      {blocked.length === 0 ? <EmptyState>제외된 글이 없습니다.</EmptyState> : (
        <ul>
          {blocked.map((row) => <li>{localeLabel(row.locale)}{" / "}{row.title}{" / "}{articleStateLabel(row.state)}</li>)}
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

export interface NotificationSettingsProps {
  banner: string;
  csrf: string;
  statusRows: readonly { channelLabel: string; enabled: boolean; payloadMode: string; smtpConfigured: boolean }[];
  email: {
    enabled: boolean;
    payloadMode: "receipt-only" | "full-inquiry";
    host: string;
    port: string | number;
    from: string;
    to: string;
    secretRef: string;
  };
  hermesEnabled: boolean;
}

export function notificationSettingsBodyHtml(props: NotificationSettingsProps): string {
  const { email } = props;
  return renderToHtml(
    <Screen heading="알림 설정" banner={props.banner}>
      <h2>현재 설정</h2>
      <table>
        <thead>
          <tr><th>채널</th><th>사용 여부</th><th>발송 방식</th><th>SMTP 구성</th></tr>
        </thead>
        <tbody>
          {props.statusRows.map((row) => (
            <tr>
              <td>{row.channelLabel}</td>
              <td>{row.enabled ? "사용" : "사용 안 함"}</td>
              <td>{row.payloadMode}</td>
              <td>{row.smtpConfigured ? "구성됨" : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>이메일 알림</h2>
      <form method="post" action="/admin/notifications">
        <input type="hidden" name="csrf" value={props.csrf} />
        <input type="hidden" name="channel" value="email" />
        <label><input type="checkbox" name="enabled" value="1" checked={email.enabled} /> 이메일 알림 사용</label>
        <label for="email-payload">발송 방식</label>
        <select id="email-payload" name="payloadMode">
          <option value="receipt-only" selected={email.payloadMode === "receipt-only"}>접수 확인만</option>
          <option value="full-inquiry" selected={email.payloadMode === "full-inquiry"}>전체 문의 내용</option>
        </select>
        <fieldset>
          <legend>SMTP TLS 설정</legend>
          <label for="smtp-host">보내는 서버(Host)</label>
          <input id="smtp-host" name="smtpHost" value={email.host} maxlength={253} />
          <label for="smtp-port">포트</label>
          <input id="smtp-port" name="smtpPort" inputmode="numeric" value={email.port} readonly />
          <label for="smtp-from">보내는 주소(From)</label>
          <input id="smtp-from" name="smtpFrom" type="email" value={email.from} maxlength={254} />
          <label for="smtp-to">받는 주소(운영자)</label>
          <input id="smtp-to" name="smtpTo" type="email" value={email.to} maxlength={254} />
          <label for="smtp-tls">TLS 방식</label>
          <select id="smtp-tls" name="smtpTlsMode"><option value="implicit-tls">Implicit TLS</option></select>
          <label for="smtp-secret">키체인 참조</label>
          <input id="smtp-secret" name="smtpSecretRef" value={email.secretRef} placeholder="keychain:wisdom-smtp" maxlength={137} />
          <small class="muted">비밀번호를 직접 입력하지 않습니다. macOS 키체인에 저장한 항목 이름(예: keychain:wisdom-smtp)만 참조합니다.</small>
        </fieldset>
        <label><input type="checkbox" name="fullInquiryApproved" value="yes" /> 전체 문의 내용 발송 승인</label>
        <button type="submit">이메일 설정 저장</button>
      </form>
      <h2>Hermes(텔레그램) 알림</h2>
      <form method="post" action="/admin/notifications">
        <input type="hidden" name="csrf" value={props.csrf} />
        <input type="hidden" name="channel" value="hermes-telegram" />
        <label><input type="checkbox" name="enabled" value="1" checked={props.hermesEnabled} /> Hermes 알림 사용</label>
        <button type="submit">Hermes 설정 저장</button>
      </form>
      <h2>테스트 발송</h2>
      <form method="post" action="/admin/notifications/test">
        <input type="hidden" name="csrf" value={props.csrf} />
        <label for="test-channel">채널</label>
        <select id="test-channel" name="channel">
          <option value="email">이메일</option>
          <option value="hermes-telegram">Hermes(텔레그램)</option>
        </select>
        <button type="submit">테스트 알림 보내기</button>
      </form>
    </Screen>,
  );
}

export interface ArticleActionForm { action: string; label: string; confirm?: string }
export interface ArticleHeadView {
  locale: string;
  state: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sourcesJson: string;
  rowVersion: number;
  slug?: string;
  actions: readonly ArticleActionForm[];
}
export interface ArticleRevisionItem {
  locale: string;
  revisionNo: number;
  title: string;
  createdByType: string;
  createdAt: string;
  diff?: { href: string; label: string };
}
export interface ArticleDetailProps {
  articleId: string;
  heading: string;
  sourceLocale: string;
  banner: string;
  csrf: string;
  translate?: { rowVersion: number; targetLocales: readonly string[] };
  heads: readonly ArticleHeadView[];
  revisions: readonly ArticleRevisionItem[];
}

const ArticleHeadSection: FC<{ articleId: string; csrf: string; head: ArticleHeadView }> = ({ articleId, csrf, head }) => (
  <section>
    <h3>{localeLabel(head.locale)}{" / "}{articleStateLabel(head.state)}</h3>
    <p>{head.title}</p>
    <p>{head.summary}</p>
    <h4>본문 (Markdown)</h4>
    <pre>{head.bodyMarkdown}</pre>
    <h4>출처</h4>
    <pre>{head.sourcesJson}</pre>
    {head.slug === undefined ? null : (
      <form method="post" action={`/admin/articles/${encodeURIComponent(articleId)}/locales/${encodeURIComponent(head.locale)}/slug`}>
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="rowVersion" value={head.rowVersion} />
        <label for={`slug-${head.locale}`}>공개 주소(slug)</label>
        <input id={`slug-${head.locale}`} name="slug" value={head.slug} maxlength={96} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" title="소문자·숫자·하이픈만 사용하세요 (예: visa-guide)" required />
        <button type="submit">주소 저장</button>
      </form>
    )}
    {head.actions.map((action) => (
      <form method="post" action={`/admin/articles/${encodeURIComponent(articleId)}/locales/${encodeURIComponent(head.locale)}/${action.action}`}>
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="rowVersion" value={head.rowVersion} />
        {action.confirm === undefined ? null : <label><input type="checkbox" required /> {action.confirm}</label>}
        <button type="submit">{action.label}</button>
      </form>
    ))}
  </section>
);

export function articleDetailBodyHtml(props: ArticleDetailProps): string {
  return renderToHtml(
    <>
      <h1>{props.heading}</h1>
      {props.banner ? raw(props.banner) : null}
      <p>원문 언어: {localeLabel(props.sourceLocale)}</p>
      {props.translate === undefined ? null : (
        <form method="post" action={`/admin/articles/${encodeURIComponent(props.articleId)}/translations`}>
          <input type="hidden" name="csrf" value={props.csrf} />
          <input type="hidden" name="rowVersion" value={props.translate.rowVersion} />
          <label for="translate-target">번역 언어</label>
          <select id="translate-target" name="targetLocale">
            {props.translate.targetLocales.map((locale) => <option value={locale}>{localeLabel(locale)}</option>)}
          </select>
          <button type="submit">번역 요청</button>
        </form>
      )}
      <h2>언어본</h2>
      {props.heads.map((head) => <ArticleHeadSection articleId={props.articleId} csrf={props.csrf} head={head} />)}
      <h2>리비전 이력</h2>
      <ul>
        {props.revisions.map((rev) => (
          <li>
            {localeLabel(rev.locale)}{" #"}{rev.revisionNo}{" "}{rev.title}{" ("}{createdByTypeLabel(rev.createdByType)}{") "}
            <span class="muted">{rev.createdAt}</span>
            {rev.diff === undefined ? null : <>{" "}<a href={rev.diff.href}>{rev.diff.label}</a></>}
          </li>
        ))}
      </ul>
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
              {row.version}{" / "}{releaseStateLabel(row.state)}{" "}
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

export interface AnalyticsBucketView {
  startDay: string;
  label: string;
  views: number;
  visitors: number;
}

export interface AnalyticsView {
  from: string;
  to: string;
  granularity: "day" | "week" | "month";
  metric: "views" | "visitors";
  activePreset: "7d" | "30d" | "90d" | "custom";
  totals: { views: number; visitors: number };
  buckets: readonly AnalyticsBucketView[];
  topPages: readonly { path: string; locale: string; views: number }[];
  referrers: readonly { referrerOrigin: string; views: number }[];
  locales: readonly { locale: string; views: number }[];
}

const GRANULARITY_LABELS = { day: "일", week: "주", month: "월" } as const;
const METRIC_LABELS = { views: "조회수", visitors: "순 방문자" } as const;

const PresetLink: FC<{ preset: "7d" | "30d" | "90d"; label: string; view: AnalyticsView }> = ({ preset, label, view }) => (
  view.activePreset === preset
    ? <strong>{label}</strong>
    : <a href={`/admin/analytics?range=${preset}&metric=${view.metric}`}>{label}</a>
);

export function analyticsBodyHtml(view: AnalyticsView): string {
  const metricLabel = METRIC_LABELS[view.metric];
  const averageViews = view.buckets.length === 0
    ? 0
    : Math.round(view.totals.views / Math.max(1, view.buckets.length));
  return renderToHtml(
    <Screen heading="방문 통계">
      <p>
        <PresetLink preset="7d" label="최근 7일" view={view} />{" · "}
        <PresetLink preset="30d" label="최근 30일" view={view} />{" · "}
        <PresetLink preset="90d" label="최근 90일" view={view} />
      </p>
      <form method="get" action="/admin/analytics">
        <label for="analytics-from">시작일</label>
        <input id="analytics-from" type="date" name="from" value={view.from} />
        <label for="analytics-to">종료일</label>
        <input id="analytics-to" type="date" name="to" value={view.to} />
        <label for="analytics-granularity">단위</label>
        <select id="analytics-granularity" name="g">
          {(["day", "week", "month"] as const).map((granularity) => (
            <option value={granularity} selected={granularity === view.granularity}>
              {GRANULARITY_LABELS[granularity]}
            </option>
          ))}
        </select>
        <label for="analytics-metric">지표</label>
        <select id="analytics-metric" name="metric">
          {(["views", "visitors"] as const).map((metric) => (
            <option value={metric} selected={metric === view.metric}>{METRIC_LABELS[metric]}</option>
          ))}
        </select>
        <button type="submit">조회</button>
      </form>
      <dl>
        <dt>총 조회수</dt><dd>{view.totals.views}</dd>
        <dt>총 순 방문자</dt><dd>{view.totals.visitors}</dd>
        <dt>구간 평균 조회수</dt><dd>{averageViews}</dd>
      </dl>
      <p class="muted">순 방문자는 일 단위 고유 기준입니다. 식별값이 매일 파기되어 주·월 순 방문자는 일별 고유수의 합으로 집계됩니다.</p>
      {view.buckets.length === 0 ? <EmptyState>선택한 기간에 데이터가 없습니다.</EmptyState> : (
        <>
          <LineChart
            ariaLabel={`${view.from}부터 ${view.to}까지 ${GRANULARITY_LABELS[view.granularity]} 단위 ${metricLabel} 추이`}
            points={view.buckets.map((bucket) => ({
              label: bucket.label,
              value: view.metric === "views" ? bucket.views : bucket.visitors,
              tooltip: `${bucket.startDay} · ${metricLabel} ${view.metric === "views" ? bucket.views : bucket.visitors}`,
            }))}
          />
          <details>
            <summary>표로 보기</summary>
            <table>
              <thead>
                <tr><th>구간</th><th>조회수</th><th>순 방문자</th></tr>
              </thead>
              <tbody>
                {view.buckets.map((bucket) => (
                  <tr>
                    <td>{bucket.startDay}</td>
                    <td>{bucket.views}</td>
                    <td>{bucket.visitors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
      <h2>인기 페이지</h2>
      {view.topPages.length === 0 ? <EmptyState>기록된 조회가 없습니다.</EmptyState> : (
        <table>
          <thead>
            <tr><th>경로</th><th>언어</th><th>조회수</th></tr>
          </thead>
          <tbody>
            {view.topPages.map((row) => (
              <tr>
                <td>{row.path}</td>
                <td>{localeLabel(row.locale)}</td>
                <td>{row.views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>유입 경로</h2>
      {view.referrers.length === 0 ? <EmptyState>기록된 유입이 없습니다.</EmptyState> : (
        <table>
          <thead>
            <tr><th>출처</th><th>조회수</th></tr>
          </thead>
          <tbody>
            {view.referrers.map((row) => (
              <tr>
                <td>{row.referrerOrigin === "" ? "직접 방문" : row.referrerOrigin}</td>
                <td>{row.views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>언어별 조회</h2>
      {view.locales.length === 0 ? <EmptyState>기록된 조회가 없습니다.</EmptyState> : (
        <table>
          <thead>
            <tr><th>언어</th><th>조회수</th></tr>
          </thead>
          <tbody>
            {view.locales.map((row) => (
              <tr>
                <td>{localeLabel(row.locale)}</td>
                <td>{row.views}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Screen>,
  );
}
