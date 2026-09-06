/**
 * TARGET closing days - the days the ECB publishes no euro reference rates.
 *
 * The ECB publishes on TARGET business days only. TARGET closes on Saturdays,
 * Sundays, and six named days per year. Unlike most national calendars, TARGET
 * does NOT move a holiday that falls on a weekend to the following Monday, so
 * the closing set is fully determined by the year.
 *
 * The version string is recorded in every audit row. If this rule set ever
 * changes, bump it - a resolution decision must be traceable to the calendar
 * that produced it, and a silently edited calendar makes past decisions
 * unreproducible.
 */

import { addDays, fromUtcDate, isWeekend, type IsoDate } from './dates.js';

export const CALENDAR_VERSION = 'target-2002.1';

/**
 * Gregorian Easter Sunday (Meeus/Jones/Butcher). Good Friday and Easter Monday
 * are the only two TARGET closings that move, which is why this is computed
 * rather than tabulated - a hardcoded table silently expires.
 */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fromUtcDate(new Date(Date.UTC(year, month - 1, day)));
}

const closingsByYear = new Map<number, Set<string>>();

/** The six named TARGET closing days for a year, excluding weekends. */
export function targetClosingDays(year: number): ReadonlySet<string> {
  const cached = closingsByYear.get(year);
  if (cached) return cached;

  const easter = easterSunday(year);
  const days = new Set<string>([
    `${year}-01-01`,
    addDays(easter, -2), // Good Friday
    addDays(easter, 1), // Easter Monday
    `${year}-05-01`,
    `${year}-12-25`,
    `${year}-12-26`,
  ]);

  closingsByYear.set(year, days);
  return days;
}

export function isTargetHoliday(date: IsoDate): boolean {
  const year = Number(date.slice(0, 4));
  return targetClosingDays(year).has(date);
}

/** A day the ECB is expected to publish a reference rate. */
export function isTargetBusinessDay(date: IsoDate): boolean {
  return !isWeekend(date) && !isTargetHoliday(date);
}

/**
 * The longest run of consecutive TARGET closing days is four: Good Friday,
 * Saturday, Sunday, Easter Monday. Walking back further than this to find a
 * published rate means the feed has a gap, not that the market was closed -
 * which is an escalation, not a value.
 */
export const MAX_CONSECUTIVE_CLOSING_DAYS = 4;
