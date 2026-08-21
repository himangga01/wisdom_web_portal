import { adminConsultationListSchema } from "@wisdom/shared";
import { Link, useSearchParams } from "react-router-dom";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";

export function ConsultationListPage() {
  const [search] = useSearchParams();
  const page = search.get("page") ?? "1";
  const { data, error, loading } = useResource(
    `/consultations?page=${encodeURIComponent(page)}`,
    adminConsultationListSchema,
  );
  return (
    <>
      <PageHeader eyebrow="INBOX" title="상담 관리" description="개인정보는 상세 화면에서만 확인할 수 있습니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : !data?.items.length ? (
        <Empty>표시할 상담이 없습니다.</Empty>
      ) : (
        <section className="panel table-panel">
          <div className="table-wrap">
            <table>
              <thead><tr><th>접수번호</th><th>상태</th><th>언어</th><th>분류</th><th>접수 시각</th></tr></thead>
              <tbody>{data.items.map((item) => (
                <tr key={item.id}>
                  <td><Link className="table-link" to={`/consultations/${encodeURIComponent(item.id)}`}>{item.receiptId}</Link></td>
                  <td><StatusBadge value={item.status} /></td>
                  <td>{item.locale}</td>
                  <td>{item.category}</td>
                  <td>{new Date(item.receivedAtMs).toLocaleString()}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Pagination page={data.page} path="/consultations" />
        </section>
      )}
    </>
  );
}
