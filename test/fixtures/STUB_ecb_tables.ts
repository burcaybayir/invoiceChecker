/**
 * STUB rate tables. These are NOT real ECB reference rates and must never be
 * treated as such - every value is a round synthetic number chosen to make the
 * expected arithmetic obvious by inspection.
 *
 * The magnitudes are deliberately far from 1.0. A direction bug on a pair that
 * sits near parity (EUR/USD around 1.08) inverts to another plausible-looking
 * rate and slips through review; on these values an inversion is off by orders
 * of magnitude and cannot hide:
 *
 *   USD -> JPY  = 180 / 1.2 = 150      (correct)
 *   inverted    = 1.2 / 180 = 0.00666  (obviously wrong)
 */

import type { EcbDayTable, EcbRateSource } from '../../src/rates/ecb-source.js';
import type { IsoDate } from '../../src/domain/dates.js';

export const STUB_SOURCE_URL = 'https://stub.invalid/STUB_eurofxref-hist-90d.xml';

/** Units of currency per 1 EUR, as the ECB quotes them. */
export const STUB_RATES: ReadonlyArray<readonly [string, string]> = [
  ['EUR', '1'],
  ['USD', '1.2000'],
  ['JPY', '180.00'],
  ['GBP', '0.80000'],
];

export function stubTable(): Map<string, string> {
  return new Map(STUB_RATES.map(([c, r]) => [c, r]));
}

export class StubEcbSource implements EcbRateSource {
  readonly requestedDates: string[] = [];

  constructor(
    private readonly dates: ReadonlySet<string>,
    private readonly failure?: Error,
  ) {}

  async tableForDate(date: IsoDate): Promise<EcbDayTable | null> {
    this.requestedDates.push(date);
    if (this.failure) throw this.failure;
    if (!this.dates.has(date)) return null;
    return {
      date,
      rates: stubTable(),
      sourceUrl: STUB_SOURCE_URL,
      fetchedAt: '2026-06-01T12:00:00.000Z',
    };
  }
}

/** A clock frozen at a known instant, so publication-window rules are deterministic. */
export function fixedClock(iso: string) {
  return { now: () => new Date(iso) };
}
