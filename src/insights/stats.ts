/** Every published number carries one decimal, so what the API returns is exactly what the LLM sees. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Quantile by linear interpolation between closest ranks (the NumPy / Excel PERCENTILE.INC
 * definition), rounded to one decimal. Returns null for an empty sample rather than
 * inventing a value.
 */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const below = sorted[lower] as number;
  const above = sorted[Math.min(lower + 1, sorted.length - 1)] as number;
  return round1(below + (above - below) * (rank - lower));
}

export function percentage(part: number, whole: number): number | null {
  return whole === 0 ? null : round1((part / whole) * 100);
}
