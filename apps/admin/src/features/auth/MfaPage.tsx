import { useState, type FormEvent } from "react";

import { useSession } from "../../app/session";
import { ErrorMessage } from "../../components/AsyncState";

export function MfaPage() {
  const { completeMfa, restartLogin } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      await completeMfa(
        String(form.get("username") ?? ""),
        form.get("method") === "recovery" ? "recovery" : "totp",
        String(form.get("code") ?? ""),
      );
    } catch (nextError) {
      setError(nextError);
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="mfa-title">
        <p className="eyebrow">2단계 인증</p>
        <h1 id="mfa-title">본인 확인</h1>
        <p className="muted">인증 앱 코드 또는 복구 코드를 입력하세요.</p>
        {error ? <ErrorMessage error={error} /> : null}
        <form onSubmit={(event) => void submit(event)}>
          <label>아이디<input name="username" autoComplete="username" required maxLength={128} autoFocus /></label>
          <label>인증 방식<select name="method" defaultValue="totp"><option value="totp">인증 앱</option><option value="recovery">복구 코드</option></select></label>
          <label>인증 코드<input name="code" autoComplete="one-time-code" required maxLength={128} /></label>
          <button className="button button-primary" type="submit" disabled={pending}>
            {pending ? "인증 중…" : "로그인"}
          </button>
          <button className="button button-ghost" type="button" disabled={pending} onClick={() => void restartLogin()}>
            처음부터 다시 로그인
          </button>
        </form>
      </section>
    </main>
  );
}
