/**
 * The comparison, as pure arithmetic.
 *
 * No I/O, no clock, no network - given the same inputs this returns the same
 * output forever, which is what makes it testable and what makes a flagged
 * invoice reproducible months later in front of an auditor.
 */

import type { Tolerance } from '../config.js';
import { Dec, formatMoney, parseDecimal, roundMoney, type MoneyRounding } from './money.js';
import type { RateQuote } from './rate-types.js';

export type DiscrepancyVerdict = 'cleared' | 'flagged' | 'anomaly';

export type AnomalyReason =
  | 'rate_direction_mismatch'
  | 'invalid_applied_rate'
  | 'invalid_official_rate'
  | 'invalid_amount'
  | 'recorded_total_mismatch';

export interface DiscrepancyInput {
  invoiceId: string;
  sourceCurrency: string;
  targetCurrency: string;
  /** Invoice amount in the source currency, as a decimal string. */
  sourceAmount: string;
  /** The rate actually applied, quoted target-per-source. */
  appliedRate: string;
  /** The official rate, already normalised by the resolver. */
  officialQuote: RateQuote;
  /** The target-currency total as recorded on the invoice, when available - cross-checked, not trusted. */
  recordedTargetTotal?: string;
  tolerance: Tolerance;
  rounding: MoneyRounding;
}

export interface DiscrepancyResult {
  invoiceId: string;
  verdict: DiscrepancyVerdict;
  anomaly?: { reason: AnomalyReason; detail: string };
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  appliedRate: string;
  officialRate: string;
  /** sourceAmount x appliedRate, rounded to the currency's scale. */
  appliedTotal: string;
  /** sourceAmount x officialRate, rounded the same way. */
  correctedTotal: string;
  /** correctedTotal - appliedTotal. Signed: positive means the invoice was under-converted. */
  correctionAmount: string;
  /** |correctedTotal - appliedTotal|, in target currency. */
  absoluteDelta: string;
  /** |applied - official| / official, as a percentage. */
  relativeDeltaPct: string;
  direction: 'applied_rate_too_high' | 'applied_rate_too_low' | 'exact_match';
  tolerance: Tolerance;
  thresholds: { relativeExceeded: boolean; absoluteExceeded: boolean };
  rounding: MoneyRounding;
}

export function computeDiscrepancy(input: DiscrepancyInput): DiscrepancyResult {
  const base = skeleton(input);

  // --- Direction guard ---
  // The resolver normalises every quote to target-per-source. If what arrived
  // is not that, the arithmetic below would be silently, plausibly wrong, so it
  // is refused rather than performed.
  if (
    input.officialQuote.base !== input.sourceCurrency ||
    input.officialQuote.quote !== input.targetCurrency
  ) {
    return anomaly(
      base,
      'rate_direction_mismatch',
      `Official quote is ${input.officialQuote.base}/${input.officialQuote.quote} but the invoice converts ` +
        `${input.sourceCurrency} to ${input.targetCurrency}. Refusing to compare: a rate applied in the wrong ` +
        `direction produces a plausible but incorrect total.`,
    );
  }

  const amount = parseDecimal(input.sourceAmount);
  if (!amount) {
    return anomaly(base, 'invalid_amount', `Source amount "${input.sourceAmount}" is not a decimal number.`);
  }

  const applied = parseDecimal(input.appliedRate);
  if (!applied || !applied.isPositive() || applied.isZero()) {
    return anomaly(
      base,
      'invalid_applied_rate',
      `Applied rate "${input.appliedRate}" is not a positive number; the invoice cannot be checked as-is.`,
    );
  }

  const official = parseDecimal(input.officialQuote.rate);
  if (!official || !official.isPositive() || official.isZero()) {
    return anomaly(
      base,
      'invalid_official_rate',
      `Official rate "${input.officialQuote.rate}" is not a positive number.`,
    );
  }

  const appliedTotal = roundMoney(amount.times(applied), input.rounding);
  const correctedTotal = roundMoney(amount.times(official), input.rounding);
  const correction = correctedTotal.minus(appliedTotal);
  const absoluteDelta = correction.abs();

  // --- Cross-check the recorded total ---
  // If the invoice's own total does not equal amount x applied rate, then one of
  // the three recorded figures is wrong and we do not know which. That is an
  // anomaly in its own right, not an FX discrepancy to email someone about.
  if (input.recordedTargetTotal !== undefined) {
    const recorded = parseDecimal(input.recordedTargetTotal);
    if (!recorded) {
      return anomaly(
        base,
        'recorded_total_mismatch',
        `Recorded target total "${input.recordedTargetTotal}" is not a decimal number.`,
      );
    }
    // One minor unit of slack absorbs a legitimate difference in rounding mode.
    const slack = new Dec(10).pow(-input.rounding.scale);
    if (recorded.minus(appliedTotal).abs().greaterThan(slack)) {
      return anomaly(
        base,
        'recorded_total_mismatch',
        `Invoice records a total of ${formatMoney(recorded, input.rounding)} ${input.targetCurrency}, but ` +
          `${input.sourceAmount} ${input.sourceCurrency} x ${input.appliedRate} = ` +
          `${formatMoney(appliedTotal, input.rounding)}. The invoice is internally inconsistent, so the applied ` +
          `rate cannot be checked against it.`,
      );
    }
  }

  const relativeDeltaPct = applied.minus(official).abs().div(official).times(100);

  // Both thresholds must be exceeded. See DEFAULT_TOLERANCE for why.
  const relativeExceeded = relativeDeltaPct.greaterThan(new Dec(input.tolerance.relativePct));
  const absoluteFloor = parseDecimal(input.tolerance.absoluteFloor) ?? new Dec(0);
  const absoluteExceeded = absoluteDelta.greaterThan(absoluteFloor);

  return {
    ...base,
    verdict: relativeExceeded && absoluteExceeded ? 'flagged' : 'cleared',
    officialRate: input.officialQuote.rate,
    appliedTotal: formatMoney(appliedTotal, input.rounding),
    correctedTotal: formatMoney(correctedTotal, input.rounding),
    correctionAmount: formatMoney(correction, input.rounding),
    absoluteDelta: formatMoney(absoluteDelta, input.rounding),
    relativeDeltaPct: relativeDeltaPct.toSignificantDigits(8).toString(),
    direction: applied.equals(official)
      ? 'exact_match'
      : applied.greaterThan(official)
        ? 'applied_rate_too_high'
        : 'applied_rate_too_low',
    thresholds: { relativeExceeded, absoluteExceeded },
  };
}

function skeleton(input: DiscrepancyInput): DiscrepancyResult {
  return {
    invoiceId: input.invoiceId,
    verdict: 'anomaly',
    sourceCurrency: input.sourceCurrency,
    targetCurrency: input.targetCurrency,
    sourceAmount: input.sourceAmount,
    appliedRate: input.appliedRate,
    officialRate: input.officialQuote.rate,
    appliedTotal: '0',
    correctedTotal: '0',
    correctionAmount: '0',
    absoluteDelta: '0',
    relativeDeltaPct: '0',
    direction: 'exact_match',
    tolerance: input.tolerance,
    thresholds: { relativeExceeded: false, absoluteExceeded: false },
    rounding: input.rounding,
  };
}

function anomaly(base: DiscrepancyResult, reason: AnomalyReason, detail: string): DiscrepancyResult {
  return { ...base, verdict: 'anomaly', anomaly: { reason, detail } };
}
