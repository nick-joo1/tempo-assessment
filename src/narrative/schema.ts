import { z } from 'zod';
import { PeriodSchema } from '../insights/schema.js';

const factIds = z
  .array(z.string())
  .describe('Ids of the facts this rests on, copied exactly from the fact sheet.');

/**
 * What the model is asked to return. It is sent to the API as the structured-output
 * schema, so the field descriptions below are part of the prompt.
 */
export const NarrativeDraftSchema = z.object({
  headline: z
    .string()
    .describe('One sentence: the single observation most worth acting on or knowing.'),
  summary: z.string().describe('Two to four sentences that can be read on their own.'),
  findings: z
    .array(
      z.object({
        title: z.string().describe('A short label for the observation.'),
        detail: z.string().describe('One to three sentences: what the numbers show.'),
        evidence: factIds,
      }),
    )
    .describe('Two to five observations, most important first.'),
  hypothesis: z
    .object({
      statement: z.string().describe('The suspected root cause, phrased as a hypothesis.'),
      reasoning: z.string().describe('How the cited facts, taken together, point to it.'),
      evidence: factIds,
      alternatives: z
        .array(z.string())
        .describe('Other explanations these facts cannot rule out. At least one.'),
      nextCheck: z
        .string()
        .describe('One concrete thing a person could look at to confirm or refute it.'),
    })
    .nullable()
    .describe('Null unless at least two independent signals point the same way.'),
  confidence: z.object({
    score: z.number().describe('Between 0 and 1: how likely this reading of the data is right.'),
    rationale: z.string().describe('One or two sentences on what raises or limits the score.'),
  }),
  caveats: z
    .array(z.string())
    .describe('Limits of this particular data set, such as a small sample. May be empty.'),
});
export type NarrativeDraft = z.infer<typeof NarrativeDraftSchema>;

const EvidenceSchema = z.array(
  z.object({
    fact: z.string().describe('Id of a value in the review-flow insight for the same period.'),
    value: z
      .union([z.number(), z.string()])
      .nullable()
      .describe('The value of that fact, resolved by the server rather than quoted by the model.'),
  }),
);

/** What the API returns: the model's draft with evidence resolved and verification attached. */
export const NarrativeSchema = z.object({
  repository: z.string(),
  period: PeriodSchema,
  baselinePeriod: PeriodSchema.nullable(),
  dataAsOf: z.string().describe('When the underlying data was last synced from GitHub.'),
  headline: z.string(),
  summary: z.string(),
  findings: z.array(z.object({ title: z.string(), detail: z.string(), evidence: EvidenceSchema })),
  hypothesis: z
    .object({
      statement: z.string(),
      reasoning: z.string(),
      evidence: EvidenceSchema,
      alternatives: z.array(z.string()),
      nextCheck: z.string(),
    })
    .nullable()
    .describe('A root-cause hypothesis, or null when the signal does not support one.'),
  confidence: z.object({
    score: z.number().describe('The model’s score, limited to `ceiling`. Between 0 and 1.'),
    modelScore: z.number().nullable().describe('The score as the model reported it.'),
    ceiling: z
      .number()
      .describe('The highest score the sample size and baseline coverage can justify.'),
    ceilingReason: z.string(),
    rationale: z.string(),
  }),
  caveats: z.array(z.string()),
  verification: z.object({
    status: z
      .enum(['verified', 'flagged'])
      .describe(
        '`verified`: every cited fact exists and every number in the text matches a cited fact. `flagged`: it does not, even after one repair attempt; treat the text with suspicion.',
      ),
    issues: z.array(z.string()),
    attempts: z.number().int().describe('Model calls it took: 0 (none needed), 1 or 2.'),
  }),
  model: z.string().nullable().describe('Null when no model call was needed.'),
  generatedAt: z.string(),
  cached: z.boolean(),
});
export type Narrative = z.infer<typeof NarrativeSchema>;

/** The part of a narrative that is generated once and then cached. */
export type GeneratedNarrative = Omit<
  Narrative,
  'repository' | 'period' | 'baselinePeriod' | 'dataAsOf' | 'cached'
>;
