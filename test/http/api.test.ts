import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { MergedPullRequest, RepoRef } from '../../src/domain.js';
import { GitHubError, rateLimited } from '../../src/github/client.js';
import type { GitHubGateway, RepositoryInfo } from '../../src/github/gateway.js';
import { type NarrativeModel, NarrativeModelError } from '../../src/narrative/model.js';
import { NarrativeService } from '../../src/narrative/service.js';
import { type Db, openDatabase } from '../../src/store/database.js';
import { NarrativeCache } from '../../src/store/narratives.js';
import { PullRequestStore } from '../../src/store/pull-requests.js';
import { RepoStore } from '../../src/store/repos.js';
import { SyncService } from '../../src/sync/sync-service.js';
import {
  ScriptedModel,
  slowdownInsight,
  slowdownPullRequests,
  soundDraft,
} from '../narrative/fixtures.js';

const NOW = new Date('2026-11-11T00:00:00Z');
/** With the 60-day lookback used here, history is synced from this day on. */
const COVERED_FROM = '2026-09-12';
const WIDGETS = '/v1/repos/acme/widgets';
/** The period `slowdownInsight` describes. */
const SLOWDOWN = 'from=2026-10-15&to=2026-11-04';

/** GitHub as a set of repositories that all contain the same pull requests. */
class FakeGitHub implements GitHubGateway {
  readonly repositories = new Map<string, RepositoryInfo>();
  readonly pullRequests: MergedPullRequest[] = slowdownPullRequests();
  /** Thrown instead of answering a repository lookup. */
  lookupFailure: Error | null = null;
  /** Thrown instead of returning pull requests to a sync. */
  syncFailure: Error | null = null;
  /** Lets the syncs waiting after `hold()` proceed. */
  release: () => void = () => undefined;
  #gate: Promise<void> = Promise.resolve();

  add(owner: string, name: string, overrides: Partial<RepositoryInfo> = {}): void {
    const repository = { owner, name, isPrivate: false, defaultBranch: 'main', ...overrides };
    this.repositories.set(`${owner}/${name}`.toLowerCase(), repository);
  }

  /** Makes syncs wait until `release()` is called. */
  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async getRepository(ref: RepoRef): Promise<RepositoryInfo> {
    if (this.lookupFailure) throw this.lookupFailure;
    const repository = this.repositories.get(`${ref.owner}/${ref.name}`.toLowerCase());
    if (!repository) {
      throw new GitHubError('not_found', `Repository ${ref.owner}/${ref.name} was not found`);
    }
    return repository;
  }

  async *mergedPullRequestPages(): AsyncGenerator<MergedPullRequest[]> {
    await this.#gate;
    if (this.syncFailure) throw this.syncFailure;
    yield this.pullRequests;
  }
}

let db: Db;
let github: FakeGitHub;
let sync: SyncService;
let app: FastifyInstance;

/** Builds the real application over an in-memory database, with GitHub and the model faked. */
async function start(
  options: { model?: NarrativeModel | null; maxTrackedRepos?: number } = {},
): Promise<void> {
  const logger = pino({ level: 'silent' });
  const clock = () => NOW;
  db = openDatabase(':memory:');
  const repos = new RepoStore(db);
  const pullRequests = new PullRequestStore(db);
  github = new FakeGitHub();
  github.add('acme', 'widgets');
  sync = new SyncService({ github, repos, pullRequests, clock, logger, lookbackDays: 60 });
  app = await buildApp({
    repos,
    pullRequests,
    github,
    sync,
    narrative: new NarrativeService({
      model: options.model ?? null,
      cache: new NarrativeCache(db),
      clock,
      logger,
    }),
    clock,
    maxTrackedRepos: options.maxTrackedRepos ?? 5,
    allowPrivateRepos: false,
  });
}

beforeEach(() => start());

afterEach(async () => {
  await app.close();
  github.release();
  await sync.stop();
  if (db.open) db.close();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const put = (url: string) => app.inject({ method: 'PUT', url });

/** Tracks a repository and waits until its first sync has ended, one way or the other. */
async function track(url = WIDGETS): Promise<void> {
  await put(url);
  await vi.waitFor(async () => {
    expect((await get(url)).json().sync.state).toMatch(/succeeded|failed/);
  });
}

/** Asserts that the response is a problem document and returns it. */
function problem(
  response: Awaited<ReturnType<typeof get>>,
  status: number,
  code: string,
): { detail: string; errors?: { path: string; message: string }[] } {
  expect(response.statusCode).toBe(status);
  expect(response.headers['content-type']).toBe('application/problem+json; charset=utf-8');
  const body = response.json();
  expect(body).toMatchObject({ type: 'about:blank', status, code });
  expect(body.requestId).toBe(response.headers['x-request-id']);
  return body;
}

describe('tracking a repository', () => {
  it('verifies it on GitHub, answers at once and backfills in the background', async () => {
    github.hold();

    const created = await put(WIDGETS);

    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(WIDGETS);
    expect(created.json()).toEqual({
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      sync: {
        state: 'running',
        error: null,
        lastSyncedAt: null,
        coveredFrom: null,
        pullRequests: 0,
      },
      links: {
        self: WIDGETS,
        reviewFlow: `${WIDGETS}/insights/review-flow`,
        narrative: `${WIDGETS}/insights/review-flow/narrative`,
      },
    });

    github.release();
    await vi.waitFor(async () => {
      expect((await get(WIDGETS)).json().sync).toEqual({
        state: 'succeeded',
        error: null,
        lastSyncedAt: NOW.toISOString(),
        coveredFrom: COVERED_FROM,
        pullRequests: 42,
      });
    });
  });

  it('is idempotent: tracking again queues a refresh instead of a duplicate', async () => {
    await track();

    const again = await put(WIDGETS);

    expect(again.statusCode).toBe(200);
    expect((await get('/v1/repos')).json().repositories).toHaveLength(1);
  });

  it('stores the name as GitHub spells it, however the request spelt it', async () => {
    const created = await put('/v1/repos/ACME/Widgets');

    expect(created.json()).toMatchObject({ owner: 'acme', name: 'widgets' });
    expect(created.headers.location).toBe(WIDGETS);
    expect((await put(WIDGETS)).statusCode).toBe(200);
  });

  it('rejects a repository GitHub does not know', async () => {
    problem(await put('/v1/repos/acme/nothing'), 404, 'repository_not_found');
    expect((await get('/v1/repos')).json().repositories).toEqual([]);
  });

  it('refuses private repositories, because the API has no authentication', async () => {
    github.add('acme', 'secret', { isPrivate: true });

    problem(await put('/v1/repos/acme/secret'), 403, 'private_repository');
    expect((await get('/v1/repos/acme/secret')).statusCode).toBe(404);
  });

  it('rejects a repository without a default branch', async () => {
    github.add('acme', 'empty', { defaultBranch: null });

    problem(await put('/v1/repos/acme/empty'), 422, 'repository_empty');
  });

  it('stops at the configured number of repositories', async () => {
    await app.close();
    await start({ maxTrackedRepos: 1 });
    github.add('acme', 'gadgets');
    await put(WIDGETS);

    const refused = problem(await put('/v1/repos/acme/gadgets'), 409, 'repository_limit_reached');

    expect(refused.detail).toContain('at most 1');
    // Refreshing a repository that is already tracked still works at the limit.
    expect((await put(WIDGETS)).statusCode).toBe(200);
  });

  it('rejects names GitHub could not have issued, before asking GitHub', async () => {
    github.lookupFailure = new Error('GitHub must not be called');

    const rejected = problem(await put('/v1/repos/-acme/widgets'), 400, 'invalid_request');

    expect(rejected.errors).toEqual([
      { path: 'params/owner', message: 'Must be a GitHub user or organisation name' },
    ]);
    // An encoded slash stays inside the parameter, where the name rules reject it.
    problem(await put('/v1/repos/acme/widgets%2Fpulls'), 400, 'invalid_request');
  });

  it('reports GitHub being out of quota as a temporary condition', async () => {
    github.lookupFailure = rateLimited(new Date(Date.now() + 120_000));

    const response = await put(WIDGETS);

    problem(response, 503, 'github_rate_limited');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(100);
  });

  it('says what went wrong with GitHub, in words the server chose', async () => {
    github.lookupFailure = new GitHubError('unauthorized', 'GitHub rejected the configured token');

    const failed = problem(await put(WIDGETS), 502, 'github_unavailable');

    expect(failed.detail).toBe('GitHub rejected the configured token');
  });

  it('forgets a repository and everything stored for it on DELETE', async () => {
    await track();

    expect((await app.inject({ method: 'DELETE', url: WIDGETS })).statusCode).toBe(204);

    problem(await get(WIDGETS), 404, 'repository_not_tracked');
    problem(await get(`${WIDGETS}/insights/review-flow`), 404, 'repository_not_tracked');
    expect(db.prepare('SELECT COUNT(*) FROM pull_requests').pluck().get()).toBe(0);
    problem(await app.inject({ method: 'DELETE', url: WIDGETS }), 404, 'repository_not_tracked');
  });
});

describe('the review-flow insight', () => {
  it('is what the metric computes from the pull requests GitHub returned', async () => {
    await track();

    const response = await get(`${WIDGETS}/insights/review-flow?${SLOWDOWN}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(slowdownInsight());
  });

  it('covers the 30 days up to today unless told otherwise', async () => {
    await track();

    const insight = (await get(`${WIDGETS}/insights/review-flow`)).json();

    expect(insight.period).toEqual({ from: '2026-10-13', to: '2026-11-11', days: 30 });
    expect(insight.baselinePeriod).toEqual({ from: '2026-09-13', to: '2026-10-12', days: 30 });
  });

  it('reports no changes when the period before was not synced in full', async () => {
    await track();

    const insight = (
      await get(`${WIDGETS}/insights/review-flow?from=2026-09-20&to=2026-10-10`)
    ).json();

    expect(insight.baselinePeriod).toBeNull();
    expect(insight.metrics.mergedPullRequests).toEqual({
      current: 17,
      baseline: null,
      delta: null,
      changePct: null,
    });
  });

  it('lets clients revalidate with an ETag instead of downloading it again', async () => {
    await track();
    const url = `${WIDGETS}/insights/review-flow?${SLOWDOWN}`;
    const first = await get(url);

    const second = await get(url, { 'if-none-match': String(first.headers.etag) });

    expect(first.headers['cache-control']).toBe('no-cache');
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('answers 409 with a retry delay while the first sync is running', async () => {
    github.hold();
    await put(WIDGETS);

    const response = await get(`${WIDGETS}/insights/review-flow`);

    problem(response, 409, 'sync_in_progress');
    expect(response.headers['retry-after']).toBe('5');
  });

  it('says why when the first sync failed, and recovers when it is retried', async () => {
    github.syncFailure = new GitHubError('unavailable', 'GitHub responded with HTTP 502');
    await track();

    const failed = problem(await get(`${WIDGETS}/insights/review-flow`), 409, 'sync_failed');
    expect(failed.detail).toContain('GitHub responded with HTTP 502');

    github.syncFailure = null;
    await track();
    expect((await get(`${WIDGETS}/insights/review-flow`)).statusCode).toBe(200);
  });

  it('rejects periods that start before the synced history', async () => {
    await track();

    const rejected = problem(
      await get(`${WIDGETS}/insights/review-flow?from=2026-08-20&to=2026-09-15`),
      422,
      'period_not_covered',
    );

    expect(rejected.detail).toContain(COVERED_FROM);
  });

  it.each([
    ['from=2026-02-30', "'from' must be a calendar date formatted YYYY-MM-DD"],
    ['to=2026-11-12', "'to' must not be in the future"],
    ['from=2026-11-05&to=2026-11-01', "'from' must not be after 'to'"],
    ['from=2026-07-01&to=2026-11-01', 'The period must not exceed 90 days'],
  ])('rejects the period %s', async (query, detail) => {
    await track();

    const rejected = problem(
      await get(`${WIDGETS}/insights/review-flow?${query}`),
      400,
      'invalid_period',
    );

    expect(rejected.detail).toBe(detail);
  });

  it('rejects parameters it does not know rather than ignoring them', async () => {
    await track();

    problem(await get(`${WIDGETS}/insights/review-flow?form=2026-10-15`), 400, 'invalid_request');
  });
});

describe('the narrative', () => {
  const url = `${WIDGETS}/insights/review-flow/narrative?${SLOWDOWN}`;

  it('is written once per set of numbers and carries evidence the server resolved', async () => {
    const model = new ScriptedModel(soundDraft());
    await app.close();
    await start({ model });
    await track();

    const first = await get(url);
    const second = await get(url);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      repository: 'acme/widgets',
      period: { from: '2026-10-15', to: '2026-11-04', days: 21 },
      headline: soundDraft().headline,
      findings: [
        { evidence: [{ fact: 'metrics.cycleTimeP50Hours.delta', value: 18.5 }] },
        { evidence: [{ fact: 'metrics.timeToFirstReviewP50Hours.current', value: 26.5 }] },
        {
          evidence: [
            { fact: 'metrics.topReviewerSharePct.current', value: 100 },
            { fact: 'topReviewers[bob].reviews', value: 21 },
          ],
        },
      ],
      confidence: { score: 0.8, modelScore: 0.8, ceiling: 0.9 },
      verification: { status: 'verified', issues: [], attempts: 1 },
      model: 'test-model',
      cached: false,
    });
    expect(second.json()).toEqual({ ...first.json(), cached: true });
    expect(model.prompts).toHaveLength(1);
  });

  it('answers 503 without a model key, and leaves the insight available', async () => {
    await track();

    problem(await get(url), 503, 'narrative_not_configured');
    expect((await get(`${WIDGETS}/insights/review-flow?${SLOWDOWN}`)).statusCode).toBe(200);
  });

  it('answers 503 with a retry delay when the model provider is rate limiting', async () => {
    await app.close();
    await start({ model: new ScriptedModel(new NarrativeModelError('rate_limited', 'slow', 7)) });
    await track();

    const response = await get(url);

    problem(response, 503, 'narrative_unavailable');
    expect(response.headers['retry-after']).toBe('7');
  });

  it('answers 502 when the model returns nothing usable, without saying what', async () => {
    const refusal = new NarrativeModelError('refused', 'internal: prompt 4f2a was declined');
    await app.close();
    await start({ model: new ScriptedModel(refusal) });
    await track();

    const failed = problem(await get(url), 502, 'narrative_failed');

    expect(failed.detail).not.toContain('4f2a');
  });

  it('applies the same checks as the insight before it spends any tokens', async () => {
    const model = new ScriptedModel();
    await app.close();
    await start({ model });
    await track();

    problem(
      await get(`${WIDGETS}/insights/review-flow/narrative?from=2026-08-20&to=2026-09-15`),
      422,
      'period_not_covered',
    );
    expect(model.prompts).toEqual([]);
  });

  it('has a request budget of its own', async () => {
    const responses = [];
    for (let request = 0; request < 11; request += 1) responses.push(await get(url));

    expect(responses.slice(0, 10).map((response) => response.statusCode)).toEqual(
      Array(10).fill(404),
    );
    const limited = responses[10] as (typeof responses)[number];
    problem(limited, 429, 'rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('the application', () => {
  it('answers the liveness and readiness probes', async () => {
    expect((await get('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await get('/readyz')).json()).toEqual({ status: 'ready' });
  });

  it('is not ready when the database is gone', async () => {
    db.close();

    problem(await get('/readyz'), 503, 'not_ready');
    expect((await get('/healthz')).statusCode).toBe(200);
  });

  it('hides the cause of unexpected errors behind a request id', async () => {
    github.lookupFailure = new Error('connect ECONNREFUSED 10.0.0.7:5432');

    const failed = problem(await put(WIDGETS), 500, 'internal_error');

    expect(failed.detail).not.toContain('10.0.0.7');
  });

  it('issues its own request ids, ignoring any the client sends', async () => {
    const response = await get('/healthz', { 'x-request-id': 'forged' });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes with a problem document', async () => {
    problem(await get('/v1/nothing'), 404, 'not_found');
    problem(await app.inject({ method: 'POST', url: WIDGETS }), 404, 'not_found');
  });

  it('describes every route in an OpenAPI document', async () => {
    const document = (await get('/openapi.json')).json();

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).sort()).toEqual([
      '/healthz',
      '/readyz',
      '/v1/repos',
      '/v1/repos/{owner}/{name}',
      '/v1/repos/{owner}/{name}/insights/review-flow',
      '/v1/repos/{owner}/{name}/insights/review-flow/narrative',
    ]);
  });

  it('serves the UI under a policy that allows nothing but its own files', async () => {
    const page = await get('/');

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)|\bstyle=|<style/);
  });
});
