import type { AnalyticsDatabase } from "./store.js";

// Read-side queries and pure date-bucketing helpers for the admin dashboard.
// All inputs are Seoul-calendar day strings ("YYYY-MM-DD"); day arithmetic runs
// on UTC timestamps of those strings, which is safe because the strings are
// already day-resolved.

export interface DayCount {
  day: string;
  views: number;
  visitors: number;
}

export interface AnalyticsTotals {
  views: number;
  visitors: number;
}

/**
 * Guards every day string entering the query helpers below. A bare
 * `\d{4}-\d{2}-\d{2}` shape is not enough: "2026-00-00" parses to NaN and makes
 * `shiftDay` throw a RangeError, while "2026-02-30" silently rolls over to
 * March 2. Requiring the parsed date to round-trip rejects both.
 */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function shiftDay(day: string, byDays: number): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return new Date(time + byDays * 86_400_000).toISOString().slice(0, 10);
}

export function daySpan(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000) + 1;
}

export function analyticsTotals(db: AnalyticsDatabase, fromDay: string, toDay: string): AnalyticsTotals {
  return db.sqlite.prepare(`
    SELECT coalesce(sum(views), 0) AS views, coalesce(sum(visitors), 0) AS visitors
    FROM analytics_site_days WHERE day BETWEEN ? AND ?
  `).get(fromDay, toDay) as AnalyticsTotals;
}

/** Continuous per-day series with zero-filled gaps, oldest first. */
export function siteSeries(db: AnalyticsDatabase, fromDay: string, toDay: string): DayCount[] {
  const rows = db.sqlite.prepare(`
    SELECT day, views, visitors FROM analytics_site_days
    WHERE day BETWEEN ? AND ? ORDER BY day
  `).all(fromDay, toDay) as DayCount[];
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const series: DayCount[] = [];
  for (let day = fromDay; day <= toDay; day = shiftDay(day, 1)) {
    series.push(byDay.get(day) ?? { day, views: 0, visitors: 0 });
  }
  return series;
}

export interface TopPageRow {
  path: string;
  locale: string;
  views: number;
}

export function topPages(db: AnalyticsDatabase, fromDay: string, toDay: string, limit = 20): TopPageRow[] {
  return db.sqlite.prepare(`
    SELECT path, locale, sum(views) AS views FROM analytics_page_days
    WHERE day BETWEEN ? AND ? GROUP BY path, locale
    ORDER BY views DESC, path, locale LIMIT ?
  `).all(fromDay, toDay, limit) as TopPageRow[];
}

export interface ReferrerRow {
  referrerOrigin: string;
  views: number;
}

export function topReferrers(db: AnalyticsDatabase, fromDay: string, toDay: string, limit = 20): ReferrerRow[] {
  return (db.sqlite.prepare(`
    SELECT referrer_origin, sum(views) AS views FROM analytics_referrer_days
    WHERE day BETWEEN ? AND ? GROUP BY referrer_origin
    ORDER BY views DESC, referrer_origin LIMIT ?
  `).all(fromDay, toDay, limit) as Array<{ referrer_origin: string; views: number }>)
    .map((row) => ({ referrerOrigin: row.referrer_origin, views: row.views }));
}

export interface LocaleRow {
  locale: string;
  views: number;
}

export function localeSplit(db: AnalyticsDatabase, fromDay: string, toDay: string): LocaleRow[] {
  return db.sqlite.prepare(`
    SELECT locale, sum(views) AS views FROM analytics_page_days
    WHERE day BETWEEN ? AND ? GROUP BY locale ORDER BY views DESC, locale
  `).all(fromDay, toDay) as LocaleRow[];
}

export type Granularity = "day" | "week" | "month";

export interface SeriesBucket {
  /** Bucket start day ("YYYY-MM-DD" / month start). */
  startDay: string;
  label: string;
  views: number;
  visitors: number;
}

function weekStart(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(time).getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return shiftDay(day, -sinceMonday);
}

function bucketLabel(startDay: string, granularity: Granularity): string {
  const [year = "", month = "", dayOfMonth = ""] = startDay.split("-");
  if (granularity === "month") return `${year}.${Number(month)}`;
  return `${Number(month)}.${Number(dayOfMonth)}`;
}

/**
 * Groups the continuous day series into day/week(Monday-start)/month buckets.
 * Visitors sum across days — the daily-salt design makes cross-day
 * deduplication impossible, so week/month "visitors" are sums of daily uniques
 * (the Plausible-class semantics the dashboard footnotes).
 */
export function bucketSeries(series: readonly DayCount[], granularity: Granularity): SeriesBucket[] {
  const buckets: SeriesBucket[] = [];
  let current: SeriesBucket | undefined;
  for (const point of series) {
    const startDay = granularity === "day"
      ? point.day
      : granularity === "week"
        ? weekStart(point.day)
        : `${point.day.slice(0, 7)}-01`;
    if (!current || current.startDay !== startDay) {
      current = { startDay, label: bucketLabel(startDay, granularity), views: 0, visitors: 0 };
      buckets.push(current);
    }
    current.views += point.views;
    current.visitors += point.visitors;
  }
  return buckets;
}

/** Default granularity for a span: day up to a month, week up to ~4 months. */
export function autoGranularity(spanDays: number): Granularity {
  if (spanDays <= 31) return "day";
  if (spanDays <= 120) return "week";
  return "month";
}
