import { describe, expect, it } from 'vitest';
import { AIRouter } from './AIRouter.js';
import { ModelRegistry } from './registry.js';
import type { InferenceProvider, ModelInfo } from './types.js';

/**
 * Running entirely on this machine, as a rule rather than a preference.
 *
 * `preferLocal` only ranks. On a machine where Ollama is not running it
 * ranked nothing, and the conversation went to a cloud model - silently, and
 * to somebody who had asked for local precisely so that would not happen.
 * A person cannot detect that from the reply, which is what makes it the
 * failure worth a test rather than a comment.
 */

function provider(options: {
  id: string;
  location: 'local' | 'cloud';
  configured?: boolean;
  reply?: string;
}): InferenceProvider {
  return {
    id: options.id,
    name: options.id,
    location: options.location,
    isConfigured: () =>
      options.configured === false
        ? { configured: false, reason: `${options.id} is not running.` }
        : { configured: true, reason: null },
    generate: async () => ({ text: options.reply ?? `answer from ${options.id}` }),
  } as unknown as InferenceProvider;
}

function registryWith(entries: Array<{ id: string; provider: string }>): ModelRegistry {
  const models: ModelInfo[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.id,
    family: 'test',
    author: 'test',
    inferenceProvider: entry.provider,
    capabilities: ['chat'],
    contextLength: 8192,
    maxOutputTokens: 1024,
    status: 'available',
  }));
  return new ModelRegistry(models);
}

const MODELS = [
  { id: 'llama3', provider: 'ollama' },
  { id: 'gemini-pro', provider: 'gemini' },
];

const routerWith = (options: { localOnly: boolean; localRunning: boolean }) =>
  new AIRouter({
    registry: registryWith(MODELS),
    localOnly: options.localOnly,
    preferLocal: true,
    providers: [
      provider({ id: 'ollama', location: 'local', configured: options.localRunning }),
      provider({ id: 'gemini', location: 'cloud' }),
    ],
  });

describe('running entirely on this machine', () => {
  it('answers locally when a local model is running', async () => {
    const result = await routerWith({ localOnly: true, localRunning: true }).generate([
      { role: 'user', content: 'hello' },
    ]);

    expect(result.text).toContain('ollama');
  });

  /** The whole point. Silence beats an answer from somewhere else. */
  it('refuses rather than falling back to the cloud', async () => {
    const router = routerWith({ localOnly: true, localRunning: false });

    expect(router.plan({ capabilities: ['chat'], reason: 'x' })).toEqual([]);
    await expect(router.generate([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      /entirely on this machine/i,
    );
  });

  it('does not tell you to configure a cloud provider you deliberately excluded', async () => {
    const router = routerWith({ localOnly: true, localRunning: false });

    await expect(router.generate([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      /Ollama is not running|ollama is not running/i,
    );

    const { reason } = router.describeSelection();
    expect(reason).not.toMatch(/gemini/i);
  });

  /** With the rule off, the old behaviour is untouched. */
  it('still falls back to the cloud when the rule is off', async () => {
    const result = await routerWith({ localOnly: false, localRunning: false }).generate([
      { role: 'user', content: 'hello' },
    ]);

    expect(result.text).toContain('gemini');
  });

  it('prefers local over cloud when both are available and the rule is off', async () => {
    const result = await routerWith({ localOnly: false, localRunning: true }).generate([
      { role: 'user', content: 'hello' },
    ]);

    expect(result.text).toContain('ollama');
  });
});
