import type { AdminNotificationsDto } from "@wisdom/shared";
import { useState, type FormEvent } from "react";

import { apiRequest } from "../../api/client";
import { useResource } from "../../api/use-resource";
import { ErrorMessage, Loading } from "../../components/AsyncState";
import { PageHeader } from "../../components/PageHeader";
import { StatusBadge } from "../../components/StatusBadge";

export function NotificationsPage() {
  const resource = useResource<AdminNotificationsDto>("/notifications");
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [mutationError, setMutationError] = useState<unknown>();
  const saveEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending("email"); setMessage(undefined); setMutationError(undefined);
    try {
      await apiRequest("/notifications", { method: "POST", body: {
        channel: "email",
        enabled: form.get("enabled") === "on",
        payloadMode: String(form.get("payloadMode")),
        fullInquiryApproved: form.get("fullInquiryApproved") === "on",
        smtp: {
          host: String(form.get("host")), port: 465, from: String(form.get("from")),
          to: String(form.get("to")), secretRef: String(form.get("secretRef")),
        },
      }});
      setMessage("이메일 알림 설정을 저장했습니다.");
      await resource.reload();
    } catch (error) { setMutationError(error); } finally { setPending(undefined); }
  };
  const saveHermes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending("hermes"); setMessage(undefined); setMutationError(undefined);
    try {
      await apiRequest("/notifications", { method: "POST", body: { channel: "hermes-telegram", enabled: form.get("enabled") === "on" } });
      setMessage("Hermes 알림 설정을 저장했습니다.");
      await resource.reload();
    } catch (error) { setMutationError(error); } finally { setPending(undefined); }
  };
  const sendTest = async (channel: "email" | "hermes-telegram") => {
    setPending(`test:${channel}`); setMessage(undefined); setMutationError(undefined);
    try {
      await apiRequest("/notifications/test", { method: "POST", body: { channel } });
      setMessage("테스트 알림을 대기열에 추가했습니다.");
    } catch (error) { setMutationError(error); } finally { setPending(undefined); }
  };
  if (resource.loading) return <Loading />;
  if (resource.error || !resource.data) return <ErrorMessage error={resource.error} />;
  const email = resource.data.settings.find((item) => item.channel === "email");
  const hermes = resource.data.settings.find((item) => item.channel === "hermes-telegram");
  return (
    <>
      <PageHeader eyebrow="DELIVERY" title="알림 설정" description="비밀값은 Keychain 참조만 저장하며 화면에 노출하지 않습니다." />
      {message ? <div className="alert alert-success" role="status">{message}</div> : null}
      {mutationError ? <ErrorMessage error={mutationError} /> : null}
      <div className="settings-grid">
        <section className="panel form-panel">
          <div className="section-heading"><h2>이메일</h2><StatusBadge value={email?.enabled ? "active" : "disabled"} /></div>
          <form onSubmit={(event) => void saveEmail(event)}>
            <label className="check-label"><input type="checkbox" name="enabled" defaultChecked={email?.enabled} /> 이메일 알림 활성화</label>
            <label>전송 범위<select name="payloadMode" defaultValue={email?.payloadMode ?? "receipt-only"}><option value="receipt-only">접수 정보만</option><option value="full-inquiry">문의 전체</option></select></label>
            <div className="form-grid">
              <label>SMTP 호스트<input name="host" defaultValue={email?.smtp?.host ?? ""} maxLength={253} required /></label>
              <label>포트<input value="465" readOnly /></label>
              <label>보내는 주소<input name="from" type="email" defaultValue={email?.smtp?.from ?? ""} required /></label>
              <label>받는 주소<input name="to" type="email" defaultValue={email?.smtp?.to ?? ""} required /></label>
              <label className="full">Keychain 참조<input name="secretRef" defaultValue={email?.smtp?.secretRef ?? ""} placeholder="keychain:wisdom-smtp" required /></label>
            </div>
            <label className="check-label"><input type="checkbox" name="fullInquiryApproved" /> 문의 전체 전송을 명시적으로 승인</label>
            <div className="action-row"><button className="button button-primary" disabled={pending === "email"}>설정 저장</button><button className="button button-secondary" type="button" disabled={pending === "test:email"} onClick={() => void sendTest("email")}>테스트 발송</button></div>
          </form>
        </section>
        <section className="panel form-panel">
          <div className="section-heading"><h2>Hermes Telegram</h2><StatusBadge value={hermes?.enabled ? "active" : "disabled"} /></div>
          <form onSubmit={(event) => void saveHermes(event)}>
            <label className="check-label"><input type="checkbox" name="enabled" defaultChecked={hermes?.enabled} /> Hermes 알림 활성화</label>
            <p className="muted">연결 비밀값은 서버 Keychain과 환경 설정에서 관리합니다.</p>
            <div className="action-row"><button className="button button-primary" disabled={pending === "hermes"}>설정 저장</button><button className="button button-secondary" type="button" disabled={pending === "test:hermes-telegram"} onClick={() => void sendTest("hermes-telegram")}>테스트 발송</button></div>
          </form>
        </section>
      </div>
    </>
  );
}
