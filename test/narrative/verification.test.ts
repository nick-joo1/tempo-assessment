import { describe, expect, it } from 'vitest';
import type { ReviewFlowInsight } from '../../src/insights/schema.js';
import { buildFactSheet, renderFactSheet } from '../../src/narrative/facts.js';
import type { NarrativeDraft } from '../../src/narrative/schema.js';
import { confidenceCeiling, verifyDraft } from '../../src/narrative/verification.js';
import { slowdownInsight, soundDraft } from './fixtures.js';

const insight = slowdownInsight();
const facts = buildFactSheet(insight);

/** The sound draft plus one more finding, which verification reports as `findings[3]`. */
function withFinding(detail: string, evidence: string[]): NarrativeDraft {
  const draft = soundDraft();
  return {
    ...draft,
    findings: [...draft.findings, { title: 'Another finding', detail, evidence }],
  };
}

describe('the fact sheet', () => {
  it('gives every value of the insight a stable id', () => {
    expect(facts.get('period.from')).toBe('2026-10-15');
    expect(facts.get('baselinePeriod.to')).toBe('2026-10-14');
    expect(facts.get('metrics.cycleTimeP50Hours.current')).toBe(30.5);
    expect(facts.get('metrics.cycleTimeP50Hours.baseline')).toBe(12);
    expect(facts.get('metrics.cycleTimeP50Hours.delta')).toBe(18.5);
    expect(facts.get('metrics.cycleTimeP50Hours.changePct')).toBe(154.2);
    expect(facts.get('metrics.timeToFirstReviewP50Hours.delta')).toBe(22.5);
    expect(facts.get('metrics.firstReviewToMergeP50Hours.changePct')).toBe(-50);
    expect(facts.get('weekly[2026-10-15].mergedPullRequests')).toBe(7);
    expect(facts.get('sizeBuckets[M].pullRequests')).toBe(21);
    expect(facts.get('topReviewers[bob].sharePct')).toBe(100);
    expect(facts.get('topAuthors[alice].linesChanged')).toBe(1650);
    expect(facts.get('slowestPullRequests[#200].cycleTimeHours')).toBe(30.5);
  });

  it('renders one fact per line and marks missing values', () => {
    const rendered = renderFactSheet(facts).split('\n');

    expect(rendered).toHaveLength(facts.size);
    expect(rendered).toContain('metrics.cycleTimeP50Hours.delta = 18.5');
    expect(rendered).toContain('metrics.mergedWithoutReviewPct.changePct = n/a');
  });
});

describe('verifyDraft', () => {
  it('accepts a draft whose numbers all come from the facts it cites', () => {
    expect(verifyDraft(soundDraft(), facts)).toEqual([]);
  });

  it('accepts a value that is rounded, truncated or written with separators', () => {
    const draft = withFinding(
      'Cycle time rose by 154.2%, or about 154%; the median is now 31 hours (30 and a half). alice changed 1,650 lines.',
      ['metrics.cycleTimeP50Hours.changePct', 'topAuthors[alice].linesChanged'],
    );

    expect(verifyDraft(draft, facts)).toEqual([]);
  });

  it('accepts the magnitude of a negative change', () => {
    const draft = withFinding('Getting from first review to merge took 50% less time.', [
      'metrics.firstReviewToMergeP50Hours.changePct',
    ]);

    expect(verifyDraft(draft, facts)).toEqual([]);
  });

  it('does not mistake names, ordinals and small counts for data', () => {
    const draft = withFinding(
      'The P90 (the 90th percentile) and the top 3 reviewers tell the same story.',
      ['metrics.cycleTimeP90Hours.current'],
    );

    expect(verifyDraft(draft, facts)).toEqual([]);
  });

  it('rejects a number that is not in the fact sheet', () => {
    const draft = withFinding('The median went from 12 hours to 45.5 hours.', [
      'metrics.cycleTimeP50Hours.delta',
    ]);

    expect(verifyDraft(draft, facts)).toEqual([
      'findings[3]: the number 45.5 is not a fact it cites',
    ]);
  });

  it('rejects a real number quoted without citing where it comes from', () => {
    const draft = withFinding('Pull requests waited a median of 26.5 hours for a first review.', [
      'metrics.cycleTimeP50Hours.delta',
    ]);

    expect(verifyDraft(draft, facts)).toEqual([
      'findings[3]: the number 26.5 is not a fact it cites',
    ]);
  });

  it('rejects values converted into another unit', () => {
    const draft = withFinding('The median is now 1.3 days, which is 1,830 minutes.', [
      'metrics.cycleTimeP50Hours.current',
    ]);

    expect(verifyDraft(draft, facts)).toEqual([
      'findings[3]: the number 1.3 is not a fact it cites',
      'findings[3]: the number 1,830 is not a fact it cites',
    ]);
  });

  it('rejects a citation that is not a fact id', () => {
    const draft = withFinding('Something changed.', [
      'metrics.cycleTimeP50Hours',
      'metrics.velocity.current',
    ]);

    expect(verifyDraft(draft, facts)).toEqual([
      "findings[3]: cites 'metrics.cycleTimeP50Hours', which is not a fact id in the fact sheet",
      "findings[3]: cites 'metrics.velocity.current', which is not a fact id in the fact sheet",
    ]);
  });

  it('rejects dates and pull requests that are not in the fact sheet', () => {
    const draft = withFinding(
      'Things changed on 2026-10-20 with #999, unlike on 2026-10-15 with #200.',
      ['slowestPullRequests[#200].cycleTimeHours'],
    );

    expect(verifyDraft(draft, facts)).toEqual([
      'findings[3]: the date 2026-10-20 is not in the fact sheet',
      'findings[3]: pull request #999 is not in the fact sheet',
    ]);
  });

  it('holds the headline and summary to what the findings cite', () => {
    const draft = soundDraft({
      headline: 'Cycle time rose to 30.5 hours.',
      summary: 'Review throughput fell by 37% over the period.',
    });

    expect(verifyDraft(draft, facts)).toEqual([
      'summary: the number 37% is not a fact cited as evidence',
    ]);
  });

  it('requires findings, evidence and an alternative to every hypothesis', () => {
    const sound = soundDraft();
    const draft = soundDraft({
      findings: [],
      hypothesis: sound.hypothesis && { ...sound.hypothesis, evidence: [], alternatives: [] },
    });

    expect(verifyDraft(draft, facts)).toEqual(
      expect.arrayContaining([
        'findings: at least one finding is required',
        'hypothesis: name at least one alternative explanation',
        'hypothesis: cites no evidence',
      ]),
    );
  });

  it('reports at most a dozen issues, enough for a repair without flooding the prompt', () => {
    const invented = Array.from({ length: 30 }, (_, index) => `${1000 + index} units`);
    const draft = withFinding(invented.join(', '), ['metrics.cycleTimeP50Hours.current']);

    expect(verifyDraft(draft, facts)).toHaveLength(12);
  });
});

describe('confidenceCeiling', () => {
  const withSample = (current: number, baseline: number | null): ReviewFlowInsight => ({
    ...insight,
    metrics: {
      ...insight.metrics,
      mergedPullRequests: { current, baseline, delta: null, changePct: null },
    },
  });

  it.each([
    [4, 40, 0.3],
    [19, 40, 0.6],
    [20, null, 0.7],
    [20, 4, 0.7],
    [20, 5, 0.9],
  ])('for %i pull requests against a baseline of %s is %f', (current, baseline, ceiling) => {
    expect(confidenceCeiling(withSample(current, baseline)).value).toBe(ceiling);
  });

  it('never allows certainty: the data shows where time went, not why', () => {
    expect(confidenceCeiling(withSample(5000, 5000)).value).toBeLessThan(1);
  });
});
