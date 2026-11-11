import { z } from 'zod';

/**
 * The review-flow metrics and what each one means. This is the single source of truth:
 * the same text documents the OpenAPI schema and is given to the LLM as its glossary, so
 * the model reasons from the definitions the API actually implements.
 */
export const METRIC_DEFINITIONS = {
  mergedPullRequests:
    'Pull requests by human authors merged into the default branch during the period.',
  botPullRequests:
    'Merged pull requests authored by bots such as dependency updaters. Counted here and excluded from every other metric.',
  activeAuthors: 'Distinct human authors with at least one merged pull request.',
  cycleTimeP50Hours: 'Median hours from pull request creation to merge.',
  cycleTimeP90Hours: '90th-percentile hours from creation to merge: the slow tail.',
  timeToFirstReviewP50Hours:
    'Median hours a pull request waited for its first review by another human, counted from when it became reviewable (creation, or leaving draft). Only reviewed pull requests count.',
  timeToFirstReviewP90Hours: '90th-percentile wait for the first review, in hours.',
  firstReviewToMergeP50Hours:
    'Median hours from the first review to merge: time spent iterating and getting approval.',
  firstReviewWaitSharePct:
    'For the median reviewed pull request, the percentage of its cycle time spent waiting for the first review.',
  mergedWithoutReviewPct:
    'Percentage of merged pull requests that no other human reviewed before the merge.',
  prSizeP50Lines: 'Median pull request size in changed lines (additions plus deletions).',
  reviewsSubmitted:
    'Reviews submitted before merge by humans other than the author: approvals, change requests and review comments.',
  reviewsPerPullRequest: 'Average number of reviews per merged pull request.',
  activeReviewers: 'Distinct humans who submitted at least one review.',
  topReviewerSharePct: 'Percentage of all reviews submitted by the single most active reviewer.',
  reviewersForHalfOfReviews:
    'Smallest number of reviewers who together submitted at least half of all reviews. A low number means review capacity is concentrated in few people.',
} as const;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;
export const METRIC_KEYS = Object.keys(METRIC_DEFINITIONS) as MetricKey[];

/** One metric's values for a single cohort. Null means the sample was empty. */
export type FlowSummary = Record<MetricKey, number | null>;

const MetricComparisonSchema = z.object({
  current: z.number().nullable().describe('Value for the requested period.'),
  baseline: z.number().nullable().describe('Value for the preceding period of equal length.'),
  delta: z
    .number()
    .nullable()
    .describe('current - baseline, in the metric’s own unit (percentage points for Pct metrics).'),
  changePct: z
    .number()
    .nullable()
    .describe('Relative change against the baseline, in percent. Null when the baseline is 0.'),
});
export type MetricComparison = z.infer<typeof MetricComparisonSchema>;

const MetricsSchema = z.object(
  Object.fromEntries(
    METRIC_KEYS.map((key) => [key, MetricComparisonSchema.describe(METRIC_DEFINITIONS[key])]),
  ) as Record<MetricKey, typeof MetricComparisonSchema>,
);

export const PeriodSchema = z.object({
  from: z.string().describe('First day, inclusive (UTC, YYYY-MM-DD).'),
  to: z.string().describe('Last day, inclusive (UTC, YYYY-MM-DD).'),
  days: z.number().int(),
});

const hours = z.number().nullable();

export const ReviewFlowInsightSchema = z.object({
  repository: z.string(),
  period: PeriodSchema,
  baselinePeriod: PeriodSchema.nullable().describe(
    'The equally long period immediately before `period`. Null when it predates the synced history.',
  ),
  dataAsOf: z.string().describe('When the underlying data was last synced from GitHub.'),
  metrics: MetricsSchema,
  weekly: z
    .array(
      z.object({
        start: z.string().describe('First day of the bucket (UTC, YYYY-MM-DD).'),
        days: z.number().int().describe('Bucket length; the last bucket of a period may be short.'),
        mergedPullRequests: z.number().int(),
        cycleTimeP50Hours: hours,
        timeToFirstReviewP50Hours: hours,
      }),
    )
    .describe('The period split into 7-day buckets, by merge date, starting at `period.from`.'),
  sizeBuckets: z
    .array(
      z.object({
        label: z.enum(['XS', 'S', 'M', 'L', 'XL']),
        minLines: z.number().int(),
        maxLines: z.number().int().nullable().describe('Inclusive upper bound; null means open.'),
        pullRequests: z.number().int(),
        cycleTimeP50Hours: hours,
        timeToFirstReviewP50Hours: hours,
      }),
    )
    .describe('Merged pull requests grouped by changed lines, to show how size relates to speed.'),
  topReviewers: z.array(
    z.object({
      login: z.string(),
      reviews: z.number().int(),
      approvals: z.number().int(),
      changesRequested: z.number().int(),
      pullRequestsReviewed: z.number().int(),
      sharePct: z.number().nullable().describe('Share of all reviews in the period.'),
    }),
  ),
  topAuthors: z.array(
    z.object({
      login: z.string(),
      mergedPullRequests: z.number().int(),
      linesChanged: z.number().int(),
      cycleTimeP50Hours: hours,
    }),
  ),
  slowestPullRequests: z.array(
    z.object({
      number: z.number().int(),
      author: z.string(),
      cycleTimeHours: z.number(),
      timeToFirstReviewHours: hours,
      sizeLines: z.number().int(),
      reviews: z.number().int(),
    }),
  ),
});

export type ReviewFlowInsight = z.infer<typeof ReviewFlowInsightSchema>;
