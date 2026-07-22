import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  apiRequest,
  setAuthRequiredHandler,
  setCsrfToken,
} from "./client";

afterEach(() => {
  setAuthRequiredHandler(undefined);
  setCsrfToken(undefined);
  vi.unstubAllGlobals();
});

describe("administrator API client", () => {
  it("returns a success envelope and forwards mutation CSRF", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-token");
      return new Response(JSON.stringify({ data: { saved: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-token");
    await expect(apiRequest("/notifications", {
      method: "POST",
      body: { enabled: true },
    })).resolves.toEqual({ saved: true });
  });

  it("notifies the session boundary only when authentication is required", async () => {
    const required = vi.fn();
    setAuthRequiredHandler(required);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "AUTH_REQUIRED", message: "expired" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(apiRequest("/dashboard")).rejects.toMatchObject({
      name: "AdminApiError",
      status: 401,
      code: "AUTH_REQUIRED",
    });
    expect(required).toHaveBeenCalledOnce();

    required.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "AUTH_INVALID", message: "invalid" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(apiRequest("/auth/mfa", { method: "POST", body: {} })).rejects.toBeInstanceOf(AdminApiError);
    expect(required).not.toHaveBeenCalled();
  });

  it("turns malformed non-success responses into a stable internal error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "legacy-shape" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })));
    await expect(apiRequest("/dashboard")).rejects.toMatchObject({
      name: "AdminApiError",
      status: 503,
      code: "INTERNAL_ERROR",
      message: "서버 오류 응답을 확인하지 못했습니다.",
    });
  });
});
