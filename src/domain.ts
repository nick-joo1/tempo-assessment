/** Types shared by the ingestion, storage and insight layers. Timestamps are epoch milliseconds. */

export interface RepoRef {
  owner: string;
  name: string;
}

/** Submitted review states. PENDING reviews are never ingested: nobody but their author can see them. */
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export interface Review {
  /** GitHub node id; stable across syncs. */
  id: string;
  reviewer: string;
  reviewerIsBot: boolean;
  state: ReviewState;
  submittedAt: number;
}

/** A pull request merged into the repository's default branch, with every review submitted on it. */
export interface MergedPullRequest {
  number: number;
  author: string;
  authorIsBot: boolean;
  createdAt: number;
  /** When the PR first left draft, or null if it was never a draft. */
  readyAt: number | null;
  mergedAt: number;
  updatedAt: number;
  additions: number;
  deletions: number;
  reviews: Review[];
}

export type Clock = () => Date;
