import { describe, expect, it } from 'vitest';
import { assessInstalledModels, preferredLocalModel } from './localModels.js';
import type { ModelInfo } from './types.js';

/** The machine this was written on, with the free memory that was measured. */
const thisMachine = {
  totalMemoryBytes: 7.8 * 1024 ** 3,
  memoryIsApproximate: false,
  availableMemoryBytes: 2.3 * 1024 ** 3,
};

const roomy = {
  totalMemoryBytes: 64 * 1024 ** 3,
  memoryIsApproximate: false,
  availableMemoryBytes: 48 * 1024 ** 3,
};

const installed = (id: string): ModelInfo => ({
  id,
  name: id,
  family: 'Local',
  author: 'Unknown',
  inferenceProvider: 'ollama',
  capabilities: ['chat'],
  contextLength: 0,
  maxOutputTokens: null,
  status: 'available',
});

/** Both of these are genuinely installed on the machine in question. */
const bothInstalled = [installed('qwen2.5:7b'), installed('qwen2.5:3b')];

describe('assessInstalledModels', () => {
  /**
   * The measurement this exists for: on this machine the 7B produced 0.2
   * tokens per second against the 3B's 10.8, because it was swapping. It is
   * installed and it is not usable, and those are different facts.
   */
  it('marks an installed model unavailable when it will not fit', () => {
    const assessed = assessInstalledModels(bothInstalled, thisMachine);
    const sevenB = assessed.find((model) => model.id === 'qwen2.5:7b');

    expect(sevenB?.status).toBe('unavailable');
    expect(sevenB?.note).toContain('swap to disk');
  });

  it('leaves the model that actually ran well available', () => {
    const assessed = assessInstalledModels(bothInstalled, thisMachine);
    expect(assessed.find((model) => model.id === 'qwen2.5:3b')?.status).toBe('available');
  });

  it('keeps both on a machine with room for both', () => {
    const assessed = assessInstalledModels(bothInstalled, roomy);
    expect(assessed.every((model) => model.status === 'available')).toBe(true);
  });

  /**
   * Unknown is not a refusal. A model whose size cannot be read from its name
   * may run perfectly well, and blocking it would be a guess presented as
   * caution - the same optimism-in-reverse the fit assessor was corrected for.
   */
  it('does not block a model whose size cannot be read', () => {
    const assessed = assessInstalledModels([installed('my-custom-model')], thisMachine);
    expect(assessed[0]?.status).toBe('available');
  });

  it('always explains itself', () => {
    for (const model of assessInstalledModels(bothInstalled, thisMachine)) {
      expect(model.note?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe('preferredLocalModel', () => {
  /**
   * The point of the whole arrangement: the right model is chosen on this
   * machine without any model name being written down. The 3B wins because it
   * fits, not because it was named.
   */
  it('chooses the largest model that actually fits', () => {
    const assessed = assessInstalledModels(bothInstalled, thisMachine);
    expect(preferredLocalModel(assessed)?.id).toBe('qwen2.5:3b');
  });

  it('chooses the larger one where there is room for it', () => {
    const assessed = assessInstalledModels(bothInstalled, roomy);
    expect(preferredLocalModel(assessed)?.id).toBe('qwen2.5:7b');
  });

  it('returns null rather than a model that will swap', () => {
    const assessed = assessInstalledModels([installed('qwen2.5:7b')], thisMachine);
    expect(preferredLocalModel(assessed)).toBeNull();
  });

  it('returns null when nothing is installed', () => {
    expect(preferredLocalModel([])).toBeNull();
  });

  // A known quantity is a better bet than one that could be anything.
  it('prefers a model of readable size over an unreadable one', () => {
    const assessed = assessInstalledModels(
      [installed('my-custom-model'), installed('qwen2.5:3b')],
      thisMachine,
    );
    expect(preferredLocalModel(assessed)?.id).toBe('qwen2.5:3b');
  });
});
