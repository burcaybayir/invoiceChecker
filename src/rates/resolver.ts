/**
 * Turns "what was the official rate for this invoice?" into one of three
 * answers: a rate, a retry, or an escalation.
 *
 * The rules, in the order they are applied:
 *
 *  1. A malformed or future date is an escalation, never a lookup.
 *  2. Weekends and TARGET holidays walk back to the last published business day,
 *     and the date the rate actually came from is recorded.
 *  3. A rate for today that has not been published yet is *deferred*. This is
 *     the rule that stops the pipeline from quietly stamping yesterday's rate on
 *     a same-day invoice, which would be a wrong number with a clean audit trail.
 *  4. A TARGET business day missing from the feed is an escalation. The walk-back
 *     skips days the market was closed; it never skips a day the ECB should have
 *     published, because that means the feed is wrong and hiding it is worse.
 *  5. Nothing is ever interpolated, averaged, or filled from today's rate.
 */

import { PUBLICATION } from '../config.js';
import { addDays, compareDates, parseIsoDate, systemClock, zonedNow, type Clock, type IsoDate } from '../domain/dates.js';
import { Dec, formatDerivedRate, parseDecimal } from '../domain/money.js';
import type {
  Derivation,
  RateLookupResult,
  RateQuote,
  ResolvedRate,
  SourceRef,
} from '../domain/rate-types.js';
import {
  CALENDAR_VERSION,
  MAX_CONSECUTIVE_CLOSING_DAYS,
  isTargetBusinessDay,
} from '../domain/target-calendar.js';
import type { EcbDayTable, EcbRateSource } from './ecb-source.js';
import { FatalHttpError, RateSourceFormatError, RateSourceUnavailableError } from './errors.js';

/** Every ECB rate is quoted against the euro, so the euro is the only possible pivot. */
const PIVOT = 'EUR';

export interface ResolveRateRequest {
  requestedDate: string;
  base: string;
  quote: string;
}

export interface ResolverDeps {
  source: EcbRateSource;
  clock?: Clock;
  /**
   * Whether a pair the ECB does not publish directly may be derived by dividing
   * two published euro legs. Exact arithmetic on published numbers, but the
   * result is a figure the ECB never printed, so every derived row is flagged.
   * Set false to escalate non-euro pairs instead.
   */
  allowTriangulation?: boolean;
  maxWalkBackDays?: number;
}

export async function resolveOfficialRate(
  request: ResolveRateRequest,
  deps: ResolverDeps,
): Promise<RateLookupResult> {
  const clock = deps.clock ?? systemClock;
  const allowTriangulation = deps.allowTriangulation ?? true;
  const maxWalkBack = deps.maxWalkBackDays ?? MAX_CONSECUTIVE_CLOSING_DAYS;

  const base = request.base.trim().toUpperCase();
  const quote = request.quote.trim().toUpperCase();

  const requestedDate = parseIsoDate(request.requestedDate.trim());
  if (!requestedDate) {
    return {
      kind: 'escalate',
      reason: 'invalid_date',
      requestedDate: null,
      detail: `"${request.requestedDate}" is not a valid YYYY-MM-DD calendar date.`,
    };
  }

  if (base === quote) {
    return {
      kind: 'escalate',
      reason: 'same_currency',
      requestedDate,
      detail: `Source and target currency are both ${base}; there is no conversion to check.`,
    };
  }

  const now = zonedNow(clock, PUBLICATION.timeZone);
  if (compareDates(requestedDate, now.date) > 0) {
    return {
      kind: 'escalate',
      reason: 'future_date',
      requestedDate,
      detail: `Invoice date ${requestedDate} is in the future (today is ${now.date} in ${PUBLICATION.timeZone}). No rate can exist for it.`,
    };
  }

  // --- Rule 2/3/4: find the date whose published rate applies ---
  let candidate = requestedDate;
  let steps = 0;
  let table: EcbDayTable | null = null;

  while (steps <= maxWalkBack) {
    if (isTargetBusinessDay(candidate)) {
      const isToday = candidate === now.date;

      if (isToday && now.minutesSinceMidnight < PUBLICATION.cutoffMinutes) {
        return notYetPublished(candidate, requestedDate, clock, 'the ECB has not published today yet');
      }

      try {
        table = await deps.source.tableForDate(candidate);
      } catch (error) {
        return sourceFailure(error, requestedDate, clock);
      }

      if (table) break;

      if (isToday) {
        // Past the cutoff but still absent: late publication, not a missing day.
        return notYetPublished(
          candidate,
          requestedDate,
          clock,
          "today's rate is past its usual publication time but has not appeared yet",
        );
      }

      // Rule 4: a business day the ECB should have published but did not.
      return {
        kind: 'escalate',
        reason: 'no_rate_published',
        requestedDate,
        detail:
          `${candidate} is a TARGET business day but the ECB feed contains no rates for it. ` +
          `Not substituting an earlier date: this is a gap in the feed, not a market closure.`,
      };
    }

    candidate = addDays(candidate, -1);
    steps++;
  }

  if (!table) {
    return {
      kind: 'escalate',
      reason: 'walk_back_exceeded',
      requestedDate,
      detail:
        `Found no TARGET business day within ${maxWalkBack} days before ${requestedDate}. ` +
        `The longest legitimate TARGET closure is ${MAX_CONSECUTIVE_CLOSING_DAYS} days, so this indicates a calendar or feed problem.`,
    };
  }

  // --- Rate direction: normalise whatever the ECB published into base -> quote ---
  return buildQuote({
    table,
    requestedDate,
    rateDate: candidate,
    dateResolution: candidate === requestedDate ? 'exact' : 'previous_business_day',
    base,
    quote,
    allowTriangulation,
  });
}

interface BuildQuoteArgs {
  table: EcbDayTable;
  requestedDate: IsoDate;
  rateDate: IsoDate;
  dateResolution: ResolvedRate['dateResolution'];
  base: string;
  quote: string;
  allowTriangulation: boolean;
}

/**
 * The ECB publishes `units of X per 1 EUR`. Producing `units of quote per 1 base`
 * is therefore one of three cases, and getting it wrong is the single easiest
 * way to produce a plausible-looking wrong answer.
 */
function buildQuote(args: BuildQuoteArgs): RateLookupResult {
  const { table, base, quote } = args;

  const basePublished = table.rates.get(base);
  const quotePublished = table.rates.get(quote);

  const missing = [
    basePublished === undefined ? base : null,
    quotePublished === undefined ? quote : null,
  ].filter((c): c is string => c !== null);

  if (missing.length > 0) {
    return {
      kind: 'escalate',
      reason: 'unknown_currency',
      requestedDate: args.requestedDate,
      detail: `The ECB reference rate table for ${args.rateDate} does not publish ${missing.join(' or ')}.`,
    };
  }

  const baseRate = parseDecimal(basePublished!);
  const quoteRate = parseDecimal(quotePublished!);
  // decimal.js treats zero as positive and returns Infinity for x/0 rather than
  // throwing, so zero has to be excluded explicitly or a corrupt feed becomes a
  // rate of "Infinity" instead of an escalation.
  if (!baseRate?.isPositive() || baseRate.isZero() || !quoteRate?.isPositive() || quoteRate.isZero()) {
    return {
      kind: 'escalate',
      reason: 'source_format',
      requestedDate: args.requestedDate,
      detail: `Non-positive published rate for ${base} or ${quote} on ${args.rateDate}.`,
    };
  }

  const sources: SourceRef[] = [];
  let rate: string;
  let derivation: Derivation;
  let derived: boolean;

  if (base === PIVOT) {
    // Published exactly as we need it. Recorded verbatim - never re-rounded.
    rate = quotePublished!;
    derivation = { type: 'direct' };
    derived = false;
    sources.push(sourceRef(table, quote, quotePublished!));
  } else if (quote === PIVOT) {
    // The ECB publishes EUR->base; we need base->EUR.
    rate = formatDerivedRate(new Dec(1).div(baseRate));
    derivation = { type: 'inverted', publishedPair: `${PIVOT}/${base}` };
    derived = true;
    sources.push(sourceRef(table, base, basePublished!));
  } else {
    if (!args.allowTriangulation) {
      return {
        kind: 'escalate',
        reason: 'unknown_currency',
        requestedDate: args.requestedDate,
        detail:
          `${base}/${quote} is not published by the ECB, which quotes every currency against ${PIVOT}. ` +
          `Triangulation is disabled, so this pair needs a human decision.`,
      };
    }
    // (quote per EUR) / (base per EUR) = quote per base.
    rate = formatDerivedRate(quoteRate.div(baseRate));
    derivation = { type: 'triangulated', pivot: PIVOT, legs: [`${PIVOT}/${base}`, `${PIVOT}/${quote}`] };
    derived = true;
    sources.push(sourceRef(table, base, basePublished!), sourceRef(table, quote, quotePublished!));
  }

  const rateQuote: RateQuote = { base, quote, rate };

  return {
    kind: 'resolved',
    quote: rateQuote,
    requestedDate: args.requestedDate,
    rateDate: args.rateDate,
    dateResolution: args.dateResolution,
    derivation,
    derived,
    sources,
    fetchedAt: table.fetchedAt,
    calendarVersion: CALENDAR_VERSION,
  };
}

function sourceRef(table: EcbDayTable, currency: string, publishedRate: string): SourceRef {
  return { url: table.sourceUrl, rateDate: table.date, currency, publishedRate };
}

function notYetPublished(
  candidate: IsoDate,
  requestedDate: IsoDate,
  clock: Clock,
  why: string,
): RateLookupResult {
  const retryAfter = new Date(clock.now().getTime() + PUBLICATION.graceMinutes * 60_000);
  return {
    kind: 'deferred',
    reason: 'not_yet_published',
    requestedDate,
    retryAfter: retryAfter.toISOString(),
    detail:
      `No rate for ${candidate} yet: ${why}. ` +
      `Deferring rather than falling back to an earlier date, which would silently apply the wrong rate.`,
  };
}

function sourceFailure(error: unknown, requestedDate: IsoDate, clock: Clock): RateLookupResult {
  if (error instanceof RateSourceFormatError) {
    return {
      kind: 'escalate',
      reason: 'source_format',
      requestedDate,
      detail: `The ECB feed at ${error.url} did not match the expected format: ${error.message}`,
    };
  }

  if (error instanceof FatalHttpError) {
    return {
      kind: 'deferred',
      reason: 'source_unavailable',
      requestedDate,
      retryAfter: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      detail: `${error.message}. This status will not resolve by retrying; the feed configuration needs checking.`,
    };
  }

  if (error instanceof RateSourceUnavailableError) {
    return {
      kind: 'deferred',
      reason: 'source_unavailable',
      requestedDate,
      retryAfter: new Date(clock.now().getTime() + 15 * 60_000).toISOString(),
      detail: error.message,
    };
  }

  return {
    kind: 'deferred',
    reason: 'source_unavailable',
    requestedDate,
    retryAfter: new Date(clock.now().getTime() + 15 * 60_000).toISOString(),
    detail: `Unexpected error reading the ECB feed: ${error instanceof Error ? error.message : String(error)}`,
  };
}
