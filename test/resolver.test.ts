import { describe, expect, it } from 'vitest';
import { resolveOfficialRate } from '../src/rates/resolver.js';
import { FatalHttpError, RateSourceFormatError, RateSourceUnavailableError } from '../src/rates/errors.js';
import { StubEcbSource, fixedClock } from './fixtures/STUB_ecb_tables.js';

/** Published business days available in the stub feed. */
const PUBLISHED = new Set([
  '2026-03-13', // Fri
  '2026-03-16', // Mon
  '2026-04-02', // Maundy Thursday
  '2026-04-07', // Tue after Easter
  '2026-12-24', // Christmas Eve
  '2026-12-28', // Mon after Christmas
]);

/** Well after every date under test, so nothing is accidentally "today". */
const LATER = fixedClock('2027-06-01T12:00:00Z');

const resolve = (
  date: string,
  base: string,
  quote: string,
  opts: { source?: StubEcbSource; clock?: { now(): Date }; allowTriangulation?: boolean } = {},
) =>
  resolveOfficialRate(
    { requestedDate: date, base, quote },
    {
      source: opts.source ?? new StubEcbSource(PUBLISHED),
      clock: opts.clock ?? LATER,
      ...(opts.allowTriangulation !== undefined ? { allowTriangulation: opts.allowTriangulation } : {}),
    },
  );

describe('date resolution', () => {
  it('uses the invoice date when it is a published business day', async () => {
    const result = await resolve('2026-03-13', 'EUR', 'USD');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.rateDate).toBe('2026-03-13');
    expect(result.requestedDate).toBe('2026-03-13');
    expect(result.dateResolution).toBe('exact');
  });

  it('falls back from a Saturday to the preceding Friday and says so', async () => {
    const result = await resolve('2026-03-14', 'EUR', 'USD');
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.rateDate).toBe('2026-03-13');
    expect(result.dateResolution).toBe('previous_business_day');
  });

  it('falls back from a Sunday to the preceding Friday', async () => {
    const result = await resolve('2026-03-15', 'EUR', 'USD');
    if (result.kind !== 'resolved') throw new Error(`expected resolved, got ${result.kind}`);
    expect(result.rateDate).toBe('2026-03-13');
  });

  it('walks back across the full Good Friday to Easter Monday closure', async () => {
    // The longest legitimate TARGET closure: Fri/Sat/Sun/Mon all closed, so an
    // Easter Monday invoice must reach back four days to Maundy Thursday.
    const source = new StubEcbSource(PUBLISHED);
    const result = await resolve('2026-04-06', 'EUR', 'USD', { source });
    if (result.kind !== 'resolved') throw new Error(`expected resolved, got ${result.kind}`);
    expect(result.rateDate).toBe('2026-04-02');
    expect(result.dateResolution).toBe('previous_business_day');
    // Closed days are skipped by the calendar, never probed against the feed.
    expect(source.requestedDates).toEqual(['2026-04-02']);
  });

  it('walks back across the Christmas closure to Christmas Eve', async () => {
    const result = await resolve('2026-12-27', 'EUR', 'USD');
    if (result.kind !== 'resolved') throw new Error(`expected resolved, got ${result.kind}`);
    expect(result.rateDate).toBe('2026-12-24');
  });

  it('records the calendar version that produced the decision', async () => {
    const result = await resolve('2026-03-14', 'EUR', 'USD');
    if (result.kind !== 'resolved') throw new Error('expected resolved');
    expect(result.calendarVersion).toBe('target-2002.1');
  });
});

describe('missing rates are never filled in', () => {
  it('escalates a business day that is absent from the feed instead of walking back', async () => {
    // 2026-03-17 is a Tuesday; the stub feed has no entry for it. Walking back
    // to Monday would produce a plausible, wrong, auditable number.
    const result = await resolve('2026-03-17', 'EUR', 'USD');
    expect(result.kind).toBe('escalate');
    if (result.kind !== 'escalate') return;
    expect(result.reason).toBe('no_rate_published');
    expect(result.detail).toContain('gap in the feed');
  });

  it('escalates a future invoice date rather than using the latest rate', async () => {
    const result = await resolve('2027-08-01', 'EUR', 'USD', { clock: LATER });
    expect(result.kind).toBe('escalate');
    if (result.kind !== 'escalate') return;
    expect(result.reason).toBe('future_date');
  });

  it('escalates a malformed date', async () => {
    const result = await resolve('2026-02-31', 'EUR', 'USD');
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('invalid_date');
  });

  it('escalates a currency the ECB does not publish', async () => {
    const result = await resolve('2026-03-13', 'EUR', 'XYZ');
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('unknown_currency');
    expect(result.detail).toContain('XYZ');
  });

  it('escalates when source and target are the same currency', async () => {
    const result = await resolve('2026-03-13', 'EUR', 'EUR');
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('same_currency');
  });

  it('escalates when no business day is found inside the walk-back window', async () => {
    const result = await resolveOfficialRate(
      { requestedDate: '2026-03-15', base: 'EUR', quote: 'USD' },
      { source: new StubEcbSource(PUBLISHED), clock: LATER, maxWalkBackDays: 1 },
    );
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('walk_back_exceeded');
  });
});

describe('publication window', () => {
  // Europe/Berlin is UTC+2 in April (CEST), so 08:00Z is 10:00 local.
  const beforeCutoff = fixedClock('2026-04-07T08:00:00Z');
  const afterCutoff = fixedClock('2026-04-07T16:30:00Z'); // 18:30 local

  it("defers today's rate before the publication cutoff instead of using yesterday's", async () => {
    const source = new StubEcbSource(new Set(['2026-04-02'])); // today not published yet
    const result = await resolve('2026-04-07', 'EUR', 'USD', { source, clock: beforeCutoff });
    expect(result.kind).toBe('deferred');
    if (result.kind !== 'deferred') return;
    expect(result.reason).toBe('not_yet_published');
    // The critical assertion: it never reached back to an earlier date.
    expect(source.requestedDates).toEqual([]);
  });

  it("resolves today's rate once it is published", async () => {
    const result = await resolve('2026-04-07', 'EUR', 'USD', { clock: afterCutoff });
    if (result.kind !== 'resolved') throw new Error(`expected resolved, got ${result.kind}`);
    expect(result.rateDate).toBe('2026-04-07');
  });

  it('defers rather than escalates when today is late to publish', async () => {
    const source = new StubEcbSource(new Set(['2026-04-02']));
    const result = await resolve('2026-04-07', 'EUR', 'USD', { source, clock: afterCutoff });
    if (result.kind !== 'deferred') throw new Error(`expected deferred, got ${result.kind}`);
    expect(result.reason).toBe('not_yet_published');
  });
});

describe('source failures are classified, not guessed at', () => {
  it('defers when the feed is unreachable after retries', async () => {
    const source = new StubEcbSource(PUBLISHED, new RateSourceUnavailableError('timeout', 3));
    const result = await resolve('2026-03-13', 'EUR', 'USD', { source });
    if (result.kind !== 'deferred') throw new Error('expected deferred');
    expect(result.reason).toBe('source_unavailable');
  });

  it('defers on a non-retryable HTTP status but says retrying will not help', async () => {
    const source = new StubEcbSource(PUBLISHED, new FatalHttpError('ECB feed returned 404 Not Found'));
    const result = await resolve('2026-03-13', 'EUR', 'USD', { source });
    if (result.kind !== 'deferred') throw new Error('expected deferred');
    expect(result.detail).toContain('will not resolve by retrying');
  });

  it('escalates a feed whose format changed, rather than parsing around it', async () => {
    const source = new StubEcbSource(
      PUBLISHED,
      new RateSourceFormatError('no gesmes:Envelope', 'https://stub.invalid/x.xml'),
    );
    const result = await resolve('2026-03-13', 'EUR', 'USD', { source });
    if (result.kind !== 'escalate') throw new Error('expected escalate');
    expect(result.reason).toBe('source_format');
  });
});
