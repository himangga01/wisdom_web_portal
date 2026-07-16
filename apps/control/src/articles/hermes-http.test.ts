import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createControlApp } from "../app.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { computeHermesArticleDraftSignature } from "./hermes-intake.js";

const NOW = Date.parse("2026-07-16T00:00:00.000Z");
const SECRET = Buffer.alloc(32, 81);
let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

function body() {
  return JSON.stringify({
    idempotencyKey: "hermes-http-20260716-0001",
    hermesDraftId: "hermes_01JYYYYYYYYYYYYYYYYYYYYYYY",
    sourceLocale: "ko",
    title: "Guide",
    summary: "Administrative guidance summary.",
    bodyMarkdown: "## Safe guidance\n\nBody.\n",
    sources: [{
      id: "source-1",
      url: "https://example.com/source",
      sourceTimestamp: "2026-07-16T00:00:00.000Z",
    }],
  });
}

function signedHeaders(serialized: string, nonce = "nonce-http-20260716-0001") {
  const rawBody = Buffer.from(serialized, "utf8");
  const unsigned = {
    method: "POST",
    route: "/internal/v1/article-drafts",
    peerAddress: "127.0.0.1",
    timestamp: String(NOW),
    nonce,
    idempotencyKey: "hermes-http-20260716-0001",
    rawBody,
  };
  return {
    "content-type": "application/json",
    "idempotency-key": unsigned.idempotencyKey,
    "x-hermes-timestamp": unsigned.timestamp,
    "x-hermes-nonce": unsigned.nonce,
    "x-hermes-signature": computeHermesArticleDraftSignature(SECRET, unsigned),
  };
}

function fixture(hostRouting = false) {
  testDatabase = createTestDatabase();
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
  ];
  let index = 0;
  return createControlApp({
    db: testDatabase.db,
    keyProvider: createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 82) }),
    allowedOrigins: [],
    enforceOrigin: false,
    hermesHmacSecret: SECRET,
    now: () => NOW,
    randomUUID: () => ids[index++]!,
    peerAddress: (context) => context.req.header("x-test-peer") ?? "127.0.0.1",
    ...(hostRouting ? {
      publicOrigin: "https://www.example.test",
      adminOrigin: "https://admin.example.test",
      authSecret: Buffer.alloc(32, 83),
      withdrawalSecret: Buffer.alloc(32, 84),
      dummyPasswordHash: "unused-test-hash",
    } : {}),
  });
}

describe("Hermes internal article HTTP route", () => {
  it("accepts signed loopback raw bytes and returns an idempotent replay", async () => {
    const app = fixture();
    const serialized = body();
    const first = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: signedHeaders(serialized),
      body: serialized,
    });
    expect(first.status).toBe(201);
    const firstPayload = await first.text();
    expect(JSON.parse(firstPayload)).toEqual({
      articleId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      state: "draft",
    });

    const replay = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: signedHeaders(serialized, "nonce-http-20260716-0002"),
      body: serialized,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.text()).toBe(firstPayload);
  });

  it("remains reachable from the literal local origin when public/admin host routing is enabled", async () => {
    const app = fixture(true);
    const serialized = body();
    const response = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: signedHeaders(serialized),
      body: serialized,
    });
    expect(response.status).toBe(201);
    expect(JSON.parse(await response.text())).toMatchObject({ state: "draft" });
  });

  it("never trusts a forwarded loopback address", async () => {
    const app = fixture();
    const serialized = body();
    const response = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: {
        ...signedHeaders(serialized),
        "x-test-peer": "203.0.113.10",
        "x-forwarded-for": "127.0.0.1",
      },
      body: serialized,
    });
    expect(response.status).toBe(404);
    expect(testDatabase!.db.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 0 });
  });

  it("hides the endpoint from a non-loopback peer before media-type or authentication checks", async () => {
    const app = fixture();
    const response = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": String(300 * 1_024),
        "x-test-peer": "203.0.113.10",
      },
      body: "not authenticated",
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(testDatabase!.db.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 0 });
  });

  it.each([
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-server",
    "x-real-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
  ])("rejects loopback requests carrying the proxy header %s", async (header) => {
    const app = fixture();
    const response = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        [header]: "127.0.0.1",
      },
      body: "missing authentication",
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(testDatabase!.db.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 0 });
  });

  it("requires JSON and authentication headers without reflecting secrets", async () => {
    const app = fixture();
    const response = await app.request("http://127.0.0.1/internal/v1/article-drafts", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: SECRET.toString("hex"),
    });
    expect(response.status).toBe(415);
    expect(await response.text()).not.toContain(SECRET.toString("hex"));
  });
});
