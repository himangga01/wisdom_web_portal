import type { AdminPublishPreviewDto } from "@wisdom/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";

export function PublishPreviewPage() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const page = search.get("page") ?? "1";
  const { data, error, loading } = useResource<AdminPublishPreviewDto>(
    `/publish/preview?page=${encodeURIComponent(page)}`,
  );
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const restoreReviewFocus = useRef(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      reviewButton.current?.focus();
    }
  }, [confirming]);
  const publish = async () => {
    setPending(true);
    setMutationError(undefined);
    try {
      if (!data) return;
      const confirmation = await apiRequest<{ confirmationToken: string }>("/publish/confirm", {
        method: "POST",
        body: { fingerprint: data.fingerprint },
      });
      await apiRequest("/publish", {
        method: "POST",
        body: { confirmationToken: confirmation.confirmationToken, fingerprint: data.fingerprint },
      });
      navigate("/releases");
    } catch (nextError) {
      setMutationError(nextError);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="PUBLICATION"
        title="게시 미리보기"
        description="승인된 콘텐츠와 정책 번들을 검증된 공개 릴리스로 만듭니다."
        actions={<Link className="button button-secondary" to="/releases">릴리스 목록</Link>}
      />
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : data ? (
        <div className="content-stack">
          <section className="panel">
            <div className="section-heading"><h2>포함 대상</h2><span className="count">{data.eligibleTotal}</span></div>
            {data.eligible.length ? <ul className="item-list">{data.eligible.map((item) => <li key={`${item.articleId}:${item.locale}`}><div><strong>{item.title}</strong><span>{item.locale} · {item.slug}</span></div><StatusBadge value={item.state} /></li>)}</ul> : <Empty>이 페이지에는 포함 대상이 없습니다.</Empty>}
          </section>
          <section className="panel">
            <div className="section-heading"><h2>제외 대상</h2><span className="count">{data.blockedTotal}</span></div>
            {data.blocked.length ? <ul className="item-list">{data.blocked.map((item) => <li key={`${item.articleId}:${item.locale}`}><div><strong>{item.title}</strong><span>{item.locale} · 소스 연결 {item.sourceBindingValid ? "정상" : "확인 필요"}</span></div><StatusBadge value={item.state} /></li>)}</ul> : <Empty>이 페이지에는 제외 대상이 없습니다.</Empty>}
          </section>
          <Pagination page={data.page} path="/publish/preview" />
          <section className="danger-zone" aria-labelledby="publish-action-title">
            <div>
              <h2 id="publish-action-title">공개 릴리스 게시</h2>
              <p>{confirming
                ? `전체 포함 ${data.eligibleTotal}건과 제외 ${data.blockedTotal}건을 확인했습니다. 새 공개 릴리스를 빌드하고 전환합니다.`
                : "빌드와 검증이 성공한 경우에만 공개 포인터가 전환됩니다."}</p>
            </div>
            <div className="action-row">
              {confirming ? <button className="button button-secondary" type="button" disabled={pending} onClick={() => setConfirming(false)}>취소</button> : null}
              <button
                ref={confirming ? confirmButton : reviewButton}
                className="button button-primary"
                disabled={pending}
                onClick={() => {
                  if (confirming) void publish();
                  else {
                    restoreReviewFocus.current = true;
                    setConfirming(true);
                  }
                }}
              >{pending ? "게시 중…" : confirming ? "확인 후 게시 실행" : "게시 검토"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
