import { describe, expect, it } from 'vitest';
import { InvalidPeriodError, resolvePeriod } from '../../src/insights/period.js';

const NOW = new Date('2026-11-11T15:30:00Z');

describe('resolvePeriod', () => {
  it('treats both dates as inclusive and derives the preceding baseline of equal length', () => {
    const period = resolvePeriod({ from: '2026-10-01', to: '2026-10-14' }, NOW);

    expect(period.current).toEqual({ from: '2026-10-01', to: '2026-10-14', days: 14 });
    expect(period.baseline).toEqual({ from: '2026-09-17', to: '2026-09-30', days: 14 });
    expect(new Date(period.startMs).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(new Date(period.endMs).toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(new Date(period.baselineStartMs).toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  it('defaults to the 30 days ending today (UTC)', () => {
    expect(resolvePeriod({}, NOW).current).toEqual({
      from: '2026-10-13',
      to: '2026-11-11',
      days: 30,
    });
  });

  it('defaults `from` relative to an explicit `to`', () => {
    expect(resolvePeriod({ to: '2026-10-30' }, NOW).current.from).toBe('2026-10-01');
  });

  it('accepts a single-day period and the 90-day maximum', () => {
    expect(resolvePeriod({ from: '2026-11-11', to: '2026-11-11' }, NOW).current.days).toBe(1);
    expect(resolvePeriod({ from: '2026-08-14', to: '2026-11-11' }, NOW).current.days).toBe(90);
  });

  it.each([
    ['a malformed date', { from: '2026-10-1' }],
    ['a datetime where a date is expected', { from: '2026-10-01T00:00:00Z' }],
    ['a date that does not exist', { from: '2026-02-30', to: '2026-03-10' }],
    ['a period that ends in the future', { from: '2026-11-01', to: '2026-11-12' }],
    ['`from` after `to`', { from: '2026-10-10', to: '2026-10-01' }],
    ['a period longer than 90 days', { from: '2026-08-13', to: '2026-11-11' }],
  ])('rejects %s', (_case, query) => {
    expect(() => resolvePeriod(query, NOW)).toThrow(InvalidPeriodError);
  });
});
