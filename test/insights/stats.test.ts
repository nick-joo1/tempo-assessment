import { describe, expect, it } from 'vitest';
import { percentage, quantile, round1 } from '../../src/insights/stats.js';

describe('quantile', () => {
  it('interpolates linearly between the closest ranks', () => {
    expect(quantile([4, 10, 24, 48], 0.5)).toBe(17);
    expect(quantile([4, 10, 24, 48], 0.9)).toBe(40.8);
    expect(quantile([1, 2, 6], 0.9)).toBe(5.2);
  });

  it('does not depend on input order and leaves the input untouched', () => {
    const values = [48, 4, 24, 10];
    expect(quantile(values, 0.5)).toBe(17);
    expect(values).toEqual([48, 4, 24, 10]);
  });

  it('returns the only value of a single-element sample for any quantile', () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('returns null instead of a number for an empty sample', () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('percentage', () => {
  it('rounds to one decimal', () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(3, 4)).toBe(75);
  });

  it('is null when the whole is zero', () => {
    expect(percentage(0, 0)).toBeNull();
  });
});

describe('round1', () => {
  it('rounds half away from zero at one decimal', () => {
    expect(round1(42.857)).toBe(42.9);
    expect(round1(-42.857)).toBe(-42.9);
  });
});
