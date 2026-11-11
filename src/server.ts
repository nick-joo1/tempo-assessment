import { existsSync } from 'node:fs';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { GitHubGraphQLClient } from './github/client.js';
import { GraphQLGitHubGateway } from './github/gateway.js';
import { AnthropicNarrativeModel } from './narrative/model.js';
import { NarrativeService } from './narrative/service.js';
import { openDatabase } from './store/database.js';
import { NarrativeCache } from './store/narratives.js';
import { PullRequestStore } from './store/pull-requests.js';
import { RepoStore } from './store/repos.js';
import { SyncService } from './sync/sync-service.js';

/** How long shutdown may take before the process exits regardless. */
const SHUTDOWN_GRACE_MS = 10_000;

if (existsSync('.env')) process.loadEnvFile('.env');

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`${error.message}\nCopy .env.example to .env and fill it in.`);
    process.exit(1);
  }
})();

const logger = pino({
  level: config.logLevel,
  ...(config.env === 'development' && { transport: { target: 'pino-pretty' } }),
});
const clock = () => new Date();

const db = openDatabase(config.databasePath);
const repos = new RepoStore(db);
const pullRequests = new PullRequestStore(db);
const github = new GraphQLGitHubGateway(new GitHubGraphQLClient({ token: config.githubToken }));
const sync = new SyncService({
  github,
  repos,
  pullRequests,
  clock,
  logger: logger.child({ component: 'sync' }),
  lookbackDays: config.sync.lookbackDays,
});
const narrative = new NarrativeService({
  model: config.llm.apiKey
    ? new AnthropicNarrativeModel({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        effort: config.llm.effort,
        logger: logger.child({ component: 'llm' }),
      })
    : null,
  cache: new NarrativeCache(db),
  clock,
  logger: logger.child({ component: 'narrative' }),
});

const app = await buildApp({
  repos,
  pullRequests,
  github,
  sync,
  narrative,
  clock,
  maxTrackedRepos: config.maxTrackedRepos,
  allowPrivateRepos: config.allowPrivateRepos,
  logger,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();

  // Stop accepting requests, let the sync in flight reach a page boundary, then close
  // the database it was writing to.
  await app.close();
  await sync.stop();
  db.close();
}
process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logger.fatal({ err: error }, 'could not start the server');
  process.exit(1);
}
if (!config.llm.apiKey) {
  logger.warn('ANTHROPIC_API_KEY is not set: the narrative endpoint will answer 503');
}
sync.start(config.sync.intervalMinutes);
