import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createControlApp } from "../app.js";
import { createStaticKeyProvider } from "../crypto/index.js";

const PUBLIC_ORIGIN = "https://www.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const databases: TestDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

function fixture() {
  const database = createTestDatabase();
  databases.push(database);
  return createControlApp({
    db: database.db,
    keyProvider: createStaticKeyProvider({ id: "pii-test", secret: Buffer.alloc(32, 41) }),
    allowedOrigins: [PUBLIC_ORIGIN],
    enforceOrigin: true,
    publicOrigin: PUBLIC_ORIGIN,
    adminOrigin: ADMIN_ORIGIN,
    authSecret: Buffer.alloc(32, 42),
    withdrawalSecret: Buffer.alloc(32, 43),
    dummyPasswordHash: "test-only-unused-dummy-hash",
    peerAddress: () => "127.0.0.1",
  });
}

describe("React administrator entry routes", () => {
  it("serves the React shell only on the administrator origin", async () => {
    const app = fixture();
    const response = await app.request(`${ADMIN_ORIGIN}/admin/consultations/example`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await response.text();
    const script = /\/admin\/assets\/admin-[A-Za-z0-9_-]+\.js/u.exec(html)?.[0];
    const stylesheet = /\/admin\/assets\/admin-[A-Za-z0-9_-]+\.css/u.exec(html)?.[0];
    expect(script).toBeTruthy();
    expect(stylesheet).toBeTruthy();
    expect(html).toContain('id="root"');
    for (const asset of [script!, stylesheet!]) {
      const assetResponse = await app.request(`${ADMIN_ORIGIN}${asset}`);
      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
    expect((await app.request(`${PUBLIC_ORIGIN}/admin`)).status).toBe(404);
  });

  it("returns a JSON authentication error for an anonymous API session", async () => {
    const response = await fixture().request(`${ADMIN_ORIGIN}/admin/api/v1/session`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "관리자 로그인이 필요합니다." },
    });
  });
});
