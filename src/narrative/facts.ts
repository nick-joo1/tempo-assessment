import { METRIC_KEYS, type ReviewFlowInsight } from '../insights/schema.js';

export type FactValue = number | string | null;

/**
 * Every value of an insight under a stable id such as `metrics.cycleTimeP50Hours.delta` or
 * `topReviewers[octocat].sharePct`. The sheet is what the model reads, what its evidence
 * must cite, and what its prose is verified against, so the three can never drift apart.
 */
export type FactSheet = ReadonlyMap<string, FactValue>;

export function buildFactSheet(insight: ReviewFlowInsight): FactSheet {
  const facts = new Map<string, FactValue>();
  const add = (prefix: string, values: Record<string, FactValue>) => {
    for (const [key, value] of Object.entries(values)) facts.set(`${prefix}.${key}`, value);
  };

  add('period', insight.period);
  if (insight.baselinePeriod) add('baselinePeriod', insight.baselinePeriod);
  for (const key of METRIC_KEYS) add(`metrics.${key}`, insight.metrics[key]);
  for (const { start, ...week } of insight.weekly) add(`weekly[${start}]`, week);
  for (const { label, ...bucket } of insight.sizeBuckets) add(`sizeBuckets[${label}]`, bucket);
  for (const { login, ...reviewer } of insight.topReviewers) {
    add(`topReviewers[${login}]`, reviewer);
  }
  for (const { login, ...author } of insight.topAuthors) add(`topAuthors[${login}]`, author);
  for (const { number, ...pr } of insight.slowestPullRequests) {
    add(`slowestPullRequests[#${number}]`, pr);
  }
  return facts;
}

/** One `id = value` line per fact; `n/a` stands for a value that does not exist. */
export function renderFactSheet(facts: FactSheet): string {
  return [...facts].map(([id, value]) => `${id} = ${value ?? 'n/a'}`).join('\n');
}

/**
 * The id of the thing a fact describes: `metrics.cycleTimeP50Hours` for
 * `metrics.cycleTimeP50Hours.delta`. Citing one fact puts its siblings within reach, so a
 * finding that cites a metric's change may also quote its current and baseline values.
 */
export function subjectOf(factId: string): string {
  return factId.slice(0, factId.lastIndexOf('.'));
}
