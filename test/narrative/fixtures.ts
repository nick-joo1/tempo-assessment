import type { MergedPullRequest } from '../../src/domain.js';
import { resolvePeriod } from '../../src/insights/period.js';
import { computeReviewFlow } from '../../src/insights/review-flow.js';
import type { ReviewFlowInsight } from '../../src/insights/schema.js';
import type { NarrativeDraft } from '../../src/narrative/schema.js';
import { pullRequest, review } from '../helpers.js';

const NOW = new Date('2026-11-11T00:00:00Z');
const HOUR_MS = 3_600_000;

/**
 * `count` pull requests merged one per day from `firstDay`, each opened `cycleHours`
 * before its merge and approved by `reviewer` after `waitHours`.
 */
function batch(options: {
  firstNumber: number;
  count: number;
  firstDay: string;
  cycleHours: number;
  waitHours: number;
  reviewer: string;
}): MergedPullRequest[] {
  return Array.from({ length: options.count }, (_, index) => {
    const mergedAt = Date.parse(`${options.firstDay}T12:00:00Z`) + index * 24 * HOUR_MS;
    const createdAt = mergedAt - options.cycleHours * HOUR_MS;
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
    return pullRequest(
      {
        number: options.firstNumber + index,
        author: index % 2 === 0 ? 'alice' : 'dave',
        created: iso(createdAt),
        merged: iso(mergedAt),
        lines: [120, 30],
      },
      [review(options.reviewer, iso(createdAt + options.waitHours * HOUR_MS))],
    );
  });
}

/**
 * Three weeks in which review slowed down against the three weeks before:
 * 21 pull requests in each, cycle time 30.5h (was 12h), wait for first review 26.5h (was 4h).
 */
export function slowdownInsight(): ReviewFlowInsight {
  return computeReviewFlow({
    repository: 'acme/widgets',
    period: resolvePeriod({ from: '2026-10-15', to: '2026-11-04' }, NOW),
    baselineCovered: true,
    pullRequests: [
      ...batch({
        firstNumber: 100,
        count: 21,
        firstDay: '2026-09-24',
        cycleHours: 12,
        waitHours: 4,
        reviewer: 'carol',
      }),
      ...batch({
        firstNumber: 200,
        count: 21,
        firstDay: '2026-10-15',
        cycleHours: 30.5,
        waitHours: 26.5,
        reviewer: 'bob',
      }),
    ],
    dataAsOf: NOW,
  });
}

/** A draft that quotes only numbers the slowdown insight contains and cites where they are. */
export function soundDraft(overrides: Partial<NarrativeDraft> = {}): NarrativeDraft {
  return {
    headline: 'Median cycle time rose to 30.5 hours, almost all of it spent waiting for review.',
    summary:
      'Between 2026-10-15 and 2026-11-04 the 21 merged pull requests took a median of 30.5 hours, up from 12 hours. The wait for a first review grew to 26.5 hours.',
    findings: [
      {
        title: 'Cycle time more than doubled',
        detail: 'The median went from 12 hours to 30.5 hours, an increase of 18.5 hours.',
        evidence: ['metrics.cycleTimeP50Hours.delta'],
      },
      {
        title: 'Waiting for review dominates',
        detail: 'Pull requests waited a median of 26.5 hours for a first review, up from 4.',
        evidence: ['metrics.timeToFirstReviewP50Hours.current'],
      },
      {
        title: 'One person reviews everything',
        detail: 'bob submitted 100% of the 21 reviews.',
        evidence: ['metrics.topReviewerSharePct.current', 'topReviewers[bob].reviews'],
      },
    ],
    hypothesis: {
      statement: 'Review capacity is a bottleneck.',
      reasoning:
        'The wait for review grew by 22.5 hours while a single reviewer handled every review.',
      evidence: [
        'metrics.timeToFirstReviewP50Hours.delta',
        'metrics.reviewersForHalfOfReviews.current',
      ],
      alternatives: ['The pull requests may have been harder to review.'],
      nextCheck: 'Check whether other reviewers were away during the period.',
    },
    confidence: { score: 0.8, rationale: 'Two signals agree across 21 pull requests.' },
    caveats: [],
    ...overrides,
  };
}
