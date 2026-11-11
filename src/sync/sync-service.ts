import type { BaseLogger } from 'pino';
import type { Clock } from '../domain.js';
import { GitHubError } from '../github/client.js';
import type { GitHubGateway } from '../github/gateway.js';
import { DAY_MS } from '../insights/period.js';
import type { PullRequestStore } from '../store/pull-requests.js';
import type { RepoStore, TrackedRepo } from '../store/repos.js';

/**
 * GitHub's listing can lag a few seconds behind writes, so each incremental sync re-reads
 * a small window before the previous cursor. Upserts make the overlap harmless.
 */
const CURSOR_OVERLAP_MS = 10 * 60_000;

export interface SyncServiceOptions {
  github: GitHubGateway;
  repos: RepoStore;
  pullRequests: PullRequestStore;
  clock: Clock;
  logger: BaseLogger;
  /** How much history the first sync of a repository backfills. */
  lookbackDays: number;
}

/**
 * Keeps tracked repositories in step with GitHub. Syncs run one at a time, off the
 * request path: HTTP handlers only ever read what a sync has already stored.
 *
 * The first sync of a repository backfills `lookbackDays` of merged pull requests. Later
 * syncs are incremental: pull requests are listed most recently updated first, and paging
 * stops at the first one that has not changed since the previous sync.
 */
export class SyncService {
  readonly #options: SyncServiceOptions;
  readonly #queue = new Set<number>();
  #draining = false;
  #drained: Promise<void> = Promise.resolve();
  #pausedUntil = 0;
  #resumeTimer: NodeJS.Timeout | undefined;
  #refreshTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: SyncServiceOptions) {
    this.#options = options;
  }

  /** Syncs every tracked repository now and then again every `intervalMinutes` (0: only now). */
  start(intervalMinutes: number): void {
    this.#enqueueAll();
    if (intervalMinutes > 0) {
      this.#refreshTimer = setInterval(() => this.#enqueueAll(), intervalMinutes * 60_000);
      this.#refreshTimer.unref();
    }
  }

  /** Schedules a sync. Enqueueing a repository that is already waiting is a no-op. */
  enqueue(repoId: number): void {
    if (this.#stopped) return;
    if (!this.#queue.has(repoId)) {
      this.#queue.add(repoId);
      this.#options.repos.markQueued(repoId);
    }
    this.#wake();
  }

  /** Stops scheduling and waits for the sync in flight to reach its next page boundary. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#refreshTimer);
    clearTimeout(this.#resumeTimer);
    await this.#drained;
  }

  #enqueueAll(): void {
    for (const repo of this.#options.repos.list()) this.enqueue(repo.id);
  }

  /** Starts the worker unless it is already running. */
  #wake(): void {
    if (this.#draining || this.#stopped) return;
    this.#draining = true;
    this.#drained = this.#drain().catch((error: unknown) => {
      // Sync failures are handled per repository; only a failing store can end up here.
      this.#options.logger.error({ err: error }, 'sync worker stopped unexpectedly');
    });
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#stopped) {
        const pauseMs = this.#pausedUntil - this.#options.clock().getTime();
        if (pauseMs > 0) {
          clearTimeout(this.#resumeTimer);
          this.#resumeTimer = setTimeout(() => this.#wake(), pauseMs);
          this.#resumeTimer.unref();
          return;
        }

        const [repoId] = this.#queue;
        if (repoId === undefined) return;
        this.#queue.delete(repoId);

        const repo = this.#options.repos.get(repoId);
        if (repo) await this.#sync(repo);
      }
    } finally {
      // Cleared in the same tick as the decision to stop, so an enqueue can never slip in
      // between "queue is empty" and "worker is idle" and be left waiting.
      this.#draining = false;
    }
  }

  async #sync(repo: TrackedRepo): Promise<void> {
    const { github, repos, pullRequests, clock, logger, lookbackDays } = this.#options;
    const repository = `${repo.owner}/${repo.name}`;
    const startedAt = clock().getTime();

    const today = Math.floor(startedAt / DAY_MS) * DAY_MS;
    const syncedFrom = repo.syncedFrom ?? today - lookbackDays * DAY_MS;
    const stopBefore =
      repo.syncedFrom === null || repo.syncCursor === null
        ? syncedFrom
        : repo.syncCursor - CURSOR_OVERLAP_MS;
    let cursor = repo.syncCursor ?? syncedFrom;
    let stored = 0;

    try {
      repos.markRunning(repo.id);
      for await (const page of github.mergedPullRequestPages(repo, repo.defaultBranch)) {
        // Stop at a page boundary on shutdown, or if the repository was untracked meanwhile.
        if (this.#stopped || !repos.get(repo.id)) return;

        const changed = page.filter((pr) => pr.updatedAt >= stopBefore);
        const inWindow = changed.filter((pr) => pr.mergedAt >= syncedFrom);
        pullRequests.upsert(repo.id, inWindow);
        stored += inWindow.length;
        for (const pr of changed) cursor = Math.max(cursor, pr.updatedAt);

        if (changed.length < page.length) break;
      }
      repos.markSucceeded(repo.id, { syncedFrom, cursor, at: clock().getTime() });
      logger.info(
        { repository, pullRequests: stored, durationMs: clock().getTime() - startedAt },
        'repository synced',
      );
    } catch (error) {
      if (error instanceof GitHubError && error.code === 'rate_limited' && error.retryAt) {
        // The limit applies to the token, not the repository: hold the whole queue, and
        // put this repository back so it resumes once GitHub accepts requests again.
        this.#pausedUntil = error.retryAt.getTime();
        repos.markFailed(
          repo.id,
          `${error.message}; retrying after ${error.retryAt.toISOString()}`,
        );
        this.enqueue(repo.id);
      } else {
        // Only messages this service wrote itself are stored and later shown to API clients.
        repos.markFailed(
          repo.id,
          error instanceof GitHubError ? error.message : 'Unexpected error while syncing',
        );
      }
      logger.warn({ repository, err: error }, 'repository sync failed');
    }
  }
}
