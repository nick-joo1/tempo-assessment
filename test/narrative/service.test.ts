import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePeriod } from '../../src/insights/period.js';
import { computeReviewFlow } from '../../src/insights/review-flow.js';
import type { ReviewFlowInsight } from '../../src/insights/schema.js';
import { type NarrativeModel, NarrativeModelError } from '../../src/narrative/model.js';
import type { NarrativeDraft } from '../../src/narrative/schema.js';
import { NarrativeNotConfiguredError, NarrativeService } from '../../src/narrative/service.js';
import { openDatabase } from '../../src/store/database.js';
import { NarrativeCache } from '../../src/store/narratives.js';
import { RepoStore } from '../../src/store/repos.js';
import { pullRequest } from '../helpers.js';
import { slowdownInsight, soundDraft } from './fixtures.js';

const NOW = new Date('2026-11-11T09:00:00Z');

/** A model that answers with the given drafts or failures, in order. */
class ScriptedModel implements NarrativeModel {
  readonly id = 'test-model';
  readonly fingerprint = 'test-model/medium';
  readonly prompts: { system: string; user: string }[] = [];
  readonly #answers: (NarrativeDraft | Error | Promise<NarrativeDraft>)[];

  constructor(...answers: (NarrativeDraft | Error | Promise<NarrativeDraft>)[]) {
    this.#answers = answers;
  }

  async draft(prompt: { system: string; user: string }): Promise<NarrativeDraft> {
    this.prompts.push(prompt);
    const answer = this.#answers.shift();
    if (!answer) throw new Error('The test did not expect another model call');
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

const unbacked = () => soundDraft({ summary: 'Review throughput fell by 37% over the period.' });

let cache: NarrativeCache;
let repoId: number;

beforeEach(() => {
  const db = openDatabase(':memory:');
  cache = new NarrativeCache(db);
  repoId = new RepoStore(db).insert(
    { owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    0,
  ).id;
});

function serviceWith(model: NarrativeModel | null): NarrativeService {
  return new NarrativeService({
    model,
    cache,
    clock: () => NOW,
    logger: pino({ level: 'silent' }),
  });
}

describe('a verified narrative', () => {
  it('carries the insight it describes and evidence resolved by the server', async () => {
    const insight = slowdownInsight();
    const model = new ScriptedModel(soundDraft());

    const narrative = await serviceWith(model).narrate(repoId, insight);

    expect(narrative).toMatchObject({
      repository: 'acme/widgets',
      period: insight.period,
      baselinePeriod: insight.baselinePeriod,
      dataAsOf: insight.dataAsOf,
      headline: soundDraft().headline,
      verification: { status: 'verified', issues: [], attempts: 1 },
      model: 'test-model',
      generatedAt: NOW.toISOString(),
      cached: false,
    });
    expect(narrative.findings[0]?.evidence).toEqual([
      { fact: 'metrics.cycleTimeP50Hours.delta', value: 18.5 },
    ]);
    expect(narrative.hypothesis?.evidence).toEqual([
      { fact: 'metrics.timeToFirstReviewP50Hours.delta', value: 22.5 },
      { fact: 'metrics.reviewersForHalfOfReviews.current', value: 1 },
    ]);
  });

  it('gives the model the fact sheet as data and nothing else about the repository', async () => {
    const model = new ScriptedModel(soundDraft());

    await serviceWith(model).narrate(repoId, slowdownInsight());

    const [prompt] = model.prompts;
    expect(prompt?.user).toContain('Repository: acme/widgets');
    expect(prompt?.user).toContain('metrics.cycleTimeP50Hours.delta = 18.5');
    expect(prompt?.system).toContain('cycleTimeP50Hours: Median hours from pull request creation');
    expect(prompt?.system).not.toContain('acme');
  });

  it('limits the confidence to what the sample can justify, and says so', async () => {
    const model = new ScriptedModel(
      soundDraft({ confidence: { score: 0.99, rationale: 'Sure.' } }),
    );

    const { confidence } = await serviceWith(model).narrate(repoId, slowdownInsight());

    expect(confidence).toEqual({
      score: 0.9,
      modelScore: 0.99,
      ceiling: 0.9,
      ceilingReason: 'Pull request metadata shows where time goes, but cannot prove why.',
      rationale: 'Sure.',
    });
  });

  it('keeps a confidence below the ceiling as the model reported it', async () => {
    const model = new ScriptedModel(
      soundDraft({ confidence: { score: 0.55, rationale: 'Mixed.' } }),
    );

    const { confidence } = await serviceWith(model).narrate(repoId, slowdownInsight());

    expect(confidence).toMatchObject({ score: 0.55, modelScore: 0.55, ceiling: 0.9 });
  });
});

describe('caching', () => {
  it('serves a verified narrative from the cache while the numbers are unchanged', async () => {
    const model = new ScriptedModel(soundDraft());
    const service = serviceWith(model);
    const first = await service.narrate(repoId, slowdownInsight());

    // A later sync that changes no number only moves `dataAsOf`.
    const resynced = { ...slowdownInsight(), dataAsOf: '2026-11-11T10:00:00.000Z' };
    const second = await service.narrate(repoId, resynced);

    expect(model.prompts).toHaveLength(1);
    expect(second).toEqual({ ...first, dataAsOf: resynced.dataAsOf, cached: true });
  });

  it('survives a restart, because the cache is in the database', async () => {
    await serviceWith(new ScriptedModel(soundDraft())).narrate(repoId, slowdownInsight());

    const afterRestart = await serviceWith(new ScriptedModel()).narrate(repoId, slowdownInsight());

    expect(afterRestart.cached).toBe(true);
  });

  it('writes a new narrative when a number changes', async () => {
    const model = new ScriptedModel(soundDraft(), soundDraft());
    const service = serviceWith(model);
    const insight = slowdownInsight();
    await service.narrate(repoId, insight);

    const changed: ReviewFlowInsight = {
      ...insight,
      metrics: {
        ...insight.metrics,
        prSizeP50Lines: { ...insight.metrics.prSizeP50Lines, current: 151 },
      },
    };
    const narrative = await service.narrate(repoId, changed);

    expect(model.prompts).toHaveLength(2);
    expect(narrative.cached).toBe(false);
  });

  it('shares one model call between concurrent requests for the same narrative', async () => {
    let release: (draft: NarrativeDraft) => void = () => undefined;
    const pending = new Promise<NarrativeDraft>((resolve) => {
      release = resolve;
    });
    const model = new ScriptedModel(pending);
    const service = serviceWith(model);

    const both = Promise.all([
      service.narrate(repoId, slowdownInsight()),
      service.narrate(repoId, slowdownInsight()),
    ]);
    release(soundDraft());
    const [first, second] = await both;

    expect(model.prompts).toHaveLength(1);
    expect(first.headline).toBe(second.headline);
  });
});

describe('a draft that fails verification', () => {
  it('is sent back once with the issues, and the repaired draft is used', async () => {
    const model = new ScriptedModel(unbacked(), soundDraft());

    const narrative = await serviceWith(model).narrate(repoId, slowdownInsight());

    expect(narrative.verification).toEqual({ status: 'verified', issues: [], attempts: 2 });
    expect(narrative.summary).toBe(soundDraft().summary);
    const repair = model.prompts[1]?.user ?? '';
    expect(repair).toContain('- summary: the number 37% is not a fact cited as evidence');
    expect(repair).toContain('Review throughput fell by 37% over the period.');
    expect(repair).toContain('metrics.cycleTimeP50Hours.delta = 18.5');
  });

  it('is returned flagged when the repair fails too, and is not cached', async () => {
    const model = new ScriptedModel(unbacked(), unbacked(), soundDraft());
    const service = serviceWith(model);

    const flagged = await service.narrate(repoId, slowdownInsight());
    expect(flagged.verification).toEqual({
      status: 'flagged',
      issues: ['summary: the number 37% is not a fact cited as evidence'],
      attempts: 2,
    });

    const next = await service.narrate(repoId, slowdownInsight());
    expect(next).toMatchObject({ cached: false, verification: { status: 'verified' } });
    expect(model.prompts).toHaveLength(3);
  });

  it('keeps the original when the repair is worse', async () => {
    const worse = soundDraft({
      headline: 'Cycle time rose by 61%.',
      summary: 'Throughput fell by 37% and 88 pull requests stalled.',
    });
    const model = new ScriptedModel(unbacked(), worse);

    const narrative = await serviceWith(model).narrate(repoId, slowdownInsight());

    expect(narrative.summary).toBe(unbacked().summary);
    expect(narrative.verification.issues).toHaveLength(1);
  });

  it('drops citations that do not resolve from the evidence it returns', async () => {
    const [first, ...rest] = soundDraft().findings;
    const invented = soundDraft({
      findings: [
        { ...first, evidence: ['metrics.cycleTimeP50Hours.delta', 'metrics.velocity.current'] },
        ...rest,
      ] as NarrativeDraft['findings'],
    });
    const model = new ScriptedModel(invented, invented);

    const narrative = await serviceWith(model).narrate(repoId, slowdownInsight());

    expect(narrative.verification.status).toBe('flagged');
    expect(narrative.findings[0]?.evidence).toEqual([
      { fact: 'metrics.cycleTimeP50Hours.delta', value: 18.5 },
    ]);
  });
});

describe('without anything to narrate', () => {
  const emptyInsight = (bots = 0) =>
    computeReviewFlow({
      repository: 'acme/widgets',
      period: resolvePeriod({ from: '2026-10-01', to: '2026-10-07' }, NOW),
      baselineCovered: false,
      pullRequests: Array.from({ length: bots }, (_, index) =>
        pullRequest({
          number: index + 1,
          author: 'dependabot[bot]',
          authorIsBot: true,
          created: '2026-10-01',
          merged: '2026-10-02',
        }),
      ),
      dataAsOf: NOW,
    });

  it('answers deterministically, without a model call or a configured model', async () => {
    const narrative = await serviceWith(null).narrate(repoId, emptyInsight());

    expect(narrative).toMatchObject({
      headline: 'No pull requests by human authors were merged between 2026-10-01 and 2026-10-07.',
      findings: [],
      hypothesis: null,
      confidence: { score: 1, modelScore: null },
      verification: { status: 'verified', issues: [], attempts: 0 },
      model: null,
      cached: false,
    });
  });

  it('mentions bot merges, which the metrics leave out', async () => {
    const narrative = await serviceWith(null).narrate(repoId, emptyInsight(3));

    expect(narrative.summary).toContain('3 bot-authored pull request(s)');
  });
});

describe('failures', () => {
  it('reports a missing model as not configured', async () => {
    await expect(serviceWith(null).narrate(repoId, slowdownInsight())).rejects.toBeInstanceOf(
      NarrativeNotConfiguredError,
    );
  });

  it('passes model failures on and caches nothing, so the next request tries again', async () => {
    const failure = new NarrativeModelError(
      'unavailable',
      'The model provider could not be reached',
    );
    const model = new ScriptedModel(failure, soundDraft());
    const service = serviceWith(model);

    await expect(service.narrate(repoId, slowdownInsight())).rejects.toBe(failure);
    await expect(service.narrate(repoId, slowdownInsight())).resolves.toMatchObject({
      cached: false,
      verification: { status: 'verified' },
    });
  });
});
