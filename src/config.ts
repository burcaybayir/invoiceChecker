/**
 * Policy that has to be defensible to an accountant, kept in one place so a
 * decision can be traced to the settings that produced it.
 */

import type { MoneyRounding } from './domain/money.js';

export interface Tolerance {
  /** Relative gap between applied and official rate, in percent. */
  relativePct: number;
  /** Absolute gap on the invoice total, in target-currency units. */
  absoluteFloor: string;
}

/**
 * An invoice is flagged only when BOTH thresholds are exceeded.
 *
 * The relative test alone floods the queue with cent-level noise on large
 * invoices; the absolute floor alone flags every large invoice carrying a
 * trivial rounding difference. Requiring both means an invoice is raised only
 * when the error is proportionally meaningful AND materially worth an email.
 */
export const DEFAULT_TOLERANCE: Tolerance = {
  relativePct: 0.5,
  absoluteFloor: '25',
};

/** Per-pair overrides, keyed `SOURCE/TARGET`. A 0.5% band means different things on different pairs. */
export const TOLERANCE_OVERRIDES: Readonly<Record<string, Tolerance>> = {};

export function toleranceFor(sourceCurrency: string, targetCurrency: string): Tolerance {
  return TOLERANCE_OVERRIDES[`${sourceCurrency}/${targetCurrency}`] ?? DEFAULT_TOLERANCE;
}

/**
 * Minor-unit digits per currency. Default 2; these are the ECB-published
 * currencies that use none.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'ISK', 'KRW']);

export const DEFAULT_ROUNDING_MODE = 'half_up' as const;

export function roundingFor(currency: string): MoneyRounding {
  return {
    scale: ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2,
    mode: DEFAULT_ROUNDING_MODE,
  };
}

/** The ECB publishes reference rates at about 16:00 Frankfurt time on TARGET business days. */
export const PUBLICATION = {
  timeZone: 'Europe/Berlin',
  /** Minutes since local midnight. */
  cutoffMinutes: 16 * 60,
  /**
   * Grace after the cutoff before a still-absent rate stops being "not yet
   * published". Within the grace window the answer is "come back later", never
   * "use yesterday's rate".
   */
  graceMinutes: 90,
} as const;
