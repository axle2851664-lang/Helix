import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_INFERENCE_PROVIDERS, MODEL_REGISTRY } from './registry.js';
import { CerebrasProvider } from './CerebrasProvider.js';
import { GeminiProvider } from './GeminiProvider.js';
import { MistralProvider } from './MistralProvider.js';
import { OllamaProvider } from './OllamaProvider.js';
import { canRefreshCredentials, TauriInferenceTransport } from './transport.js';
import type { InferenceTransport } from './types.js';

/**
 * The claim `IMPLEMENTED_INFERENCE_PROVIDERS` makes, checked against the
 * classes that exist - and the credential chain that made every cloud
 * provider unreachable.
 *
 * That chain was: the transport is constructed knowing only about Ollama, and
 * `refreshCredentials` - which asks the shell what it actually holds - had no
 * caller outside a test. So `hasCredential('mistral')` answered false for
 * ever and Mistral reported itself unconfigured however good the key was.
 * Nothing here would have failed; the feature simply did not work.
 */

function transportWith(configured: readonly string[]): InferenceTransport {
  return new TauriInferenceTransport({
    invoke: (async (command: string) =>
      command === 'configured_inference_providers' ? [...configured] : {}) as never,
    configuredProviders: configured,
  });
}

describe('IMPLEMENTED_INFERENCE_PROVIDERS', () => {
  it('names exactly the providers that have a class', () => {
    const transport = transportWith([]);
    const built = [
      new OllamaProvider({ transport }),
      new GeminiProvider({ transport }),
      new CerebrasProvider({ transport }),
      new MistralProvider({ transport }),
    ].map((provider) => provider.id);

    expect([...IMPLEMENTED_INFERENCE_PROVIDERS].sort()).toEqual(built.sort());
  });

  /**
   * Anthropic is the one the list exists to exclude. The shell can reach
   * api.anthropic.com and the registry lists Claude models, so every other
   * signal says it works.
   */
  it('excludes anthropic, which the registry lists but nothing implements', () => {
    expect(MODEL_REGISTRY.some((model) => model.inferenceProvider === 'anthropic')).toBe(true);
    expect(IMPLEMENTED_INFERENCE_PROVIDERS).not.toContain('anthropic');
  });

  it('names a provider for every model the registry carries', () => {
    for (const model of MODEL_REGISTRY) {
      expect(typeof model.inferenceProvider).toBe('string');
    }
  });
});

describe('the credential chain', () => {
  it('reports a cloud provider unconfigured until the shell is asked', async () => {
    // Exactly how the kernel builds it: Ollama needs no key, so it is passed
    // in, and everything else is meant to arrive from the shell.
    const transport = transportWith(['ollama']);
    const mistral = new MistralProvider({ transport });

    expect(mistral.isConfigured().configured).toBe(false);

    // The call that had no caller. This is the whole bug.
    const configured = await (transport as unknown as {
      refreshCredentials(): Promise<string[]>;
    }).refreshCredentials();

    expect(configured).toContain('ollama');
  });

  it('considers it configured once the shell names it', async () => {
    const transport = transportWith(['ollama', 'mistral']);
    const mistral = new MistralProvider({ transport });
    await (transport as unknown as { refreshCredentials(): Promise<string[]> })
      .refreshCredentials();

    expect(mistral.isConfigured().configured).toBe(true);
  });

  /** The guard the kernel uses, so a browser transport is not asked. */
  it('can be detected on a transport that supports it, and not on one that does not', () => {
    expect(canRefreshCredentials(transportWith([]))).toBe(true);
    expect(canRefreshCredentials({})).toBe(false);
    expect(canRefreshCredentials(null)).toBe(false);
  });
});
