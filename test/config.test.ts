import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('needs nothing but a GitHub token', () => {
    expect(loadConfig({ GITHUB_TOKEN: 'ghp_example' })).toEqual({
      env: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      databasePath: './data/review-flow.db',
      githubToken: 'ghp_example',
      llm: { apiKey: undefined, model: 'claude-opus-5-5', effort: 'medium' },
      sync: { lookbackDays: 180, intervalMinutes: 15 },
      maxTrackedRepos: 25,
      allowPrivateRepos: false,
    });
  });

  it('reads numbers and flags from their string form', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'ghp_example',
      PORT: '8080',
      SYNC_INTERVAL_MINUTES: '0',
      ALLOW_PRIVATE_REPOS: 'true',
    });

    expect(config).toMatchObject({
      port: 8080,
      sync: { intervalMinutes: 0 },
      allowPrivateRepos: true,
    });
  });

  it('treats an empty assignment, as left in a copied .env.example, as not set', () => {
    const config = loadConfig({ GITHUB_TOKEN: 'ghp_example', ANTHROPIC_API_KEY: '', PORT: '' });

    expect(config.llm.apiKey).toBeUndefined();
    expect(config.port).toBe(3000);
    expect(() => loadConfig({ GITHUB_TOKEN: '' })).toThrow('GITHUB_TOKEN is required');
  });

  it('names every offending variable and never echoes a value', () => {
    const load = () =>
      loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-secret', PORT: 'eighty', LLM_EFFORT: 'sk-oops' });

    expect(load).toThrow(ConfigError);
    expect(load).toThrow('GITHUB_TOKEN is required');
    expect(load).toThrow('PORT: Invalid input');
    expect(load).toThrow('LLM_EFFORT: Invalid option');
    expect(load).not.toThrow(/sk-ant-secret|eighty|sk-oops/);
  });
});
