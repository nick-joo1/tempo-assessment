import { describe, expect, it } from 'vitest';
import type { MergedPullRequest } from '../../src/domain.js';
import { resolvePeriod } from '../../src/insights/period.js';
import { computeReviewFlow } from '../../src/insights/review-flow.js';
import { pullRequest, review } from '../helpers.js';

const NOW = new Date('2026-11-11T00:00:00Z');
const PERIOD = resolvePeriod({ from: '2026-10-01', to: '2026-10-14' }, NOW);

/**
 * Four human pull requests in the period, chosen so every rule is exercised and every
 * expected number below can be checked by hand:
 *
 *   #1  cycle 10h, first review after 2h, merged 8h later
 *   #2  cycle 24h, draft for 4h, first review 6h after leaving draft, merged 14h later
 *   #3  cycle 48h, reviewed only by a bot -> counts as unreviewed
 *   #4  cycle  4h, reviewed after 1h while still a draft, merged 3h later
 */
const CURRENT: MergedPullRequest[] = [
  pullRequest(
    {
      number: 1,
      author: 'alice',
      created: '2026-10-01',
      merged: '2026-10-01T10:00',
      lines: [5, 3],
    },
    [review('bob', '2026-10-01T02:00')],
  ),
  pullRequest(
    {
      number: 2,
      author: 'alice',
      created: '2026-10-02',
      ready: '2026-10-02T04:00',
      merged: '2026-10-03',
      lines: [150, 50],
    },
    [
      review('alice', '2026-10-02T05:00', 'COMMENTED'), // the author replying in a thread
      review('bob', '2026-10-02T10:00', 'CHANGES_REQUESTED'),
      review('carol', '2026-10-02T20:00'),
      review('bob', '2026-10-03T05:00', 'COMMENTED'), // after the merge
    ],
  ),
  pullRequest(
    { number: 3, author: 'bob', created: '2026-10-08', merged: '2026-10-10', lines: [1000, 200] },
    [review('review-bot', '2026-10-08T00:05', 'APPROVED', true)],
  ),
  pullRequest(
    {
      number: 4,
      author: 'carol',
      created: '2026-10-09',
      ready: '2026-10-09T02:00',
      merged: '2026-10-09T04:00',
      lines: [30, 10],
    },
    [review('bob', '2026-10-09T01:00')],
  ),
  pullRequest({
    number: 5,
    author: 'dependabot',
    authorIsBot: true,
    created: '2026-10-05',
    merged: '2026-10-05T01:00',
  }),
];

const BASELINE: MergedPullRequest[] = [
  pullRequest({ number: 10, author: 'alice', created: '2026-09-20', merged: '2026-09-20T08:00' }, [
    review('carol', '2026-09-20T04:00'),
  ]),
  pullRequest({ number: 11, author: 'bob', created: '2026-09-21', merged: '2026-09-21T12:00' }, [
    review('carol', '2026-09-21T03:00'),
  ]),
];

function compute(pullRequests: MergedPullRequest[], baselineCovered = true) {
  return computeReviewFlow({
    repository: 'acme/widgets',
    period: PERIOD,
    baselineCovered,
    pullRequests,
    dataAsOf: NOW,
  });
}

describe('computeReviewFlow', () => {
  const insight = compute([...CURRENT, ...BASELINE]);
  const current = Object.fromEntries(
    Object.entries(insight.metrics).map(([key, metric]) => [key, metric.current]),
  );

  it('summarises the period with numbers that match the source data', () => {
    expect(current).toEqual({
      mergedPullRequests: 4,
      botPullRequests: 1,
      activeAuthors: 3,
      cycleTimeP50Hours: 17, // median of 4, 10, 24, 48
      cycleTimeP90Hours: 40.8,
      timeToFirstReviewP50Hours: 2, // median of 1, 2, 6
      timeToFirstReviewP90Hours: 5.2,
      firstReviewToMergeP50Hours: 8, // median of 3, 8, 14
      firstReviewWaitSharePct: 25, // median of 20%, 25%, 25%
      mergedWithoutReviewPct: 25, // #3 of 4
      prSizeP50Lines: 120, // median of 8, 40, 200, 1200
      reviewsSubmitted: 4,
      reviewsPerPullRequest: 1,
      activeReviewers: 2,
      topReviewerSharePct: 75, // bob: 3 of 4
      reviewersForHalfOfReviews: 1,
    });
  });

  it('ignores self-reviews, bot reviews and reviews submitted after the merge', () => {
    expect(insight.topReviewers).toEqual([
      {
        login: 'bob',
        reviews: 3,
        approvals: 2,
        changesRequested: 1,
        pullRequestsReviewed: 3,
        sharePct: 75,
      },
      {
        login: 'carol',
        reviews: 1,
        approvals: 1,
        changesRequested: 0,
        pullRequestsReviewed: 1,
        sharePct: 25,
      },
    ]);
  });

  it('keeps reviewer totals consistent with the headline review count', () => {
    const listed = insight.topReviewers.reduce((total, reviewer) => total + reviewer.reviews, 0);
    expect(listed).toBe(insight.metrics.reviewsSubmitted.current);
  });

  it('measures the wait for review from when a draft became ready', () => {
    const second = insight.slowestPullRequests.find((pr) => pr.number === 2);
    expect(second?.timeToFirstReviewHours).toBe(6);
  });

  it('falls back to creation time when the first review arrived during the draft', () => {
    const fourth = insight.slowestPullRequests.find((pr) => pr.number === 4);
    expect(fourth?.timeToFirstReviewHours).toBe(1);
  });

  it('compares against the baseline using the published, rounded values', () => {
    expect(insight.baselinePeriod).toEqual({ from: '2026-09-17', to: '2026-09-30', days: 14 });
    expect(insight.metrics.mergedPullRequests).toEqual({
      current: 4,
      baseline: 2,
      delta: 2,
      changePct: 100,
    });
    expect(insight.metrics.timeToFirstReviewP50Hours).toEqual({
      current: 2,
      baseline: 3.5,
      delta: -1.5,
      changePct: -42.9,
    });
  });

  it('reports no relative change against a zero baseline', () => {
    expect(insight.metrics.botPullRequests).toEqual({
      current: 1,
      baseline: 0,
      delta: 1,
      changePct: null,
    });
  });

  it('buckets merges into 7-day weeks starting at the period start', () => {
    expect(insight.weekly).toEqual([
      {
        start: '2026-10-01',
        days: 7,
        mergedPullRequests: 2,
        cycleTimeP50Hours: 17,
        timeToFirstReviewP50Hours: 4,
      },
      {
        start: '2026-10-08',
        days: 7,
        mergedPullRequests: 2,
        cycleTimeP50Hours: 26,
        timeToFirstReviewP50Hours: 1,
      },
    ]);
  });

  it('groups pull requests by size, leaving empty buckets visible', () => {
    expect(insight.sizeBuckets.map((b) => [b.label, b.pullRequests, b.cycleTimeP50Hours])).toEqual([
      ['XS', 1, 10],
      ['S', 1, 4],
      ['M', 1, 24],
      ['L', 0, null],
      ['XL', 1, 48],
    ]);
  });

  it('ranks authors by merged pull requests, breaking ties by login', () => {
    expect(insight.topAuthors).toEqual([
      { login: 'alice', mergedPullRequests: 2, linesChanged: 208, cycleTimeP50Hours: 17 },
      { login: 'bob', mergedPullRequests: 1, linesChanged: 1200, cycleTimeP50Hours: 48 },
      { login: 'carol', mergedPullRequests: 1, linesChanged: 40, cycleTimeP50Hours: 4 },
    ]);
  });

  it('lists the slowest pull requests first', () => {
    expect(insight.slowestPullRequests.map((pr) => pr.number)).toEqual([3, 2, 1, 4]);
    expect(insight.slowestPullRequests[0]).toEqual({
      number: 3,
      author: 'bob',
      cycleTimeHours: 48,
      timeToFirstReviewHours: null,
      sizeLines: 1200,
      reviews: 0,
    });
  });

  it('assigns a pull request merged exactly on a boundary to the later period', () => {
    const onStart = pullRequest({
      number: 20,
      author: 'dana',
      created: '2026-09-30',
      merged: '2026-10-01',
    });
    const onEnd = pullRequest({
      number: 21,
      author: 'dana',
      created: '2026-10-14',
      merged: '2026-10-15',
    });
    const metrics = compute([onStart, onEnd]).metrics;

    expect(metrics.mergedPullRequests.current).toBe(1);
    expect(metrics.mergedPullRequests.baseline).toBe(0);
  });

  it('omits the baseline when synced history does not cover it', () => {
    const uncovered = compute(CURRENT, false);

    expect(uncovered.baselinePeriod).toBeNull();
    expect(uncovered.metrics.cycleTimeP50Hours).toEqual({
      current: 17,
      baseline: null,
      delta: null,
      changePct: null,
    });
  });

  it('returns nulls rather than zeros for statistics of an empty period', () => {
    const empty = compute([]);

    expect(empty.metrics.mergedPullRequests.current).toBe(0);
    expect(empty.metrics.cycleTimeP50Hours.current).toBeNull();
    expect(empty.metrics.mergedWithoutReviewPct.current).toBeNull();
    expect(empty.metrics.reviewersForHalfOfReviews.current).toBeNull();
    expect(empty.topReviewers).toEqual([]);
    expect(empty.weekly.map((week) => week.mergedPullRequests)).toEqual([0, 0]);
  });

  it('marks a short final week', () => {
    const tenDays = computeReviewFlow({
      repository: 'acme/widgets',
      period: resolvePeriod({ from: '2026-10-01', to: '2026-10-10' }, NOW),
      baselineCovered: true,
      pullRequests: CURRENT,
      dataAsOf: NOW,
    });

    expect(tenDays.weekly.map((week) => [week.start, week.days])).toEqual([
      ['2026-10-01', 7],
      ['2026-10-08', 3],
    ]);
  });
});
