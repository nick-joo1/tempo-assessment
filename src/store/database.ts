import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Forward-only migrations. The index of the last applied one is kept in SQLite's
 * `user_version`, so a migration is never edited once released: append a new one instead.
 */
const MIGRATIONS = [
  `
  CREATE TABLE repos (
    id             INTEGER PRIMARY KEY,
    owner          TEXT NOT NULL COLLATE NOCASE,
    name           TEXT NOT NULL COLLATE NOCASE,
    default_branch TEXT NOT NULL,
    sync_state     TEXT NOT NULL CHECK (sync_state IN ('queued', 'running', 'succeeded', 'failed')),
    sync_error     TEXT,
    -- Start of the history that is fully synced; null until the first backfill completes.
    synced_from    INTEGER,
    -- Latest pull request update seen; the next sync resumes from here.
    sync_cursor    INTEGER,
    last_synced_at INTEGER,
    created_at     INTEGER NOT NULL,
    UNIQUE (owner, name)
  ) STRICT;

  CREATE TABLE pull_requests (
    repo_id       INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    number        INTEGER NOT NULL,
    author        TEXT NOT NULL,
    author_is_bot INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    ready_at      INTEGER,
    merged_at     INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    additions     INTEGER NOT NULL,
    deletions     INTEGER NOT NULL,
    PRIMARY KEY (repo_id, number)
  ) STRICT, WITHOUT ROWID;

  -- Every insight is a range scan over one repository's merges.
  CREATE INDEX pull_requests_by_merge ON pull_requests (repo_id, merged_at);

  CREATE TABLE reviews (
    repo_id         INTEGER NOT NULL,
    pr_number       INTEGER NOT NULL,
    id              TEXT NOT NULL,
    reviewer        TEXT NOT NULL,
    reviewer_is_bot INTEGER NOT NULL,
    state           TEXT NOT NULL,
    submitted_at    INTEGER NOT NULL,
    PRIMARY KEY (repo_id, pr_number, id),
    FOREIGN KEY (repo_id, pr_number) REFERENCES pull_requests (repo_id, number) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE narratives (
    cache_key  TEXT PRIMARY KEY,
    repo_id    INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX narratives_by_repo ON narratives (repo_id);
  `,
];

/** Opens (creating if needed) the database at `path` and brings its schema up to date. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const applied = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.slice(applied).forEach((migration, offset) => {
    db.transaction(() => {
      db.exec(migration);
      db.pragma(`user_version = ${applied + offset + 1}`);
    })();
  });
}
