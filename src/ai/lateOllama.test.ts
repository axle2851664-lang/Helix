import { describe, expect, it } from 'vitest';
import { OllamaProvider } from './OllamaProvider.js';
import type { InferenceTransport } from './types.js';

/**
 * Ollama started after Helix.
 *
 * This is the ordinary case now, not an edge one: Helix refuses cloud
 * inference by default, so the first thing it says on a fresh machine is
 * "no local model is available" - and the obvious next action is to go and
 * start Ollama. If that only takes effect after a restart, the instruction
 * Helix just gave does not work.
 *
 * The trap underneath is real and cost a fix that did nothing:
 * `getAvailableModels()` caches an empty list when a probe fails, so a poll
 * built on it re-asks the cache forever and never reaches the service again.
 * These tests exist to keep that from coming back quietly.
 */

function lateTransport(options: { startsAfter: number }) {
  let calls = 0;
  const transport: InferenceTransport = {
    id: 'ollama',
    unavailableReason: () => null,
    hasCredential: () => false,
    request: async () => {
      calls += 1;
      if (calls <= options.startsAfter) throw new Error('ECONNREFUSED');
      return {
        models: [
          {
            name: 'llama3.2:3b',
            model: 'llama3.2:3b',
            size: 2_000_000_000,
            details: { parameter_size: '3B', family: 'llama', quantization_level: 'Q4_0' },
          },
        ],
      };
    },
  };
  return { transport, calls: () => calls };
}

describe('a local runtime that starts after Helix', () => {
  it('is found by a later refresh', async () => {
    const { transport } = lateTransport({ startsAfter: 2 });
    const provider = new OllamaProvider({ transport });

    expect(await provider.getAvailableModels()).toEqual([]);
    expect(await provider.refresh()).toEqual([]);

    const found = await provider.refresh();
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('llama3.2:3b');
  });

  /**
   * The bug this file was written for. Asking the cached accessor again
   * never reaches the service, so a poll built on it looks busy and
   * achieves nothing.
   */
  it('is NOT found by asking the cached accessor again, which is why the poll refreshes', async () => {
    const { transport, calls } = lateTransport({ startsAfter: 1 });
    const provider = new OllamaProvider({ transport });

    await provider.getAvailableModels();
    const after = calls();

    await provider.getAvailableModels();
    await provider.getAvailableModels();

    // No further requests were made: the empty list came from the cache.
    expect(calls()).toBe(after);
    expect(await provider.getAvailableModels()).toEqual([]);

    // Only a refresh goes back to the service.
    expect(await provider.refresh()).toHaveLength(1);
    expect(calls()).toBeGreaterThan(after);
  });

  it('keeps reporting the model once it has been found', async () => {
    const { transport } = lateTransport({ startsAfter: 0 });
    const provider = new OllamaProvider({ transport });

    expect(await provider.getAvailableModels()).toHaveLength(1);
    expect(await provider.getAvailableModels()).toHaveLength(1);
  });
});
