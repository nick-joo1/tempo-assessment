import { randomUUID } from 'node:crypto';
import etag from '@fastify/etag';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Clock } from './domain.js';
import type { GitHubGateway } from './github/gateway.js';
import { healthRoutes } from './http/health.js';
import { insightRoutes } from './http/insights.js';
import { Problem, sendProblem } from './http/problem.js';
import { repoRoutes } from './http/repos.js';
import type { NarrativeService } from './narrative/service.js';
import type { PullRequestStore } from './store/pull-requests.js';
import type { RepoStore } from './store/repos.js';
import type { SyncService } from './sync/sync-service.js';

/** Requests per client address per minute, across all routes. */
const GLOBAL_RATE_LIMIT = 300;

export interface AppDependencies {
  repos: RepoStore;
  pullRequests: PullRequestStore;
  github: GitHubGateway;
  sync: SyncService;
  narrative: NarrativeService;
  clock: Clock;
  maxTrackedRepos: number;
  allowPrivateRepos: boolean;
  /** Omit to disable logging. */
  logger?: FastifyBaseLogger;
}

/**
 * Assembles the HTTP application around services that already exist. It starts nothing
 * and owns nothing: the caller creates, starts and stops the services, which lets tests
 * drive the real application with fakes behind it.
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({
    loggerInstance: deps.logger,
    // Request ids appear in every log line and in every error response, and are never
    // taken from the request: a client cannot forge or collide them.
    genReqId: () => randomUUID(),
    // No route accepts a request body.
    bodyLimit: 16 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(sendProblem);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) =>
      new Problem(
        429,
        'rate_limited',
        'Too many requests',
        `Limit of ${context.max} requests per ${context.after} exceeded. See the Retry-After header.`,
      ),
  });
  await app.register(etag);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Review Flow Insights',
        version: '1.0.0',
        description:
          'Review-flow metrics for GitHub repositories, and an LLM narrative grounded in them. Errors are RFC 9457 problem details; branch on `code`.',
      },
      tags: [
        { name: 'repositories', description: 'Choose which repositories are synced.' },
        { name: 'insights', description: 'Metrics and the narrative over them.' },
        { name: 'operations', description: 'Probes.' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    // This process speaks plain HTTP and leaves TLS to whatever fronts it. Some browsers
    // apply this directive to localhost too, which would leave the page without assets.
    transformStaticCSP: (policy) => policy.replace('upgrade-insecure-requests;', ''),
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.register(async (api) => {
    // Responses reflect the latest sync, so clients must revalidate; the ETag makes that
    // a 304 without a body whenever nothing has changed.
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'no-cache');
    });
    await api.register(healthRoutes, { repos: deps.repos });
    await api.register(repoRoutes, deps);
    await api.register(insightRoutes, deps);
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) =>
    sendProblem(new Problem(404, 'not_found', 'Not found', 'No such resource.'), request, reply),
  );

  return app;
}
