import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { AIRouter, Requirement } from '../ai/AIRouter.js';

/**
 * Writing code, on this machine and nowhere else (spec 5, and your standing
 * instruction that it be completely local).
 *
 * "Completely local" is the whole design, and it is why this does not simply
 * call `AIRouter.generate`. The router *prefers* local when the setting says
 * so, and prefers is not only: it will fall back to a cloud provider when the
 * local one is busy, misconfigured or slow to answer. For ordinary chat that
 * fallback is a kindness. Here it would mean the thing you asked to stay on
 * this machine quietly left it - and you would not be told, because a
 * substitution note is easy to miss and impossible to undo.
 *
 * So this picks the provider itself, from the local ones only, and refuses
 * with a reason when there are none. A refusal you can act on beats an answer
 * that broke the one rule you set.
 */

export const CODE_REQUIREMENT: Requirement = {
  capabilities: ['chat'],
  reason: 'Writing code.',
};

export interface CodeRequest {
  instruction: string;
  /** Hint for the model and for the fence label. Free text: "python", "rust". */
  language?: string;
}

export interface CodeResult {
  code: string;
  /** What the model actually labelled it, or the requested language. */
  language: string;
  /** Anything the model said outside the code, kept rather than discarded. */
  notes: string;
  modelId: string;
  providerId: string;
}

export interface CodeWriterOptions {
  router: AIRouter;
  logger: Logger;
}

/**
 * The instruction given to the model.
 *
 * Small local models are chatty and apologetic, and they explain code that was
 * not asked about. The prompt asks for one fenced block so the answer can be
 * separated reliably, rather than hoping prose and code are distinguishable
 * afterwards.
 */
export function codePrompt(request: CodeRequest): { system: string; user: string } {
  const language = request.language?.trim();
  return {
    system: [
      'You write code. Reply with exactly one fenced code block.',
      language ? `Write it in ${language}.` : 'Choose a language that suits the request, and label the fence with it.',
      'Label the fence with the language, like ```python.',
      'Put anything you need to say after the block, in one or two sentences. Never inside it.',
      'Do not apologise, do not restate the request, and do not explain code that works.',
      'If the request is ambiguous, make the smallest reasonable assumption and say what you assumed after the block.',
    ]
      .filter(Boolean)
      .join(' '),
    user: request.instruction,
  };
}

const FENCE = /```([\w+#.-]*)\r?\n([\s\S]*?)```/;

/**
 * Separate the code from whatever else the model said.
 *
 * A model that ignores the instruction and replies in prose still gets its
 * answer shown - as code, because that is what was asked for, and hiding it
 * behind "no code block found" would throw away a working answer over
 * formatting.
 */
export function extractCode(text: string, fallbackLanguage = ''): { code: string; language: string; notes: string } {
  const match = FENCE.exec(text);
  if (!match) {
    return { code: text.trim(), language: fallbackLanguage, notes: '' };
  }

  const [whole, fenceLanguage = '', body = ''] = match;
  const notes = (text.slice(0, match.index) + text.slice(match.index + whole.length))
    .replace(/```[\s\S]*?```/g, '')
    .trim();

  return {
    code: body.replace(/\s+$/, ''),
    language: fenceLanguage.trim() || fallbackLanguage,
    notes,
  };
}

export class CodeWriter {
  readonly #router: AIRouter;
  readonly #logger: Logger;

  constructor(options: CodeWriterOptions) {
    this.#router = options.router;
    this.#logger = options.logger;
  }

  /** The local models that could write code, best first. */
  #localCandidates() {
    return this.#router
      .plan(CODE_REQUIREMENT)
      .filter((candidate) => candidate.provider.location === 'local');
  }

  /**
   * Whether code can be written without leaving this machine.
   *
   * Reported separately from writing, so the screen can say "no local model"
   * before somebody types a request rather than after.
   */
  available(): { available: boolean; reason: string | null } {
    if (this.#localCandidates().length > 0) return { available: true, reason: null };

    const anyAtAll = this.#router.plan(CODE_REQUIREMENT).length > 0;
    return {
      available: false,
      reason: anyAtAll
        ? 'Helix can reach a model, but only a cloud one. Writing code here is local-only, so it will not use it. Install a local model - Ollama with a code model is the usual choice.'
        : 'No model is configured at all. Writing code needs one, and it has to be a local one.',
    };
  }

  async write(request: CodeRequest): Promise<CodeResult> {
    const instruction = request.instruction.trim();
    if (instruction === '') {
      throw new HelixError('VALIDATION_FAILED', 'Tell me what to write.');
    }

    const candidates = this.#localCandidates();
    const first = candidates[0];
    if (!first) {
      throw new HelixError(
        'PROVIDER_NOT_CONFIGURED',
        this.available().reason ?? 'No local model is available.',
        { remedy: 'settings:providers' },
      );
    }

    const prompt = codePrompt(request);
    const failures: string[] = [];

    // Every candidate here is local, so falling through them cannot leave the
    // machine. That is the only reason a loop is safe at all.
    for (const candidate of candidates) {
      try {
        const result = await candidate.provider.generate({
          model: candidate.model.id,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });

        const extracted = extractCode(result.text, request.language?.trim() ?? '');
        if (extracted.code.trim() === '') {
          failures.push(`${candidate.model.id} returned nothing`);
          continue;
        }

        return {
          ...extracted,
          modelId: candidate.model.id,
          providerId: candidate.provider.id,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#logger.warn('A local model could not write that.', {
          model: candidate.model.id,
          reason,
        });
        failures.push(`${candidate.model.id}: ${reason}`);
      }
    }

    throw new HelixError('PROVIDER_UNREACHABLE', 'The local model could not write that.', {
      technical: failures.join('; '),
      remedy: 'settings:providers',
    });
  }
}
