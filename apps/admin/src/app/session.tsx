import {
  adminPreAuthSchema,
  adminSessionSchema,
  adminVoidSchema,
  type AdminPreAuthDto,
  type AdminSessionDto,
} from "@wisdom/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import {
  AdminApiError,
  apiRequest,
  setAuthRequiredHandler,
  setCsrfToken,
} from "../api/client";

type SessionState =
  | { stage: "loading" }
  | { stage: "error"; error: unknown }
  | { stage: "anonymous" }
  | AdminPreAuthDto
  | AdminSessionDto;

interface SessionContextValue {
  state: SessionState;
  login(username: string, password: string): Promise<void>;
  completeMfa(username: string, method: "totp" | "recovery", code: string): Promise<void>;
  restartLogin(): Promise<void>;
  retrySession(): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<SessionState>({ stage: "loading" });

  useEffect(() => setAuthRequiredHandler(() => {
    setCsrfToken(undefined);
    setState({ stage: "anonymous" });
  }), []);

  const retrySession = useCallback(async () => {
    setState({ stage: "loading" });
    try {
      const session = await apiRequest("/session", adminSessionSchema);
      setCsrfToken(session.csrfToken);
      setState(session);
      return;
    } catch (error) {
      if (!(error instanceof AdminApiError) || error.status !== 401) {
        setState({ stage: "error", error });
        return;
      }
    }
    try {
      const preauth = await apiRequest("/auth/preauth", adminPreAuthSchema);
      setCsrfToken(preauth.csrfToken);
      setState(preauth);
    } catch (error) {
      setCsrfToken(undefined);
      setState(error instanceof AdminApiError && error.status === 401
        ? { stage: "anonymous" }
        : { stage: "error", error });
    }
  }, []);

  useEffect(() => {
    void retrySession();
  }, [retrySession]);

  const login = useCallback(async (username: string, password: string) => {
    const preauth = await apiRequest("/auth/login", adminPreAuthSchema, {
      method: "POST",
      body: { username, password },
    });
    setCsrfToken(preauth.csrfToken);
    setState(preauth);
  }, []);

  const completeMfa = useCallback(async (
    username: string,
    method: "totp" | "recovery",
    code: string,
  ) => {
    const session = await apiRequest("/auth/mfa", adminSessionSchema, {
      method: "POST",
      body: { username, method, code },
    });
    setCsrfToken(session.csrfToken);
    setState(session);
  }, []);

  const restartLogin = useCallback(async () => {
    try {
      await apiRequest("/auth/preauth/reset", adminVoidSchema, { method: "POST", body: {} });
    } finally {
      setCsrfToken(undefined);
      setState({ stage: "anonymous" });
    }
  }, []);

  const logout = useCallback(async () => {
    await apiRequest("/auth/logout", adminVoidSchema, { method: "POST", body: {} });
    setCsrfToken(undefined);
    setState({ stage: "anonymous" });
  }, []);

  const value = useMemo(() => ({
    state,
    login,
    completeMfa,
    restartLogin,
    retrySession,
    logout,
  }), [
    state,
    login,
    completeMfa,
    restartLogin,
    retrySession,
    logout,
  ]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is required");
  return value;
}
