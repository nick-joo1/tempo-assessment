import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().default('./data/review-flow.db'),
  GITHUB_TOKEN: z.string(),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('claude-opus-5-5'),
  LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(14).max(730).default(180),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  MAX_TRACKED_REPOS: z.coerce.number().int().min(1).max(500).default(25),
  ALLOW_PRIVATE_REPOS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databasePath: string;
  githubToken: string;
  llm: {
    apiKey: string | undefined;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  sync: { lookbackDays: number; intervalMinutes: number };
  maxTrackedRepos: number;
  allowPrivateRepos: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses and validates the process environment. Fails fast with the names of the
 * offending variables; values are never echoed because some of them are secrets.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An empty assignment in a .env file ("ANTHROPIC_API_KEY=") means "not set".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) =>
      issue.code === 'invalid_type' && !(issue.path.join('.') in present)
        ? `${issue.path.join('.')} is required`
        : `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }

  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databasePath: e.DATABASE_PATH,
    githubToken: e.GITHUB_TOKEN,
    llm: { apiKey: e.ANTHROPIC_API_KEY, model: e.LLM_MODEL, effort: e.LLM_EFFORT },
    sync: { lookbackDays: e.SYNC_LOOKBACK_DAYS, intervalMinutes: e.SYNC_INTERVAL_MINUTES },
    maxTrackedRepos: e.MAX_TRACKED_REPOS,
    allowPrivateRepos: e.ALLOW_PRIVATE_REPOS,
  };
}
