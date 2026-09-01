/**
 * Models and the infrastructure that runs them.
 *
 * These are two different things and the type system is made to say so,
 * because conflating them is the mistake that produces a status panel reading
 * "AI MODEL: Cerebras". Cerebras is not a model. It is an inference provider -
 * infrastructure that runs models other people trained. Llama is a model.
 * Qwen is a model. gpt-oss is a model. Any of them can run on Cerebras, and
 * the same model can run somewhere else entirely.
 *
 * So a `ModelInfo` names the model and records which provider serves it, and
 * an `InferenceProvider` knows how to run models without knowing which one it
 * will be asked for. Neither is allowed to hard-code the other.
 *
 * The consequence worth stating: every result carries the model and provider
 * that *actually* ran, not the ones that were requested. When a fallback
 * substitutes something, the substitution is in the result rather than in a
 * log nobody reads.
 */

/** What a model can do. Used for routing, so it must describe real capability. */
export type Capability = 'chat' | 'reasoning' | 'coding' | 'vision' | 'fast' | 'long-context';

/**
 * How much is actually known about a model entry.
 *
 * `unverified` is not a soft form of `available`. It means the id and details
 * were written from documentation rather than confirmed against the provider's
 * own model list, and it must not be presented as a working configuration.
 * The authoritative list always comes from `getAvailableModels()`.
 */
export type ModelStatus = 'available' | 'unverified' | 'unavailable';

export interface ModelInfo {
  /** The exact id the inference provider expects on the wire. */
  id: string;
  /** Display name. */
  name: string;
  /** Model family: Llama, Qwen, gpt-oss, Claude. Not the provider. */
  family: string;
  /** Who trained it. Meta, Alibaba, OpenAI, Anthropic. Not the provider. */
  author: string;
  /** Id of the InferenceProvider that serves it. */
  inferenceProvider: string;
  capabilities: readonly Capability[];
  /** Maximum input context in tokens. */
  contextLength: number;
  /** Maximum tokens it will produce in one response, when known. */
  maxOutputTokens: number | null;
  status: ModelStatus;
  /** Why the status is what it is. Required for anything not `available`. */
  note?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  /** Wire id of the model to run. Never defaulted inside a provider. */
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface GenerateResult {
  text: string;
  /** The model that actually produced this. May differ from what was asked. */
  model: string;
  /** The provider that actually ran it. */
  inferenceProvider: string;
  usage: TokenUsage;
  /** Why generation stopped, as the provider reported it. Null when unstated. */
  stopReason: string | null;
}

export interface ProviderConfiguration {
  configured: boolean;
  /** Present when not configured: what is missing, in plain language. */
  reason?: string;
}

/**
 * Infrastructure that runs models.
 *
 * Deliberately knows nothing about which model it will be asked for: the model
 * arrives in the request. A provider that hard-coded one would have to be
 * rewritten to change models, which is precisely what this interface exists to
 * prevent.
 */
export interface InferenceProvider {
  readonly id: string;
  readonly name: string;
  /** Where inference happens. A privacy and cost fact, not a detail. */
  readonly location: 'local' | 'cloud';

  /** Whether it can actually run. Never optimistic. */
  isConfigured(): ProviderConfiguration;

  /** Models this provider serves. The authoritative list where one exists. */
  getAvailableModels(): Promise<readonly ModelInfo[]>;

  getModelInfo(modelId: string): Promise<ModelInfo | undefined>;

  generate(request: GenerateRequest): Promise<GenerateResult>;

  /**
   * Same as generate, delivering text as it arrives.
   * Resolves with the complete result once the stream ends.
   */
  stream(
    request: GenerateRequest,
    onChunk: (text: string) => void,
  ): Promise<GenerateResult>;
}

/**
 * How a request reaches an outside origin.
 *
 * Split out because the answer differs by host, and the difference is the
 * whole reason the desktop shell exists. A browser page cannot hold an API key
 * safely - anything in the page is readable by anything else in the page - and
 * this build's content policy forbids reaching an outside origin at all. The
 * shell makes the request in Rust, where the key never enters the web view.
 *
 * A provider therefore never calls `fetch` itself. It asks a transport, and
 * the transport is what knows whether that is possible here.
 */
export interface InferenceTransport {
  readonly id: string;
  /** Why a request cannot be made from this host, or null when it can. */
  unavailableReason(): string | null;
  /** Whether a credential is held for this provider. Never the value. */
  hasCredential(providerId: string): boolean;

  request(options: {
    providerId: string;
    path: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<unknown>;
}
