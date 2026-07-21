import type { Locale } from "@wisdom/shared";

const DATE_LOCALES: Record<Locale, string> = {
  ko: "ko-KR",
  en: "en-US",
  "zh-Hans": "zh-Hans-CN",
  "zh-Hant": "zh-Hant-TW",
};

const FORMATTERS = new Map<Locale, Intl.DateTimeFormat>();

function formatterFor(locale: Locale): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DATE_LOCALES[locale], {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Seoul",
    });
    FORMATTERS.set(locale, formatter);
  }
  return formatter;
}

/**
 * Renders an ISO instant as a locale-appropriate calendar date. The `datetime`
 * attribute should keep the raw ISO string; this is display text only. Falls
 * back to the ISO date (YYYY-MM-DD) when the input cannot be parsed.
 */
export function formatDisplayDate(iso: string, locale: Locale): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso.slice(0, 10);
  return formatterFor(locale).format(new Date(parsed));
}
