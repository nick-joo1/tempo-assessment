import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Clock } from '../domain.js';
import type { GitHubGateway } from '../github/gateway.js';
import { formatUtcDay } from '../insights/period.js';
import type { PullRequestStore } from '../store/pull-requests.js';
import type { RepoStore, TrackedRepo } from '../store/repos.js';
import type { SyncService } from '../sync/sync-service.js';
import { Problem, problemResponse } from './problem.js';

/**
 * GitHub's own naming rules. Owner and name only ever travel to GitHub as GraphQL
 * variables, so this is not what prevents injection; it rejects nonsense early and keeps
 * what is stored, logged and echoed back within a known alphabet.
 */
export const RepoParamsSchema = z.object({
  owner: z
    .string()
    .regex(/^[A-Za-z\d][A-Za-z\d_-]{0,38}$/, 'Must be a GitHub user or organisation name')
    .describe('GitHub user or organisation, e.g. `fastify`.'),
  name: z
    .string()
    .regex(/^(?!\.{1,2}$)[A-Za-z\d._-]{1,100}$/, 'Must be a GitHub repository name')
    .describe('Repository name, e.g. `fastify`.'),
});

const RepositorySchema = z.object({
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string().describe('Only pull requests merged into this branch are counted.'),
  sync: z.object({
    state: z
      .enum(['queued', 'running', 'succeeded', 'failed'])
      .describe('Outcome of the most recent sync with GitHub.'),
    error: z.string().nullable().describe('Why the most recent failed sync failed.'),
    lastSyncedAt: z.string().nullable(),
    coveredFrom: z
      .string()
      .nullable()
      .describe(
        'First day (UTC) of fully synced history. Null until the first sync completes; from then on insights are available for periods that start on or after it.',
      ),
    pullRequests: z.number().int().describe('Merged pull requests stored for this repository.'),
  }),
  links: z.object({ self: z.string(), reviewFlow: z.string(), narrative: z.string() }),
});

export interface RepoRoutesOptions {
  repos: RepoStore;
  pullRequests: PullRequestStore;
  github: GitHubGateway;
  sync: SyncService;
  clock: Clock;
  maxTrackedRepos: number;
  allowPrivateRepos: boolean;
}

export const repoRoutes: FastifyPluginAsyncZod<RepoRoutesOptions> = async (app, options) => {
  const { repos, pullRequests, github, sync } = options;

  const represent = (repo: TrackedRepo): z.infer<typeof RepositorySchema> => {
    const self = `/v1/repos/${repo.owner}/${repo.name}`;
    return {
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      sync: {
        state: repo.syncState,
        error: repo.syncError,
        lastSyncedAt: repo.lastSyncedAt === null ? null : new Date(repo.lastSyncedAt).toISOString(),
        coveredFrom: repo.syncedFrom === null ? null : formatUtcDay(repo.syncedFrom),
        pullRequests: pullRequests.count(repo.id),
      },
      links: {
        self,
        reviewFlow: `${self}/insights/review-flow`,
        narrative: `${self}/insights/review-flow/narrative`,
      },
    };
  };

  app.get(
    '/v1/repos',
    {
      schema: {
        tags: ['repositories'],
        summary: 'List tracked repositories',
        response: { 200: z.object({ repositories: z.array(RepositorySchema) }) },
      },
    },
    async () => ({ repositories: repos.list().map(represent) }),
  );

  app.put(
    '/v1/repos/:owner/:name',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['repositories'],
        summary: 'Track a repository and sync it now',
        description:
          'Idempotent. The first call verifies the repository on GitHub and starts backfilling its history in the background; poll the returned resource until `sync.coveredFrom` is set. Calling it again for a tracked repository queues a refresh.',
        params: RepoParamsSchema,
        response: {
          200: RepositorySchema.describe('Already tracked; a refresh was queued.'),
          201: RepositorySchema.describe('Now tracked; the first sync was queued.'),
          403: problemResponse('`private_repository`: private repositories are not accepted.'),
          404: problemResponse('`repository_not_found`: GitHub has no such public repository.'),
          409: problemResponse('`repository_limit_reached`.'),
          422: problemResponse('`repository_empty`: there is no default branch to analyse.'),
        },
      },
    },
    async (request, reply) => {
      const tracked = repos.find(request.params);
      if (tracked) {
        sync.enqueue(tracked.id);
        return represent(repos.get(tracked.id) ?? tracked);
      }
      if (repos.count() >= options.maxTrackedRepos) {
        throw new Problem(
          409,
          'repository_limit_reached',
          'Repository limit reached',
          `This server tracks at most ${options.maxTrackedRepos} repositories. Stop tracking one first.`,
        );
      }

      const found = await github.getRepository(request.params);
      if (found.isPrivate && !options.allowPrivateRepos) {
        throw new Problem(
          403,
          'private_repository',
          'Private repository',
          'This server only analyses public repositories.',
        );
      }
      if (found.defaultBranch === null) {
        throw new Problem(
          422,
          'repository_empty',
          'Repository is empty',
          'The repository has no default branch, so there are no merged pull requests to analyse.',
        );
      }

      // GitHub resolves names case-insensitively and follows renames, and another request
      // may have tracked the repository while this one was waiting: look again under the
      // canonical name before inserting.
      const canonical = { owner: found.owner, name: found.name };
      const existing = repos.find(canonical);
      const repo =
        existing ??
        repos.insert(
          { ...canonical, defaultBranch: found.defaultBranch },
          options.clock().getTime(),
        );
      sync.enqueue(repo.id);

      const body = represent(repos.get(repo.id) ?? repo);
      if (existing) return body;
      return reply.code(201).header('location', body.links.self).send(body);
    },
  );

  app.get(
    '/v1/repos/:owner/:name',
    {
      schema: {
        tags: ['repositories'],
        summary: 'Get a tracked repository and its sync status',
        params: RepoParamsSchema,
        response: { 200: RepositorySchema, 404: problemResponse('`repository_not_tracked`.') },
      },
    },
    async (request) => represent(requireTracked(repos, request.params)),
  );

  app.delete(
    '/v1/repos/:owner/:name',
    {
      schema: {
        tags: ['repositories'],
        summary: 'Stop tracking a repository and delete its data',
        params: RepoParamsSchema,
        response: {
          204: z.undefined().describe('No longer tracked.'),
          404: problemResponse('`repository_not_tracked`.'),
        },
      },
    },
    async (request, reply) => {
      repos.delete(requireTracked(repos, request.params).id);
      return reply.code(204).send();
    },
  );
};

export function requireTracked(
  repos: RepoStore,
  ref: z.infer<typeof RepoParamsSchema>,
): TrackedRepo {
  const repo = repos.find(ref);
  if (!repo) {
    throw new Problem(
      404,
      'repository_not_tracked',
      'Repository not tracked',
      `${ref.owner}/${ref.name} is not tracked. Send PUT /v1/repos/${ref.owner}/${ref.name} to start tracking it.`,
    );
  }
  return repo;
}
