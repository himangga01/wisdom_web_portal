import type { AdminConsultationDetailDto, ConsultationStatus } from "@wisdom/shared";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";

export function ConsultationDetailPage() {
  const { id = "" } = useParams();
  const resource = useResource<AdminConsultationDetailDto>(`/consultations/${encodeURIComponent(id)}`);
  const [mutationError, setMutationError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!resource.data) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setMutationError(undefined);
    try {
      await apiRequest(`/consultations/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: {
          status: String(form.get("status")) as ConsultationStatus,
          rowVersion: resource.data.rowVersion,
          email: form.get("email") === "on",
          hermes: form.get("hermes") === "on",
        },
      });
      await resource.reload();
    } catch (error) {
      setMutationError(error);
    } finally {
      setPending(false);
    }
  };
  if (resource.loading) return <Loading />;
  if (resource.error || !resource.data) return <ErrorMessage error={resource.error} />;
  const item = resource.data;
  return (
    <>
      <PageHeader
        eyebrow="CONSULTATION"
        title={item.receiptId}
        description="상담 상세 정보와 처리 상태를 관리합니다."
        actions={<Link className="button button-secondary" to="/consultations">목록으로</Link>}
      />
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      <div className="detail-grid">
        <section className="panel">
          <div className="section-heading"><h2>접수 정보</h2><StatusBadge value={item.status} /></div>
          <dl className="definition-grid">
            <div><dt>언어</dt><dd>{item.locale}</dd></div>
            <div><dt>분류</dt><dd>{item.category}</dd></div>
            <div><dt>선호 연락</dt><dd>{item.preferredContact}</dd></div>
            <div><dt>접수 시각</dt><dd>{new Date(item.receivedAtMs).toLocaleString()}</dd></div>
          </dl>
        </section>
        <section className="panel sensitive-panel">
          <div className="section-heading"><h2>개인정보</h2><span className="sensitive-label">민감 정보</span></div>
          {item.pii ? (
            <dl className="definition-grid">
              <div><dt>이름</dt><dd>{item.pii.name}</dd></div>
              <div><dt>전화</dt><dd>{item.pii.phone}</dd></div>
              <div><dt>이메일</dt><dd>{item.pii.email || "-"}</dd></div>
              <div><dt>회사</dt><dd>{item.pii.company || "-"}</dd></div>
              <div className="full"><dt>문의 내용</dt><dd className="message-body">{item.pii.message}</dd></div>
            </dl>
          ) : <p className="muted">보유기간 만료로 개인정보가 파기되었습니다.</p>}
        </section>
      </div>
      <section className="panel form-panel">
        <h2>상태 변경</h2>
        {item.nextStatuses.length ? (
          <form onSubmit={(event) => void submit(event)}>
            <label>다음 상태<select name="status" required defaultValue=""><option value="" disabled>상태 선택</option>{item.nextStatuses.map((status) => <option key={status}>{status}</option>)}</select></label>
            <div className="checkbox-row">
              <label><input type="checkbox" name="email" /> 이메일 알림</label>
              <label><input type="checkbox" name="hermes" /> Hermes 알림</label>
            </div>
            <button className="button button-primary" type="submit" disabled={pending}>{pending ? "저장 중…" : "상태 저장"}</button>
          </form>
        ) : <p className="muted">종료 상태이므로 변경할 수 없습니다.</p>}
      </section>
    </>
  );
}
