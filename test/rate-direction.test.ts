/**
 * Rate direction.
 *
 * The ECB publishes "units of X per 1 EUR". Everything downstream expects
 * "units of target per 1 source". Getting that backwards is the single easiest
 * way to produce a wrong answer that looks right, so these tests assert the
 * exact expected value AND assert that the inverted value is not what came back.
 *
 * All fixture rates sit far from parity on purpose - see STUB_ecb_tables.ts.
 */

import { describe, expect, it } from 'vitest';
import { resolveOfficialRate } from '../src/rates/resolver.js';
import { StubEcbSource, fixedClock } from './fixtures/STUB_ecb_tables.js';

const PUBLISHED = new Set(['2026-03-13']);
const CLOCK = fixedClock('2027-06-01T12:00:00Z');

const resolve = (base: string, quote: string, allowTriangulation = true) =>
  resolveOfficialRate(
    { requestedDate: '2026-03-13', base, quote },
    { source: new StubEcbSource(PUBLISHED), clock: CLOCK, allowTriangulation },
  );

describe('EUR as the base currency', () => {
  it('uses the published rate verbatim, without rounding or reformatting', async () => {
    const result = await resolve('EUR', 'USD');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    // "1.2000" not "1.2" - a published figure is recorded exactly as printed.
    expect(result.quote.rate).toBe('1.2000');
    expect(result.derived).toBe(false);
    expect(result.derivation).toEqual({ type: 'direct' });
  });

  it('means quote-per-base: 1 EUR buys 180 JPY, not 1 JPY buying 180 EUR', async () => {
    const result = await resolve('EUR', 'JPY');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.quote).toEqual({ base: 'EUR', quote: 'JPY', rate: '180.00' });
  });
});

describe('EUR as the quote currency (inversion)', () => {
  it('inverts the published rate and marks the result derived', async () => {
    const result = await resolve('USD', 'EUR');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    // 1 / 1.2 = 0.8333... to 12 significant digits.
    expect(result.quote.rate).toBe('0.833333333333');
    expect(result.derived).toBe(true);
    expect(result.derivation).toEqual({ type: 'inverted', publishedPair: 'EUR/USD' });
  });

  it('does not return the published rate unchanged', async () => {
    const result = await resolve('USD', 'EUR');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.quote.rate).not.toBe('1.2000');
  });
});

describe('neither side is EUR (triangulation)', () => {
  it('divides the two euro legs in the right order', async () => {
    // (JPY per EUR) / (USD per EUR) = 180 / 1.2 = 150 JPY per USD.
    const result = await resolve('USD', 'JPY');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.quote).toEqual({ base: 'USD', quote: 'JPY', rate: '150' });
    expect(result.derived).toBe(true);
    expect(result.derivation).toEqual({
      type: 'triangulated',
      pivot: 'EUR',
      legs: ['EUR/USD', 'EUR/JPY'],
    });
  });

  it('does not divide them the wrong way round', async () => {
    const result = await resolve('USD', 'JPY');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    // The inverted answer, 1.2/180 = 0.00666..., is off by ~22,500x. On a pair
    // near parity this assertion would pass by luck; on these values it cannot.
    expect(Number(result.quote.rate)).toBeGreaterThan(100);
    expect(Number(result.quote.rate)).toBeLessThan(200);
  });

  it('is symmetric: JPY->USD is the reciprocal of USD->JPY', async () => {
    const forward = await resolve('USD', 'JPY');
    const backward = await resolve('JPY', 'USD');
    if (forward.kind !== 'resolved' || backward.kind !== 'resolved') throw new Error('expected resolved');
    const product = Number(forward.quote.rate) * Number(backward.quote.rate);
    expect(product).toBeCloseTo(1, 10);
  });

  it('escalates instead of deriving when triangulation is disabled', async () => {
    const result = await resolve('USD', 'JPY', false);
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('unknown_currency');
    expect(result.detail).toContain('Triangulation is disabled');
  });
});

describe('audit trail', () => {
  it('records both legs of a triangulated rate as published', async () => {
    const result = await resolve('USD', 'JPY');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.sources).toEqual([
      expect.objectContaining({ currency: 'USD', publishedRate: '1.2000', rateDate: '2026-03-13' }),
      expect.objectContaining({ currency: 'JPY', publishedRate: '180.00', rateDate: '2026-03-13' }),
    ]);
    expect(result.sources.every((s) => s.url.length > 0)).toBe(true);
    expect(result.fetchedAt).toBeTruthy();
  });

  it('normalises lowercase currency codes', async () => {
    const result = await resolve('usd', 'jpy');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.quote.base).toBe('USD');
    expect(result.quote.quote).toBe('JPY');
  });
});

describe('corrupt published rates never become a value', () => {
  it('escalates a zero published rate instead of dividing by it', async () => {
    // decimal.js reports zero as "positive" and returns Infinity for x/0, so
    // without an explicit guard this pair would resolve to a rate of "Infinity".
    const zeroTable = new Map([
      ['EUR', '1'],
      ['USD', '0'],
      ['JPY', '180.00'],
    ]);
    const source = {
      async tableForDate() {
        return {
          date: '2026-03-13' as never,
          rates: zeroTable,
          sourceUrl: 'https://stub.invalid/STUB.xml',
          fetchedAt: '2026-03-13T16:00:00.000Z',
        };
      },
    };
    const result = await resolveOfficialRate(
      { requestedDate: '2026-03-13', base: 'USD', quote: 'JPY' },
      { source, clock: CLOCK },
    );
    if (result.kind !== 'escalate') throw new Error(`expected escalate, got ${result.kind}`);
    expect(result.reason).toBe('source_format');
  });
});
