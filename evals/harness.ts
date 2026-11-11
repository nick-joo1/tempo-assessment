import type { BaseLogger } from 'pino';
import { type NarrativeModel, NarrativeModelError } from '../src/narrative/model.js';
import type { Narrative } from '../src/narrative/schema.js';
import { NarrativeService } from '../src/narrative/service.js';
import { openDatabase } from '../src/store/database.js';
import { NarrativeCache } from '../src/store/narratives.js';
import { RepoStore } from '../src/store/repos.js';
import type { Scenario } from './scenarios.js';

/**
 * What became of one scenario. The three outcomes are kept apart on purpose: a narrative
 * that fails its checks, a model that produced no usable narrative, and a call that never
 * reached the model say different things, and only the first two say anything about quality.
 */
export type CaseResult = { scenario: string; run: number } & (
  | { outcome: 'scored'; narrative: Narrative; failedChecks: string[] }
  | { outcome: 'model_failure'; reason: string }
  | { outcome: 'not_scored'; reason: string }
);

/**
 * Runs one scenario through the service the API serves narratives from: the production
 * prompt, verification, repair attempt and confidence ceiling. Each case gets an empty
 * cache, so repeated runs are independent samples rather than one cached answer.
 */
export async function runCase(
  scenario: Scenario,
  run: number,
  model: NarrativeModel,
  logger: BaseLogger,
): Promise<CaseResult> {
  const db = openDatabase(':memory:');
  try {
    const repo = new RepoStore(db).insert(
      { owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      0,
    );
    const service = new NarrativeService({
      model,
      cache: new NarrativeCache(db),
      clock: () => new Date(),
      logger,
    });
    const narrative = await service.narrate(repo.id, scenario.insight);
    return {
      scenario: scenario.name,
      run,
      outcome: 'scored',
      narrative,
      failedChecks: scenario.checks
        .filter((check) => !check.passes(narrative))
        .map((check) => check.name),
    };
  } catch (error) {
    if (!(error instanceof NarrativeModelError)) throw error;
    const answered = error.code === 'refused' || error.code === 'invalid_output';
    return {
      scenario: scenario.name,
      run,
      outcome: answered ? 'model_failure' : 'not_scored',
      reason: error.message,
    };
  } finally {
    db.close();
  }
}
