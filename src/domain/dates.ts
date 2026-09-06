/**
 * Calendar dates as `YYYY-MM-DD` strings, compared and shifted in UTC.
 *
 * FX rate dates are calendar dates, not instants: the ECB's "2026-04-03 rate"
 * is the same rate whether you read it from Tokyo or Toronto. Doing the
 * arithmetic in UTC keeps a local timezone from silently shifting a rate date
 * across a day boundary. The one place a timezone genuinely matters is the
 * publication cutoff, which is a wall-clock time in Frankfurt - see
 * `zonedNow` and `publication.ts`.
 */

export type IsoDate = string & { readonly __brand: 'IsoDate' };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the parsed date, or `undefined` if it is malformed or not a real calendar date. */
export function parseIsoDate(value: string): IsoDate | undefined {
  if (!ISO_DATE.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return undefined;
  // Rejects 2026-02-31, which Date.parse would otherwise roll into March.
  const roundTrip = new Date(ms).toISOString().slice(0, 10);
  return roundTrip === value ? (value as IsoDate) : undefined;
}

export function toUtcDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function fromUtcDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/** Negative if `a` is earlier, positive if later, zero if equal. Safe because ISO dates sort lexically. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const ms = toUtcDate(to).getTime() - toUtcDate(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return toUtcDate(date).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ZonedNow {
  /** The calendar date currently in effect in the target timezone. */
  date: IsoDate;
  /** Minutes elapsed since local midnight, so a cutoff comparison needs no date maths. */
  minutesSinceMidnight: number;
}

/**
 * Reads the wall clock in `timeZone`. Uses Intl rather than a fixed UTC offset
 * so the CET/CEST switch is handled by the platform's tz database instead of by
 * an offset constant that goes wrong twice a year.
 */
export function zonedNow(clock: Clock, timeZone: string): ZonedNow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(clock.now());

  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return a "${type}" part for timezone ${timeZone}`);
    return part.value;
  };

  const date = parseIsoDate(`${get('year')}-${get('month')}-${get('day')}`);
  if (!date) throw new Error(`Intl produced an unparseable date for timezone ${timeZone}`);

  return {
    date,
    minutesSinceMidnight: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
