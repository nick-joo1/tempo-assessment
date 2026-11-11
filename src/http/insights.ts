import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Clock } from '../domain.js';
import { formatUtcDay, MAX_PERIOD_DAYS, resolvePeriod } from '../insights/period.js';
import { computeReviewFlow } from '../insights/review-flow.js';
import { type ReviewFlowInsight, ReviewFlowInsightSchema } from '../insights/schema.js';
import { NarrativeSchema } from '../narrative/schema.js';
import type { NarrativeService } from '../narrative/service.js';
import type { PullRequestStore } from '../store/pull-requests.js';
import type { RepoStore, TrackedRepo } from '../store/repos.js';
import { Problem, problemResponse } from './problem.js';
import { RepoParamsSchema, requireTracked } from './repos.js';

/** Strict, so that a misspelt parameter is an error rather than a silently applied default. */
const PeriodQuerySchema = z.strictObject({
  from: z
    .string()
    .optional()
    .describe(
      `First day of the period, inclusive (UTC, YYYY-MM-DD). Defaults to 30 days ending at \`to\`. A period spans at most ${MAX_PERIOD_DAYS} days.`,
    ),
  to: z
    .string()
    .optional()
    .describe('Last day of the period, inclusive (UTC, YYYY-MM-DD). Defaults to today.'),
});

const insightProblems = {
  400: problemResponse('`invalid_request` or `invalid_period`.'),
  404: problemResponse('`repository_not_tracked`.'),
  409: problemResponse(
    '`sync_in_progress`: the first sync is still running, retry after the `Retry-After` delay. `sync_failed`: the first sync failed.',
  ),
  422: problemResponse('`period_not_covered`: the period starts before the synced history.'),
};

export interface InsightRoutesOptions {
  repos: RepoStore;
  pullRequests: PullRequestStore;
  narrative: NarrativeService;
  clock: Clock;
}

export const insightRoutes: FastifyPluginAsyncZod<InsightRoutesOptions> = async (app, options) => {
  const { repos, pullRequests, narrative, clock } = options;

  /**
   * Computes the insight from what is already stored. Nothing here talks to GitHub: a
   * request costs two indexed range reads, however busy the repository is upstream.
   */
  const reviewFlow = (
    params: z.infer<typeof RepoParamsSchema>,
    query: z.infer<typeof PeriodQuerySchema>,
  ): { repo: TrackedRepo; insight: ReviewFlowInsight } => {
    const repo = requireTracked(repos, params);
    const repository = `${repo.owner}/${repo.name}`;
    const period = resolvePeriod(query, clock());

    if (repo.syncedFrom === null || repo.lastSyncedAt === null) {
      if (repo.syncState === 'failed') {
        throw new Problem(
          409,
          'sync_failed',
          'First sync failed',
          `The first sync of ${repository} failed: ${repo.syncError ?? 'unknown error'}. Send PUT /v1/repos/${repository} to retry.`,
        );
      }
      throw new Problem(
        409,
        'sync_in_progress',
        'First sync in progress',
        `The history of ${repository} is still being fetched from GitHub. Poll GET /v1/repos/${repository} until sync.coveredFrom is set.`,
        { headers: { 'retry-after': '5' } },
      );
    }
    if (period.startMs < repo.syncedFrom) {
      throw new Problem(
        422,
        'period_not_covered',
        'Period not covered',
        `Synced history of ${repository} starts on ${formatUtcDay(repo.syncedFrom)}. Choose a period that starts on or after that day.`,
      );
    }

    // Changes can only be reported when the preceding period was synced in full as well.
    const baselineCovered = period.baselineStartMs >= repo.syncedFrom;
    const insight = computeReviewFlow({
      repository,
      period,
      baselineCovered,
      pullRequests: pullRequests.mergedBetween(
        repo.id,
        baselineCovered ? period.baselineStartMs : period.startMs,
        period.endMs,
      ),
      dataAsOf: new Date(repo.lastSyncedAt),
    });
    return { repo, insight };
  };

  app.get(
    '/v1/repos/:owner/:name/insights/review-flow',
    {
      schema: {
        tags: ['insights'],
        summary: 'Review flow: how pull requests moved from creation to merge',
        description:
          'Where the time between opening and merging a pull request went during the period, who carried the review load, and how both compare with the equally long period before it. Pull requests by bots are excluded, as are self-reviews, bot reviews and reviews submitted after the merge.',
        params: RepoParamsSchema,
        querystring: PeriodQuerySchema,
        response: { 200: ReviewFlowInsightSchema, ...insightProblems },
      },
    },
    async (request) => reviewFlow(request.params, request.query).insight,
  );

  app.get(
    '/v1/repos/:owner/:name/insights/review-flow/narrative',
    {
      // Each uncached call spends model tokens, so this route gets a budget of its own.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['insights'],
        summary: 'An LLM narrative over the review-flow numbers',
        description:
          'What is interesting or unusual in the review-flow insight for the same period, with a root-cause hypothesis when the signal supports one. Every finding carries the facts it rests on, resolved by the server from the insight; `verification` reports whether every number in the text could be traced to them. Narratives are cached until the underlying numbers change.',
        params: RepoParamsSchema,
        querystring: PeriodQuerySchema,
        response: {
          200: NarrativeSchema,
          ...insightProblems,
          502: problemResponse('`narrative_failed`: the model returned nothing usable.'),
          503: problemResponse(
            '`narrative_unavailable`: the model provider is unreachable or rate limiting. `narrative_not_configured`: the server has no model API key.',
          ),
        },
      },
    },
    async (request) => {
      const { repo, insight } = reviewFlow(request.params, request.query);
      return narrative.narrate(repo.id, insight);
    },
  );
};
