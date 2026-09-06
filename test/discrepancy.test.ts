import { describe, expect, it } from 'vitest';
import { DEFAULT_TOLERANCE, roundingFor, type Tolerance } from '../src/config.js';
import { computeDiscrepancy, type DiscrepancyInput } from '../src/domain/discrepancy.js';

const check = (over: Partial<DiscrepancyInput> = {}) =>
  computeDiscrepancy({
    invoiceId: 'INV-1',
    sourceCurrency: 'USD',
    targetCurrency: 'EUR',
    sourceAmount: '100000',
    appliedRate: '0.86',
    officialQuote: { base: 'USD', quote: 'EUR', rate: '0.85' },
    tolerance: DEFAULT_TOLERANCE,
    rounding: roundingFor('EUR'),
    ...over,
  });

describe('the two thresholds must BOTH be exceeded', () => {
  it('flags an invoice where the rate gap is both proportionally and materially significant', () => {
    const r = check();
    expect(r.verdict).toBe('flagged');
    expect(r.thresholds).toEqual({ relativeExceeded: true, absoluteExceeded: true });
    expect(r.appliedTotal).toBe('86000.00');
    expect(r.correctedTotal).toBe('85000.00');
    expect(r.absoluteDelta).toBe('1000.00');
    expect(r.correctionAmount).toBe('-1000.00'); // over-converted, so the total comes down
    expect(r.direction).toBe('applied_rate_too_high');
  });

  it('clears a small invoice with a large rate error, because the cash impact is trivial', () => {
    // Same 1.18% rate gap, but on $100 it is one euro. Emailing someone about
    // this is how a review queue becomes noise nobody reads.
    const r = check({ sourceAmount: '100' });
    expect(r.verdict).toBe('cleared');
    expect(r.thresholds).toEqual({ relativeExceeded: true, absoluteExceeded: false });
    expect(r.absoluteDelta).toBe('1.00');
  });

  it('clears a very large invoice with a trivial rate error', () => {
    // The brief's actual worry: a 0.012% rate difference on a $10m invoice is
    // EUR 1000 of "discrepancy" that is really just rounding.
    const r = check({
      sourceAmount: '10000000',
      appliedRate: '0.8501',
    });
    expect(r.verdict).toBe('cleared');
    expect(r.thresholds).toEqual({ relativeExceeded: false, absoluteExceeded: true });
    expect(r.absoluteDelta).toBe('1000.00');
  });

  it('clears an exact match', () => {
    const r = check({ appliedRate: '0.85' });
    expect(r.verdict).toBe('cleared');
    expect(r.direction).toBe('exact_match');
    expect(r.relativeDeltaPct).toBe('0');
  });

  it('reports an under-converted invoice as a positive correction', () => {
    const r = check({ appliedRate: '0.84' });
    expect(r.verdict).toBe('flagged');
    expect(r.direction).toBe('applied_rate_too_low');
    expect(r.correctionAmount).toBe('1000.00');
  });

  it('treats the thresholds as strict: exactly at tolerance is not a discrepancy', () => {
    const tolerance: Tolerance = { relativePct: 1, absoluteFloor: '1000' };
    // 0.86 vs 0.85 is not exactly 1%, so drive the relative gap to exactly 1%.
    const r = check({ officialQuote: { base: 'USD', quote: 'EUR', rate: '1' }, appliedRate: '1.01', tolerance });
    expect(r.relativeDeltaPct).toBe('1');
    expect(r.thresholds.relativeExceeded).toBe(false);
    expect(r.verdict).toBe('cleared');
  });
});

describe('rate direction guard', () => {
  it('refuses to compare when the official quote is the wrong way round', () => {
    // The invoice converts USD->EUR; this quote is EUR->USD. Multiplying by it
    // would produce a total that looks entirely plausible and is wrong.
    const r = check({ officialQuote: { base: 'EUR', quote: 'USD', rate: '1.18' } });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe('rate_direction_mismatch');
    expect(r.anomaly?.detail).toContain('wrong');
  });

  it('refuses a quote for an unrelated pair', () => {
    const r = check({ officialQuote: { base: 'GBP', quote: 'JPY', rate: '150' } });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe('rate_direction_mismatch');
  });
});

describe('input validation', () => {
  it.each([
    ['0', 'invalid_applied_rate'],
    ['-0.85', 'invalid_applied_rate'],
    ['not-a-rate', 'invalid_applied_rate'],
  ])('rejects an applied rate of %s', (appliedRate, reason) => {
    const r = check({ appliedRate });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe(reason);
  });

  it('rejects a non-numeric amount', () => {
    const r = check({ sourceAmount: '1,000.00' });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe('invalid_amount');
  });

  it('rejects a non-positive official rate', () => {
    const r = check({ officialQuote: { base: 'USD', quote: 'EUR', rate: '0' } });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe('invalid_official_rate');
  });
});

describe('recorded total cross-check', () => {
  it('accepts a recorded total within one minor unit of the computed total', () => {
    const r = check({ sourceAmount: '100', recordedTargetTotal: '86.01' });
    expect(r.verdict).not.toBe('anomaly');
  });

  it('flags an internally inconsistent invoice as an anomaly, not an FX discrepancy', () => {
    // If amount x rate does not equal the recorded total, one of the three
    // numbers is wrong and we cannot tell which. That is not something to email
    // a supplier about.
    const r = check({ sourceAmount: '100', recordedTargetTotal: '90.00' });
    expect(r.verdict).toBe('anomaly');
    expect(r.anomaly?.reason).toBe('recorded_total_mismatch');
    expect(r.anomaly?.detail).toContain('internally inconsistent');
  });
});

describe('decimal arithmetic', () => {
  it('rounds half-up on a value floats cannot represent', () => {
    // In IEEE 754, 1.005 is actually 1.00499999999999989, so a float
    // implementation rounds this to 1.00 and quietly loses a cent.
    const r = check({
      sourceAmount: '1',
      appliedRate: '1.005',
      officialQuote: { base: 'USD', quote: 'EUR', rate: '1.005' },
    });
    expect(r.appliedTotal).toBe('1.01');
  });

  it('holds precision on amounts far beyond float safety', () => {
    const r = check({
      sourceAmount: '99999999999.99',
      appliedRate: '1',
      officialQuote: { base: 'USD', quote: 'EUR', rate: '1' },
    });
    expect(r.appliedTotal).toBe('99999999999.99');
    expect(r.absoluteDelta).toBe('0.00');
  });

  it('uses zero-decimal rounding for JPY totals', () => {
    const r = check({
      targetCurrency: 'JPY',
      sourceAmount: '100',
      appliedRate: '150.4',
      officialQuote: { base: 'USD', quote: 'JPY', rate: '150' },
      rounding: roundingFor('JPY'),
    });
    expect(r.appliedTotal).toBe('15040');
    expect(r.correctedTotal).toBe('15000');
  });

  it('always serialises money at the currency scale', () => {
    const r = check({ sourceAmount: '10', appliedRate: '1.5', officialQuote: { base: 'USD', quote: 'EUR', rate: '1.5' } });
    expect(r.appliedTotal).toBe('15.00'); // not "15"
  });
});

describe('audit fields', () => {
  it('echoes the policy that produced the verdict', () => {
    const r = check();
    expect(r.invoiceId).toBe('INV-1');
    expect(r.tolerance).toEqual(DEFAULT_TOLERANCE);
    expect(r.rounding).toEqual({ scale: 2, mode: 'half_up' });
    expect(r.officialRate).toBe('0.85');
    expect(r.appliedRate).toBe('0.86');
  });
});
