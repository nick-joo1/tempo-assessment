import { z } from 'zod';
import type { MergedPullRequest, RepoRef, Review, ReviewState } from '../domain.js';
import { GitHubError, type GitHubGraphQLClient, rateLimited } from './client.js';

/** Pull requests per page. Halved when GitHub cannot execute a page within its time limit. */
const PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const REVIEWS_PER_PAGE = 100;
/** Stop paging while this many points remain, so a sync never exhausts the token's quota. */
const RATE_LIMIT_RESERVE = 100;

export interface RepositoryInfo {
  /** Owner and name as GitHub spells them, which may differ in case from what was asked for. */
  owner: string;
  name: string;
  isPrivate: boolean;
  /** Null for an empty repository. */
  defaultBranch: string | null;
}

export interface GitHubGateway {
  /** @throws GitHubError with code `not_found` when the repository does not exist or is not visible. */
  getRepository(ref: RepoRef): Promise<RepositoryInfo>;
  /**
   * Pages through pull requests merged into `branch`, most recently updated first, so a
   * caller can stop as soon as it reaches pull requests it has already seen.
   */
  mergedPullRequestPages(ref: RepoRef, branch: string): AsyncIterable<MergedPullRequest[]>;
}

const timestamp = z.iso.datetime().transform((value) => Date.parse(value));
const ActorSchema = z.object({ __typename: z.string(), login: z.string() }).nullable();
const PageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const RateLimitSchema = z.object({ remaining: z.number(), resetAt: z.iso.datetime() }).nullish();

const ReviewConnectionSchema = z.object({
  pageInfo: PageInfoSchema,
  nodes: z.array(
    z
      .object({
        id: z.string(),
        state: z.string(),
        submittedAt: timestamp.nullable(),
        author: ActorSchema,
      })
      .nullable(),
  ),
});
type ReviewConnection = z.infer<typeof ReviewConnectionSchema>;

const PullRequestNodeSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  createdAt: timestamp,
  mergedAt: timestamp.nullable(),
  updatedAt: timestamp,
  additions: z.number().int(),
  deletions: z.number().int(),
  author: ActorSchema,
  timelineItems: z.object({
    nodes: z.array(z.object({ createdAt: timestamp.optional() }).nullable()),
  }),
  reviews: ReviewConnectionSchema,
});

const REVIEW_FIELDS = /* GraphQL */ `
  pageInfo { hasNextPage endCursor }
  nodes { id state submittedAt author { __typename login } }
`;

const REPOSITORY_QUERY = /* GraphQL */ `
  query Repository($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      owner { login }
      name
      isPrivate
      defaultBranchRef { name }
    }
  }
`;

const RepositoryResponseSchema = z.object({
  repository: z
    .object({
      owner: z.object({ login: z.string() }),
      name: z.string(),
      isPrivate: z.boolean(),
      defaultBranchRef: z.object({ name: z.string() }).nullable(),
    })
    .nullable(),
});

const PULL_REQUESTS_QUERY = /* GraphQL */ `
  query MergedPullRequests(
    $owner: String!, $name: String!, $branch: String!, $pageSize: Int!, $cursor: String
  ) {
    rateLimit { remaining resetAt }
    repository(owner: $owner, name: $name) {
      pullRequests(
        states: MERGED, baseRefName: $branch, first: $pageSize, after: $cursor,
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          createdAt
          mergedAt
          updatedAt
          additions
          deletions
          author { __typename login }
          timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], first: 1) {
            nodes { ... on ReadyForReviewEvent { createdAt } }
          }
          reviews(first: ${REVIEWS_PER_PAGE}) { ${REVIEW_FIELDS} }
        }
      }
    }
  }
`;

const PullRequestsResponseSchema = z.object({
  rateLimit: RateLimitSchema,
  repository: z
    .object({
      pullRequests: z.object({
        pageInfo: PageInfoSchema,
        nodes: z.array(PullRequestNodeSchema.nullable()),
      }),
    })
    .nullable(),
});

const MORE_REVIEWS_QUERY = /* GraphQL */ `
  query MoreReviews($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on PullRequest {
        reviews(first: ${REVIEWS_PER_PAGE}, after: $cursor) { ${REVIEW_FIELDS} }
      }
    }
  }
`;

const MoreReviewsResponseSchema = z.object({
  node: z.object({ reviews: ReviewConnectionSchema }).nullable(),
});

export class GraphQLGitHubGateway implements GitHubGateway {
  readonly #client: GitHubGraphQLClient;

  constructor(client: GitHubGraphQLClient) {
    this.#client = client;
  }

  async getRepository(ref: RepoRef): Promise<RepositoryInfo> {
    const { repository } = await this.#client.query(
      REPOSITORY_QUERY,
      { owner: ref.owner, name: ref.name },
      RepositoryResponseSchema,
    );
    if (!repository) throw notFound(ref);
    return {
      owner: repository.owner.login,
      name: repository.name,
      isPrivate: repository.isPrivate,
      defaultBranch: repository.defaultBranchRef?.name ?? null,
    };
  }

  async *mergedPullRequestPages(
    ref: RepoRef,
    branch: string,
  ): AsyncGenerator<MergedPullRequest[], void, void> {
    let pageSize = PAGE_SIZE;
    let cursor: string | null = null;

    while (true) {
      let response: z.infer<typeof PullRequestsResponseSchema>;
      try {
        response = await this.#client.query(
          PULL_REQUESTS_QUERY,
          { owner: ref.owner, name: ref.name, branch, pageSize, cursor },
          PullRequestsResponseSchema,
        );
      } catch (error) {
        // Pages full of heavily reviewed pull requests can exceed GitHub's execution time
        // limit, which surfaces as a transient failure. A smaller page usually gets through.
        const transient = error instanceof GitHubError && error.code === 'unavailable';
        if (!transient || pageSize <= MIN_PAGE_SIZE) throw error;
        pageSize = Math.max(MIN_PAGE_SIZE, Math.ceil(pageSize / 2));
        continue;
      }
      if (!response.repository) throw notFound(ref);

      const { nodes, pageInfo } = response.repository.pullRequests;
      const page: MergedPullRequest[] = [];
      for (const node of nodes) {
        if (!node || node.mergedAt === null) continue;
        page.push({
          number: node.number,
          author: loginOf(node.author),
          authorIsBot: isBot(node.author),
          createdAt: node.createdAt,
          readyAt: node.timelineItems.nodes[0]?.createdAt ?? null,
          mergedAt: node.mergedAt,
          updatedAt: node.updatedAt,
          additions: node.additions,
          deletions: node.deletions,
          reviews: await this.#allReviews(node.id, node.reviews),
        });
      }
      yield page;

      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return;
      cursor = pageInfo.endCursor;

      const { rateLimit } = response;
      if (rateLimit && rateLimit.remaining < RATE_LIMIT_RESERVE) {
        throw rateLimited(new Date(rateLimit.resetAt));
      }
    }
  }

  /** Maps the reviews fetched with a pull request, following the connection if there are more. */
  async #allReviews(pullRequestId: string, firstPage: ReviewConnection): Promise<Review[]> {
    const reviews = toReviews(firstPage);
    let { pageInfo } = firstPage;
    while (pageInfo.hasNextPage && pageInfo.endCursor !== null) {
      const { node } = await this.#client.query(
        MORE_REVIEWS_QUERY,
        { id: pullRequestId, cursor: pageInfo.endCursor },
        MoreReviewsResponseSchema,
      );
      if (!node) break;
      reviews.push(...toReviews(node.reviews));
      pageInfo = node.reviews.pageInfo;
    }
    return reviews;
  }
}

const SUBMITTED_STATES: ReadonlySet<string> = new Set<ReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
]);

function toReviews(connection: ReviewConnection): Review[] {
  const reviews: Review[] = [];
  for (const node of connection.nodes) {
    // A PENDING review is a draft only its author (possibly the token owner) can see.
    if (!node || node.submittedAt === null || !SUBMITTED_STATES.has(node.state)) continue;
    reviews.push({
      id: node.id,
      reviewer: loginOf(node.author),
      reviewerIsBot: isBot(node.author),
      state: node.state as ReviewState,
      submittedAt: node.submittedAt,
    });
  }
  return reviews;
}

type Actor = z.infer<typeof ActorSchema>;

/** The login GitHub shows for content whose author deleted their account. */
const DELETED_USER = 'ghost';

/**
 * Logins end up in API responses, the UI and the LLM prompt. GitHub restricts them to a
 * narrow alphabet, but that is GitHub's promise, not ours: enforce it at the boundary.
 */
function loginOf(actor: Actor): string {
  if (!actor) return DELETED_USER;
  return actor.login.replace(/[^A-Za-z0-9_[\]-]/g, '').slice(0, 64) || DELETED_USER;
}

function isBot(actor: Actor): boolean {
  return actor !== null && (actor.__typename === 'Bot' || actor.login.endsWith('[bot]'));
}

function notFound(ref: RepoRef): GitHubError {
  return new GitHubError(
    'not_found',
    `Repository ${ref.owner}/${ref.name} was not found on GitHub`,
  );
}
