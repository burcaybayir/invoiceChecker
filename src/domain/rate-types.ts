/**
 * Rate lookup vocabulary.
 *
 * The three outcomes are deliberately distinct types, because the pipeline
 * treats them completely differently: a resolved rate is a value, a deferred
 * lookup is a retry, and an escalation is a human's problem. Collapsing any two
 * of them into a nullable value is how a pipeline ends up quietly using
 * yesterday's rate for a date that simply has not published yet.
 */

import type { IsoDate } from './dates.js';

/**
 * `rate` is always **units of `quote` per one unit of `base`**, i.e. the number
 * you multiply a `base` amount by to get a `quote` amount. Every rate in this
 * system is normalised to this form on the way out of the resolver, so nothing
 * downstream has to know how the source happened to quote it.
 */
export interface RateQuote {
  base: string;
  quote: string;
  rate: string;
}

export type Derivation =
  /** The source published this exact pair; the rate is recorded verbatim. */
  | { type: 'direct' }
  /** 1 / published, because the source quotes the pair the other way round. */
  | { type: 'inverted'; publishedPair: string }
  /** Two published legs divided through a pivot the source quotes everything against. */
  | { type: 'triangulated'; pivot: string; legs: [string, string] };

export interface SourceRef {
  url: string;
  rateDate: IsoDate;
  currency: string;
  /** Exactly as published, before any normalisation. */
  publishedRate: string;
}

export type DateResolution = 'exact' | 'previous_business_day';

export interface ResolvedRate {
  kind: 'resolved';
  quote: RateQuote;
  /** The invoice's date. */
  requestedDate: IsoDate;
  /** The date the rate actually came from - the two differ across weekends and holidays. */
  rateDate: IsoDate;
  dateResolution: DateResolution;
  derivation: Derivation;
  /**
   * True when the rate was computed from published figures rather than
   * published as-is. Derived is not the same as estimated - it is exact
   * arithmetic on published numbers - but an accountant is entitled to know
   * which rows are which.
   */
  derived: boolean;
  sources: SourceRef[];
  fetchedAt: string;
  calendarVersion: string;
}

/** Try again later. Not an error, and never a reason to substitute another date's rate. */
export interface DeferredRate {
  kind: 'deferred';
  reason: 'not_yet_published' | 'source_unavailable';
  requestedDate: IsoDate;
  /** ISO timestamp; retrying before this is pointless. */
  retryAfter: string;
  detail: string;
}

/** A human has to look at this. Never carries a rate. */
export interface RateEscalation {
  kind: 'escalate';
  reason:
    | 'no_rate_published'
    | 'unknown_currency'
    | 'invalid_date'
    | 'future_date'
    | 'same_currency'
    | 'walk_back_exceeded'
    | 'source_format';
  requestedDate: IsoDate | null;
  detail: string;
}

export type RateLookupResult = ResolvedRate | DeferredRate | RateEscalation;
