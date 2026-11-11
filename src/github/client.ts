import { z } from 'zod';

/** Fixed endpoint: nothing a caller supplies ever becomes part of the URL. */
const GRAPHQL_URL = 'https://api.github.com/graphql';
const USER_AGENT = 'review-flow-insights';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const FALLBACK_RATE_LIMIT_WAIT_MS = 60_000;

export type GitHubErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'unavailable'
  | 'invalid_response';

export class GitHubError extends Error {
  override name = 'GitHubError';

  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    /** For `rate_limited`: when GitHub will accept requests again. */
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

const EnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
});

export interface GraphQLClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Total tries for a request that fails with a transient error. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GitHubGraphQLClient {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GraphQLClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
  }

  /**
   * Runs a query and validates the `data` it returns. User input must only ever be passed
   * through `variables`; documents are compile-time constants.
   */
  async query<T>(
    document: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const body = JSON.stringify({ query: document, variables });
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#send(body, schema);
      } catch (error) {
        const transient = error instanceof GitHubError && error.code === 'unavailable';
        if (!transient || attempt >= this.#maxAttempts) throw error;
        // Exponential backoff with full jitter: 0-500ms, 0-1s, 0-2s...
        await this.#sleep(Math.random() * 500 * 2 ** (attempt - 1));
      }
    }
  }

  async #send<T>(body: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    let payload: unknown;
    try {
      response = await this.#fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.ok) payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new GitHubError('invalid_response', 'GitHub returned a body that is not JSON');
      }
      const reason = error instanceof Error ? error.name : 'unknown error';
      throw new GitHubError('unavailable', `The request to GitHub failed (${reason})`);
    }

    if (!response.ok) {
      // Release the connection instead of leaving an unread body to the garbage collector.
      await response.body?.cancel().catch(() => undefined);
      throw errorForStatus(response);
    }

    const envelope = EnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
      throw new GitHubError('invalid_response', 'GitHub returned an unexpected response envelope');
    }
    const [firstError] = envelope.data.errors ?? [];
    if (firstError) throw errorForGraphQL(firstError, response.headers);

    const data = schema.safeParse(envelope.data.data);
    if (!data.success) {
      const where = data.error.issues[0]?.path.join('.') ?? '';
      throw new GitHubError('invalid_response', `GitHub returned unexpected data at '${where}'`);
    }
    return data.data;
  }
}

function errorForStatus(response: Response): GitHubError {
  const { status, headers } = response;
  if (status === 401) {
    return new GitHubError('unauthorized', 'GitHub rejected the configured token');
  }
  if (status === 403 || status === 429) {
    const retryAt = rateLimitReset(headers);
    if (retryAt || status === 429) {
      return rateLimited(retryAt);
    }
    return new GitHubError('unauthorized', 'GitHub refused the request: the token lacks access');
  }
  return new GitHubError('unavailable', `GitHub responded with HTTP ${status}`);
}

function errorForGraphQL(error: { type?: string; message: string }, headers: Headers): GitHubError {
  switch (error.type) {
    case 'NOT_FOUND':
      return new GitHubError('not_found', 'GitHub could not find the requested resource');
    case 'RATE_LIMITED':
      return rateLimited(rateLimitReset(headers));
    case 'FORBIDDEN':
      return new GitHubError('unauthorized', 'GitHub refused the request: the token lacks access');
    default:
      // In practice an untyped error is GitHub timing out while executing the query.
      return new GitHubError('unavailable', 'GitHub failed to execute the query');
  }
}

export function rateLimited(retryAt: Date | null): GitHubError {
  return new GitHubError(
    'rate_limited',
    'The GitHub API rate limit has been reached',
    retryAt ?? new Date(Date.now() + FALLBACK_RATE_LIMIT_WAIT_MS),
  );
}

/** Reads GitHub's primary (`x-ratelimit-*`) and secondary (`retry-after`) rate-limit headers. */
function rateLimitReset(headers: Headers): Date | null {
  const retryAfterSeconds = Number(headers.get('retry-after'));
  if (retryAfterSeconds > 0) return new Date(Date.now() + retryAfterSeconds * 1000);

  const resetEpochSeconds = Number(headers.get('x-ratelimit-reset'));
  if (headers.get('x-ratelimit-remaining') === '0' && resetEpochSeconds > 0) {
    return new Date(resetEpochSeconds * 1000);
  }
  return null;
}
