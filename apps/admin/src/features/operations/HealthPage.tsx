import type { AdminHealthDto } from "@wisdom/shared";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";

export function HealthPage() {
  const { data, error, loading } = useResource<AdminHealthDto>("/health");
  return (
    <>
      <PageHeader eyebrow="SYSTEM" title="서비스 상태" description="데이터베이스와 알림 대기열의 비민감 상태만 표시합니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : data ? (
        <div className="content-stack">
          <section className="panel health-summary"><div><h2>데이터베이스 및 정책</h2><p>관리자 기능 사용 준비 상태</p></div><StatusBadge value={data.ready ? "ready" : "not ready"} /></section>
          <section className="panel"><h2>알림 대기열</h2>{data.queues.length ? <div className="stat-grid compact">{data.queues.map((queue) => <div className="stat-card" key={queue.state}><StatusBadge value={queue.state} /><strong>{queue.count}</strong><span>작업</span></div>)}</div> : <Empty>대기열 작업이 없습니다.</Empty>}</section>
        </div>
      ) : null}
    </>
  );
}
