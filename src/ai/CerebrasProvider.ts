import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';

/**
 * Cerebras inference.
 *
 * Cerebras runs models; it is not one. This class knows how to talk to their
 * API and has no opinion about which model it is asked for - the model arrives
 * in the request, so changing model is a configuration change and never a code
 * change. That is the requirement this whole file is shaped around.
 *
 * The API is OpenAI-compatible chat completions, which is why almost all of it
 * now lives in `OpenAICompatibleProvider`: Mistral speaks the same dialect,
 * and a second copy of the response parser would be a second place for a
 * provider quirk to be handled in one and missed in the other.
 */
export class CerebrasProvider extends OpenAICompatibleProvider {
  readonly id = 'cerebras';
  readonly name = 'Cerebras';
  /** Cerebras spells the output cap this way; Mistral does not. */
  protected readonly maxTokensParam = 'max_completion_tokens';
}
