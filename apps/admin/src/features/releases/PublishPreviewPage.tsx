import {
  adminConfirmationSchema,
  adminPublicationResultSchema,
  adminPublishPreviewSchema,
} from "@wisdom/shared";
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
  const { data, error, loading } = useResource(
    `/publish/preview?mode=next-batch&page=${encodeURIComponent(page)}`,
    adminPublishPreviewSchema,
  );
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<"next-batch" | "policy-only" | null>(null);
  const [mutationError, setMutationError] = useState<unknown>();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const restoreReviewFocus = useRef(false);
  useEffect(() => {
    if (confirming !== null) confirmButton.current?.focus();
    else if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      reviewButton.current?.focus();
    }
  }, [confirming]);
  const publish = async (mode: "next-batch" | "policy-only") => {
    setPending(true);
    setMutationError(undefined);
    try {
      if (!data) return;
      const preview = mode === data.mode
        ? data
        : await apiRequest(
            `/publish/preview?mode=${encodeURIComponent(mode)}&page=1`,
            adminPublishPreviewSchema,
          );
      const confirmation = await apiRequest("/publish/confirm", adminConfirmationSchema, {
        method: "POST",
        body: { mode, fingerprint: preview.fingerprint },
      });
      await apiRequest("/publish", adminPublicationResultSchema, {
        method: "POST",
        body: {
          confirmationToken: confirmation.confirmationToken,
          mode,
          fingerprint: preview.fingerprint,
        },
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
            <div className="section-heading"><h2>다음 게시 묶음</h2><span className="count">{data.batchCount}</span></div>
            <p>전체 승인 {data.eligibleTotal}건 · 이번 묶음 {data.batchCount}건 · 이후 남음 {data.remainingAfterBatch}건</p>
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
              <p>{confirming !== null
                ? confirming === "next-batch"
                  ? `다음 승인 묶음 ${data.batchCount}건을 게시합니다.`
                  : `승인 콘텐츠 ${data.eligibleTotal}건은 유지하고 정책만 게시합니다.`
                : "빌드와 검증이 성공한 경우에만 공개 포인터가 전환됩니다."}</p>
            </div>
            <div className="action-row">
              {confirming !== null ? <button className="button button-secondary" type="button" disabled={pending} onClick={() => setConfirming(null)}>취소</button> : (
                <>
                  <button
                    ref={reviewButton}
                    className="button button-primary"
                    disabled={pending || data.batchCount === 0}
                    onClick={() => {
                      restoreReviewFocus.current = true;
                      setConfirming("next-batch");
                    }}
                  >다음 승인 묶음 게시</button>
                  <button
                    className="button button-secondary"
                    disabled={pending}
                    onClick={() => {
                      restoreReviewFocus.current = true;
                      setConfirming("policy-only");
                    }}
                  >정책만 게시</button>
                </>
              )}
              {confirming !== null ? (
              <button
                ref={confirmButton}
                className="button button-primary"
                disabled={pending}
                onClick={() => { void publish(confirming); }}
              >{pending ? "게시 중…" : "확인 후 게시 실행"}</button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
