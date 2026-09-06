/**
 * The tool boundary: what the model actually sees.
 *
 * These assert the contract the agent depends on - the annotations that let
 * read-only calls batch, the structured payload it reads fields from, and the
 * mapping from outcome to `isError`. That mapping matters: a deferral and an
 * escalation are legitimate answers, not tool failures, and marking them as
 * errors would invite the model to retry them.
 */

import { describe, expect, it } from 'vitest';
import { createFetchOfficialRateTool } from '../src/tools/fetch-official-rate.js';
import { createComputeDiscrepancyTool } from '../src/tools/compute-discrepancy.js';
import { FX_TOOL_NAMES, createFxServer } from '../src/tools/server.js';
import { RateSourceUnavailableError } from '../src/rates/errors.js';
import { StubEcbSource, fixedClock } from './fixtures/STUB_ecb_tables.js';

const PUBLISHED = new Set(['2026-03-13']);
const CLOCK = fixedClock('2027-06-01T12:00:00Z');

const callFetch = async (args: { date: string; base: string; quote: string }, source?: StubEcbSource) => {
  const t = createFetchOfficialRateTool({
    source: source ?? new StubEcbSource(PUBLISHED),
    clock: CLOCK,
  });
  return t.handler(args, undefined) as Promise<any>;
};

const callCompute = async (args: Record<string, unknown>) => {
  const t = createComputeDiscrepancyTool();
  return t.handler(args as any, undefined) as Promise<any>;
};

describe('tool annotations', () => {
  it('marks both tools read-only so the agent can batch them', () => {
    const fetchTool = createFetchOfficialRateTool({ source: new StubEcbSource(PUBLISHED), clock: CLOCK });
    const computeTool = createComputeDiscrepancyTool();
    expect(fetchTool.annotations?.readOnlyHint).toBe(true);
    expect(computeTool.annotations?.readOnlyHint).toBe(true);
    expect(fetchTool.annotations?.idempotentHint).toBe(true);
    // Only the rate lookup reaches outside the process.
    expect(fetchTool.annotations?.openWorldHint).toBe(true);
    expect(computeTool.annotations?.openWorldHint).toBe(false);
  });
});

describe('fetch_official_rate', () => {
  it('returns the resolved rate as structured data, not just prose', async () => {
    const result = await callFetch({ date: '2026-03-13', base: 'EUR', quote: 'USD' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.kind).toBe('resolved');
    expect(result.structuredContent.quote).toEqual({ base: 'EUR', quote: 'USD', rate: '1.2000' });
    expect(result.structuredContent.rateDate).toBe('2026-03-13');
  });

  it('says in the text which date a fallback rate came from', async () => {
    const result = await callFetch({ date: '2026-03-14', base: 'EUR', quote: 'USD' });
    expect(result.content[0].text).toContain('2026-03-13');
    expect(result.content[0].text).toContain('last TARGET business day');
  });

  it('warns the model when a rate is derived rather than published', async () => {
    const result = await callFetch({ date: '2026-03-13', base: 'USD', quote: 'JPY' });
    expect(result.content[0].text).toContain('DERIVED');
    expect(result.structuredContent.derived).toBe(true);
  });

  it('reports an escalation as a normal result and tells the model not to retry', async () => {
    const result = await callFetch({ date: '2026-03-17', base: 'EUR', quote: 'USD' });
    expect(result.structuredContent.kind).toBe('escalate');
    // An escalation is a valid answer to a valid question, not a tool failure.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Do not retry');
    expect(result.content[0].text).toContain('escalation');
  });

  it('marks an exhausted feed as an error with a do-not-retry instruction', async () => {
    const source = new StubEcbSource(PUBLISHED, new RateSourceUnavailableError('timeout', 3));
    const result = await callFetch({ date: '2026-03-13', base: 'EUR', quote: 'USD' }, source);
    expect(result.isError).toBe(true);
    expect(result.structuredContent.reason).toBe('source_unavailable');
    expect(result.content[0].text).toContain('Do not retry this invoice in this pass');
  });

  it('never tells the model to substitute another date', async () => {
    const result = await callFetch({ date: '2026-03-17', base: 'EUR', quote: 'USD' });
    expect(result.content[0].text).toContain('do not estimate');
  });
});

describe('compute_discrepancy', () => {
  const base = {
    invoice_id: 'INV-9',
    source_currency: 'USD',
    target_currency: 'EUR',
    source_amount: '100000',
    applied_rate: '0.86',
    official_rate: '0.85',
    official_rate_base: 'USD',
    official_rate_quote: 'EUR',
  };

  it('returns the verdict and the corrected total as structured data', async () => {
    const result = await callCompute(base);
    expect(result.structuredContent.verdict).toBe('flagged');
    expect(result.structuredContent.correctedTotal).toBe('85000.00');
    expect(result.content[0].text).toContain('FLAGGED');
  });

  it('explains a clearance rather than returning a bare verdict', async () => {
    const result = await callCompute({ ...base, source_amount: '100' });
    expect(result.structuredContent.verdict).toBe('cleared');
    expect(result.content[0].text).toContain('below the absolute floor');
    expect(result.content[0].text).toContain('No correction and no email');
  });

  it('refuses a mismatched rate direction and says not to send a correction', async () => {
    const result = await callCompute({ ...base, official_rate_base: 'EUR', official_rate_quote: 'USD' });
    expect(result.structuredContent.verdict).toBe('anomaly');
    expect(result.structuredContent.anomaly.reason).toBe('rate_direction_mismatch');
    expect(result.content[0].text).toContain('do not send a correction');
  });

  it('normalises lowercase currency codes before the direction check', async () => {
    const result = await callCompute({
      ...base,
      source_currency: 'usd',
      target_currency: 'eur',
      official_rate_base: 'usd',
      official_rate_quote: 'eur',
    });
    expect(result.structuredContent.verdict).toBe('flagged');
  });
});

describe('fx server registration', () => {
  it('exposes both read-only tools under fully-qualified names', () => {
    const server = createFxServer({ source: new StubEcbSource(PUBLISHED), clock: CLOCK });
    expect(server.name).toBe('fx');
    expect(FX_TOOL_NAMES).toEqual({
      fetchOfficialRate: 'mcp__fx__fetch_official_rate',
      computeDiscrepancy: 'mcp__fx__compute_discrepancy',
    });
  });
});
