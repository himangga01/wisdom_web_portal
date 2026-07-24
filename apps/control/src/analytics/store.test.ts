import { afterEach, describe, expect, it } from "vitest";

import {
  analyticsIpBucket,
  closeAnalyticsDatabase,
  openAnalyticsDatabase,
  pruneAnalytics,
  recordPageview,
  seoulDay,
  type AnalyticsDatabase,
} from "./store.js";

// 2026-07-24 12:00 KST (03:00 UTC) — comfortably inside one Seoul day.
const NOON_KST = Date.UTC(2026, 6, 24, 3, 0, 0);
// KST midnight boundary: 2026-07-24 15:00 UTC == 2026-07-25 00:00 KST.
const BEFORE_MIDNIGHT = Date.UTC(2026, 6, 24, 14, 59, 59);
const AFTER_MIDNIGHT = Date.UTC(2026, 6, 24, 15, 0, 1);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function testDb(): AnalyticsDatabase {
  const db = openAnalyticsDatabase(":memory:");
  cleanups.push(() => closeAnalyticsDatabase(db));
  return db;
}

function view(db: AnalyticsDatabase, overrides: Partial<Parameters<typeof recordPageview>[1]> = {}): void {
  recordPageview(db, {
    nowMs: NOON_KST,
    address: "203.0.113.10",
    userAgent: "Mozilla/5.0 (Macintosh) TestBrowser/1.0",
    path: "/insights",
    locale: "ko",
    referrerOrigin: "",
    ...overrides,
  });
}

function siteDay(db: AnalyticsDatabase, day: string): { views: number; visitors: number } | undefined {
  return db.sqlite.prepare(
    "SELECT views, visitors FROM analytics_site_days WHERE day = ?",
  ).get(day) as { views: number; visitors: number } | undefined;
}

describe("seoulDay", () => {
  it("derives the Seoul calendar day across the KST midnight boundary", () => {
    expect(seoulDay(BEFORE_MIDNIGHT)).toBe("2026-07-24");
    expect(seoulDay(AFTER_MIDNIGHT)).toBe("2026-07-25");
  });
});

describe("analyticsIpBucket", () => {
  it("drops the last IPv4 octet, including for IPv4-mapped IPv6", () => {
    expect(analyticsIpBucket("203.0.113.77")).toBe("203.0.113.0/24");
    expect(analyticsIpBucket("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
  });

  it("collapses IPv6 to its /64", () => {
    expect(analyticsIpBucket("2001:db8:aaaa:bbbb:1:2:3:4")).toBe("2001:db8:aaaa:bbbb::/64");
  });
});

describe("recordPageview", () => {
  it("counts repeat views by the same visitor as one unique", () => {
    const db = testDb();
    view(db);
    view(db, { path: "/about" });
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 2, visitors: 1 });
  });

  it("counts distinct user agents as distinct visitors", () => {
    const db = testDb();
    view(db);
    view(db, { userAgent: "Mozilla/5.0 (iPhone) OtherBrowser/2.0" });
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 2, visitors: 2 });
  });

  it("treats addresses in the same IPv4 /24 as one visitor", () => {
    const db = testDb();
    view(db, { address: "203.0.113.10" });
    view(db, { address: "203.0.113.250" });
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 2, visitors: 1 });
  });

  it("accumulates per-page and per-referrer rollups", () => {
    const db = testDb();
    view(db);
    view(db, { path: "/insights", locale: "en", referrerOrigin: "https://www.google.com" });
    view(db, { referrerOrigin: "https://www.google.com" });
    expect(db.sqlite.prepare(
      "SELECT locale, views FROM analytics_page_days WHERE day = '2026-07-24' AND path = '/insights' ORDER BY locale",
    ).all()).toEqual([
      { locale: "en", views: 1 },
      { locale: "ko", views: 2 },
    ]);
    expect(db.sqlite.prepare(
      "SELECT referrer_origin, views FROM analytics_referrer_days WHERE day = '2026-07-24' ORDER BY referrer_origin",
    ).all()).toEqual([
      { referrer_origin: "", views: 1 },
      { referrer_origin: "https://www.google.com", views: 2 },
    ]);
  });

  it("rotates the salt at KST midnight and destroys the previous salt", () => {
    const db = testDb();
    view(db, { nowMs: BEFORE_MIDNIGHT });
    view(db, { nowMs: AFTER_MIDNIGHT });
    // Same person, but the new day's salt makes them a fresh unique.
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 1, visitors: 1 });
    expect(siteDay(db, "2026-07-25")).toEqual({ views: 1, visitors: 1 });
    expect(db.sqlite.prepare("SELECT day FROM analytics_daily_salt").all())
      .toEqual([{ day: "2026-07-25" }]);
  });
});

describe("pruneAnalytics", () => {
  it("removes expired salts, visitor hashes, and out-of-retention rollups", () => {
    const db = testDb();
    view(db, { nowMs: BEFORE_MIDNIGHT });
    // A rollup row older than 25 months must be dropped; recent rows survive.
    db.sqlite.prepare(
      "INSERT INTO analytics_site_days (day, views, visitors) VALUES ('2024-05-01', 9, 4)",
    ).run();
    const result = pruneAnalytics(db, AFTER_MIDNIGHT);
    expect(result).toEqual({ salts: 1, visitorDays: 1, rollupRows: 1 });
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 1, visitors: 1 });
    expect(siteDay(db, "2024-05-01")).toBeUndefined();
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM analytics_visitor_days").get())
      .toEqual({ n: 0 });
  });

  it("keeps today's salt and hashes so the current day keeps deduplicating", () => {
    const db = testDb();
    view(db);
    pruneAnalytics(db, NOON_KST);
    view(db);
    expect(siteDay(db, "2026-07-24")).toEqual({ views: 2, visitors: 1 });
  });
});
