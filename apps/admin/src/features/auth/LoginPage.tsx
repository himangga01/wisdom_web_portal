import { useState, type FormEvent } from "react";

import { useSession } from "../../app/session";
import { ErrorMessage } from "../../components/AsyncState";

export function LoginPage() {
  const { login } = useSession();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(undefined);
    try {
      await login(String(form.get("username") ?? ""), String(form.get("password") ?? ""));
    } catch (nextError) {
      setError(nextError);
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">JIHYE OFFICE</p>
        <h1 id="login-title">관리자 로그인</h1>
        <p className="muted">승인된 관리자 계정으로 로그인하세요.</p>
        {error ? <ErrorMessage error={error} /> : null}
        <form onSubmit={(event) => void submit(event)}>
          <label>아이디<input name="username" autoComplete="username" required maxLength={128} autoFocus /></label>
          <label>비밀번호<input name="password" type="password" autoComplete="current-password" required maxLength={1024} /></label>
          <button className="button button-primary" type="submit" disabled={pending}>
            {pending ? "확인 중…" : "계속"}
          </button>
          {pending ? <p className="sr-only" role="status">로그인 정보를 확인하는 중입니다.</p> : null}
        </form>
      </section>
    </main>
  );
}
