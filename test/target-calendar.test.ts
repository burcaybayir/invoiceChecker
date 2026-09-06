import { describe, expect, it } from 'vitest';
import { parseIsoDate } from '../src/domain/dates.js';
import {
  easterSunday,
  isTargetBusinessDay,
  isTargetHoliday,
  targetClosingDays,
} from '../src/domain/target-calendar.js';

const d = (s: string) => {
  const parsed = parseIsoDate(s);
  if (!parsed) throw new Error(`bad test date ${s}`);
  return parsed;
};

describe('easterSunday', () => {
  // Independently known Gregorian Easter dates - the computus is the one piece
  // of the calendar that cannot be eyeballed.
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2030, '2030-04-21'],
  ])('computes Easter %i as %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('TARGET closing days', () => {
  it('closes on the six named days', () => {
    const days = targetClosingDays(2026);
    expect([...days].sort()).toEqual([
      '2026-01-01',
      '2026-04-03', // Good Friday
      '2026-04-06', // Easter Monday
      '2026-05-01',
      '2026-12-25',
      '2026-12-26',
    ]);
  });

  it('does not move a holiday that falls on a weekend to the next weekday', () => {
    // 2026-12-26 is a Saturday. TARGET has no substitute-day rule, so the
    // following Monday is a normal business day.
    expect(isTargetHoliday(d('2026-12-26'))).toBe(true);
    expect(isTargetBusinessDay(d('2026-12-28'))).toBe(true);
  });
});

describe('isTargetBusinessDay', () => {
  it.each([
    ['2026-03-13', true], // Friday
    ['2026-03-14', false], // Saturday
    ['2026-03-15', false], // Sunday
    ['2026-03-16', true], // Monday
    ['2026-04-02', true], // Maundy Thursday - the ECB still publishes
    ['2026-04-03', false], // Good Friday
    ['2026-04-06', false], // Easter Monday
    ['2026-05-01', false], // Labour Day
    ['2026-01-01', false], // New Year
    ['2025-12-31', true], // New Year's Eve is a normal business day
  ])('%s -> business day: %s', (date, expected) => {
    expect(isTargetBusinessDay(d(date))).toBe(expected);
  });
});
