import type { AdminFailureListDto } from "@wisdom/shared";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";

export function FailuresPage() {
  const [search] = useSearchParams();
  const page = search.get("page") ?? "1";
  const resource = useResource<AdminFailureListDto>(`/failures?page=${encodeURIComponent(page)}`);
  const [pending, setPending] = useState<string>();
  const [mutationError, setMutationError] = useState<unknown>();
  const requeue = async (id: string) => {
    setPending(id); setMutationError(undefined);
    try { await apiRequest(`/failures/${encodeURIComponent(id)}/requeue`, { method: "POST", body: {} }); await resource.reload(); }
    catch (error) { setMutationError(error); }
    finally { setPending(undefined); }
  };
  return (
    <>
      <PageHeader eyebrow="RECOVERY" title="실패 작업" description="실패한 알림 작업을 확인하고 명시적으로 재시도합니다." />
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      {resource.loading ? <Loading /> : resource.error ? <ErrorMessage error={resource.error} /> : !resource.data?.items.length ? <Empty>실패한 알림이 없습니다.</Empty> : (
        <section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>채널</th><th>이벤트</th><th>시도</th><th>오류 코드</th><th>작업</th></tr></thead><tbody>{resource.data.items.map((item) => <tr key={item.id}><td>{item.channel}</td><td><code>{item.eventType}</code></td><td>{item.attemptCount}</td><td>{item.lastErrorCode ?? "-"}</td><td><button className="button button-secondary" disabled={pending === item.id} onClick={() => void requeue(item.id)}>{pending === item.id ? "처리 중…" : "재시도"}</button></td></tr>)}</tbody></table></div><Pagination page={resource.data.page} path="/failures" /></section>
      )}
    </>
  );
}
