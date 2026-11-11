import type { MergedPullRequest, Review, ReviewState } from '../src/domain.js';

/** Epoch ms for a UTC timestamp written as `2026-10-01` or `2026-10-01T10:00`. */
export function at(timestamp: string): number {
  return Date.parse(timestamp.includes('T') ? `${timestamp}:00Z` : `${timestamp}T00:00:00Z`);
}

let nextReviewId = 0;

export function review(
  reviewer: string,
  submittedAt: string,
  state: ReviewState = 'APPROVED',
  reviewerIsBot = false,
): Review {
  nextReviewId += 1;
  return {
    id: `review-${nextReviewId}`,
    reviewer,
    reviewerIsBot,
    state,
    submittedAt: at(submittedAt),
  };
}

export function pullRequest(
  fields: {
    number: number;
    author: string;
    created: string;
    merged: string;
    ready?: string;
    lines?: [additions: number, deletions: number];
    authorIsBot?: boolean;
  },
  reviews: Review[] = [],
): MergedPullRequest {
  const [additions, deletions] = fields.lines ?? [10, 0];
  return {
    number: fields.number,
    author: fields.author,
    authorIsBot: fields.authorIsBot ?? false,
    createdAt: at(fields.created),
    readyAt: fields.ready ? at(fields.ready) : null,
    mergedAt: at(fields.merged),
    updatedAt: at(fields.merged),
    additions,
    deletions,
    reviews,
  };
}
