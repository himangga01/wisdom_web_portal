import { adminConsentAuthoritySchema } from "@wisdom/shared";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";

export function ConsentsPage() {
  const { data, error, loading } = useResource("/consents", adminConsentAuthoritySchema);
  const candidate = data?.databaseCandidate ?? null;
  return (
    <>
      <PageHeader eyebrow="POLICY" title="동의 문서" description="데이터베이스 게시 후보와 실제 공개 권한을 구분해 확인합니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : !data ? <Empty>동의 권한 상태를 불러올 수 없습니다.</Empty> : (
        <>
          <section className="panel">
            <div className="section-heading"><h2>공개 권한</h2><span className="count">{data.inSync ? "일치" : "불일치"}</span></div>
            <p>DB 후보: <strong>{candidate?.bundleId ?? "없음"}</strong></p>
            <p>공개 릴리스: <strong>{data.publicAuthority?.bundleId ?? "없음"}</strong></p>
            {data.publicAuthority ? <p><code>{data.publicAuthority.releaseId}</code></p> : null}
          </section>
          {!candidate ? <Empty>완전한 활성 동의 번들이 없습니다.</Empty> : (
        <section className="panel table-panel">
          <div className="section-heading"><h2>{candidate.bundleId}</h2><span className="count">{candidate.documents.length}</span></div>
          <div className="table-wrap"><table><thead><tr><th>종류</th><th>언어</th><th>버전</th></tr></thead><tbody>{candidate.documents.map((document) => <tr key={`${document.kind}:${document.locale}`}><td>{document.kind}</td><td>{document.locale}</td><td><code>{document.version}</code></td></tr>)}</tbody></table></div>
        </section>
          )}
        </>
      )}
    </>
  );
}
