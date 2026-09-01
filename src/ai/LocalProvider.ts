import type {
  GenerateRequest,
  GenerateResult,
  InferenceProvider,
  ModelInfo,
  ProviderConfiguration,
} from './types.js';
import { MODEL_REGISTRY } from './registry.js';

/**
 * Local inference.
 *
 * Nothing runs yet, and this class exists to say so precisely rather than to
 * leave a hole in the architecture. It is a real provider that reports itself
 * unconfigured, which means the router can prefer local inference today and
 * that preference will simply take effect the moment a runtime is installed -
 * no routing code changes.
 *
 * A word on a confusion worth heading off: Helix already runs Whisper on this
 * machine. That is speech recognition, not a language model. Having local
 * speech says nothing about being able to answer a question locally, and the
 * note below says so where a user will actually read it.
 */

export interface LocalProviderOptions {
  /**
   * Set once a runtime exists. Left out entirely rather than defaulted to
   * something optimistic.
   */
  runtime?: {
    isReady(): boolean;
    generate(request: GenerateRequest): Promise<GenerateResult>;
  };
}

export class LocalProvider implements InferenceProvider {
  readonly id = 'local';
  readonly name = 'Local inference';
  readonly location = 'local' as const;

  readonly #runtime: LocalProviderOptions['runtime'];

  constructor(options: LocalProviderOptions = {}) {
    this.#runtime = options.runtime;
  }

  isConfigured(): ProviderConfiguration {
    if (!this.#runtime) {
      return {
        configured: false,
        reason:
          'No local language model runtime is installed. Helix runs Whisper locally for speech, which is a different thing.',
      };
    }
    if (!this.#runtime.isReady()) {
      return { configured: false, reason: 'The local runtime is installed but not ready.' };
    }
    return { configured: true };
  }

  async getAvailableModels(): Promise<readonly ModelInfo[]> {
    return MODEL_REGISTRY.filter((model) => model.inferenceProvider === this.id);
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return (await this.getAvailableModels()).find((model) => model.id === modelId);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const configuration = this.isConfigured();
    if (!configuration.configured || !this.#runtime) {
      throw new Error(configuration.reason ?? 'Local inference is not available.');
    }
    return this.#runtime.generate(request);
  }

  async stream(
    request: GenerateRequest,
    onChunk: (text: string) => void,
  ): Promise<GenerateResult> {
    const result = await this.generate(request);
    if (result.text !== '') onChunk(result.text);
    return result;
  }
}
