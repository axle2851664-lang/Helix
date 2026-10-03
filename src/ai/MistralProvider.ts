import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

/**
 * Mistral inference.
 *
 * Mistral runs models; it is not one - the same distinction Cerebras is held
 * to, and for the same reason: if "Mistral" ever appears as a model family,
 * the status panel starts reporting the company where the model should be.
 *
 * The API is OpenAI-compatible chat completions, so everything here lives in
 * `OpenAICompatibleProvider`. What is genuinely Mistral's own is the output
 * cap's name: `max_tokens`, where Cerebras takes `max_completion_tokens`.
 * Sending the wrong one is not an error - the provider ignores it, and the
 * first sign is a reply far longer than it was asked for.
 */
export class MistralProvider extends OpenAICompatibleProvider {
  readonly id = 'mistral';
  readonly name = 'Mistral';
  protected readonly maxTokensParam = 'max_tokens';
}
