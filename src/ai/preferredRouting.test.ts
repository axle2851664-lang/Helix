import { describe, expect, it } from 'vitest';
import { AIRouter } from './AIRouter.js';
import { ModelRegistry } from './registry.js';
import { preferredLocalModel } from './localModels.js';
import type { InferenceProvider, ModelInfo } from './types.js';

/**
 * The chosen model is the one that answers.
 *
 * `preferredLocalModel` picks the largest model that actually fits the
 * machine, with a comment explaining that applying the rule naively would
 * pick the 7B that runs at 0.2 tokens per second. That calculation was
 * computed, logged, emitted on the bus - and never reached the router, which
 * ranked every usable local model equally and answered on whichever one the
 * registry listed first. A machine with a 7B and a 3B installed used the 3B.
 */

const model = (id: string, provider = 'ollama'): ModelInfo => ({
  id,
  name: id,
  family: 'qwen',
  author: 'Alibaba',
  inferenceProvider: provider,
  capabilities: ['chat'],
  contextLength: 8192,
  maxOutputTokens: 1024,
  status: 'available',
});

const provider = (id: string, location: 'local' | 'cloud'): InferenceProvider =>
  ({
    id,
    name: id,
    location,
    isConfigured: () => ({ configured: true, reason: null }),
    generate: async () => ({ text: `from ${id}` }),
  }) as unknown as InferenceProvider;

const installed = [model('qwen2.5:7b'), model('qwen2.5:3b'), model('llama3.2:3b')];

function router() {
  return new AIRouter({
    registry: new ModelRegistry(installed),
    preferLocal: true,
    providers: [provider('ollama', 'local'), provider('gemini', 'cloud')],
  });
}

describe('routing to the chosen local model', () => {
  it('answers on the largest installed model once it is told', () => {
    const ai = router();
    const chosen = preferredLocalModel(installed)?.id ?? null;
    expect(chosen).toBe('qwen2.5:7b');

    ai.setPreferredModel(chosen);
    expect(ai.plan({ capabilities: ['chat'], reason: 'x' })[0]?.model.id).toBe('qwen2.5:7b');
  });

  /** The bug: without the wiring, registry order decides. */
  it('does not silently pick by registry order once a choice exists', () => {
    const ai = new AIRouter({
      // 3B listed first, as a runtime is perfectly entitled to do.
      registry: new ModelRegistry([model('qwen2.5:3b'), model('qwen2.5:7b')]),
      preferLocal: true,
      providers: [provider('ollama', 'local')],
    });

    expect(ai.plan({ capabilities: ['chat'], reason: 'x' })[0]?.model.id).toBe('qwen2.5:3b');

    ai.setPreferredModel('qwen2.5:7b');
    expect(ai.plan({ capabilities: ['chat'], reason: 'x' })[0]?.model.id).toBe('qwen2.5:7b');
  });

  it('can be cleared, and then no model is favoured', () => {
    const ai = router();
    ai.setPreferredModel('qwen2.5:3b');
    expect(ai.plan({ capabilities: ['chat'], reason: 'x' })[0]?.model.id).toBe('qwen2.5:3b');

    ai.setPreferredModel(null);
    expect(ai.plan({ capabilities: ['chat'], reason: 'x' })[0]?.model.id).toBe('qwen2.5:7b');
  });

  /**
   * The preference must not drag a cloud model ahead of a local one when
   * Helix has been told to stay on this machine.
   */
  it('never outranks local-only', () => {
    const ai = new AIRouter({
      registry: new ModelRegistry([model('gemini-2.5-pro', 'gemini'), model('qwen2.5:7b')]),
      localOnly: true,
      preferLocal: true,
      providers: [provider('ollama', 'local'), provider('gemini', 'cloud')],
    });

    ai.setPreferredModel('gemini-2.5-pro');
    const plan = ai.plan({ capabilities: ['chat'], reason: 'x' });

    expect(plan.map((entry) => entry.model.id)).toEqual(['qwen2.5:7b']);
  });
});
