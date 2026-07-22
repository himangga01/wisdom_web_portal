import { useEffect, useRef, type ReactNode } from "react";

export function Loading({ label = "불러오는 중" }: { label?: string }) {
  return <div className="state-card" role="status" aria-live="polite"><span className="spinner" />{label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state-card">{children}</div>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const message = error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
  useEffect(() => { ref.current?.focus(); }, [message]);
  return <div ref={ref} className="alert alert-error" role="alert" tabIndex={-1}>{message}</div>;
}
