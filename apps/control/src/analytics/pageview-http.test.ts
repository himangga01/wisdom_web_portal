import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../test/helpers.js";
import { createControlApp } from "../app.js";
import { createStaticKeyProvider } from "../crypto/index.js";
import { closeAnalyticsDatabase, openAnalyticsDatabase, type AnalyticsDatabase } from "./store.js";

const ORIGIN = "https://www.example.test";
const NOON_KST = Date.UTC(2026, 6, 24, 3, 0, 0);
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 9) });
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture() {
  const database = createTestDatabase();
  const analyticsDb = openAnalyticsDatabase(":memory:");
  cleanups.push(() => {
    closeAnalyticsDatabase(analyticsDb);
    database.close();
  });
  const app = createControlApp({
    db: database.db,
    analyticsDb,
    keyProvider,
    allowedOrigins: [ORIGIN],
    enforceOrigin: true,
    now: () => NOON_KST,
    peerAddress: () => "203.0.113.10",
    logger: { write: () => {} },
  });
  return { app, analyticsDb };
}

async function beacon(
  app: ReturnType<typeof createControlApp>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(`${ORIGIN}/api/v1/pageview`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh) TestBrowser/1.0",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function totals(analyticsDb: AnalyticsDatabase): { views: number; visitors: number } {
  const row = analyticsDb.sqlite.prepare(
    "SELECT coalesce(sum(views), 0) AS views, coalesce(sum(visitors), 0) AS visitors FROM analytics_site_days",
  ).get() as { views: number; visitors: number };
  return row;
}

describe("POST /api/v1/pageview", () => {
  it("records an allowlisted localized path and answers 204", async () => {
    const { app, analyticsDb } = fixture();
    const response = await beacon(app, { p: "/en/insights", r: "https://www.google.com/search?q=x" });
    expect(response.status).toBe(204);
    expect(totals(analyticsDb)).toEqual({ views: 1, visitors: 1 });
    expect(analyticsDb.sqlite.prepare(
      "SELECT path, locale, views FROM analytics_page_days",
    ).all()).toEqual([{ path: "/insights", locale: "en", views: 1 }]);
    expect(analyticsDb.sqlite.prepare(
      "SELECT referrer_origin, views FROM analytics_referrer_days",
    ).all()).toEqual([{ referrer_origin: "https://www.google.com", views: 1 }]);
  });

  it("counts article slugs, strips queries, and treats self-referrals as direct", async () => {
    const { app, analyticsDb } = fixture();
    await beacon(app, { p: "/zh-hans/insights/visa-guide?utm=x", r: `${ORIGIN}/zh-hans` });
    expect(analyticsDb.sqlite.prepare(
      "SELECT path, locale FROM analytics_page_days",
    ).all()).toEqual([{ path: "/insights/visa-guide", locale: "zh-Hans" }]);
    expect(analyticsDb.sqlite.prepare(
      "SELECT referrer_origin FROM analytics_referrer_days",
    ).all()).toEqual([{ referrer_origin: "" }]);
  });

  it("silently drops paths that are not published routes", async () => {
    const { app, analyticsDb } = fixture();
    for (const p of ["/admin", "/insights/Bad-Slug", "/nope", "../x"]) {
      const response = await beacon(app, { p });
      expect(response.status, p).toBe(204);
    }
    expect(totals(analyticsDb)).toEqual({ views: 0, visitors: 0 });
  });

  it("drops disallowed or missing origins without a hint", async () => {
    const { app, analyticsDb } = fixture();
    const wrongOrigin = await beacon(app, { p: "/" }, { origin: "https://evil.example.test" });
    expect(wrongOrigin.status).toBe(204);
    const missingOrigin = await app.request(`${ORIGIN}/api/v1/pageview`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ p: "/" }),
    });
    expect(missingOrigin.status).toBe(204);
    expect(totals(analyticsDb)).toEqual({ views: 0, visitors: 0 });
  });

  it("drops bots, missing user agents, prefetches, and opt-out signals", async () => {
    const { app, analyticsDb } = fixture();
    await beacon(app, { p: "/" }, { "user-agent": "FancyBot/2.0 (+https://bots.example)" });
    await beacon(app, { p: "/" }, { "user-agent": "curl/8.5.0" });
    await beacon(app, { p: "/" }, { "user-agent": "" });
    await beacon(app, { p: "/" }, { "sec-purpose": "prefetch;prerender" });
    await beacon(app, { p: "/" }, { "sec-gpc": "1" });
    await beacon(app, { p: "/" }, { dnt: "1" });
    expect(totals(analyticsDb)).toEqual({ views: 0, visitors: 0 });
  });

  it("drops malformed bodies and wrong content types", async () => {
    const { app, analyticsDb } = fixture();
    expect((await beacon(app, "not json")).status).toBe(204);
    expect((await beacon(app, { p: "/", extra: "field" })).status).toBe(204);
    expect((await beacon(app, { p: `/${"a".repeat(2_000)}` })).status).toBe(204);
    expect((await beacon(app, { p: "/" }, { "content-type": "text/plain" })).status).toBe(204);
    expect(totals(analyticsDb)).toEqual({ views: 0, visitors: 0 });
  });

  it("rate limits a flooding bucket while still answering 204", async () => {
    const { app, analyticsDb } = fixture();
    for (let index = 0; index < 65; index++) {
      const response = await beacon(app, { p: "/" });
      expect(response.status).toBe(204);
    }
    // The ten-minute window admits 60; the rest are silently dropped.
    expect(totals(analyticsDb)).toEqual({ views: 60, visitors: 1 });
  });
});
