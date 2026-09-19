import type {
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  InferenceProvider,
  InferenceTransport,
  ModelInfo,
  ProviderConfiguration,
} from './types.js';
import { MODEL_REGISTRY } from './registry.js';

/**
 * Google's Gemini models, through the Generative Language API.
 *
 * Unlike Cerebras, this is not an OpenAI-compatible endpoint, and the
 * differences are not cosmetic. Three of them change the code rather than the
 * field names:
 *
 * 1. **There is no `system` role.** A system prompt goes in its own
 *    `systemInstruction` field, and putting it in `contents` as a user turn
 *    instead - the obvious shortcut - makes the model treat Helix's persona as
 *    something the user said, which it then answers rather than adopts.
 *
 * 2. **The assistant role is called `model`.** Sending `assistant` is not
 *    rejected with a clear error; it produces a 400 about an invalid role at
 *    the end of a long request body.
 *
 * 3. **Turns must alternate.** Two user messages in a row are refused. Helix
 *    does send consecutive user turns - the web research tool passes evidence
 *    and then the question - so they are merged here rather than left to fail
 *    at the far end.
 *
 * As everywhere else in this directory, it never calls `fetch`. The key lives
 * in the shell's environment and is attached in Rust, so the page can use
 * Gemini without ever holding the means to.
 */

const API_VERSION = 'v1beta';

/** Read defensively: a shape that changed should yield less, never nonsense. */
interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
    finishReason?: unknown;
  }>;
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  promptFeedback?: { blockReason?: unknown };
  error?: { message?: unknown; status?: unknown };
}

interface ModelListResponse {
  models?: Array<{
    name?: unknown;
    displayName?: unknown;
    inputTokenLimit?: unknown;
    outputTokenLimit?: unknown;
    supportedGenerationMethods?: unknown;
  }>;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `models/gemini-2.5-flash` -> `gemini-2.5-flash`. */
export function bareModelId(name: string): string {
  return name.replace(/^models\//, '');
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

/**
 * Turn Helix's messages into Gemini's shape.
 *
 * Exported because this is where the three differences above are actually
 * handled, and it is worth testing directly rather than through a request.
 */
export function toGeminiBody(request: GenerateRequest): GeminiRequestBody {
  const systems: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of request.messages as readonly ChatMessage[]) {
    if (message.role === 'system') {
      // Collected rather than placed in the conversation: a persona answered
      // instead of adopted is the failure this avoids.
      if (message.content.trim() !== '') systems.push(message.content);
      continue;
    }

    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];

    if (previous && previous.role === role) {
      // Gemini refuses two turns from the same side. Merging keeps both,
      // which is better than dropping one and better than a 400.
      previous.parts.push({ text: message.content });
      continue;
    }

    contents.push({ role, parts: [{ text: message.content }] });
  }

  const config: { temperature?: number; maxOutputTokens?: number } = {};
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens;

  return {
    contents,
    ...(systems.length > 0
      ? { systemInstruction: { parts: [{ text: systems.join('\n\n') }] } }
      : {}),
    ...(Object.keys(config).length > 0 ? { generationConfig: config } : {}),
  };
}

/** Pull the text out of a response, tolerating a shape that has moved. */
export function readGeminiText(body: GenerateContentResponse): string {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => asText(part?.text))
    .filter((text) => text !== '')
    .join('');
}

export interface GeminiProviderOptions {
  transport: InferenceTransport;
}

export class GeminiProvider implements InferenceProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly location = 'cloud' as const;

  readonly #transport: InferenceTransport;

  constructor(options: GeminiProviderOptions) {
    this.#transport = options.transport;
  }

  isConfigured(): ProviderConfiguration {
    const blocked = this.#transport.unavailableReason(this.id);
    if (blocked !== null) return { configured: false, reason: blocked };
    return { configured: true };
  }

  async getAvailableModels(): Promise<readonly ModelInfo[]> {
    try {
      const body = (await this.#transport.request({
        providerId: this.id,
        path: `/${API_VERSION}/models`,
        body: null,
      })) as ModelListResponse;

      const listed = Array.isArray(body.models) ? body.models : [];
      const usable = listed.filter((model) => {
        const methods = model.supportedGenerationMethods;
        // A model that cannot generate content is not a model Helix can use;
        // embedding models are returned by the same endpoint.
        return Array.isArray(methods) && methods.includes('generateContent');
      });

      if (usable.length === 0) return this.#fromRegistry();

      return usable.map((model): ModelInfo => {
        const id = bareModelId(asText(model.name));
        return {
          id,
          name: asText(model.displayName) || id,
          family: 'Gemini',
          author: 'Google',
          inferenceProvider: this.id,
          capabilities: ['chat', 'reasoning', 'coding', 'long-context', 'vision'],
          contextLength: asNumber(model.inputTokenLimit) ?? 32_768,
          maxOutputTokens: asNumber(model.outputTokenLimit),
          // Confirmed by the provider's own list, which is the whole point of
          // asking rather than shipping a hardcoded set.
          status: 'available',
        };
      });
    } catch {
      // The live list is authoritative when it answers. When it does not,
      // saying "no models" would be worse than offering the documented ones
      // marked as unverified - which is exactly what that status is for.
      return this.#fromRegistry();
    }
  }

  #fromRegistry(): readonly ModelInfo[] {
    return MODEL_REGISTRY.filter((model) => model.inferenceProvider === this.id);
  }

  async getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
    const models = await this.getAvailableModels();
    return models.find((model) => model.id === modelId);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const model = bareModelId(request.model);
    const body = (await this.#transport.request({
      providerId: this.id,
      path: `/${API_VERSION}/models/${encodeURIComponent(model)}:generateContent`,
      body: toGeminiBody(request),
      ...(request.signal ? { signal: request.signal } : {}),
    })) as GenerateContentResponse;

    if (body.error) {
      throw new Error(asText(body.error.message) || 'Gemini refused the request.');
    }

    const text = readGeminiText(body);

    if (text === '') {
      // An empty answer has two very different causes and they need different
      // things done about them, so they are not blended into "no reply".
      const blocked = asText(body.promptFeedback?.blockReason);
      const finish = asText(body.candidates?.[0]?.finishReason);
      if (blocked !== '') {
        throw new Error(`Gemini declined to answer that (${blocked}).`);
      }
      if (finish === 'MAX_TOKENS') {
        throw new Error('Gemini hit its output limit before writing anything.');
      }
      throw new Error('Gemini returned an empty reply.');
    }

    return {
      text,
      model,
      inferenceProvider: this.id,
      usage: {
        inputTokens: asNumber(body.usageMetadata?.promptTokenCount),
        outputTokens: asNumber(body.usageMetadata?.candidatesTokenCount),
      },
      stopReason: asText(body.candidates?.[0]?.finishReason) || null,
    };
  }

  /**
   * Gemini does stream, and this does not.
   *
   * The shell's `inference_request` returns one JSON value when the request
   * completes; there is no channel for partial text to come back across. So
   * this generates and delivers the whole answer as a single chunk, which is
   * honest about what happens rather than pretending to stream by slicing a
   * finished string - a trick that looks like streaming and helps nobody.
   */
  async stream(
    request: GenerateRequest,
    onChunk: (text: string) => void,
  ): Promise<GenerateResult> {
    const result = await this.generate(request);
    onChunk(result.text);
    return result;
  }
}
