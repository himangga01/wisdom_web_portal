import { adminRevisionDiffSchema } from "@wisdom/shared";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { useResource } from "../../api/use-resource";
import { ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";

export function RevisionDiffPage() {
  const { id = "", revisionId = "" } = useParams();
  const [search] = useSearchParams();
  const against = search.get("against") ?? "";
  const { data, error, loading } = useResource(
    `/articles/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/diff?against=${encodeURIComponent(against)}`,
    adminRevisionDiffSchema,
  );
  if (loading) return <Loading />;
  if (error || !data) return <ErrorMessage error={error} />;
  return (
    <>
      <PageHeader eyebrow={data.locale} title="리비전 비교" actions={<Link className="button button-secondary" to={`/articles/${encodeURIComponent(id)}`}>문서로 돌아가기</Link>} />
      <div className="diff-grid">
        <section className="panel"><h2>이전</h2><h3>{data.previous.title}</h3><p>{data.previous.summary}</p><pre>{data.previous.bodyMarkdown}</pre></section>
        <section className="panel"><h2>현재</h2><h3>{data.current.title}</h3><p>{data.current.summary}</p><pre>{data.current.bodyMarkdown}</pre></section>
      </div>
    </>
  );
}
