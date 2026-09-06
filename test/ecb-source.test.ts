/**
 * Feed parsing and HTTP failure classification.
 *
 * The XML below is shaped like the ECB envelope but every rate is a STUB value
 * (see STUB_ecb_tables.ts). None of these numbers is a real published rate.
 */

import { describe, expect, it, vi } from 'vitest';
import { HttpEcbSource, parseEcbEnvelope } from '../src/rates/ecb-source.js';
import { FatalHttpError, RateSourceFormatError, RateSourceUnavailableError } from '../src/rates/errors.js';
import { parseIsoDate } from '../src/domain/dates.js';
import { fixedClock } from './fixtures/STUB_ecb_tables.js';

const STUB_URL = 'https://stub.invalid/STUB_feed.xml';

const STUB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>
  <Cube>
    <Cube time='2026-03-16'>
      <Cube currency='USD' rate='1.2100'/>
      <Cube currency='JPY' rate='181.00'/>
    </Cube>
    <Cube time='2026-03-13'>
      <Cube currency='USD' rate='1.2000'/>
      <Cube currency='JPY' rate='180.00'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const d = (s: string) => parseIsoDate(s)!;

describe('parseEcbEnvelope', () => {
  it('reads every dated table in the document', () => {
    const tables = parseEcbEnvelope(STUB_XML, STUB_URL);
    expect([...tables.keys()].sort()).toEqual(['2026-03-13', '2026-03-16']);
  });

  it('keeps rates as published strings rather than parsing them to numbers', () => {
    const tables = parseEcbEnvelope(STUB_XML, STUB_URL);
    // "1.2000", not 1.2 - trailing zeros are part of what was published, and a
    // float round-trip is exactly what this system must never do.
    expect(tables.get(d('2026-03-13'))?.get('USD')).toBe('1.2000');
  });

  it('adds EUR to every table as the implicit unit', () => {
    const tables = parseEcbEnvelope(STUB_XML, STUB_URL);
    expect(tables.get(d('2026-03-13'))?.get('EUR')).toBe('1');
  });

  it('handles a single-day document, where the XML has no array', () => {
    const single = STUB_XML.replace(/<Cube time='2026-03-16'>[\s\S]*?<\/Cube>\s*(?=<Cube time)/, '');
    const tables = parseEcbEnvelope(single, STUB_URL);
    expect([...tables.keys()]).toEqual(['2026-03-13']);
  });

  it.each([
    ['not xml at all', '<<<'],
    ['no envelope', '<?xml version="1.0"?><other/>'],
    ['no dated cubes', '<gesmes:Envelope xmlns:gesmes="g"><Cube/></gesmes:Envelope>'],
    [
      'a non-numeric rate',
      `<gesmes:Envelope xmlns:gesmes="g"><Cube><Cube time='2026-03-13'><Cube currency='USD' rate='n/a'/></Cube></Cube></gesmes:Envelope>`,
    ],
    [
      'an unparseable date',
      `<gesmes:Envelope xmlns:gesmes="g"><Cube><Cube time='16 March'><Cube currency='USD' rate='1.2'/></Cube></Cube></gesmes:Envelope>`,
    ],
    [
      'a table with no currencies',
      `<gesmes:Envelope xmlns:gesmes="g"><Cube><Cube time='2026-03-13'></Cube></Cube></gesmes:Envelope>`,
    ],
  ])('rejects %s loudly rather than parsing around it', (_label, xml) => {
    expect(() => parseEcbEnvelope(xml, STUB_URL)).toThrow(RateSourceFormatError);
  });
});

describe('HttpEcbSource', () => {
  const ok = () => new Response(STUB_XML, { status: 200 });
  const clock = fixedClock('2026-03-16T12:00:00Z');

  const build = (fetchImpl: typeof fetch, sleep = vi.fn(async () => {})) =>
    new HttpEcbSource({ clock, fetchImpl, sleep, baseBackoffMs: 1 });

  it('returns the table for a published date', async () => {
    const source = build(vi.fn(ok) as unknown as typeof fetch);
    const table = await source.tableForDate(d('2026-03-13'));
    expect(table?.rates.get('USD')).toBe('1.2000');
    expect(table?.sourceUrl).toContain('eurofxref');
  });

  it('returns null for a date the feed does not contain', async () => {
    const source = build(vi.fn(ok) as unknown as typeof fetch);
    expect(await source.tableForDate(d('2026-03-14'))).toBeNull();
  });

  it('retries a 5xx with backoff and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn(async () => {});
    const source = build(fetchImpl as unknown as typeof fetch, sleep);

    expect(await source.tableForDate(d('2026-03-13'))).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 rather than treating it as fatal', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(ok());
    const source = build(fetchImpl as unknown as typeof fetch);
    expect(await source.tableForDate(d('2026-03-13'))).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up as unavailable once attempts are exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' }));
    const source = build(fetchImpl as unknown as typeof fetch);
    await expect(source.tableForDate(d('2026-03-13'))).rejects.toBeInstanceOf(RateSourceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404, because a wrong request stays wrong', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }));
    const source = build(fetchImpl as unknown as typeof fetch);
    await expect(source.tableForDate(d('2026-03-13'))).rejects.toBeInstanceOf(FatalHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed feed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<<<', { status: 200 }));
    const source = build(fetchImpl as unknown as typeof fetch);
    await expect(source.tableForDate(d('2026-03-13'))).rejects.toBeInstanceOf(RateSourceFormatError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches a document once and serves every date in it from cache', async () => {
    const fetchImpl = vi.fn(ok);
    const source = build(fetchImpl as unknown as typeof fetch);
    await source.tableForDate(d('2026-03-13'));
    await source.tableForDate(d('2026-03-16'));
    await source.tableForDate(d('2026-03-13'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent lookups into a single request', async () => {
    const fetchImpl = vi.fn(ok);
    const source = build(fetchImpl as unknown as typeof fetch);
    await Promise.all([
      source.tableForDate(d('2026-03-13')),
      source.tableForDate(d('2026-03-16')),
      source.tableForDate(d('2026-03-13')),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads recent dates from the 90-day feed and older ones from the full history', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(ok());
    });
    const source = build(fetchImpl as unknown as typeof fetch);
    await source.tableForDate(d('2026-03-13')); // days old
    await source.tableForDate(d('2020-01-02')); // years old
    expect(urls[0]).toContain('hist-90d');
    expect(urls[1]).toContain('eurofxref-hist.xml');
  });
});

describe('corrupt rates in the feed', () => {
  it('rejects a zero rate at parse time', () => {
    const xml = `<gesmes:Envelope xmlns:gesmes="g"><Cube><Cube time='2026-03-13'><Cube currency='USD' rate='0'/></Cube></Cube></gesmes:Envelope>`;
    expect(() => parseEcbEnvelope(xml, STUB_URL)).toThrow(RateSourceFormatError);
  });
});
