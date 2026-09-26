import { describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './OllamaProvider.js';
import type { InferenceTransport } from './types.js';

/**
 * A wait that ends.
 *
 * Reported from a running build: Helix sat on "Standing by" for ever after
 * the request finally started reaching Ollama. Neither side had a timeout -
 * the shell's HTTP client had none, and nothing on this side gave up either -
 * so a stalled request waited indefinitely with nothing on screen to read and
 * nothing to do. That is indistinguishable from a crash, and worse, because
 * the user keeps waiting.
 */

const transportThat = (behaviour: (path: string) => Promise<unknown>): InferenceTransport =>
  ({
    id: 'tauri',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: (options: { path: string }) => behaviour(options.path),
  }) as unknown as InferenceTransport;

const never = () => new Promise<never>(() => {});

describe('when the local runtime stops answering', () => {
  it('gives up on a generation rather than waiting for ever', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OllamaProvider({ transport: transportThat(never) });
      const attempt = provider.generate({ model: 'qwen2.5:7b', messages: [] });
      const settled = attempt.catch((error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(180_000);

      expect(await settled).toContain('did not answer within three minutes');
    } finally {
      vi.useRealTimers();
    }
  });

  /** The message has to be worth reading, or it is just a different hang. */
  it('explains the slow first load and names what to do', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OllamaProvider({ transport: transportThat(never) });
      const settled = provider
        .generate({ model: 'qwen2.5:7b', messages: [] })
        .catch((error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(180_000);
      const message = await settled;

      expect(message).toContain('qwen2.5:7b');
      expect(message).toMatch(/loads the whole model into memory/i);
      expect(message).toMatch(/smaller model/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on listing models far sooner, because that call is cheap', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OllamaProvider({ transport: transportThat(never) });
      const settled = provider.getAvailableModels();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await settled).toEqual([]);

      expect(provider.isConfigured().reason).toContain('ten seconds');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a runtime that is merely slow', () => {
  /**
   * The failure that would make this worse than the hang: abandoning a
   * machine that was about to answer. A large model loading off a slow disk
   * legitimately takes minutes.
   */
  it('waits out a slow first load and returns the answer', async () => {
    vi.useFakeTimers();
    try {
      const provider = new OllamaProvider({
        transport: transportThat(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ message: { content: 'Good evening.' } }), 150_000),
            ),
        ),
      });

      const attempt = provider.generate({ model: 'qwen2.5:7b', messages: [] });
      await vi.advanceTimersByTimeAsync(150_000);

      expect((await attempt).text).toBe('Good evening.');
    } finally {
      vi.useRealTimers();
    }
  });
});
