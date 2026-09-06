/**
 * The ECB euro foreign exchange reference rate feed.
 *
 * The ECB publishes one rate per currency **against the euro**, quoted as units
 * of foreign currency per 1 EUR (`<Cube currency='USD' rate='1.1692'/>` means
 * one euro buys 1.1692 dollars). Every non-EUR pair therefore has to be derived
 * - see `resolver.ts`.
 *
 * A whole document covers many dates, so the natural cache unit is the document,
 * not the (date, pair) tuple: one fetch answers every currency for every date it
 * contains. That is why `tableForDate` is cheap enough for the resolver to call
 * in a day-by-day walk-back loop.
 */

import { XMLParser } from 'fast-xml-parser';
import { daysBetween, fromUtcDate, parseIsoDate, systemClock, type Clock, type IsoDate } from '../domain/dates.js';
import { FatalHttpError, RateSourceFormatError, RateSourceUnavailableError } from './errors.js';

export const ECB_FEEDS = {
  /** Today only. */
  daily: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
  /** Rolling 90 days - covers almost every invoice we will ever look up. */
  ninetyDay: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml',
  /** Every published day since 1999. Large; fetched only for older invoices. */
  full: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml',
} as const;

export interface EcbDayTable {
  date: IsoDate;
  /** Currency code -> units per 1 EUR, exactly as published. EUR itself is present as "1". */
  rates: ReadonlyMap<string, string>;
  sourceUrl: string;
  fetchedAt: string;
}

export interface EcbRateSource {
  /** The published table for a date, or `null` if that date is absent from the feed. */
  tableForDate(date: IsoDate): Promise<EcbDayTable | null>;
}

const RATE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Parses the GESMES envelope into per-date tables.
 *
 * Validation is strict on purpose. Every rejection here surfaces as a fatal
 * `RateSourceFormatError` rather than a skipped row, so a feed change breaks the
 * run loudly instead of silently shrinking the data.
 */
export function parseEcbEnvelope(xml: string, url: string): Map<IsoDate, Map<string, string>> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false, // keep rates as published strings; never through a float
    trimValues: true,
  });

  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (cause) {
    throw new RateSourceFormatError(
      `ECB feed is not well-formed XML: ${cause instanceof Error ? cause.message : String(cause)}`,
      url,
    );
  }

  const envelope = (doc as Record<string, any>)?.['gesmes:Envelope'];
  if (!envelope) throw new RateSourceFormatError('ECB feed has no gesmes:Envelope element', url);

  const outerCube = envelope['Cube'];
  if (!outerCube) throw new RateSourceFormatError('ECB envelope has no Cube element', url);

  const dayCubes = asArray(outerCube['Cube']);
  if (dayCubes.length === 0) throw new RateSourceFormatError('ECB envelope contains no dated Cube entries', url);

  const tables = new Map<IsoDate, Map<string, string>>();

  for (const dayCube of dayCubes) {
    const rawDate = dayCube?.['@_time'];
    if (typeof rawDate !== 'string') {
      throw new RateSourceFormatError('ECB dated Cube is missing its time attribute', url);
    }
    const date = parseIsoDate(rawDate);
    if (!date) throw new RateSourceFormatError(`ECB Cube has an unparseable time attribute: ${rawDate}`, url);

    const rates = new Map<string, string>([['EUR', '1']]);
    for (const entry of asArray(dayCube['Cube'])) {
      const currency = entry?.['@_currency'];
      const rate = entry?.['@_rate'];
      if (typeof currency !== 'string' || typeof rate !== 'string') {
        throw new RateSourceFormatError(`ECB rate entry for ${date} is missing currency or rate`, url);
      }
      if (!RATE_PATTERN.test(rate)) {
        throw new RateSourceFormatError(`ECB rate for ${currency} on ${date} is not a decimal: ${rate}`, url);
      }
      // A published rate of zero is corrupt data, not a rate. Rejecting it here
      // stops it reaching the division in the resolver, where it would silently
      // become Infinity rather than throwing.
      if (Number(rate) === 0) {
        throw new RateSourceFormatError(`ECB rate for ${currency} on ${date} is zero, which cannot be a rate`, url);
      }
      rates.set(currency.toUpperCase(), rate);
    }

    if (rates.size <= 1) {
      throw new RateSourceFormatError(`ECB table for ${date} contains no currencies`, url);
    }
    tables.set(date, rates);
  }

  return tables;
}

function asArray(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export interface HttpEcbSourceOptions {
  clock?: Clock;
  fetchImpl?: typeof fetch;
  /** Injected so backoff tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseBackoffMs?: number;
  requestTimeoutMs?: number;
  /** How long a parsed document stays usable before being refetched. */
  documentTtlMs?: number;
}

interface CachedDocument {
  tables: Map<IsoDate, Map<string, string>>;
  fetchedAt: string;
  expiresAt: number;
}

export class HttpEcbSource implements EcbRateSource {
  private readonly clock: Clock;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly documentTtlMs: number;
  private readonly cache = new Map<string, CachedDocument>();
  /** De-duplicates concurrent fetches of the same document across a batch. */
  private readonly inFlight = new Map<string, Promise<CachedDocument>>();

  constructor(options: HttpEcbSourceOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.documentTtlMs = options.documentTtlMs ?? 30 * 60_000;
  }

  async tableForDate(date: IsoDate): Promise<EcbDayTable | null> {
    const url = this.feedFor(date);
    const doc = await this.document(url);
    const rates = doc.tables.get(date);
    if (!rates) return null;
    return { date, rates, sourceUrl: url, fetchedAt: doc.fetchedAt };
  }

  private feedFor(date: IsoDate): string {
    const age = daysBetween(date, fromUtcDate(this.clock.now()));
    // A small margin under the feed's 90 days, so a date near the boundary does
    // not fall between the two documents.
    return age <= 85 ? ECB_FEEDS.ninetyDay : ECB_FEEDS.full;
  }

  private async document(url: string): Promise<CachedDocument> {
    const cached = this.cache.get(url);
    if (cached && cached.expiresAt > this.clock.now().getTime()) return cached;

    const pending = this.inFlight.get(url);
    if (pending) return pending;

    const load = this.fetchDocument(url)
      .then((doc) => {
        this.cache.set(url, doc);
        return doc;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });

    this.inFlight.set(url, load);
    return load;
  }

  private async fetchDocument(url: string): Promise<CachedDocument> {
    let lastError = '';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const xml = await this.fetchOnce(url);
        return {
          tables: parseEcbEnvelope(xml, url),
          fetchedAt: this.clock.now().toISOString(),
          expiresAt: this.clock.now().getTime() + this.documentTtlMs,
        };
      } catch (error) {
        // A malformed feed will be just as malformed on the next attempt.
        if (error instanceof RateSourceFormatError) throw error;
        if (error instanceof FatalHttpError) throw error;

        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.maxAttempts) {
          // Exponential backoff with jitter, so a batch retrying together does
          // not resynchronise into a thundering herd.
          const backoff = this.baseBackoffMs * 2 ** (attempt - 1);
          await this.sleep(backoff + Math.floor(Math.random() * this.baseBackoffMs));
        }
      }
    }

    throw new RateSourceUnavailableError(
      `ECB feed ${url} unavailable after ${this.maxAttempts} attempts: ${lastError}`,
      this.maxAttempts,
    );
  }

  private async fetchOnce(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/xml,text/xml' },
      });

      if (response.ok) return await response.text();

      // 4xx other than 429 means our request is wrong; retrying cannot fix it.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new FatalHttpError(`ECB feed ${url} returned ${response.status} ${response.statusText}`);
      }
      throw new Error(`ECB feed ${url} returned ${response.status} ${response.statusText}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
