import type { MergedPullRequest, Review } from '../domain.js';
import { DAY_MS, formatUtcDay, type ResolvedPeriod } from './period.js';
import {
  type FlowSummary,
  METRIC_KEYS,
  type MetricComparison,
  type MetricKey,
  type ReviewFlowInsight,
} from './schema.js';
import { percentage, quantile, round1 } from './stats.js';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;
const LEADERBOARD_SIZE = 10;
const SLOWEST_SIZE = 5;

const SIZE_BUCKETS = [
  { label: 'XS', minLines: 0, maxLines: 9 },
  { label: 'S', minLines: 10, maxLines: 99 },
  { label: 'M', minLines: 100, maxLines: 499 },
  { label: 'L', minLines: 500, maxLines: 999 },
  { label: 'XL', minLines: 1000, maxLines: null },
] as const;

export interface ReviewFlowInput {
  repository: string;
  period: ResolvedPeriod;
  /** Whether synced history reaches back far enough to cover the baseline period. */
  baselineCovered: boolean;
  /** Pull requests merged between the start of the baseline (or period) and the period end. */
  pullRequests: readonly MergedPullRequest[];
  dataAsOf: Date;
}

/** A human-authored merged pull request reduced to the timings the metric is built from. */
interface PullRequestFlow {
  number: number;
  author: string;
  mergedAt: number;
  sizeLines: number;
  cycleHours: number;
  /** Null when no other human reviewed the pull request before it merged. */
  waitForReviewHours: number | null;
  reviewToMergeHours: number | null;
  /** Reviews that count: by a human other than the author, submitted before the merge. */
  reviews: Review[];
}

interface Cohort {
  flows: PullRequestFlow[];
  botPullRequests: number;
}

export function computeReviewFlow(input: ReviewFlowInput): ReviewFlowInsight {
  const { period, pullRequests, baselineCovered } = input;
  const current = selectCohort(pullRequests, period.startMs, period.endMs);
  const baseline = baselineCovered
    ? selectCohort(pullRequests, period.baselineStartMs, period.startMs)
    : null;

  return {
    repository: input.repository,
    period: period.current,
    baselinePeriod: baselineCovered ? period.baseline : null,
    dataAsOf: input.dataAsOf.toISOString(),
    metrics: compare(summarize(current), baseline && summarize(baseline)),
    weekly: weeklyTrend(current.flows, period),
    sizeBuckets: groupBySize(current.flows),
    topReviewers: rankReviewers(current.flows),
    topAuthors: rankAuthors(current.flows),
    slowestPullRequests: slowest(current.flows),
  };
}

function selectCohort(
  pullRequests: readonly MergedPullRequest[],
  startMs: number,
  endMs: number,
): Cohort {
  const cohort: Cohort = { flows: [], botPullRequests: 0 };
  for (const pr of pullRequests) {
    if (pr.mergedAt < startMs || pr.mergedAt >= endMs) continue;
    if (pr.authorIsBot) cohort.botPullRequests += 1;
    else cohort.flows.push(toFlow(pr));
  }
  return cohort;
}

function toFlow(pr: MergedPullRequest): PullRequestFlow {
  // GitHub records an author's replies in review threads as COMMENTED reviews by the author,
  // and people keep commenting after a merge; neither is a review that gated this merge.
  const reviews = pr.reviews.filter(
    (review) =>
      !review.reviewerIsBot && review.reviewer !== pr.author && review.submittedAt <= pr.mergedAt,
  );
  const firstReviewAt = reviews.reduce<number | null>(
    (earliest, review) =>
      earliest === null || review.submittedAt < earliest ? review.submittedAt : earliest,
    null,
  );
  // Time spent in draft is not time spent waiting for a reviewer. A review that arrived while
  // the PR was still a draft shows nobody was waiting on the draft status, so creation counts.
  const reviewableAt =
    pr.readyAt !== null && (firstReviewAt === null || pr.readyAt <= firstReviewAt)
      ? pr.readyAt
      : pr.createdAt;

  return {
    number: pr.number,
    author: pr.author,
    mergedAt: pr.mergedAt,
    sizeLines: pr.additions + pr.deletions,
    cycleHours: (pr.mergedAt - pr.createdAt) / HOUR_MS,
    waitForReviewHours: firstReviewAt === null ? null : (firstReviewAt - reviewableAt) / HOUR_MS,
    reviewToMergeHours: firstReviewAt === null ? null : (pr.mergedAt - firstReviewAt) / HOUR_MS,
    reviews,
  };
}

const present = (value: number | null): value is number => value !== null;
const cycleHoursOf = (flows: readonly PullRequestFlow[]) => flows.map((flow) => flow.cycleHours);
const waitHoursOf = (flows: readonly PullRequestFlow[]) =>
  flows.map((flow) => flow.waitForReviewHours).filter(present);

function summarize({ flows, botPullRequests }: Cohort): FlowSummary {
  const reviewsByReviewer = new Map<string, number>();
  for (const flow of flows) {
    for (const review of flow.reviews) {
      reviewsByReviewer.set(review.reviewer, (reviewsByReviewer.get(review.reviewer) ?? 0) + 1);
    }
  }
  const reviewCounts = [...reviewsByReviewer.values()].sort((a, b) => b - a);
  const reviewsSubmitted = reviewCounts.reduce((total, count) => total + count, 0);
  const reviewed = flows.filter((flow) => flow.waitForReviewHours !== null);
  const waitShares = reviewed
    .filter((flow) => flow.cycleHours > 0)
    .map((flow) => ((flow.waitForReviewHours as number) / flow.cycleHours) * 100);

  return {
    mergedPullRequests: flows.length,
    botPullRequests,
    activeAuthors: new Set(flows.map((flow) => flow.author)).size,
    cycleTimeP50Hours: quantile(cycleHoursOf(flows), 0.5),
    cycleTimeP90Hours: quantile(cycleHoursOf(flows), 0.9),
    timeToFirstReviewP50Hours: quantile(waitHoursOf(flows), 0.5),
    timeToFirstReviewP90Hours: quantile(waitHoursOf(flows), 0.9),
    firstReviewToMergeP50Hours: quantile(
      flows.map((flow) => flow.reviewToMergeHours).filter(present),
      0.5,
    ),
    firstReviewWaitSharePct: quantile(waitShares, 0.5),
    mergedWithoutReviewPct: percentage(flows.length - reviewed.length, flows.length),
    prSizeP50Lines: quantile(
      flows.map((flow) => flow.sizeLines),
      0.5,
    ),
    reviewsSubmitted,
    reviewsPerPullRequest: flows.length === 0 ? null : round1(reviewsSubmitted / flows.length),
    activeReviewers: reviewCounts.length,
    topReviewerSharePct: percentage(reviewCounts[0] ?? 0, reviewsSubmitted),
    reviewersForHalfOfReviews: reviewersCovering(reviewCounts, reviewsSubmitted / 2),
  };
}

/** How many of the busiest reviewers it takes to reach `target` reviews. */
function reviewersCovering(countsDescending: readonly number[], target: number): number | null {
  if (countsDescending.length === 0) return null;
  let covered = 0;
  let reviewers = 0;
  for (const count of countsDescending) {
    covered += count;
    reviewers += 1;
    if (covered >= target) break;
  }
  return reviewers;
}

/**
 * Deltas are derived from the rounded values that are published, so a reader who subtracts
 * `baseline` from `current` gets exactly `delta`.
 */
function compare(
  current: FlowSummary,
  baseline: FlowSummary | null,
): Record<MetricKey, MetricComparison> {
  const comparison = {} as Record<MetricKey, MetricComparison>;
  for (const key of METRIC_KEYS) {
    const now = current[key];
    const before = baseline?.[key] ?? null;
    const delta = now !== null && before !== null ? round1(now - before) : null;
    comparison[key] = {
      current: now,
      baseline: before,
      delta,
      changePct: delta !== null && before ? round1((delta / before) * 100) : null,
    };
  }
  return comparison;
}

function weeklyTrend(
  flows: readonly PullRequestFlow[],
  period: ResolvedPeriod,
): ReviewFlowInsight['weekly'] {
  const buckets: PullRequestFlow[][] = Array.from(
    { length: Math.ceil(period.current.days / 7) },
    () => [],
  );
  for (const flow of flows) {
    buckets[Math.floor((flow.mergedAt - period.startMs) / WEEK_MS)]?.push(flow);
  }
  return buckets.map((bucket, index) => {
    const start = period.startMs + index * WEEK_MS;
    return {
      start: formatUtcDay(start),
      days: Math.min(7, (period.endMs - start) / DAY_MS),
      mergedPullRequests: bucket.length,
      cycleTimeP50Hours: quantile(cycleHoursOf(bucket), 0.5),
      timeToFirstReviewP50Hours: quantile(waitHoursOf(bucket), 0.5),
    };
  });
}

function groupBySize(flows: readonly PullRequestFlow[]): ReviewFlowInsight['sizeBuckets'] {
  return SIZE_BUCKETS.map((bucket) => {
    const members = flows.filter(
      (flow) =>
        flow.sizeLines >= bucket.minLines &&
        (bucket.maxLines === null || flow.sizeLines <= bucket.maxLines),
    );
    return {
      ...bucket,
      pullRequests: members.length,
      cycleTimeP50Hours: quantile(cycleHoursOf(members), 0.5),
      timeToFirstReviewP50Hours: quantile(waitHoursOf(members), 0.5),
    };
  });
}

function rankReviewers(flows: readonly PullRequestFlow[]): ReviewFlowInsight['topReviewers'] {
  const byReviewer = new Map<
    string,
    { reviews: number; approvals: number; changesRequested: number; pullRequests: Set<number> }
  >();
  let total = 0;
  for (const flow of flows) {
    for (const review of flow.reviews) {
      let tally = byReviewer.get(review.reviewer);
      if (!tally) {
        tally = { reviews: 0, approvals: 0, changesRequested: 0, pullRequests: new Set() };
        byReviewer.set(review.reviewer, tally);
      }
      total += 1;
      tally.reviews += 1;
      if (review.state === 'APPROVED') tally.approvals += 1;
      if (review.state === 'CHANGES_REQUESTED') tally.changesRequested += 1;
      tally.pullRequests.add(flow.number);
    }
  }
  return [...byReviewer]
    .map(([login, tally]) => ({
      login,
      reviews: tally.reviews,
      approvals: tally.approvals,
      changesRequested: tally.changesRequested,
      pullRequestsReviewed: tally.pullRequests.size,
      sharePct: percentage(tally.reviews, total),
    }))
    .sort((a, b) => b.reviews - a.reviews || a.login.localeCompare(b.login))
    .slice(0, LEADERBOARD_SIZE);
}

function rankAuthors(flows: readonly PullRequestFlow[]): ReviewFlowInsight['topAuthors'] {
  const byAuthor = new Map<string, PullRequestFlow[]>();
  for (const flow of flows) {
    const authored = byAuthor.get(flow.author);
    if (authored) authored.push(flow);
    else byAuthor.set(flow.author, [flow]);
  }
  return [...byAuthor]
    .map(([login, authored]) => ({
      login,
      mergedPullRequests: authored.length,
      linesChanged: authored.reduce((total, flow) => total + flow.sizeLines, 0),
      cycleTimeP50Hours: quantile(cycleHoursOf(authored), 0.5),
    }))
    .sort((a, b) => b.mergedPullRequests - a.mergedPullRequests || a.login.localeCompare(b.login))
    .slice(0, LEADERBOARD_SIZE);
}

function slowest(flows: readonly PullRequestFlow[]): ReviewFlowInsight['slowestPullRequests'] {
  return [...flows]
    .sort((a, b) => b.cycleHours - a.cycleHours || a.number - b.number)
    .slice(0, SLOWEST_SIZE)
    .map((flow) => ({
      number: flow.number,
      author: flow.author,
      cycleTimeHours: round1(flow.cycleHours),
      timeToFirstReviewHours:
        flow.waitForReviewHours === null ? null : round1(flow.waitForReviewHours),
      sizeLines: flow.sizeLines,
      reviews: flow.reviews.length,
    }));
}
