import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BaseLogger } from 'pino';
import { type NarrativeDraft, NarrativeDraftSchema } from './schema.js';

const REQUEST_TIMEOUT_MS = 90_000;
/** Room for thinking plus a narrative of a few hundred words. */
const MAX_OUTPUT_TOKENS = 16_000;

export type NarrativeModelErrorCode =
  | 'unavailable'
  | 'rate_limited'
  | 'refused'
  | 'invalid_output'
  | 'misconfigured';

export class NarrativeModelError extends Error {
  override name = 'NarrativeModelError';

  constructor(
    readonly code: NarrativeModelErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** The one capability the narrative service needs from a language model. */
export interface NarrativeModel {
  /** Model id, reported with every narrative. */
  readonly id: string;
  /** Everything about the model's configuration that changes what it writes. */
  readonly fingerprint: string;
  /** @throws NarrativeModelError */
  draft(prompt: { system: string; user: string }): Promise<NarrativeDraft>;
}

export interface AnthropicModelOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  logger: BaseLogger;
  fetch?: typeof globalThis.fetch;
}

export class AnthropicNarrativeModel implements NarrativeModel {
  readonly id: string;
  readonly fingerprint: string;
  readonly #client: Anthropic;
  readonly #effort: AnthropicModelOptions['effort'];
  readonly #logger: BaseLogger;
  readonly #format = zodOutputFormat(NarrativeDraftSchema);

  constructor(options: AnthropicModelOptions) {
    this.id = options.model;
    this.fingerprint = `${options.model}/${options.effort}`;
    this.#effort = options.effort;
    this.#logger = options.logger;
    // The SDK retries rate limits, overloads and connection errors with backoff.
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 2,
      timeout: REQUEST_TIMEOUT_MS,
      fetch: options.fetch,
    });
  }

  async draft(prompt: { system: string; user: string }): Promise<NarrativeDraft> {
    const startedAt = performance.now();
    const message = await this.#client.messages
      .create({
        model: this.id,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'adaptive' },
        // The instructions are identical for every repository and period, so they are
        // cached; only the fact sheet is paid for at the full input rate.
        system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt.user }],
        output_config: { effort: this.#effort, format: this.#format },
      })
      .catch((error: unknown) => {
        const failure = toModelError(error);
        this.#logger.warn(
          {
            code: failure.code,
            requestId: error instanceof Anthropic.APIError ? error.requestID : undefined,
            reason: error instanceof Error ? error.message : undefined,
          },
          'narrative model call failed',
        );
        throw failure;
      });

    this.#logger.info(
      {
        model: message.model,
        requestId: message._request_id,
        stopReason: message.stop_reason,
        inputTokens: message.usage.input_tokens,
        cachedInputTokens: message.usage.cache_read_input_tokens,
        outputTokens: message.usage.output_tokens,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'narrative model call',
    );

    if (message.stop_reason === 'refusal') {
      throw new NarrativeModelError('refused', 'The model declined to write this narrative');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new NarrativeModelError('invalid_output', 'The model ran out of output tokens');
    }
    return parseDraft(message.content.find((block) => block.type === 'text')?.text);
  }
}

/** Structured outputs guarantee the shape; this still validates, because guarantees have edges. */
function parseDraft(text: string | undefined): NarrativeDraft {
  let json: unknown;
  try {
    json = JSON.parse(text ?? '');
  } catch {
    throw new NarrativeModelError('invalid_output', 'The model did not return JSON');
  }
  const draft = NarrativeDraftSchema.safeParse(json);
  if (!draft.success) {
    throw new NarrativeModelError('invalid_output', 'The model returned an unexpected structure');
  }
  return draft.data;
}

function toModelError(error: unknown): NarrativeModelError {
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(error.headers.get('retry-after'));
    return new NarrativeModelError(
      'rate_limited',
      'The model provider is rate limiting requests',
      retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
    );
  }
  if (
    error instanceof Anthropic.APIConnectionError ||
    error instanceof Anthropic.InternalServerError
  ) {
    return new NarrativeModelError('unavailable', 'The model provider could not be reached');
  }
  if (error instanceof Anthropic.APIError) {
    // 4xx: a bad key, an unknown model id or a request the API rejects. Not the caller's
    // fault and not transient, so the detail goes to the log rather than the response.
    return new NarrativeModelError(
      'misconfigured',
      `The model provider rejected the request (HTTP ${error.status})`,
    );
  }
  return new NarrativeModelError('unavailable', 'The model call failed unexpectedly');
}
