import type { Db } from './database.js';

const RETENTION_MS = 30 * 86_400_000;

/** Verified narratives keyed by a hash of everything that determined them. */
export class NarrativeCache {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(cacheKey: string): string | null {
    const body = this.#db
      .prepare('SELECT body FROM narratives WHERE cache_key = ?')
      .pluck()
      .get(cacheKey) as string | undefined;
    return body ?? null;
  }

  put(cacheKey: string, repoId: number, body: string, now: number): void {
    this.#db.transaction(() => {
      // Keys embed the period and the numbers, so entries for past days are never read
      // again. Expiring them on write keeps the table bounded without a separate job.
      this.#db.prepare('DELETE FROM narratives WHERE created_at < ?').run(now - RETENTION_MS);
      this.#db
        .prepare(
          `INSERT INTO narratives (cache_key, repo_id, body, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (cache_key) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
        )
        .run(cacheKey, repoId, body, now);
    })();
  }
}
