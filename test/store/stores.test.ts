import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../../src/store/database.js';
import { NarrativeCache } from '../../src/store/narratives.js';
import { PullRequestStore } from '../../src/store/pull-requests.js';
import { RepoStore } from '../../src/store/repos.js';
import { at, pullRequest, review } from '../helpers.js';

const NOW = at('2026-11-11');
const DAY_MS = 86_400_000;

let db: Db;
let repos: RepoStore;
let pullRequests: PullRequestStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = new RepoStore(db);
  pullRequests = new PullRequestStore(db);
});

function track(name = 'widgets') {
  return repos.insert({ owner: 'acme', name, defaultBranch: 'main' }, NOW);
}

describe('openDatabase', () => {
  it('creates the file and its directory, and reopens it without migrating twice', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-flow-'));
    try {
      const path = join(directory, 'nested', 'test.db');
      const first = openDatabase(path);
      new RepoStore(first).insert({ owner: 'acme', name: 'widgets', defaultBranch: 'main' }, NOW);
      first.close();

      const second = openDatabase(path);
      expect(new RepoStore(second).count()).toBe(1);
      expect(second.pragma('user_version', { simple: true })).toBe(1);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('RepoStore', () => {
  it('starts a repository queued and without synced history', () => {
    expect(track()).toMatchObject({
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      syncState: 'queued',
      syncError: null,
      syncedFrom: null,
      syncCursor: null,
      lastSyncedAt: null,
      createdAt: NOW,
    });
  });

  it('finds repositories regardless of case, as GitHub does', () => {
    const repo = track();

    expect(repos.find({ owner: 'ACME', name: 'Widgets' })?.id).toBe(repo.id);
    expect(repos.find({ owner: 'acme', name: 'gadgets' })).toBeNull();
    expect(() =>
      repos.insert({ owner: 'Acme', name: 'WIDGETS', defaultBranch: 'main' }, NOW),
    ).toThrow(/UNIQUE/);
  });

  it('records the outcome of a sync', () => {
    const repo = track();

    repos.markFailed(repo.id, 'GitHub responded with HTTP 502');
    expect(repos.get(repo.id)).toMatchObject({ syncState: 'failed', syncedFrom: null });

    repos.markSucceeded(repo.id, { syncedFrom: NOW - 30 * DAY_MS, cursor: NOW - 5, at: NOW });
    expect(repos.get(repo.id)).toMatchObject({
      syncState: 'succeeded',
      syncError: null,
      syncedFrom: NOW - 30 * DAY_MS,
      syncCursor: NOW - 5,
      lastSyncedAt: NOW,
    });
  });

  it('deletes everything stored for a repository along with it', () => {
    const repo = track();
    const other = track('gadgets');
    const merged = pullRequest(
      { number: 1, author: 'alice', created: '2026-10-01', merged: '2026-10-02' },
      [review('bob', '2026-10-01T05:00')],
    );
    pullRequests.upsert(repo.id, [merged]);
    pullRequests.upsert(other.id, [merged]);
    new NarrativeCache(db).put('key', repo.id, '{}', NOW);

    repos.delete(repo.id);

    expect(repos.list().map((r) => r.name)).toEqual(['gadgets']);
    const rows = (table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    expect(rows('pull_requests')).toBe(1);
    expect(rows('reviews')).toBe(1);
    expect(rows('narratives')).toBe(0);
  });
});

describe('PullRequestStore', () => {
  it('returns what was stored, reviews included', () => {
    const repo = track();
    const merged = pullRequest(
      {
        number: 7,
        author: 'alice',
        created: '2026-10-01',
        ready: '2026-10-01T02:00',
        merged: '2026-10-02',
        lines: [40, 2],
      },
      [
        review('bob', '2026-10-01T05:00', 'CHANGES_REQUESTED'),
        review('ci[bot]', '2026-10-01T06:00', 'COMMENTED', true),
      ],
    );
    pullRequests.upsert(repo.id, [merged]);

    const [stored] = pullRequests.mergedBetween(repo.id, at('2026-10-01'), at('2026-10-03'));

    expect(stored).toEqual(merged);
    expect(pullRequests.count(repo.id)).toBe(1);
  });

  it('selects by merge time: start inclusive, end exclusive, one repository only', () => {
    const repo = track();
    const other = track('gadgets');
    const mergedOn = (number: number, merged: string) =>
      pullRequest({ number, author: 'alice', created: '2026-09-01', merged });
    pullRequests.upsert(repo.id, [
      mergedOn(1, '2026-09-30T23:59'),
      mergedOn(2, '2026-10-01'),
      mergedOn(3, '2026-10-07T23:59'),
      mergedOn(4, '2026-10-08'),
    ]);
    pullRequests.upsert(other.id, [mergedOn(5, '2026-10-02')]);

    const selected = pullRequests.mergedBetween(repo.id, at('2026-10-01'), at('2026-10-08'));

    expect(selected.map((pr) => pr.number).sort()).toEqual([2, 3]);
  });

  it('replaces a pull request and its reviews when it is synced again', () => {
    const repo = track();
    const fields = { number: 1, author: 'alice', created: '2026-10-01', merged: '2026-10-02' };
    const dismissed = review('bob', '2026-10-01T05:00', 'CHANGES_REQUESTED');
    pullRequests.upsert(repo.id, [
      pullRequest(fields, [dismissed, review('carol', '2026-10-01T06:00')]),
    ]);

    pullRequests.upsert(repo.id, [
      pullRequest({ ...fields, lines: [99, 1] }, [{ ...dismissed, state: 'DISMISSED' }]),
    ]);

    const [stored] = pullRequests.mergedBetween(repo.id, at('2026-10-01'), at('2026-10-03'));
    expect(pullRequests.count(repo.id)).toBe(1);
    expect(stored?.additions).toBe(99);
    expect(stored?.reviews).toEqual([{ ...dismissed, state: 'DISMISSED' }]);
  });
});

describe('NarrativeCache', () => {
  it('returns what was put under a key, and null for an unknown key', () => {
    const cache = new NarrativeCache(db);
    const repo = track();

    cache.put('key', repo.id, '{"headline":"first"}', NOW);
    cache.put('key', repo.id, '{"headline":"second"}', NOW);

    expect(cache.get('key')).toBe('{"headline":"second"}');
    expect(cache.get('other')).toBeNull();
  });

  it('expires entries older than 30 days whenever something is written', () => {
    const cache = new NarrativeCache(db);
    const repo = track();
    cache.put('old', repo.id, '{}', NOW - 31 * DAY_MS);
    cache.put('recent', repo.id, '{}', NOW - 29 * DAY_MS);

    cache.put('new', repo.id, '{}', NOW);

    expect(cache.get('old')).toBeNull();
    expect(cache.get('recent')).toBe('{}');
    expect(cache.get('new')).toBe('{}');
  });
});
