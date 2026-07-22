import type { AdminReleaseListDto } from "@wisdom/shared";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";

export function ReleaseListPage() {
  const [search] = useSearchParams();
  const page = search.get("page") ?? "1";
  const resource = useResource<AdminReleaseListDto>(`/releases?page=${encodeURIComponent(page)}`);
  const [pending, setPending] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [mutationError, setMutationError] = useState<unknown>();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const restoreReviewFocus = useRef(false);
  const operationLocked = useRef(false);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      reviewButton.current?.focus();
    }
  }, [confirming]);

  const reviewRollback = (event: MouseEvent<HTMLButtonElement>, id: string) => {
    if (operationLocked.current) return;
    reviewButton.current = event.currentTarget;
    restoreReviewFocus.current = true;
    setConfirming(id);
  };

  const rollback = async (id: string) => {
    if (operationLocked.current) return;
    operationLocked.current = true;
    setPending(id);
    setMutationError(undefined);
    try {
      const confirmation = await apiRequest<{ confirmationToken: string }>(
        `/releases/${encodeURIComponent(id)}/rollback/confirm`,
        { method: "POST", body: {} },
      );
      await apiRequest(`/releases/${encodeURIComponent(id)}/rollback`, {
        method: "POST",
        body: { confirmationToken: confirmation.confirmationToken },
      });
      await resource.reload();
      setConfirming(undefined);
    } catch (error) {
      setMutationError(error);
    } finally {
      operationLocked.current = false;
      setPending(undefined);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="RELEASES"
        title="공개 릴리스"
        description="검증된 게시 이력과 롤백 대상을 관리합니다."
        actions={<Link className="button button-primary" to="/publish/preview">게시 미리보기</Link>}
      />
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      {resource.loading ? <Loading /> : resource.error ? <ErrorMessage error={resource.error} /> : !resource.data?.items.length ? (
        <Empty>릴리스가 없습니다.</Empty>
      ) : (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>버전</th><th>상태</th><th>매니페스트</th><th>생성 시각</th><th>작업</th></tr></thead>
              <tbody>{resource.data.items.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.version}</strong></td>
                  <td><StatusBadge value={item.state} /></td>
                  <td><code className="hash">{item.manifestSha256}</code></td>
                  <td>{new Date(item.createdAtMs).toLocaleString()}</td>
                  <td>{item.state !== "retired" ? "-" : confirming === item.id ? (
                    <div className="action-row">
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={pending !== undefined}
                        onClick={() => setConfirming(undefined)}
                      >취소</button>
                      <button
                        ref={confirmButton}
                        className="button button-danger"
                        disabled={pending !== undefined}
                        onClick={() => void rollback(item.id)}
                      >{pending === item.id ? "롤백 중…" : `${item.version} 롤백 확인`}</button>
                    </div>
                  ) : (
                    <button
                      className="button button-danger"
                      disabled={pending !== undefined}
                      onClick={(event) => reviewRollback(event, item.id)}
                    >롤백 검토</button>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Pagination page={resource.data.page} path="/releases" />
        </section>
      )}
    </>
  );
}
