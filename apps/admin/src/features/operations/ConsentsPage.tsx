import type { AdminConsentBundleDto } from "@wisdom/shared";

import { useResource } from "../../api/use-resource";
import { Empty, ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";

export function ConsentsPage() {
  const { data, error, loading } = useResource<AdminConsentBundleDto | null>("/consents");
  return (
    <>
      <PageHeader eyebrow="POLICY" title="동의 문서" description="현재 활성화된 개인정보·마케팅 동의 번들을 확인합니다." />
      {loading ? <Loading /> : error ? <ErrorMessage error={error} /> : !data ? <Empty>완전한 활성 동의 번들이 없습니다.</Empty> : (
        <section className="panel table-panel">
          <div className="section-heading"><h2>{data.bundleId}</h2><span className="count">{data.documents.length}</span></div>
          <div className="table-wrap"><table><thead><tr><th>종류</th><th>언어</th><th>버전</th></tr></thead><tbody>{data.documents.map((document) => <tr key={`${document.kind}:${document.locale}`}><td>{document.kind}</td><td>{document.locale}</td><td><code>{document.version}</code></td></tr>)}</tbody></table></div>
        </section>
      )}
    </>
  );
}
