import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { RepoStore } from '../store/repos.js';
import { Problem, problemResponse } from './problem.js';

/** Probes are exempt from rate limiting: an orchestrator must always get an answer. */
export const healthRoutes: FastifyPluginAsyncZod<{ repos: RepoStore }> = async (app, { repos }) => {
  app.get(
    '/healthz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['operations'],
        summary: 'Liveness: the process is up',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/readyz',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['operations'],
        summary: 'Readiness: the database answers',
        description:
          'Does not depend on GitHub or the model provider: requests are served from the database, so an upstream outage makes data stale, not unavailable.',
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: problemResponse('`not_ready`.'),
        },
      },
    },
    async (request) => {
      try {
        repos.count();
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        throw new Problem(503, 'not_ready', 'Not ready', 'The database is not available.');
      }
      return { status: 'ready' as const };
    },
  );
};
