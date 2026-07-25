import { afterEach, describe, expect, it } from "vitest";

import {
  analyticsTotals,
  autoGranularity,
  bucketSeries,
  daySpan,
  isCalendarDay,
  localeSplit,
  shiftDay,
  siteSeries,
  topPages,
  topReferrers,
} from "./queries.js";
import { closeAnalyticsDatabase, openAnalyticsDatabase, type AnalyticsDatabase } from "./store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function seeded(): AnalyticsDatabase {
  const db = openAnalyticsDatabase(":memory:");
  cleanups.push(() => closeAnalyticsDatabase(db));
  const site = db.sqlite.prepare(
    "INSERT INTO analytics_site_days (day, views, visitors) VALUES (?, ?, ?)",
  );
  site.run("2026-07-19", 10, 4); // Sunday
  site.run("2026-07-20", 20, 8); // Monday (new ISO week)
  site.run("2026-07-22", 5, 2);  // gap on the 21st
  const pages = db.sqlite.prepare(
    "INSERT INTO analytics_page_days (day, path, locale, views) VALUES (?, ?, ?, ?)",
  );
  pages.run("2026-07-20", "/insights", "ko", 12);
  pages.run("2026-07-20", "/insights", "en", 8);
  pages.run("2026-07-22", "/consultation", "ko", 5);
  const referrers = db.sqlite.prepare(
    "INSERT INTO analytics_referrer_days (day, referrer_origin, views) VALUES (?, ?, ?)",
  );
  referrers.run("2026-07-20", "", 15);
  referrers.run("2026-07-20", "https://www.google.com", 5);
  referrers.run("2026-07-22", "https://www.google.com", 5);
  return db;
}

describe("day helpers", () => {
  it("shifts and measures day strings across month boundaries", () => {
    expect(shiftDay("2026-08-01", -1)).toBe("2026-07-31");
    expect(daySpan("2026-07-01", "2026-07-31")).toBe(31);
  });

  it("accepts only real calendar days", () => {
    for (const day of ["2026-07-25", "2024-02-29", "2026-12-31"]) {
      expect(isCalendarDay(day), day).toBe(true);
    }
    // "2026-00-00" would make shiftDay throw; "2026-02-30" would silently roll
    // over to March 2 and report a range the operator never asked for.
    for (const day of ["2026-00-00", "2026-13-45", "2026-02-30", "2026-02-29", "26-07-25", "2026-7-25", ""]) {
      expect(isCalendarDay(day), day).toBe(false);
    }
  });

  it("chooses granularity from the span", () => {
    expect(autoGranularity(7)).toBe("day");
    expect(autoGranularity(31)).toBe("day");
    expect(autoGranularity(90)).toBe("week");
    expect(autoGranularity(365)).toBe("month");
  });
});

describe("range queries", () => {
  it("totals, ranks pages and referrers, and splits by locale", () => {
    const db = seeded();
    expect(analyticsTotals(db, "2026-07-19", "2026-07-22")).toEqual({ views: 35, visitors: 14 });
    expect(topPages(db, "2026-07-19", "2026-07-22")).toEqual([
      { path: "/insights", locale: "ko", views: 12 },
      { path: "/insights", locale: "en", views: 8 },
      { path: "/consultation", locale: "ko", views: 5 },
    ]);
    expect(topReferrers(db, "2026-07-19", "2026-07-22")).toEqual([
      { referrerOrigin: "", views: 15 },
      { referrerOrigin: "https://www.google.com", views: 10 },
    ]);
    expect(localeSplit(db, "2026-07-19", "2026-07-22")).toEqual([
      { locale: "ko", views: 17 },
      { locale: "en", views: 8 },
    ]);
  });

  it("zero-fills gaps so the series is continuous", () => {
    const db = seeded();
    expect(siteSeries(db, "2026-07-19", "2026-07-22").map((point) => point.views))
      .toEqual([10, 20, 0, 5]);
  });
});

describe("bucketSeries", () => {
  const db = () => seeded();

  it("keeps day buckets one-to-one", () => {
    const buckets = bucketSeries(siteSeries(db(), "2026-07-19", "2026-07-22"), "day");
    expect(buckets.map((bucket) => bucket.label)).toEqual(["7.19", "7.20", "7.21", "7.22"]);
  });

  it("groups weeks starting on Monday", () => {
    const buckets = bucketSeries(siteSeries(db(), "2026-07-19", "2026-07-22"), "week");
    // Sunday the 19th belongs to the week of Monday the 13th; the rest to the 20th.
    expect(buckets).toEqual([
      { startDay: "2026-07-13", label: "7.13", views: 10, visitors: 4 },
      { startDay: "2026-07-20", label: "7.20", views: 25, visitors: 10 },
    ]);
  });

  it("groups months with year-qualified labels", () => {
    const series = siteSeries(db(), "2026-06-25", "2026-07-22");
    const buckets = bucketSeries(series, "month");
    expect(buckets.map((bucket) => bucket.label)).toEqual(["2026.6", "2026.7"]);
    expect(buckets[1]).toMatchObject({ startDay: "2026-07-01", views: 35, visitors: 14 });
  });
});
