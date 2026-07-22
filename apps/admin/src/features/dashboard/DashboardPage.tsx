import type { AdminDashboardDto } from "@wisdom/shared";
import { Link } from "react-router-dom";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";

export function DashboardPage() {
  const { data, error, loading } = useResource<AdminDashboardDto>("/dashboard");
  return (
    <>
      <PageHeader eyebrow="OVERVIEW" title="대시보드" description="상담 접수와 운영 상태를 빠르게 확인합니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : !data?.counts.length ? (
        <Empty>아직 접수된 상담이 없습니다.</Empty>
      ) : (
        <section className="stat-grid" aria-label="상담 상태별 건수">
          {data.counts.map((item) => (
            <Link className="stat-card" to="/consultations" key={item.status}>
              <StatusBadge value={item.status} />
              <strong>{item.count.toLocaleString()}</strong>
              <span>상담</span>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}
