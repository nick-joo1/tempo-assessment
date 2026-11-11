import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { loadConfig } from '../src/config.js';
import { AnthropicNarrativeModel } from '../src/narrative/model.js';
import { PROMPT_VERSION } from '../src/narrative/prompt.js';
import { type CaseResult, runCase } from './harness.js';
import { SCENARIOS } from './scenarios.js';

/**
 * Runs every scenario against the configured model and reports which checks hold.
 *
 *   npm run eval                                  each scenario once
 *   npm run eval -- --runs 3                      three samples per scenario
 *   npm run eval -- --scenario steady-state       only the named scenario(s)
 *
 * Exit code 0: every check passed. 1: a check failed or the model produced no narrative.
 * 2: nothing failed, but some cases never reached the model, so the result is incomplete.
 */
const RESULTS_DIR = 'evals/results';

if (existsSync('.env')) process.loadEnvFile('.env');
const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    scenario: { type: 'string', multiple: true },
  },
});

const runs = Number(args.runs);
const scenarios = args.scenario
  ? SCENARIOS.filter((scenario) => args.scenario?.includes(scenario.name))
  : SCENARIOS;
if (!Number.isInteger(runs) || runs < 1 || scenarios.length === 0) {
  console.error(
    `Usage: npm run eval -- [--runs <n>] [--scenario <name>]...\nScenarios: ${SCENARIOS.map((scenario) => scenario.name).join(', ')}`,
  );
  process.exit(2);
}

// The model and effort come from the configuration the server reads, so the evals measure
// what is deployed. They never call GitHub; the token only satisfies validation.
const { llm } = loadConfig({ ...process.env, GITHUB_TOKEN: 'unused' });
if (!llm.apiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env to run the evals.');
  process.exit(2);
}

/** Token usage is read from the log line the model client writes in production. */
interface ModelCall {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  durationMs: number;
}
const modelCalls: ModelCall[] = [];
const logger = pino(
  { level: 'info' },
  {
    write(line: string) {
      const entry = JSON.parse(line) as ModelCall & { msg: string };
      if (entry.msg === 'narrative model call') modelCalls.push(entry);
    },
  },
);
const model = new AnthropicNarrativeModel({
  apiKey: llm.apiKey,
  model: llm.model,
  effort: llm.effort,
  logger,
});

console.log(`Model ${llm.model}, effort ${llm.effort}, prompt version ${PROMPT_VERSION}\n`);
const startedAt = new Date();
const results: CaseResult[] = [];
// One case at a time: slower than a burst, but it stays inside the rate limits of a new key.
for (let run = 1; run <= runs; run += 1) {
  for (const scenario of scenarios) {
    const result = await runCase(scenario, run, model, logger);
    results.push(result);
    console.log(`${scenario.name.padEnd(22)} run ${run}  ${describe(result)}`);
  }
}

function describe(result: CaseResult): string {
  if (result.outcome === 'not_scored') return `NOT SCORED  ${result.reason}`;
  if (result.outcome === 'model_failure') return `FAIL  ${result.reason}`;
  if (result.failedChecks.length > 0) return `FAIL  ${result.failedChecks.join('; ')}`;
  return 'PASS';
}

const scored = results.filter((result) => result.outcome === 'scored');
const passed = scored.filter((result) => result.failedChecks.length === 0);
const modelFailures = results.filter((result) => result.outcome === 'model_failure');
const notScored = results.filter((result) => result.outcome === 'not_scored');
const firstDraft = scored.filter((result) => result.narrative.verification.attempts <= 1);

console.log('\nChecks, passed of scored cases:');
for (const scenario of scenarios) {
  const cases = scored.filter((result) => result.scenario === scenario.name);
  for (const check of scenario.checks) {
    const held = cases.filter((result) => !result.failedChecks.includes(check.name));
    console.log(`  ${held.length}/${cases.length}  ${scenario.name}: ${check.name}`);
  }
}

const sum = (pick: (call: ModelCall) => number) =>
  modelCalls.reduce((total, call) => total + pick(call), 0).toLocaleString('en-US');
console.log(
  [
    '',
    `Cases: ${passed.length} passed, ${scored.length - passed.length} failed their checks, ${modelFailures.length} without a usable narrative, ${notScored.length} not scored`,
    `Verified on the first draft: ${firstDraft.length} of ${scored.length}`,
    `Model calls: ${modelCalls.length}; tokens: ${sum((call) => call.inputTokens)} input, ${sum((call) => call.cachedInputTokens ?? 0)} read from cache, ${sum((call) => call.outputTokens)} output; ${sum((call) => Math.round(call.durationMs / 1000))} s in total`,
  ].join('\n'),
);

mkdirSync(RESULTS_DIR, { recursive: true });
const resultsPath = `${RESULTS_DIR}/${startedAt.toISOString().replaceAll(':', '-')}.json`;
writeFileSync(
  resultsPath,
  JSON.stringify(
    { startedAt, model: llm.model, effort: llm.effort, promptVersion: PROMPT_VERSION, results },
    null,
    2,
  ),
);
console.log(`Narratives and outcomes written to ${resultsPath}`);

if (passed.length < scored.length || modelFailures.length > 0) process.exitCode = 1;
else if (notScored.length > 0) process.exitCode = 2;
