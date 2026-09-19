import { describe, expect, it } from 'vitest';
import { GeminiProvider, bareModelId, readGeminiText, toGeminiBody } from './GeminiProvider.js';
import type { InferenceTransport } from './types.js';

/**
 * Fixtures written from Google's documented shapes. No live call has been made
 * from here - this container's proxy blocks the host - so these prove the
 * readers handle the shape they were written against and degrade safely when
 * they do not. They do not prove the shape is right.
 */
function transportReturning(body: unknown) {
  const sent: Array<{ providerId: string; path: string; body: unknown }> = [];
  const transport: InferenceTransport = {
    id: 'test',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async (options) => {
      sent.push({ providerId: options.providerId, path: options.path, body: options.body });
      return body;
    },
  };
  return { transport, sent };
}

const reply = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
});

describe('turning Helix messages into Gemini ones', () => {
  it('puts a system prompt in systemInstruction, not in the conversation', () => {
    // In contents it becomes something the user said, which the model answers
    // rather than adopts.
    const body = toGeminiBody({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: 'You are Helix.' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(body.systemInstruction?.parts[0]?.text).toBe('You are Helix.');
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });

  it('calls the assistant "model", which is what Gemini expects', () => {
    const body = toGeminiBody({
      model: 'x',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Good evening.' },
        { role: 'user', content: 'and now?' },
      ],
    });

    expect(body.contents.map((entry) => entry.role)).toEqual(['user', 'model', 'user']);
  });

  it('merges consecutive turns from the same side rather than being refused', () => {
    // Helix really does send these: the research tool passes evidence and then
    // the question, both as user turns.
    const body = toGeminiBody({
      model: 'x',
      messages: [
        { role: 'user', content: 'here is what I found' },
        { role: 'user', content: 'what does it mean?' },
      ],
    });

    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]?.parts).toHaveLength(2);
  });

  it('joins several system prompts rather than dropping all but one', () => {
    const body = toGeminiBody({
      model: 'x',
      messages: [
        { role: 'system', content: 'One.' },
        { role: 'system', content: 'Two.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body.systemInstruction?.parts[0]?.text).toBe('One.\n\nTwo.');
  });

  it('omits generationConfig entirely when nothing was asked for', () => {
    // An empty object is not the same as absent, and Gemini treats some
    // explicit nulls as instructions.
    expect(toGeminiBody({ model: 'x', messages: [] }).generationConfig).toBeUndefined();
    expect(
      toGeminiBody({ model: 'x', messages: [], temperature: 0.4 }).generationConfig,
    ).toEqual({ temperature: 0.4 });
  });

  it('ignores an empty system message rather than sending a blank instruction', () => {
    const body = toGeminiBody({ model: 'x', messages: [{ role: 'system', content: '   ' }] });
    expect(body.systemInstruction).toBeUndefined();
  });
});

describe('generating', () => {
  it('asks the path the shell actually permits', async () => {
    const { transport, sent } = transportReturning(reply('Good evening.'));
    await new GeminiProvider({ transport }).generate({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });

    // The shell refuses anything not under /v1beta/ for this provider.
    expect(sent[0]?.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(sent[0]?.providerId).toBe('gemini');
  });

  it('reports the model and provider that actually ran', async () => {
    const { transport } = transportReturning(reply('Good evening.'));
    const result = await new GeminiProvider({ transport }).generate({
      model: 'models/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.text).toBe('Good evening.');
    // The `models/` prefix is Google's own; the id reported is the bare one.
    expect(result.model).toBe('gemini-2.5-pro');
    expect(result.inferenceProvider).toBe('gemini');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.stopReason).toBe('STOP');
  });

  it('joins a reply that came back in several parts', () => {
    expect(
      readGeminiText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
    ).toBe('ab');
  });

  it('tells a refusal apart from an empty answer apart from a cut-off one', async () => {
    const blocked = transportReturning({ promptFeedback: { blockReason: 'SAFETY' } });
    await expect(
      new GeminiProvider({ transport: blocked.transport }).generate({ model: 'x', messages: [] }),
    ).rejects.toThrow(/declined to answer that \(SAFETY\)/);

    const cut = transportReturning({ candidates: [{ finishReason: 'MAX_TOKENS' }] });
    await expect(
      new GeminiProvider({ transport: cut.transport }).generate({ model: 'x', messages: [] }),
    ).rejects.toThrow(/output limit/);

    const empty = transportReturning({ candidates: [] });
    await expect(
      new GeminiProvider({ transport: empty.transport }).generate({ model: 'x', messages: [] }),
    ).rejects.toThrow(/empty reply/);
  });

  it('surfaces the provider’s own error message', async () => {
    const { transport } = transportReturning({
      error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
    });
    await expect(
      new GeminiProvider({ transport }).generate({ model: 'x', messages: [] }),
    ).rejects.toThrow(/API key not valid/);
  });

  it('delivers the whole answer through stream rather than faking chunks', async () => {
    const { transport } = transportReturning(reply('One answer.'));
    const chunks: string[] = [];
    const result = await new GeminiProvider({ transport }).stream(
      { model: 'x', messages: [] },
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual(['One answer.']);
    expect(result.text).toBe('One answer.');
  });
});

describe('the model list', () => {
  it('prefers what Google reports over what was written from documentation', async () => {
    const { transport } = transportReturning({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
      ],
    });

    const models = await new GeminiProvider({ transport }).getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('gemini-2.5-flash');
    expect(models[0]?.contextLength).toBe(1048576);
    // Confirmed by the provider, so no longer a guess.
    expect(models[0]?.status).toBe('available');
  });

  it('leaves out models that cannot generate content', async () => {
    // The same endpoint returns embedding models.
    const { transport } = transportReturning({
      models: [
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    });

    const models = await new GeminiProvider({ transport }).getAvailableModels();
    expect(models.map((model) => model.id)).toEqual(['gemini-2.5-flash']);
  });

  it('falls back to the seeded entries when the list cannot be fetched', async () => {
    const transport: InferenceTransport = {
      id: 'test',
      unavailableReason: () => null,
      hasCredential: () => true,
      request: async () => {
        throw new Error('offline');
      },
    };

    const models = await new GeminiProvider({ transport }).getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    // And they say they are guesses rather than passing as confirmed.
    expect(models.every((model) => model.status === 'unverified')).toBe(true);
  });
});

describe('where it can run', () => {
  it('refuses in a browser, and says why rather than failing later', () => {
    const browser: InferenceTransport = {
      id: 'browser',
      unavailableReason: () => 'This is a web build.',
      hasCredential: () => false,
      request: async () => ({}),
    };

    const configured = new GeminiProvider({ transport: browser }).isConfigured();
    expect(configured.configured).toBe(false);
    expect(configured.reason).toContain('web build');
  });

  it('strips the models/ prefix Google puts on its ids', () => {
    expect(bareModelId('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
    expect(bareModelId('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});
