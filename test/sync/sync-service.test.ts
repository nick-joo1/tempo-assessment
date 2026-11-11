import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergedPullRequest } from '../../src/domain.js';
import { GitHubError, rateLimited } from '../../src/github/client.js';
import type { GitHubGateway } from '../../src/github/gateway.js';
import { openDatabase } from '../../src/store/database.js';
import { PullRequestStore } from '../../src/store/pull-requests.js';
import { RepoStore, type TrackedRepo } from '../../src/store/repos.js';
import { SyncService } from '../../src/sync/sync-service.js';
import { at, pullRequest } from '../helpers.js';

const NOW = '2026-11-11T12:00:00Z';
/** With a 30-day lookback, history is synced from this day (UTC) on. */
const WINDOW_START = at('2026-10-12');

/** A pull request merged, and last updated, at the given time. */
function merged(number: number, when: string, updated = when): MergedPullRequest {
  return {
    ...pullRequest({ number, author: 'alice', created: '2026-09-01', merged: when }),
    updatedAt: at(updated),
  };
}

/** GitHub as a list of steps: a page to hand over, an error to fail with, or a side effect. */
class ScriptedGitHub implements GitHubGateway {
  script: (MergedPullRequest[] | Error | (() => void))[] = [];
  readonly pagesServed: number[] = [];
  readonly syncsStarted: string[] = [];

  async getRepository(): Promise<never> {
    throw new Error('not used by the sync service');
  }

  async *mergedPullRequestPages(ref: { name: string }): AsyncGenerator<MergedPullRequest[]> {
    this.syncsStarted.push(ref.name);
    let served = 0;
    for (const step of this.script) {
      if (step instanceof Error) throw step;
      if (typeof step === 'function') {
        step();
        continue;
      }
      served += 1;
      this.pagesServed.push(served);
      yield step;
    }
  }
}

let github: ScriptedGitHub;
let repos: RepoStore;
let pullRequests: PullRequestStore;
let sync: SyncService;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW) });
  const db = openDatabase(':memory:');
  github = new ScriptedGitHub();
  repos = new RepoStore(db);
  pullRequests = new PullRequestStore(db);
  sync = new SyncService({
    github,
    repos,
    pullRequests,
    clock: () => new Date(),
    logger: pino({ level: 'silent' }),
    lookbackDays: 30,
  });
});

afterEach(async () => {
  await sync.stop();
  vi.useRealTimers();
});

function track(name = 'widgets'): TrackedRepo {
  return repos.insert({ owner: 'acme', name, defaultBranch: 'main' }, Date.now());
}

async function syncNow(repo: TrackedRepo): Promise<TrackedRepo> {
  sync.enqueue(repo.id);
  return settled(repo);
}

/** Waits for the queue to drain and returns the repository as stored afterwards. */
async function settled(repo: TrackedRepo): Promise<TrackedRepo> {
  await vi.waitFor(() => {
    const state = repos.get(repo.id)?.syncState;
    expect(state === 'succeeded' || state === 'failed').toBe(true);
  });
  return repos.get(repo.id) as TrackedRepo;
}

function storedNumbers(repo: TrackedRepo): number[] {
  return pullRequests
    .mergedBetween(repo.id, 0, Number.MAX_SAFE_INTEGER)
    .map((pr) => pr.number)
    .sort((a, b) => a - b);
}

describe('first sync', () => {
  it('backfills the lookback window and stops paging once it is past it', async () => {
    const repo = track();
    github.script = [
      [merged(5, '2026-11-10'), merged(4, '2026-11-01')],
      // #2 merged before the window but was commented on recently: seen, not stored.
      [merged(3, '2026-10-12'), merged(2, '2026-10-01', '2026-10-20')],
      [merged(1, '2026-10-11')],
      [merged(0, '2026-09-01')],
    ];

    const synced = await syncNow(repo);

    expect(storedNumbers(repo)).toEqual([3, 4, 5]);
    expect(github.pagesServed).toEqual([1, 2, 3]);
    expect(synced).toMatchObject({
      syncState: 'succeeded',
      syncError: null,
      syncedFrom: WINDOW_START,
      syncCursor: at('2026-11-10'),
    });
    // Waiting for the sync advances the fake clock in small steps, hence not an equality.
    expect(synced.lastSyncedAt).toBeGreaterThanOrEqual(Date.parse(NOW));
    expect(synced.lastSyncedAt).toBeLessThan(Date.parse(NOW) + 60_000);
  });

  it('succeeds for a repository without merged pull requests', async () => {
    const synced = await syncNow(track());

    expect(synced).toMatchObject({ syncState: 'succeeded', syncedFrom: WINDOW_START });
  });
});

describe('later syncs', () => {
  it('fetch only what changed since the previous one', async () => {
    const repo = track();
    github.script = [[merged(2, '2026-11-10'), merged(1, '2026-11-01'), merged(0, '2026-10-20')]];
    await syncNow(repo);

    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    github.pagesServed.length = 0;
    github.script = [
      // #3 is new; #1 received a late review, which bumps its update time.
      [merged(3, '2026-11-12'), { ...merged(1, '2026-11-01', '2026-11-11T15:00'), additions: 77 }],
      // #0 has not changed since the previous sync: everything after it is known.
      [merged(2, '2026-11-10'), merged(0, '2026-10-20')],
      [merged(9, '2026-10-15')],
    ];
    const synced = await syncNow(repo);

    expect(storedNumbers(repo)).toEqual([0, 1, 2, 3]);
    expect(github.pagesServed).toEqual([1, 2]);
    expect(
      pullRequests.mergedBetween(repo.id, at('2026-11-01'), at('2026-11-02'))[0]?.additions,
    ).toBe(77);
    // The window keeps its start: it only ever grows forward.
    expect(synced).toMatchObject({ syncedFrom: WINDOW_START, syncCursor: at('2026-11-12') });
  });

  it('re-read a short overlap before the cursor to absorb listing lag', async () => {
    const repo = track();
    github.script = [[merged(1, '2026-11-10T10:00')]];
    await syncNow(repo);

    // Updated five minutes before the cursor, but not yet listed during the first sync.
    github.script = [[merged(1, '2026-11-10T10:00'), merged(2, '2026-11-10T09:55')]];
    await syncNow(repo);

    expect(storedNumbers(repo)).toEqual([1, 2]);
  });
});

describe('failures', () => {
  it('record the reason and leave the repository without history until a sync succeeds', async () => {
    const repo = track();
    github.script = [
      [merged(1, '2026-11-10')],
      new GitHubError('unavailable', 'GitHub responded with HTTP 502'),
    ];

    const failed = await syncNow(repo);
    expect(failed).toMatchObject({
      syncState: 'failed',
      syncError: 'GitHub responded with HTTP 502',
      syncedFrom: null,
    });

    github.script = [[merged(1, '2026-11-10')]];
    expect(await syncNow(repo)).toMatchObject({ syncState: 'succeeded', syncError: null });
  });

  it('do not expose the text of unexpected errors', async () => {
    const repo = track();
    github.script = [new Error('SQLITE_FULL: /var/lib/secret/path')];

    expect((await syncNow(repo)).syncError).toBe('Unexpected error while syncing');
  });

  it('pause the whole queue on a rate limit and resume when it resets', async () => {
    const limited = track('widgets');
    const waiting = track('gadgets');
    const retryAt = new Date(Date.now() + 10 * 60_000);
    github.script = [[merged(1, '2026-11-10')], rateLimited(retryAt)];

    sync.enqueue(limited.id);
    sync.enqueue(waiting.id);
    await vi.waitFor(() => expect(repos.get(limited.id)?.syncError).toContain('retrying after'));

    // Queued again rather than left failed, and nothing else was attempted meanwhile.
    expect(repos.get(limited.id)).toMatchObject({ syncState: 'queued', syncedFrom: null });
    expect(repos.get(waiting.id)?.syncState).toBe('queued');
    expect(github.syncsStarted).toEqual(['widgets']);

    github.script = [[merged(1, '2026-11-10')]];
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(await settled(limited)).toMatchObject({ syncState: 'succeeded', syncError: null });
    expect(await settled(waiting)).toMatchObject({ syncState: 'succeeded' });
    expect(github.syncsStarted).toEqual(['widgets', 'gadgets', 'widgets']);
  });
});

describe('scheduling', () => {
  it('syncs every tracked repository on start and again at each interval', async () => {
    const first = track('widgets');
    const second = track('gadgets');

    sync.start(15);
    await settled(first);
    await settled(second);
    expect(github.syncsStarted.sort()).toEqual(['gadgets', 'widgets']);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(() => expect(github.syncsStarted).toHaveLength(4));
  });

  it('collapses repeated requests for a repository that is still waiting', async () => {
    const running = track('widgets');
    const waiting = track('gadgets');

    sync.enqueue(running.id);
    sync.enqueue(waiting.id);
    sync.enqueue(waiting.id);
    await settled(running);
    await settled(waiting);

    expect(github.syncsStarted).toEqual(['widgets', 'gadgets']);
  });

  it('abandons a sync whose repository was untracked meanwhile, and carries on', async () => {
    const untracked = track('widgets');
    const next = track('gadgets');
    github.script = [
      [merged(2, '2026-11-10')],
      () => repos.delete(untracked.id),
      [merged(1, '2026-11-09')],
    ];

    sync.enqueue(untracked.id);
    sync.enqueue(next.id);

    expect(await settled(next)).toMatchObject({ syncState: 'succeeded' });
    expect(repos.get(untracked.id)).toBeNull();
    expect(pullRequests.count(untracked.id)).toBe(0);
  });

  it('stops a sync in flight at the next page boundary', async () => {
    const repo = track();
    github.script = [[merged(2, '2026-11-10')], [merged(1, '2026-11-09')]];

    sync.enqueue(repo.id);
    await sync.stop();

    expect(github.pagesServed).toEqual([1]);
    expect(repos.get(repo.id)).toMatchObject({ syncState: 'running', syncedFrom: null });
  });

  it('ignores requests after it was stopped', async () => {
    const repo = track();
    await sync.stop();

    sync.enqueue(repo.id);

    expect(github.syncsStarted).toEqual([]);
    expect(repos.get(repo.id)?.syncState).toBe('queued');
  });
});
