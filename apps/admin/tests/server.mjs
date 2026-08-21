import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/admin");
const host = "127.0.0.1";
const port = 4174;
const origin = `http://${host}:${port}`;
const consultationStates = new Map([
  ["a", { status: "received", rowVersion: 1 }],
  ["b", { status: "received", rowVersion: 1 }],
]);

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function authenticated(request) {
  return (request.headers.cookie ?? "").split(";").some((value) => value.trim() === "admin=1");
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).toSorted().join("\0") === [...expected].toSorted().join("\0");
}

function validMutation(request, csrf) {
  return request.method === "POST" && request.headers.origin === origin &&
    request.headers["x-csrf-token"] === csrf && authenticated(request);
}

async function api(request, response, url) {
  const { pathname } = url;
  if (pathname === "/admin/api/v1/session") {
    if (!authenticated(request)) {
      sendJson(response, 401, { error: { code: "AUTH_REQUIRED", message: "login" } });
      return;
    }
    sendJson(response, 200, { data: {
      stage: "authenticated", adminId: "owner", csrfToken: "session-csrf",
      expiresAtMs: Date.now() + 60_000, idleExpiresAtMs: Date.now() + 60_000,
    } });
    return;
  }
  if (pathname === "/admin/api/v1/auth/preauth") {
    sendJson(response, 401, { error: { code: "AUTH_REQUIRED", message: "login" } });
    return;
  }
  if (pathname === "/admin/api/v1/auth/login" && request.method === "POST") {
    const body = await jsonBody(request);
    if (request.headers.origin !== origin || !exactKeys(body, ["username", "password"]) ||
        body.username !== "owner" || body.password !== "owner password") {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid login request" } });
      return;
    }
    consultationStates.set("a", { status: "received", rowVersion: 1 });
    consultationStates.set("b", { status: "received", rowVersion: 1 });
    sendJson(response, 202, { data: { stage: "mfa", csrfToken: "preauth-csrf" } }, {
      "set-cookie": "preauth=1; Path=/admin; HttpOnly; SameSite=Strict",
    });
    return;
  }
  if (pathname === "/admin/api/v1/auth/mfa" && request.method === "POST") {
    const body = await jsonBody(request);
    const hasPreauth = (request.headers.cookie ?? "").split(";")
      .some((value) => value.trim() === "preauth=1");
    if (request.headers.origin !== origin || request.headers["x-csrf-token"] !== "preauth-csrf" ||
        !hasPreauth || !exactKeys(body, ["username", "method", "code"]) ||
        body.username !== "owner" || body.method !== "totp" || body.code !== "123456") {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid MFA request" } });
      return;
    }
    sendJson(response, 200, { data: {
      stage: "authenticated", adminId: "owner", csrfToken: "session-csrf",
      expiresAtMs: Date.now() + 60_000, idleExpiresAtMs: Date.now() + 60_000,
    } }, { "set-cookie": "admin=1; Path=/admin; HttpOnly; SameSite=Strict" });
    return;
  }
  if (pathname === "/admin/api/v1/auth/preauth/reset" && request.method === "POST") {
    const body = await jsonBody(request);
    const hasPreauth = (request.headers.cookie ?? "").split(";")
      .some((value) => value.trim() === "preauth=1");
    if (request.headers.origin !== origin || request.headers["x-csrf-token"] !== "preauth-csrf" ||
        !hasPreauth || !exactKeys(body, [])) {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid reset request" } });
      return;
    }
    response.writeHead(204, {
      "cache-control": "no-store",
      "set-cookie": "preauth=; Path=/admin; Max-Age=0",
    });
    response.end();
    return;
  }
  if (pathname === "/admin/api/v1/dashboard") {
    sendJson(response, 200, { data: { counts: [{ status: "received", count: 2 }] } });
    return;
  }
  if (pathname === "/admin/api/v1/consultations") {
    const page = url.searchParams.get("page") === "2" ? 2 : 1;
    sendJson(response, 200, { data: {
      items: page === 1 ? [
        { id: "a", receiptId: "receipt-a", status: "received", locale: "ko", category: "A", receivedAtMs: 1 },
        { id: "b", receiptId: "receipt-b", status: "received", locale: "ko", category: "B", receivedAtMs: 2 },
      ] : [
        { id: "c", receiptId: "receipt-c", status: "received", locale: "ko", category: "C", receivedAtMs: 3 },
      ],
      page: { page, pageSize: 2, total: 3, pageCount: 2 },
    } });
    return;
  }
  if (pathname === "/admin/api/v1/consultations/a") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    sendJson(response, 200, { data: consultation("a", "민감 A") });
    return;
  }
  if (pathname === "/admin/api/v1/consultations/b") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    sendJson(response, 200, { data: consultation("b", "민감 B") });
    return;
  }
  if (pathname === "/admin/api/v1/consultations/b/status") {
    const body = await jsonBody(request);
    if (!validMutation(request, "session-csrf") ||
        !exactKeys(body, ["status", "rowVersion", "email", "hermes"]) ||
        body.status !== "acknowledged" || body.rowVersion !== 1 ||
        body.email !== false || body.hermes !== false) {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid mutation request" } });
      return;
    }
    consultationStates.set("b", { status: "acknowledged", rowVersion: 2 });
    sendJson(response, 200, { data: {
      kind: "updated",
      httpStatus: 200,
      consultationStatus: "acknowledged",
      rowVersion: 2,
    } });
    return;
  }
  if (pathname === "/admin/api/v1/releases" && request.method === "GET") {
    sendJson(response, 200, { data: {
      items: [
        {
          id: "release-1",
          version: "v1",
          state: "retired",
          manifestSha256: "ab".repeat(32),
          verifiedAtMs: null,
          activatedAtMs: null,
          rolledBackAtMs: null,
          createdAtMs: 1,
        },
        {
          id: "release-2",
          version: "v2",
          state: "retired",
          manifestSha256: "cd".repeat(32),
          verifiedAtMs: null,
          activatedAtMs: null,
          rolledBackAtMs: null,
          createdAtMs: 2,
        },
      ],
      page: { page: 1, pageSize: 20, total: 2, pageCount: 1 },
    } });
    return;
  }
  const rollbackConfirm = /^\/admin\/api\/v1\/releases\/(release-[12])\/rollback\/confirm$/u.exec(pathname);
  if (rollbackConfirm) {
    const body = await jsonBody(request);
    if (!validMutation(request, "session-csrf") || !exactKeys(body, [])) {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid rollback confirmation" } });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    sendJson(response, 200, { data: {
      confirmationToken: `${rollbackConfirm[1]}-token`, expiresInMs: 120_000,
    } });
    return;
  }
  const rollback = /^\/admin\/api\/v1\/releases\/(release-[12])\/rollback$/u.exec(pathname);
  if (rollback) {
    const body = await jsonBody(request);
    if (!validMutation(request, "session-csrf") ||
        !exactKeys(body, ["confirmationToken"]) ||
        body.confirmationToken !== `${rollback[1]}-token`) {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "invalid rollback" } });
      return;
    }
    sendJson(response, 200, { data: {
      releaseId: rollback[1], version: "rolled-back", manifestSha256: "ef".repeat(32),
    } });
    return;
  }
  if (pathname === "/admin/api/v1/health") {
    sendJson(response, 401, { error: { code: "AUTH_REQUIRED", message: "expired" } }, {
      "set-cookie": "admin=; Path=/admin; Max-Age=0",
    });
    return;
  }
  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "missing" } });
}

function consultation(id, name) {
  const state = consultationStates.get(id) ?? { status: "received", rowVersion: 1 };
  return {
    id,
    receiptId: `receipt-${id}`,
    status: state.status,
    locale: "ko",
    category: id.toUpperCase(),
    receivedAtMs: 1,
    preferredContact: "phone",
    rowVersion: state.rowVersion,
    pii: { name, phone: "010", email: "", company: "", message: `문의 ${id}` },
    piiAvailability: "available",
    nextStatuses: state.status === "received" ? ["acknowledged"] : ["in_progress"],
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/admin/api/")) {
      await api(request, response, url);
      return;
    }
    if (url.pathname.startsWith("/admin/assets/") && /^[A-Za-z0-9._-]+$/u.test(path.basename(url.pathname))) {
      const file = path.join(root, "assets", path.basename(url.pathname));
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": file.endsWith(".css") ? "text/css" : "text/javascript",
        "cache-control": "public, max-age=31536000, immutable",
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const body = await readFile(path.join(root, "index.html"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
