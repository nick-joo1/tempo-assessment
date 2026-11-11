export const DAY_MS = 86_400_000;
export const MAX_PERIOD_DAYS = 90;
const DEFAULT_PERIOD_DAYS = 30;

/** A span of whole UTC days. Both dates are inclusive, formatted YYYY-MM-DD. */
export interface Period {
  from: string;
  to: string;
  days: number;
}

/**
 * The requested period plus the equally long period immediately before it, which is the
 * baseline every "change" is measured against. Instants are epoch ms; ends are exclusive.
 */
export interface ResolvedPeriod {
  current: Period;
  baseline: Period;
  startMs: number;
  endMs: number;
  baselineStartMs: number;
}

export class InvalidPeriodError extends Error {
  override name = 'InvalidPeriodError';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseUtcDay(value: string, field: string): number {
  const ms = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  // Date.parse normalises impossible dates (2026-02-30 -> March 2); the round trip rejects them.
  if (Number.isNaN(ms) || formatUtcDay(ms) !== value) {
    throw new InvalidPeriodError(`'${field}' must be a calendar date formatted YYYY-MM-DD`);
  }
  return ms;
}

export function formatUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Resolves `from`/`to` query parameters into a period. `to` defaults to today (UTC) and
 * `from` to 30 days ending at `to`.
 */
export function resolvePeriod(query: { from?: string; to?: string }, now: Date): ResolvedPeriod {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const lastDay = query.to === undefined ? today : parseUtcDay(query.to, 'to');
  const firstDay =
    query.from === undefined
      ? lastDay - (DEFAULT_PERIOD_DAYS - 1) * DAY_MS
      : parseUtcDay(query.from, 'from');

  if (lastDay > today) throw new InvalidPeriodError(`'to' must not be in the future`);
  if (firstDay > lastDay) throw new InvalidPeriodError(`'from' must not be after 'to'`);

  const days = (lastDay - firstDay) / DAY_MS + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw new InvalidPeriodError(`The period must not exceed ${MAX_PERIOD_DAYS} days`);
  }

  const baselineStartMs = firstDay - days * DAY_MS;
  return {
    current: { from: formatUtcDay(firstDay), to: formatUtcDay(lastDay), days },
    baseline: {
      from: formatUtcDay(baselineStartMs),
      to: formatUtcDay(firstDay - DAY_MS),
      days,
    },
    startMs: firstDay,
    endMs: lastDay + DAY_MS,
    baselineStartMs,
  };
}
