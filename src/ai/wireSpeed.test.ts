import { describe, expect, it } from 'vitest';
import { AIRouter } from './AIRouter.js';
import { ModelRegistry } from './registry.js';
import { OllamaProvider } from './OllamaProvider.js';
import { CONVERSATIONAL_TOKEN_CAP, KEEP_ALIVE } from './speed.js';
import type { InferenceTransport, ModelInfo } from './types.js';

/**
 * What actually goes on the wire.
 *
 * The speed rules are worth nothing if they stop at the edge of the module
 * that declares them - which is the fault this codebase keeps producing. So
 * these assert the request body Ollama receives, not the constants.
 */

function capturing() {
  const sent: Array<Record<string, unknown>> = [];
  const transport: InferenceTransport = {
    id: 'tauri',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async (options: { path: string; body: unknown }) => {
      if (options.body !== null) sent.push(options.body as Record<string, unknown>);
      if (options.path === '/api/tags') {
        return {
          models: [
            { name: 'qwen2.5:7b', model: 'qwen2.5:7b', details: { parameter_size: '7B' } },
            { name: 'qwen2.5:3b', model: 'qwen2.5:3b', details: { parameter_size: '3B' } },
          ],
        };
      }
      return { message: { content: 'Good evening.' } };
    },
  } as unknown as InferenceTransport;

  return { sent, provider: new OllamaProvider({ transport }) };
}

describe('the request Ollama receives', () => {
  it('asks for the model to stay in memory between messages', async () => {
    const { sent, provider } = capturing();
    await provider.generate({ model: 'qwen2.5:3b', messages: [] });

    expect(sent[0]?.['keep_alive']).toBe(KEEP_ALIVE);
  });

  it('never streams, because the transport cannot carry a stream', async () => {
    const { sent, provider } = capturing();
    await provider.generate({ model: 'qwen2.5:3b', messages: [] });

    expect(sent[0]?.['stream']).toBe(false);
  });

  it('warms a model with one token, not a whole reply', async () => {
    const { sent, provider } = capturing();
    await provider.warm('qwen2.5:3b');

    expect((sent[0]?.['options'] as { num_predict: number }).num_predict).toBe(1);
    expect(sent[0]?.['keep_alive']).toBe(KEEP_ALIVE);
  });
});

describe('the reply budget crossing the router', () => {
  const model = (id: string): ModelInfo => ({
    id,
    name: id,
    family: 'qwen',
    author: 'Alibaba',
    inferenceProvider: 'ollama',
    capabilities: ['chat'],
    contextLength: 8192,
    maxOutputTokens: 4096,
    status: 'available',
  });

  it('reaches a local model capped, not at the cloud-sized default', async () => {
    const { sent, provider } = capturing();
    const ai = new AIRouter({
      registry: new ModelRegistry([model('qwen2.5:3b')]),
      providers: [provider],
      maxOutputTokens: 4096,
      preferLocal: true,
    });

    await ai.generate([{ role: 'user', content: 'hello' }]);

    expect((sent[0]?.['options'] as { num_predict: number }).num_predict).toBe(
      CONVERSATIONAL_TOKEN_CAP,
    );
  });
});
