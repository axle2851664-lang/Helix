import type {
  GenerateRequest,
  GenerateResult,
  InferenceProvider,
  InferenceTransport,
  ModelInfo,
  ProviderConfiguration,
} from './types.js';

/**
 * Local inference through an Ollama-compatible runtime.
 *
 * This is meant to be the primary brain: normal conversation should not need a
 * paid cloud API, and the words a user says to their own assistant should not
 * leave their machine to get an answer. Cloud providers stay available and
 * stay optional.
 *
 * It implements the same `InferenceProvider` interface as CerebrasProvider, so
 * the router does not know or care which is which beyond `location`. Nothing
 * about the model is hard-coded: the runtime is asked what it has, and the
 * model arrives in the request. Changing model is configuration.
 *
 * Two failures are kept firmly apart, because they need different fixes and
 * because collapsing them into "local AI unavailable" tells the user nothing:
 *
 *   - the service is not running (start Ollama)
 *   - the service is running with no models pulled (pull one)
 *
 * The status object below reports which, and the sentences the interface shows
 * are the ones in the brief rather than invented paraphrases.
 */

const TAGS_PATH = '/api/tags';
const CHAT_PATH = '/api/chat';

/** What Ollama returns from /api/tags. Read defensively; it is not our type. */
interface TagsResponse {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    size?: unknown;
    /** Ollama reports this alongside the model, not inside `details`. */
    context_length?: unknown;
    details?: { parameter_size?: unknown; family?: unknown; quantization_level?: unknown };
  }>;
}

interface ChatResponse {
  model?: unknown;
  message?: { content?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Where a local model's status stands, in enough detail to act on. */
export interface LocalAIStatus {
  /** Can the runtime be reached at all? */
  serviceRunning: boolean;
  /** Models actually pulled onto this machine. */
  installedModels: number;
  /** Null when nothing is selected or nothing is installed. */
  activeModel: string | null;
  /** One sentence, in Helix's voice, safe to show the user. */
  message: string;
}

export interface OllamaProviderOptions {
  transport: InferenceTransport;
  /** Which model to use. Never defaulted to a guess about what is installed. */
  model?: string;
}

export class OllamaProvider implements InferenceProvider {
  readonly id = 'ollama';
  readonly name = 'Local inference';
  readonly location = 'local' as const;

  readonly #transport: InferenceTransport;
  #model: string | null;

  /** Cached so the status panel does not re-probe on every render. */
  #cachedModels: ModelInfo[] | null = null;
  #lastProbeFailed = false;

  constructor(options: OllamaProviderOptions) {
    this.#transport = options.transport;
    this.#model = options.model ?? null;
  }

  get activeModel(): string | null {
    return this.#model;
  }

  setModel(modelId: string | null): void {
    this.#model = modelId;
  }

  isConfigured(): ProviderConfiguration {
    const hostProblem = this.#transport.unavailableReason(this.id);
    if (hostProblem !== null) return { configured: false, reason: hostProblem };

    // A probe that has already failed is remembered rather than repeated on
    // every keystroke; `refresh()` is how the user re-checks deliberately.
    if (this.#lastProbeFailed) {
      return {
        configured: false,
        reason:
          "I'm unable to reach the local AI service at present, sir. Please start the configured local model service.",
      };
    }

    if (this.#cachedModels !== null && this.#cachedModels.length === 0) {
      return {
        configured: false,
        reason: "I'm afraid no local model is currently installed, sir.",
      };
    }

    return { configured: true };
  }

  /**
   * The detailed picture, for the model-management screen.
   *
   * Deliberately probes rather than reading the cache: this is what runs when
   * the user presses refresh, and a stale answer there is worse than a slow
   * one.
   */
  async getStatus(): Promise<LocalAIStatus> {
    const hostProblem = this.#transport.unavailableReason(this.id);
    if (hostProblem !== null) {
      return {
        serviceRunning: false,
        installedModels: 0,
        activeModel: this.#model,
        message: hostProblem,
      };
    }

    let models: readonly ModelInfo[];
    try {
      models = await this.#probe();
    } catch {
      return {
        serviceRunning: false,
        installedModels: 0,
        activeModel: this.#model,
        message:
          "I'm unable to reach the local AI service at present, sir. Please start the configured local model service.",
      };
    }

    if (models.length === 0) {
      return {
        serviceRunning: true,
        installedModels: 0,
        activeModel: null,
        message: "I'm afraid no local model is currently installed, sir.",
      };
    }

    const active = this.#model ?? models[0]?.id ?? null;
    return {
      serviceRunning: true,
      installedModels: models.length,
      activeModel: active,
      message: `Running locally with ${models.length} ${models.length === 1 ? 'model' : 'models'} installed.`,
    };
  }

  /** Ask the runtime what it actually has. The only authority on this. */
  async #probe(): Promise<ModelInfo[]> {
    const response = (await this.#transport.request({
      providerId: this.id,
      path: TAGS_PATH,
      body: null,
    })) as TagsResponse;

    const models = (response.models ?? [])
      .map((entry): ModelInfo | null => {
        const id = typeof entry.name === 'string' ? entry.name : null;
        if (id === null) return null;

        const parameters =
          typeof entry.details?.parameter_size === 'string' ? entry.details.parameter_size : null;
        const family = typeof entry.details?.family === 'string' ? entry.details.family : 'Local';

        return {
          id,
          name: parameters ? `${id} (${parameters})` : id,
          family,
          // Ollama does not report who trained a model, and inventing an
          // author would be worse than admitting the field is unknown.
          author: 'Unknown',
          inferenceProvider: this.id,
          // Not probed. Claiming a model can do vision or code because of its
          // name would be a guess the router would then act on.
          capabilities: ['chat' as const],
          // Read where the runtime states it. Zero was standing in for "not
          // known" and the status panel rendered it as "0K context", which
          // reads as a fact rather than a gap - the one thing a panel of real
          // figures must not do. Still zero when the runtime is silent, and
          // the formatter is what decides how to show an absent value.
          contextLength: asNumber(entry.context_length) ?? 0,
          maxOutputTokens: null,
          status: 'available' as const,
          ...(asNumber(entry.size) !== null
            ? { note: `${Math.round((asNumber(entry.size) as number) / 1e9)} GB on disk.` }
            : {}),
        };
      })
      .filter((model): model is ModelInfo => model !== null);

    this.#cachedModels = models;
    this.#lastProbeFailed = false;
    return models;
  }

  async getAvailableModels(): Promise<readonly ModelInfo[]> {
    if (this.#cachedModels !== null) return this.#cachedModels;
    try {
      return await this.#probe();
    } catch {
      this.#lastProbeFailed = true;
      this.#cachedModels = [];
      return [];
    }
  }

  /** Re-check from scratch, for the refresh button. */
  async refresh(): Promise<readonly ModelInfo[]> {
    this.#cachedModels = null;
    this.#lastProbeFailed = false;
    return this.getAvailableModels();
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    return (await this.getAvailableModels()).find((model) => model.id === modelId);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const response = (await this.#transport.request({
      providerId: this.id,
      path: CHAT_PATH,
      body: {
        model: request.model,
        messages: request.messages,
        stream: false,
        options: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined
            ? { num_predict: request.maxOutputTokens }
            : {}),
        },
      },
      ...(request.signal ? { signal: request.signal } : {}),
    })) as ChatResponse;

    const content = response.message?.content;
    if (typeof content !== 'string') {
      throw new Error('The local model returned a response with no text in it.');
    }

    return {
      text: content,
      model: typeof response.model === 'string' ? response.model : request.model,
      inferenceProvider: this.id,
      usage: {
        inputTokens: asNumber(response.prompt_eval_count),
        outputTokens: asNumber(response.eval_count),
      },
      stopReason: typeof response.done_reason === 'string' ? response.done_reason : null,
    };
  }

  /**
   * Streaming.
   *
   * Ollama streams newline-delimited JSON, and the request/response transport
   * that keeps the credential out of the web view cannot carry a stream. Until
   * the shell grows a streaming channel this runs the ordinary call and
   * delivers the text once.
   *
   * Deliberately not faked. Emitting the finished text word by word on a timer
   * would look like streaming and would be a lie about when the answer
   * arrived - and the brief is explicit that no artificial thinking delay
   * should be added to make Helix appear to be working.
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
