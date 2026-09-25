import { describe, expect, it } from 'vitest';
import { OllamaProvider } from './OllamaProvider.js';
import type { InferenceTransport } from './types.js';

/**
 * Saying which failure this is.
 *
 * The transport already tells two failures apart - a service that is not
 * running, and a page that is not permitted to reach one - and isConfigured()
 * used to replace that with one generic sentence. They have completely
 * different fixes, and collapsing them cost a real debugging session: a
 * desktop build with Ollama stopped and a browser tab that cannot reach
 * localhost produced identical words, so there was no way to tell from the
 * screen which had happened.
 */

const failing = (id: string, message: string): InferenceTransport =>
  ({
    id,
    unavailableReason: () => null,
    hasCredential: () => false,
    request: async () => {
      throw new Error(message);
    },
  }) as unknown as InferenceTransport;

describe('why local inference could not be reached', () => {
  it('repeats what the transport actually said, rather than a generic line', async () => {
    const provider = new OllamaProvider({
      transport: failing('tauri', 'I could not reach the local AI service at http://127.0.0.1:11434.'),
    });

    await provider.getAvailableModels();
    const reason = provider.isConfigured().reason ?? '';

    expect(reason).toContain('127.0.0.1:11434');
  });

  /** The piece that was missing, and the one that ends the guessing. */
  it('says when this is the web page rather than the desktop app', async () => {
    const provider = new OllamaProvider({
      transport: failing('browser', 'I could not reach the local AI service.'),
    });

    await provider.getAvailableModels();
    expect(provider.isConfigured().reason).toContain('web page');
  });

  it('does not blame the web page when running in the shell', async () => {
    const provider = new OllamaProvider({
      transport: failing('tauri', 'I could not reach the local AI service.'),
    });

    await provider.getAvailableModels();
    expect(provider.isConfigured().reason).not.toContain('web page');
  });

  it('falls back to the plain sentence when the failure said nothing useful', async () => {
    const provider = new OllamaProvider({ transport: failing('tauri', '') });

    await provider.getAvailableModels();
    expect(provider.isConfigured().reason).toContain('unable to reach');
  });

  /** A recovered service must not keep reporting the old failure. */
  it('forgets the reason once a refresh succeeds', async () => {
    let up = false;
    const transport = {
      id: 'tauri',
      unavailableReason: () => null,
      hasCredential: () => false,
      request: async () => {
        if (!up) throw new Error('I could not reach the local AI service.');
        return {
          models: [
            {
              name: 'qwen2.5:7b',
              model: 'qwen2.5:7b',
              size: 4_700_000_000,
              details: { parameter_size: '7B', family: 'qwen', quantization_level: 'Q4_0' },
            },
          ],
        };
      },
    } as unknown as InferenceTransport;

    const provider = new OllamaProvider({ transport });
    await provider.getAvailableModels();
    expect(provider.isConfigured().configured).toBe(false);

    up = true;
    await provider.refresh();

    expect(provider.isConfigured().configured).toBe(true);
    expect(provider.isConfigured().reason ?? '').not.toContain('could not reach');
  });
});
