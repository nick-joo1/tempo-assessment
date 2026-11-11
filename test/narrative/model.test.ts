import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AnthropicNarrativeModel, NarrativeModelError } from '../../src/narrative/model.js';
import { soundDraft } from './fixtures.js';

const API_KEY = 'sk-ant-test-key';
const PROMPT = { system: 'You write narratives.', user: 'Repository: acme/widgets' };

type Json = Record<string, unknown>;

function message(fields: Json = {}): Json {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'signature' },
      { type: 'text', text: JSON.stringify(soundDraft()) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1800, output_tokens: 600, cache_read_input_tokens: 1200 },
    ...fields,
  };
}

/** The adapter over the real SDK, with the Anthropic API replaced by one scripted response. */
function modelAnswering(response: Response) {
  const requests: { url: string; headers: Headers; body: Json }[] = [];
  const model = new AnthropicNarrativeModel({
    apiKey: API_KEY,
    model: 'claude-opus-5-5',
    effort: 'medium',
    logger: pino({ level: 'silent' }),
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return response;
    },
  });
  return { model, requests };
}

/** An error response the SDK is told not to retry, so tests do not sit through its backoff. */
function apiError(status: number, type: string, headers: Record<string, string> = {}): Response {
  return Response.json(
    { type: 'error', error: { type, message: `details about ${API_KEY}` } },
    { status, headers: { 'x-should-retry': 'false', ...headers } },
  );
}

async function failure(model: AnthropicNarrativeModel): Promise<NarrativeModelError> {
  const error = await model.draft(PROMPT).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(NarrativeModelError);
  return error as NarrativeModelError;
}

describe('AnthropicNarrativeModel', () => {
  it('asks for a schema-constrained draft with adaptive thinking and a cached system prompt', async () => {
    const { model, requests } = modelAnswering(Response.json(message()));

    await expect(model.draft(PROMPT)).resolves.toEqual(soundDraft());

    const [request] = requests;
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: PROMPT.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: PROMPT.user }],
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    // Sampling parameters are rejected by current models; the request must not carry any.
    expect(request?.body).not.toHaveProperty('temperature');
  });

  it('sends a schema that structured outputs accept: closed objects, every field required', async () => {
    const { model, requests } = modelAnswering(Response.json(message()));
    await model.draft(PROMPT);

    const objects: Json[] = [];
    const collectObjects = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      if ((node as Json).type === 'object') objects.push(node as Json);
      for (const child of Object.values(node)) collectObjects(child);
    };
    collectObjects(requests[0]?.body.output_config);

    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect(object.required).toEqual(Object.keys(object.properties as Json));
    }
  });

  it('identifies itself by everything that changes what it writes', () => {
    const { model } = modelAnswering(Response.json(message()));

    expect(model.id).toBe('claude-opus-5-5');
    expect(model.fingerprint).toBe('claude-opus-5-5/medium');
  });

  it('reports a refusal', async () => {
    const { model } = modelAnswering(
      Response.json(message({ stop_reason: 'refusal', content: [] })),
    );

    expect((await failure(model)).code).toBe('refused');
  });

  it('rejects output that was cut off or is not the agreed structure', async () => {
    const truncated = modelAnswering(Response.json(message({ stop_reason: 'max_tokens' })));
    const malformed = modelAnswering(
      Response.json(message({ content: [{ type: 'text', text: '{"headline": "only this"}' }] })),
    );
    const notJson = modelAnswering(
      Response.json(message({ content: [{ type: 'text', text: 'Here is the narrative:' }] })),
    );

    expect((await failure(truncated.model)).code).toBe('invalid_output');
    expect((await failure(malformed.model)).code).toBe('invalid_output');
    expect((await failure(notJson.model)).code).toBe('invalid_output');
  });

  it('maps a rate limit to a retryable error with the delay the provider asked for', async () => {
    const { model } = modelAnswering(apiError(429, 'rate_limit_error', { 'retry-after': '7' }));

    expect(await failure(model)).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 7 });
  });

  it('maps an overloaded or failing provider to unavailable', async () => {
    const { model } = modelAnswering(apiError(529, 'overloaded_error'));

    expect((await failure(model)).code).toBe('unavailable');
  });

  it('maps a rejected request to misconfigured, without repeating what the provider said', async () => {
    const { model } = modelAnswering(apiError(401, 'authentication_error'));

    const error = await failure(model);
    expect(error.code).toBe('misconfigured');
    expect(error.message).toBe('The model provider rejected the request (HTTP 401)');
  });
});
