import type {
  GenerateRequest,
  GenerateResult,
  InferenceProvider,
  InferenceTransport,
  ModelInfo,
  ProviderConfiguration,
} from './types.js';
import { MODEL_REGISTRY } from './registry.js';

/**
 * Cerebras inference.
 *
 * Cerebras runs models; it is not one. This class knows how to talk to their
 * API and has no opinion about which model it is asked for - the model arrives
 * in the request, so changing model is a configuration change and never a code
 * change. That is the requirement this whole file is shaped around.
 *
 * The API is OpenAI-compatible chat completions, which is why the request and
 * response shapes below look like that rather than like anything Cerebras
 * invented.
 *
 * It never calls `fetch` itself. Requests go through an `InferenceTransport`,
 * because whether a request can be made at all - and whether a key can be held
 * without being readable by the page - depends on the host. In a browser the
 * answer is no on both counts, and the transport says so rather than this
 * class pretending otherwise.
 */

const CHAT_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';

/** The OpenAI-compatible response shape, read defensively. */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  model?: unknown;
}

interface ModelListResponse {
  data?: Array<{ id?: unknown; context_length?: unknown }>;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface CerebrasProviderOptions {
  transport: InferenceTransport;
}

export class CerebrasProvider implements InferenceProvider {
  readonly id = 'cerebras';
  readonly name = 'Cerebras';
  readonly location = 'cloud' as const;

  readonly #transport: InferenceTransport;

  constructor(options: CerebrasProviderOptions) {
    this.#transport = options.transport;
  }

  /**
   * Two separate things can be missing, and they need different fixes, so
   * they are reported separately rather than as one "not available".
   */
  isConfigured(): ProviderConfiguration {
    const hostProblem = this.#transport.unavailableReason(this.id);
    if (hostProblem !== null) {
      return { configured: false, reason: hostProblem };
    }

    if (!this.#transport.hasCredential(this.id)) {
      return { configured: false, reason: 'Cerebras inference is not configured.' };
    }
    return { configured: true };
  }

  /**
   * The live model list, which is the authority.
   *
   * Falls back to the registry's seeded entries when the provider cannot be
   * reached - and those are marked `unverified`, so nothing here can turn a
   * guess into a claim.
   */
  async getAvailableModels(): Promise<readonly ModelInfo[]> {
    const seeded = MODEL_REGISTRY.filter((model) => model.inferenceProvider === this.id);
    if (!this.isConfigured().configured) return seeded;

    try {
      const response = (await this.#transport.request({
        providerId: this.id,
        path: MODELS_PATH,
        body: null,
      })) as ModelListResponse;

      const listed = (response.data ?? [])
        .map((entry) => (typeof entry.id === 'string' ? entry.id : null))
        .filter((id): id is string => id !== null);

      if (listed.length === 0) return seeded;

      return listed.map((id) => {
        // Keep what the seed knew about a model the provider confirms, but the
        // status becomes `available` because the provider has now named it.
        const known = seeded.find((model) => model.id === id);
        return {
          ...(known ?? {
            name: id,
            family: id.split(/[-_]/)[0] ?? id,
            author: 'Unknown',
            capabilities: ['chat'] as const,
            contextLength: 0,
            maxOutputTokens: null,
          }),
          id,
          inferenceProvider: this.id,
          status: 'available' as const,
        } as ModelInfo;
      });
    } catch {
      return seeded;
    }
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return (await this.getAvailableModels()).find((model) => model.id === modelId);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const configuration = this.isConfigured();
    if (!configuration.configured) {
      throw new Error(configuration.reason ?? 'Cerebras inference is not configured.');
    }

    const response = (await this.#transport.request({
      providerId: this.id,
      path: CHAT_PATH,
      body: {
        // Never defaulted here. A provider that substituted its own model
        // would make the status panel a lie.
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined
          ? { max_completion_tokens: request.maxOutputTokens }
          : {}),
        stream: false,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    })) as ChatCompletionResponse;

    const choice = response.choices?.[0];
    const content = choice?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('Cerebras returned a response with no text in it.');
    }

    return {
      text: content,
      // What the provider says it ran, falling back to what was asked. These
      // are usually the same and the difference matters when they are not.
      model: typeof response.model === 'string' ? response.model : request.model,
      inferenceProvider: this.id,
      usage: {
        inputTokens: asNumber(response.usage?.prompt_tokens),
        outputTokens: asNumber(response.usage?.completion_tokens),
      },
      stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    };
  }

  /**
   * Streaming.
   *
   * Server-sent events cannot be read through a request/response transport, so
   * until the shell grows a streaming channel this runs the non-streaming path
   * and delivers the text in one piece. The caller sees a correct result and a
   * single chunk rather than a fabricated typing effect - a fake stream would
   * be a lie about latency, which is the one thing Cerebras is chosen for.
   */
  async stream(
    request: GenerateRequest,
    onChunk: (text: string) => void,
  ): Promise<GenerateResult> {
    const result = await this.generate(request);
    if (result.text !== '') onChunk(result.text);
    return result;
  }
}
