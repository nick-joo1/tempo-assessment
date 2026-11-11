import type { RepoRef } from '../domain.js';
import type { Db } from './database.js';

export type SyncState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TrackedRepo extends RepoRef {
  id: number;
  defaultBranch: string;
  /** Outcome of the most recent sync attempt. */
  syncState: SyncState;
  syncError: string | null;
  /** Start (epoch ms) of fully synced history. Null until the first sync has completed. */
  syncedFrom: number | null;
  syncCursor: number | null;
  lastSyncedAt: number | null;
  createdAt: number;
}

const SELECT = `
  SELECT id, owner, name, default_branch AS defaultBranch, sync_state AS syncState,
         sync_error AS syncError, synced_from AS syncedFrom, sync_cursor AS syncCursor,
         last_synced_at AS lastSyncedAt, created_at AS createdAt
  FROM repos`;

export class RepoStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Looks a repository up by owner and name, ignoring case as GitHub does. */
  find(ref: RepoRef): TrackedRepo | null {
    return (
      this.#db
        .prepare<[string, string], TrackedRepo>(`${SELECT} WHERE owner = ? AND name = ?`)
        .get(ref.owner, ref.name) ?? null
    );
  }

  get(id: number): TrackedRepo | null {
    return this.#db.prepare<[number], TrackedRepo>(`${SELECT} WHERE id = ?`).get(id) ?? null;
  }

  list(): TrackedRepo[] {
    return this.#db.prepare<[], TrackedRepo>(`${SELECT} ORDER BY owner, name`).all();
  }

  count(): number {
    return this.#db.prepare('SELECT COUNT(*) FROM repos').pluck().get() as number;
  }

  insert(repo: RepoRef & { defaultBranch: string }, now: number): TrackedRepo {
    const { lastInsertRowid } = this.#db
      .prepare(
        `INSERT INTO repos (owner, name, default_branch, sync_state, created_at)
         VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run(repo.owner, repo.name, repo.defaultBranch, now);
    return this.get(Number(lastInsertRowid)) as TrackedRepo;
  }

  /** Removes the repository and, through cascades, everything synced or generated for it. */
  delete(id: number): void {
    this.#db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  }

  markQueued(id: number): void {
    this.#db.prepare(`UPDATE repos SET sync_state = 'queued' WHERE id = ?`).run(id);
  }

  markRunning(id: number): void {
    this.#db.prepare(`UPDATE repos SET sync_state = 'running' WHERE id = ?`).run(id);
  }

  markSucceeded(id: number, result: { syncedFrom: number; cursor: number; at: number }): void {
    this.#db
      .prepare(
        `UPDATE repos
         SET sync_state = 'succeeded', sync_error = NULL, synced_from = ?, sync_cursor = ?,
             last_synced_at = ?
         WHERE id = ?`,
      )
      .run(result.syncedFrom, result.cursor, result.at, id);
  }

  markFailed(id: number, error: string): void {
    this.#db
      .prepare(`UPDATE repos SET sync_state = 'failed', sync_error = ? WHERE id = ?`)
      .run(error, id);
  }
}
