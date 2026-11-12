import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GitHubError } from '../github/client.js';
import { InvalidPeriodError } from '../insights/period.js';
import { NarrativeModelError } from '../narrative/model.js';
import { NarrativeNotConfiguredError } from '../narrative/service.js';

/** An error with a deliberate HTTP representation (RFC 9457 problem details). */
export class Problem extends Error {
  override name = 'Problem';

  constructor(
    readonly status: number,
    /** Stable identifier clients can branch on; the prose around it may change. */
    readonly code: string,
    readonly title: string,
    detail: string,
    readonly extras: {
      headers?: Record<string, string>;
      errors?: { path: string; message: string }[];
    } = {},
  ) {
    super(detail);
  }
}

export const ProblemSchema = z
  .object({
    type: z.literal('about:blank'),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    code: z.string().describe('Stable, machine-readable identifier of the problem.'),
    requestId: z.string().describe('Quote this when reporting the problem.'),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('For `invalid_request`: what is wrong with which part of the request.'),
  })
  .describe('Problem details (RFC 9457), served as application/problem+json.');

/** An error response as it appears in a route's schema and in the OpenAPI document. */
export function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ProblemSchema } } };
}

/**
 * Maps anything a handler can throw to a problem. Unknown errors become a generic 500:
 * their message may describe internals, so it is logged but never sent.
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof Problem) return error;

  if (hasZodFastifySchemaValidationErrors(error)) {
    return new Problem(400, 'invalid_request', 'Invalid request', 'The request is not valid.', {
      errors: error.validation.map((issue) => ({
        path: `${error.validationContext}${issue.instancePath}`,
        message: issue.message ?? 'Invalid value',
      })),
    });
  }
  if (error instanceof InvalidPeriodError) {
    return new Problem(400, 'invalid_period', 'Invalid period', error.message);
  }
  if (error instanceof GitHubError) return gitHubProblem(error);
  if (error instanceof NarrativeModelError) return modelProblem(error);
  if (error instanceof NarrativeNotConfiguredError) {
    return new Problem(
      503,
      'narrative_not_configured',
      'Narratives are not configured',
      'This server has no ANTHROPIC_API_KEY, so it cannot write narratives. The review-flow insight itself is unaffected.',
    );
  }

  // Errors raised by Fastify itself for malformed requests (bad JSON, unsupported media type...).
  const { statusCode, message } = error as Partial<FastifyError>;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return new Problem(statusCode, 'bad_request', 'Bad request', message ?? 'Bad request');
  }
  return new Problem(
    500,
    'internal_error',
    'Internal server error',
    'An unexpected error occurred. It has been logged with the request id.',
  );
}

function gitHubProblem(error: GitHubError): Problem {
  switch (error.code) {
    case 'not_found':
      return new Problem(404, 'repository_not_found', 'Repository not found', error.message);
    case 'rate_limited':
      return new Problem(
        503,
        'github_rate_limited',
        'GitHub rate limit reached',
        'The server has used up its GitHub API quota. Try again later.',
        { headers: { 'retry-after': secondsUntil(error.retryAt) } },
      );
    default:
      // The client wrote these messages itself; they name the failure, never its payload.
      return new Problem(502, 'github_unavailable', 'GitHub request failed', error.message);
  }
}

function modelProblem(error: NarrativeModelError): Problem {
  if (error.code === 'rate_limited' || error.code === 'unavailable') {
    return new Problem(
      503,
      'narrative_unavailable',
      'Narrative temporarily unavailable',
      'The language model could not be reached. The review-flow insight itself is unaffected.',
      { headers: { 'retry-after': String(error.retryAfterSeconds ?? 30) } },
    );
  }
  return new Problem(
    502,
    'narrative_failed',
    'Narrative could not be generated',
    'The language model did not produce a usable narrative. The review-flow insight itself is unaffected.',
  );
}

function secondsUntil(instant: Date | undefined): string {
  const seconds = instant ? Math.ceil((instant.getTime() - Date.now()) / 1000) : 60;
  return String(Math.max(1, seconds));
}

export function sendProblem(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const problem = toProblem(error);
  // Only a failure nobody anticipated is an error, and only that one needs its stack. An
  // upstream outage or a missing model key has a deliberate response and names its own cause.
  if (problem.code === 'internal_error') {
    request.log.error({ err: error }, 'request failed');
  } else if (problem.status >= 500) {
    const reason = error instanceof Error ? error.message : String(error);
    request.log.warn({ code: problem.code, reason }, 'request failed');
  } else {
    request.log.info({ code: problem.code }, 'request rejected');
  }

  void reply
    .code(problem.status)
    .headers(problem.extras.headers ?? {})
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      title: problem.title,
      status: problem.status,
      detail: problem.message,
      code: problem.code,
      requestId: request.id,
      errors: problem.extras.errors,
    });
}
