import type { AdminApiErrorBody, AdminApiSuccess } from "@wisdom/shared";

let csrfToken: string | undefined;
let authRequiredHandler: (() => void) | undefined;

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: AdminApiErrorBody["error"]["code"];
  readonly fieldErrors: Record<string, string> | undefined;

  constructor(status: number, body: AdminApiErrorBody) {
    super(body.error.message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = body.error.code;
    this.fieldErrors = body.error.fieldErrors;
  }
}

export function setCsrfToken(value: string | undefined): void {
  csrfToken = value;
}

export function setAuthRequiredHandler(handler: (() => void) | undefined): () => void {
  authRequiredHandler = handler;
  return () => {
    if (authRequiredHandler === handler) authRequiredHandler = undefined;
  };
}

function isAdminApiErrorBody(value: unknown): value is AdminApiErrorBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(
    error && typeof error === "object" && !Array.isArray(error) &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string",
  );
}

export async function apiRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; csrf?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const mutationToken = options.csrf ?? csrfToken;
  if (method !== "GET" && mutationToken) headers.set("X-CSRF-Token", mutationToken);
  const response = await fetch(`/admin/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return undefined as T;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("서버 응답을 읽지 못했습니다.");
  }
  if (!response.ok) {
    const body = isAdminApiErrorBody(parsed)
      ? parsed
      : {
          error: {
            code: "INTERNAL_ERROR" as const,
            message: "서버 오류 응답을 확인하지 못했습니다.",
          },
        };
    if (response.status === 401 && body.error.code === "AUTH_REQUIRED") {
      authRequiredHandler?.();
    }
    throw new AdminApiError(response.status, body);
  }
  return (parsed as AdminApiSuccess<T>).data;
}
