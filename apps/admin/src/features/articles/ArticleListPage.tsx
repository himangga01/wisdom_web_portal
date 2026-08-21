import { adminArticleListSchema } from "@wisdom/shared";
import { Link, useSearchParams } from "react-router-dom";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/Pagination";
import { StatusBadge } from "../../components/StatusBadge";

export function ArticleListPage() {
  const [search] = useSearchParams();
  const page = search.get("page") ?? "1";
  const { data, error, loading } = useResource(
    `/articles?page=${encodeURIComponent(page)}`,
    adminArticleListSchema,
  );
  return (
    <>
      <PageHeader eyebrow="CONTENT" title="콘텐츠 검토" description="언어별 문서 상태와 공개 슬러그를 검토합니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : !data?.items.length ? (
        <Empty>검토할 콘텐츠가 없습니다.</Empty>
      ) : (
        <section className="panel table-panel">
          <div className="table-wrap"><table>
            <thead><tr><th>제목</th><th>언어</th><th>상태</th><th>슬러그</th><th>버전</th><th>수정 시각</th></tr></thead>
            <tbody>{data.items.map((item) => (
              <tr key={`${item.id}:${item.locale}`}>
                <td><Link className="table-link" to={`/articles/${encodeURIComponent(item.id)}`}>{item.title}</Link></td>
                <td>{item.locale}</td><td><StatusBadge value={item.state} /></td>
                <td><code>{item.slug}</code></td><td>v{item.rowVersion}</td>
                <td>{new Date(item.updatedAtMs).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <Pagination page={data.page} path="/articles" />
        </section>
      )}
    </>
  );
}
