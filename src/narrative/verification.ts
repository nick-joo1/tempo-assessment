import type { ReviewFlowInsight } from '../insights/schema.js';
import { type FactSheet, type FactValue, subjectOf } from './facts.js';
import type { NarrativeDraft } from './schema.js';

/** Facts any part of a narrative may quote without citing them. */
const ALWAYS_QUOTABLE = ['period', 'baselinePeriod'];
/** Whole numbers up to this are read as counting words ("the top 3 reviewers"), not as data. */
const LARGEST_UNCHECKED_INTEGER = 10;
const MAX_REPORTED_ISSUES = 12;

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g;
const PULL_REQUEST_REF = /#(\d+)/g;
/**
 * A number in prose, with or without thousands separators. Digits glued to a preceding
 * letter ("P90") and ordinals ("90th") are names rather than quantities, and are skipped.
 */
const NUMBER = /(?<![A-Za-z\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?!\d|(?:st|nd|rd|th)\b)(%?)/g;

/**
 * Checks a draft against the fact sheet it was written from and returns what is wrong
 * with it, in words the model can act on. An empty result means every citation resolves
 * and every number, date and pull request in the text is backed by a cited fact.
 *
 * This verifies that the numbers are real, not that the reasoning about them is sound;
 * the latter is what the evals are for.
 */
export function verifyDraft(draft: NarrativeDraft, facts: FactSheet): string[] {
  const issues: string[] = [];
  const valuesBySubject = groupValuesBySubject(facts);
  const known = knownReferences(facts);
  const alwaysQuotable = ALWAYS_QUOTABLE.flatMap((subject) => valuesBySubject.get(subject) ?? []);
  const quotedSomewhere: FactValue[] = [...alwaysQuotable];

  const cited = [
    ...draft.findings.map((finding, index) => ({
      name: `findings[${index}]`,
      texts: [finding.title, finding.detail],
      evidence: finding.evidence,
    })),
    ...(draft.hypothesis
      ? [
          {
            name: 'hypothesis',
            texts: [
              draft.hypothesis.statement,
              draft.hypothesis.reasoning,
              draft.hypothesis.nextCheck,
              ...draft.hypothesis.alternatives,
            ],
            evidence: draft.hypothesis.evidence,
          },
        ]
      : []),
  ];

  if (draft.findings.length === 0) issues.push('findings: at least one finding is required');
  if (draft.hypothesis && draft.hypothesis.alternatives.length === 0) {
    issues.push('hypothesis: name at least one alternative explanation');
  }

  for (const { name, texts, evidence } of cited) {
    if (evidence.length === 0) issues.push(`${name}: cites no evidence`);
    const quotable = [...alwaysQuotable];
    for (const id of evidence) {
      if (facts.has(id)) quotable.push(...(valuesBySubject.get(subjectOf(id)) ?? []));
      else issues.push(`${name}: cites '${id}', which is not a fact id in the fact sheet`);
    }
    quotedSomewhere.push(...quotable);
    issues.push(...unbackedReferences(name, texts, quotable, known, 'a fact it cites'));
  }

  const uncited = {
    headline: [draft.headline],
    summary: [draft.summary],
    confidence: [draft.confidence.rationale],
    caveats: draft.caveats,
  };
  for (const [name, texts] of Object.entries(uncited)) {
    issues.push(
      ...unbackedReferences(name, texts, quotedSomewhere, known, 'a fact cited as evidence'),
    );
  }

  return issues.slice(0, MAX_REPORTED_ISSUES);
}

function groupValuesBySubject(facts: FactSheet): Map<string, FactValue[]> {
  const bySubject = new Map<string, FactValue[]>();
  for (const [id, value] of facts) {
    const subject = subjectOf(id);
    const values = bySubject.get(subject);
    if (values) values.push(value);
    else bySubject.set(subject, [value]);
  }
  return bySubject;
}

/** The dates and pull request numbers that appear anywhere in the fact sheet. */
function knownReferences(facts: FactSheet): { dates: Set<string>; pullRequests: Set<string> } {
  const sheet = [...facts].map(([id, value]) => `${id} ${value}`).join('\n');
  return {
    dates: new Set(sheet.match(ISO_DATE)),
    pullRequests: new Set([...sheet.matchAll(PULL_REQUEST_REF)].map((match) => match[1] ?? '')),
  };
}

function unbackedReferences(
  name: string,
  texts: readonly string[],
  quotable: readonly FactValue[],
  known: ReturnType<typeof knownReferences>,
  expectation: string,
): string[] {
  const issues: string[] = [];
  const numbers = quotable.filter((value) => typeof value === 'number').map(Math.abs);

  for (const text of texts) {
    for (const date of text.match(ISO_DATE) ?? []) {
      if (!known.dates.has(date)) issues.push(`${name}: the date ${date} is not in the fact sheet`);
    }
    for (const [reference, number] of text.matchAll(PULL_REQUEST_REF)) {
      if (!known.pullRequests.has(number ?? '')) {
        issues.push(`${name}: pull request ${reference} is not in the fact sheet`);
      }
    }

    const prose = text.replace(ISO_DATE, ' ').replace(PULL_REQUEST_REF, ' ');
    for (const [, integer = '', fraction = '', percent] of prose.matchAll(NUMBER)) {
      const quoted = Number(integer.replaceAll(',', '') + fraction);
      if (!fraction && !percent && quoted <= LARGEST_UNCHECKED_INTEGER) continue;
      if (!numbers.some((value) => matchesQuoted(value, quoted, fraction))) {
        issues.push(`${name}: the number ${integer}${fraction}${percent} is not ${expectation}`);
      }
    }
  }
  return issues;
}

/**
 * Whether prose that says `quoted` can be a faithful rendering of `value`: either rounded
 * or truncated to the precision it was written with (40.8 may be written 40.8, 41 or 40).
 */
function matchesQuoted(value: number, quoted: number, fraction: string): boolean {
  const unit = 10 ** -Math.max(0, fraction.length - 1);
  const tolerance = unit * 1e-6;
  return value >= quoted - unit / 2 - tolerance && value < quoted + unit - tolerance;
}

export interface ConfidenceCeiling {
  value: number;
  reason: string;
}

/**
 * The most confidence the amount of data can justify, whatever the model reports. A model
 * is asked to calibrate, but a hard limit derived from the sample is cheap insurance
 * against a fluent, overconfident reading of a handful of pull requests.
 */
export function confidenceCeiling(insight: ReviewFlowInsight): ConfidenceCeiling {
  const { current, baseline } = insight.metrics.mergedPullRequests;
  const sample = current ?? 0;
  if (sample < 5) {
    return { value: 0.3, reason: 'Fewer than 5 pull requests were merged in the period.' };
  }
  if (sample < 20) {
    return { value: 0.6, reason: 'Fewer than 20 pull requests were merged in the period.' };
  }
  if ((baseline ?? 0) < 5) {
    return { value: 0.7, reason: 'There is no usable baseline period to compare against.' };
  }
  return {
    value: 0.9,
    reason: 'Pull request metadata shows where time goes, but cannot prove why.',
  };
}
