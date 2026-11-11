import { createHash } from 'node:crypto';
import type { BaseLogger } from 'pino';
import type { Clock } from '../domain.js';
import type { ReviewFlowInsight } from '../insights/schema.js';
import type { NarrativeCache } from '../store/narratives.js';
import { buildFactSheet, type FactSheet, renderFactSheet } from './facts.js';
import type { NarrativeModel } from './model.js';
import { draftPrompt, PROMPT_VERSION, repairPrompt, SYSTEM_PROMPT } from './prompt.js';
import type { GeneratedNarrative, Narrative, NarrativeDraft } from './schema.js';
import { confidenceCeiling, verifyDraft } from './verification.js';

export class NarrativeNotConfiguredError extends Error {
  override name = 'NarrativeNotConfiguredError';
}

export interface NarrativeServiceOptions {
  /** Null when no API key is configured. */
  model: NarrativeModel | null;
  cache: NarrativeCache;
  clock: Clock;
  logger: BaseLogger;
}

/**
 * Turns a review-flow insight into a narrative that can be traced back to it.
 *
 * The model receives the insight as a sheet of identified facts, must cite those ids as
 * evidence, and has its draft verified against the same sheet. A draft that fails gets
 * one chance at repair; if that fails too it is returned flagged rather than hidden, and
 * is not cached. The server, not the model, resolves the value of each cited fact.
 */
export class NarrativeService {
  readonly #options: NarrativeServiceOptions;
  readonly #inFlight = new Map<string, Promise<GeneratedNarrative>>();

  constructor(options: NarrativeServiceOptions) {
    this.#options = options;
  }

  async narrate(repoId: number, insight: ReviewFlowInsight): Promise<Narrative> {
    const { generated, cached } = await this.#generatedFor(repoId, insight);
    return {
      repository: insight.repository,
      period: insight.period,
      baselinePeriod: insight.baselinePeriod,
      dataAsOf: insight.dataAsOf,
      ...generated,
      cached,
    };
  }

  async #generatedFor(
    repoId: number,
    insight: ReviewFlowInsight,
  ): Promise<{ generated: GeneratedNarrative; cached: boolean }> {
    const { model, cache } = this.#options;
    if (insight.metrics.mergedPullRequests.current === 0) {
      return { generated: this.#nothingToNarrate(insight), cached: false };
    }
    if (!model) throw new NarrativeNotConfiguredError('No language model is configured');

    const facts = buildFactSheet(insight);
    const factSheet = renderFactSheet(facts);
    // The key covers everything that determines the text, and nothing that does not: a
    // re-sync that changes no number leaves the fact sheet, and so the key, unchanged.
    const cacheKey = createHash('sha256')
      .update([PROMPT_VERSION, model.fingerprint, insight.repository, factSheet].join('\n'))
      .digest('hex');

    const stored = cache.get(cacheKey);
    if (stored) return { generated: JSON.parse(stored) as GeneratedNarrative, cached: true };

    // Concurrent requests for the same narrative share one model call.
    let generation = this.#inFlight.get(cacheKey);
    if (!generation) {
      generation = this.#generate(model, insight, facts, factSheet)
        .then((generated) => {
          if (generated.verification.status === 'verified') {
            cache.put(cacheKey, repoId, JSON.stringify(generated), this.#now());
          }
          return generated;
        })
        .finally(() => this.#inFlight.delete(cacheKey));
      this.#inFlight.set(cacheKey, generation);
    }
    return { generated: await generation, cached: false };
  }

  async #generate(
    model: NarrativeModel,
    insight: ReviewFlowInsight,
    facts: FactSheet,
    factSheet: string,
  ): Promise<GeneratedNarrative> {
    const { repository } = insight;
    let attempts = 1;
    let draft = await model.draft({
      system: SYSTEM_PROMPT,
      user: draftPrompt(repository, factSheet),
    });
    let issues = verifyDraft(draft, facts);

    if (issues.length > 0) {
      attempts = 2;
      const repaired = await model.draft({
        system: SYSTEM_PROMPT,
        user: repairPrompt(repository, factSheet, draft, issues),
      });
      const remaining = verifyDraft(repaired, facts);
      if (remaining.length <= issues.length) {
        draft = repaired;
        issues = remaining;
      }
    }

    this.#options.logger.info(
      { repository, model: model.id, attempts, unresolvedIssues: issues.length },
      'narrative generated',
    );
    return this.#finalize(draft, insight, facts, { issues, attempts, model: model.id });
  }

  #finalize(
    draft: NarrativeDraft,
    insight: ReviewFlowInsight,
    facts: FactSheet,
    outcome: { issues: string[]; attempts: number; model: string },
  ): GeneratedNarrative {
    const resolve = (ids: readonly string[]) =>
      [...new Set(ids)]
        .filter((id) => facts.has(id))
        .map((id) => ({ fact: id, value: facts.get(id) ?? null }));
    const ceiling = confidenceCeiling(insight);
    const modelScore = Math.min(1, Math.max(0, draft.confidence.score));

    return {
      headline: draft.headline,
      summary: draft.summary,
      findings: draft.findings.map((finding) => ({
        title: finding.title,
        detail: finding.detail,
        evidence: resolve(finding.evidence),
      })),
      hypothesis: draft.hypothesis && {
        ...draft.hypothesis,
        evidence: resolve(draft.hypothesis.evidence),
      },
      confidence: {
        score: Math.round(Math.min(modelScore, ceiling.value) * 100) / 100,
        modelScore,
        ceiling: ceiling.value,
        ceilingReason: ceiling.reason,
        rationale: draft.confidence.rationale,
      },
      caveats: draft.caveats,
      verification: {
        status: outcome.issues.length === 0 ? 'verified' : 'flagged',
        issues: outcome.issues,
        attempts: outcome.attempts,
      },
      model: outcome.model,
      generatedAt: new Date(this.#now()).toISOString(),
    };
  }

  /** An empty period needs no model: there is nothing to interpret and plenty to invent. */
  #nothingToNarrate(insight: ReviewFlowInsight): GeneratedNarrative {
    const { from, to } = insight.period;
    const bots = insight.metrics.botPullRequests.current ?? 0;
    return {
      headline: `No pull requests by human authors were merged between ${from} and ${to}.`,
      summary:
        bots > 0
          ? `The only merges in this period were ${bots} bot-authored pull request(s), which review-flow metrics leave out.`
          : 'There is no review activity to describe for this period.',
      findings: [],
      hypothesis: null,
      confidence: {
        score: 1,
        modelScore: null,
        ceiling: 1,
        ceilingReason: 'A count of zero needs no interpretation.',
        rationale: 'This statement is computed directly from the synced data.',
      },
      caveats: [],
      verification: { status: 'verified', issues: [], attempts: 0 },
      model: null,
      generatedAt: new Date(this.#now()).toISOString(),
    };
  }

  #now(): number {
    return this.#options.clock().getTime();
  }
}
