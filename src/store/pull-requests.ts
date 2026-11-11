import type { MergedPullRequest, Review, ReviewState } from '../domain.js';
import type { Db } from './database.js';

interface PullRequestRow {
  number: number;
  author: string;
  authorIsBot: number;
  createdAt: number;
  readyAt: number | null;
  mergedAt: number;
  updatedAt: number;
  additions: number;
  deletions: number;
}

interface ReviewRow {
  prNumber: number;
  id: string;
  reviewer: string;
  reviewerIsBot: number;
  state: ReviewState;
  submittedAt: number;
}

export class PullRequestStore {
  readonly #db: Db;
  readonly #upsertAll: (repoId: number, pullRequests: readonly MergedPullRequest[]) => void;

  constructor(db: Db) {
    this.#db = db;

    const upsertPullRequest = db.prepare(`
      INSERT INTO pull_requests (repo_id, number, author, author_is_bot, created_at, ready_at,
                                 merged_at, updated_at, additions, deletions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (repo_id, number) DO UPDATE SET
        author = excluded.author, author_is_bot = excluded.author_is_bot,
        created_at = excluded.created_at, ready_at = excluded.ready_at,
        merged_at = excluded.merged_at, updated_at = excluded.updated_at,
        additions = excluded.additions, deletions = excluded.deletions`);
    const deleteReviews = db.prepare('DELETE FROM reviews WHERE repo_id = ? AND pr_number = ?');
    const insertReview = db.prepare(`
      INSERT INTO reviews (repo_id, pr_number, id, reviewer, reviewer_is_bot, state, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

    this.#upsertAll = db.transaction((repoId, pullRequests) => {
      for (const pr of pullRequests) {
        upsertPullRequest.run(
          repoId,
          pr.number,
          pr.author,
          Number(pr.authorIsBot),
          pr.createdAt,
          pr.readyAt,
          pr.mergedAt,
          pr.updatedAt,
          pr.additions,
          pr.deletions,
        );
        // Reviews are replaced wholesale: states change (a review can be dismissed) and
        // GitHub always returns the complete, current set for a pull request.
        deleteReviews.run(repoId, pr.number);
        for (const review of pr.reviews) {
          insertReview.run(
            repoId,
            pr.number,
            review.id,
            review.reviewer,
            Number(review.reviewerIsBot),
            review.state,
            review.submittedAt,
          );
        }
      }
    });
  }

  /** Writes a page of pull requests and their reviews atomically; safe to repeat. */
  upsert(repoId: number, pullRequests: readonly MergedPullRequest[]): void {
    this.#upsertAll(repoId, pullRequests);
  }

  count(repoId: number): number {
    return this.#db
      .prepare('SELECT COUNT(*) FROM pull_requests WHERE repo_id = ?')
      .pluck()
      .get(repoId) as number;
  }

  /** Pull requests merged in `[startMs, endMs)` with their reviews, in two indexed queries. */
  mergedBetween(repoId: number, startMs: number, endMs: number): MergedPullRequest[] {
    const reviewsByPullRequest = new Map<number, Review[]>();
    const reviewRows = this.#db
      .prepare<[number, number, number], ReviewRow>(
        `SELECT r.pr_number AS prNumber, r.id, r.reviewer, r.reviewer_is_bot AS reviewerIsBot,
                r.state, r.submitted_at AS submittedAt
         FROM pull_requests p
         JOIN reviews r ON r.repo_id = p.repo_id AND r.pr_number = p.number
         WHERE p.repo_id = ? AND p.merged_at >= ? AND p.merged_at < ?`,
      )
      .iterate(repoId, startMs, endMs);
    for (const { prNumber, reviewerIsBot, ...review } of reviewRows) {
      let reviews = reviewsByPullRequest.get(prNumber);
      if (!reviews) {
        reviews = [];
        reviewsByPullRequest.set(prNumber, reviews);
      }
      reviews.push({ ...review, reviewerIsBot: reviewerIsBot === 1 });
    }

    return this.#db
      .prepare<[number, number, number], PullRequestRow>(
        `SELECT number, author, author_is_bot AS authorIsBot, created_at AS createdAt,
                ready_at AS readyAt, merged_at AS mergedAt, updated_at AS updatedAt,
                additions, deletions
         FROM pull_requests
         WHERE repo_id = ? AND merged_at >= ? AND merged_at < ?`,
      )
      .all(repoId, startMs, endMs)
      .map((row) => ({
        ...row,
        authorIsBot: row.authorIsBot === 1,
        reviews: reviewsByPullRequest.get(row.number) ?? [],
      }));
  }
}
