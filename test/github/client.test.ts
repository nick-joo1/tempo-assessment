import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GitHubError, GitHubGraphQLClient } from '../../src/github/client.js';

const TOKEN = 'ghp_test-token';
const ViewerSchema = z.object({ viewer: z.object({ login: z.string() }) });
const VIEWER = { data: { viewer: { login: 'octocat' } } };

/** A client whose requests are answered, in order, by the given responses or failures. */
function clientAnswering(...answers: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const answer = answers.shift();
    if (!answer) throw new Error('The test did not expect another request');
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const sleep = vi.fn(async () => undefined);
  return { client: new GitHubGraphQLClient({ token: TOKEN, fetch, sleep }), fetch, sleep };
}

function failure(client: GitHubGraphQLClient): Promise<GitHubError> {
  return client.query('query { viewer { login } }', {}, ViewerSchema).then(
    () => {
      throw new Error('Expected the query to fail');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GitHubError);
      return error as GitHubError;
    },
  );
}

describe('GitHubGraphQLClient', () => {
  it('posts the document and variables to the fixed endpoint and returns validated data', async () => {
    const { client, fetch } = clientAnswering(Response.json(VIEWER));

    const data = await client.query(
      'query Q($n: Int) { viewer { login } }',
      { n: 1 },
      ViewerSchema,
    );

    expect(data).toEqual({ viewer: { login: 'octocat' } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'query Q($n: Int) { viewer { login } }',
      variables: { n: 1 },
    });
  });

  it('retries transient failures with backoff', async () => {
    const { client, fetch, sleep } = clientAnswering(
      new Response('bad gateway', { status: 502 }),
      new TypeError('fetch failed'),
      Response.json(VIEWER),
    );

    await expect(client.query('query', {}, ViewerSchema)).resolves.toEqual(VIEWER.data);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const { client, fetch } = clientAnswering(
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
    );

    expect((await failure(client)).code).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('treats an untyped GraphQL error as transient', async () => {
    const { client, fetch } = clientAnswering(
      Response.json({ data: null, errors: [{ message: 'Something went wrong while executing' }] }),
      Response.json(VIEWER),
    );

    await expect(client.query('query', {}, ViewerSchema)).resolves.toEqual(VIEWER.data);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejected token', async () => {
    const { client, fetch } = clientAnswering(new Response(null, { status: 401 }));

    expect((await failure(client)).code).toBe('unauthorized');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads the primary rate limit from the x-ratelimit headers', async () => {
    const reset = Date.parse('2026-11-11T13:00:00Z');
    const { client, fetch } = clientAnswering(
      new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / 1000) },
      }),
    );

    const error = await failure(client);
    expect(error.code).toBe('rate_limited');
    expect(error.retryAt?.getTime()).toBe(reset);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reads a secondary rate limit from retry-after', async () => {
    const { client } = clientAnswering(
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    );
    const before = Date.now();

    const error = await failure(client);
    expect(error.code).toBe('rate_limited');
    expect(error.retryAt?.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(error.retryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it('reads a 403 without rate-limit headers as missing access', async () => {
    const { client } = clientAnswering(new Response(null, { status: 403 }));

    expect((await failure(client)).code).toBe('unauthorized');
  });

  it.each([
    ['NOT_FOUND', 'not_found'],
    ['RATE_LIMITED', 'rate_limited'],
    ['FORBIDDEN', 'unauthorized'],
  ])('maps the GraphQL error type %s to %s', async (type, code) => {
    const { client } = clientAnswering(
      Response.json({ data: null, errors: [{ type, message: 'details from GitHub' }] }),
    );

    expect((await failure(client)).code).toBe(code);
  });

  it('rejects data that does not match the schema, without retrying', async () => {
    const { client, fetch } = clientAnswering(Response.json({ data: { viewer: { login: 42 } } }));

    const error = await failure(client);
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('viewer.login');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a body that is not JSON', async () => {
    const { client } = clientAnswering(new Response('<html>', { status: 200 }));

    expect((await failure(client)).code).toBe('invalid_response');
  });

  it('never repeats the upstream error text, which could carry the token', async () => {
    const leaky = new TypeError(`request with Bearer ${TOKEN} failed`);
    const { client } = clientAnswering(leaky, leaky, leaky);

    const error = await failure(client);
    expect(error.message).toBe('The request to GitHub failed (TypeError)');
    expect(error.cause).toBeUndefined();
  });
});
