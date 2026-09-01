import type { Capability, ModelInfo } from './types.js';

/**
 * The model registry.
 *
 * One entry per model, each recording which inference provider serves it. The
 * same family can appear more than once under different providers, which is
 * the point: Llama on Cerebras and Llama running locally are the same model
 * and two entirely different arrangements of cost, speed and privacy.
 *
 * On the seeded entries below, and why several say `unverified`:
 *
 * Cerebras publishes its own model list through the API, and that list is the
 * authority. What is written here is a seed so the interface has something to
 * show before a key exists, and every id in it is marked according to how well
 * I actually know it. `gpt-oss-120b` appears in their documentation. The
 * others are families Cerebras is known to serve, whose exact wire ids I have
 * not confirmed - so they are `unverified`, and the router will not choose one
 * without saying so. Writing a plausible id here and letting it 404 at request
 * time would be worse than admitting the gap.
 */

export const MODEL_REGISTRY: readonly ModelInfo[] = [
  // ------------------------------------------------------ Cerebras (cloud)
  {
    id: 'gpt-oss-120b',
    name: 'gpt-oss 120B',
    family: 'gpt-oss',
    author: 'OpenAI',
    inferenceProvider: 'cerebras',
    capabilities: ['chat', 'reasoning', 'coding', 'fast'],
    contextLength: 128_000,
    maxOutputTokens: null,
    status: 'unverified',
    note: 'Named in the Cerebras documentation. Context length and output limit are not confirmed; the live model list is authoritative.',
  },
  {
    id: 'llama-3.3-70b',
    name: 'Llama 3.3 70B',
    family: 'Llama',
    author: 'Meta',
    inferenceProvider: 'cerebras',
    capabilities: ['chat', 'reasoning', 'coding', 'fast'],
    contextLength: 128_000,
    maxOutputTokens: null,
    status: 'unverified',
    note: 'A family Cerebras is known to serve. The exact wire id is not confirmed - check the live model list before relying on it.',
  },
  {
    id: 'qwen-3-32b',
    name: 'Qwen 3 32B',
    family: 'Qwen',
    author: 'Alibaba',
    inferenceProvider: 'cerebras',
    capabilities: ['chat', 'reasoning', 'coding'],
    contextLength: 128_000,
    maxOutputTokens: null,
    status: 'unverified',
    note: 'A family Cerebras is known to serve. The exact wire id is not confirmed - check the live model list before relying on it.',
  },

  // ----------------------------------------------------- Anthropic (cloud)
  // The existing catalogue, restated in these terms. Anthropic is the
  // inference provider for Claude models; it is not the model either.
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    family: 'Claude',
    author: 'Anthropic',
    inferenceProvider: 'anthropic',
    capabilities: ['chat', 'reasoning', 'coding', 'vision', 'long-context'],
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    status: 'available',
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    family: 'Claude',
    author: 'Anthropic',
    inferenceProvider: 'anthropic',
    capabilities: ['chat', 'reasoning', 'coding', 'vision', 'long-context'],
    contextLength: 1_000_000,
    maxOutputTokens: 128_000,
    status: 'available',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    family: 'Claude',
    author: 'Anthropic',
    inferenceProvider: 'anthropic',
    capabilities: ['chat', 'coding', 'vision', 'fast'],
    contextLength: 200_000,
    maxOutputTokens: 64_000,
    status: 'available',
  },

  // ------------------------------------------------------- Local inference
  // Nothing runs locally yet. The entry exists so the router and the settings
  // can refer to local inference as a real option rather than a hypothetical,
  // and it says plainly that it is not installed.
  {
    id: 'local-gguf',
    name: 'Local model',
    family: 'Local',
    author: 'Whichever you install',
    inferenceProvider: 'local',
    capabilities: ['chat'],
    contextLength: 8_192,
    maxOutputTokens: null,
    status: 'unavailable',
    note: 'No local inference runtime is installed. Helix runs Whisper locally for speech, which is a different thing from a local language model.',
  },
];

export class ModelRegistry {
  readonly #models: ModelInfo[];

  constructor(models: readonly ModelInfo[] = MODEL_REGISTRY) {
    this.#models = [...models];
  }

  get all(): readonly ModelInfo[] {
    return this.#models;
  }

  get(id: string): ModelInfo | undefined {
    return this.#models.find((model) => model.id === id);
  }

  byProvider(providerId: string): ModelInfo[] {
    return this.#models.filter((model) => model.inferenceProvider === providerId);
  }

  /** Models that can do all of these. */
  withCapabilities(required: readonly Capability[]): ModelInfo[] {
    return this.#models.filter((model) =>
      required.every((capability) => model.capabilities.includes(capability)),
    );
  }

  /**
   * Replace one provider's entries with what the provider itself reports.
   *
   * The live list is the authority, so this drops the seeded guesses for that
   * provider entirely rather than merging - a stale invented id surviving
   * alongside real ones is exactly the confusion the seed is trying not to
   * cause.
   */
  replaceProviderModels(providerId: string, models: readonly ModelInfo[]): void {
    const others = this.#models.filter((model) => model.inferenceProvider !== providerId);
    this.#models.length = 0;
    this.#models.push(...others, ...models);
  }

  /** Every distinct inference provider named in the registry. */
  get providerIds(): string[] {
    return [...new Set(this.#models.map((model) => model.inferenceProvider))];
  }
}
