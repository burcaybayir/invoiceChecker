/**
 * Decimal arithmetic for rates and money. Never floats: 0.1 + 0.2 is not 0.3,
 * and an invoice correction that is wrong in the third decimal place is a
 * correction nobody can defend.
 */

import Decimal from 'decimal.js';

/**
 * A private constructor so this module's precision settings cannot be changed
 * by any other package that happens to import decimal.js.
 *
 * 34 significant digits is IEEE 754-2008 decimal128, comfortably beyond any
 * invoice or FX rate, so intermediate results (notably triangulation, which
 * divides one published rate by another) do not accumulate visible error.
 */
export const Dec = Decimal.clone({ precision: 34, toExpNeg: -30, toExpPos: 40 });
export type Dec = InstanceType<typeof Dec>;

export type RoundingMode = 'half_up' | 'half_even';

const ROUNDING_MODES: Record<RoundingMode, Decimal.Rounding> = {
  half_up: Decimal.ROUND_HALF_UP,
  half_even: Decimal.ROUND_HALF_EVEN,
};

export interface MoneyRounding {
  /** Minor-unit digits: 2 for EUR/USD, 0 for JPY. */
  scale: number;
  mode: RoundingMode;
}

/** Parses a decimal string, rejecting NaN/Infinity and anything non-numeric. */
export function parseDecimal(value: string): Dec | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  let parsed: Dec;
  try {
    parsed = new Dec(trimmed);
  } catch {
    return undefined;
  }
  return parsed.isFinite() ? parsed : undefined;
}

export function roundMoney(value: Dec, rounding: MoneyRounding): Dec {
  return value.toDecimalPlaces(rounding.scale, ROUNDING_MODES[rounding.mode]);
}

/** Serialises at exactly the currency's scale, so "10.5" and "10.50" never differ in an audit row. */
export function formatMoney(value: Dec, rounding: MoneyRounding): string {
  return value.toFixed(rounding.scale);
}

/**
 * Significant digits kept on a *derived* rate (an inversion or a
 * triangulation). Published rates are never rounded - they are recorded exactly
 * as the ECB printed them. Twelve significant digits is far below the
 * materiality of any invoice while still giving a stable, reproducible string
 * for the audit trail.
 */
export const DERIVED_RATE_PRECISION = 12;

export function formatDerivedRate(value: Dec): string {
  return value.toSignificantDigits(DERIVED_RATE_PRECISION).toString();
}
