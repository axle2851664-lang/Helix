import { footprintFromName } from './resources.js';
import type { ModelInfo } from './types.js';

/**
 * Choosing a local model for speed rather than for capability.
 *
 * `preferredLocalModel` picks the largest model that fits, which is the right
 * rule for the best answer and the wrong one for a fast answer. A 7B at
 * four-bit runs at a few tokens a second on a CPU; a 3B runs at several times
 * that. For ordinary conversation - "hello", "what's on my calendar" - the
 * difference between the two answers is small and the difference between two
 * seconds and forty is not.
 *
 * So the choice is made explicit rather than assumed. Speed is the default
 * because a slow assistant stops being used, and the user can ask for the
 * larger model when the answer matters more than the wait.
 *
 * What this deliberately does not do is guess at tokens per second. That
 * depends on the CPU, the GPU, the quantisation and what else is running, and
 * a made-up figure in a file about speed is exactly the sort of number
 * somebody would plan around. Parameter count is a real, readable proxy:
 * smaller is faster, always, on the same machine.
 */

export type ModelPreference = 'fast' | 'capable';

/**
 * The smallest usable model, which is the fastest one.
 *
 * Unavailable models are already excluded upstream against measured memory,
 * so everything here can actually run; this only decides which of them
 * answers first. A model whose size cannot be read sorts last - not because
 * it is bad, but because an unknown is a worse bet than a known small one
 * when the whole point is predictable speed.
 */
export function fastestLocalModel(assessed: readonly ModelInfo[]): ModelInfo | null {
  const usable = assessed.filter((model) => model.status !== 'unavailable');
  if (usable.length === 0) return null;

  const sized = usable
    .map((model) => ({ model, parameters: footprintFromName(model.id).parameters }))
    .sort((a, b) => {
      if (a.parameters === null) return 1;
      if (b.parameters === null) return -1;
      return a.parameters - b.parameters;
    });

  return sized[0]?.model ?? null;
}

/**
 * How long to keep the weights in memory after a reply.
 *
 * Ollama unloads an idle model after five minutes by default, and the next
 * message then pays the whole multi-gigabyte load again - which is the
 * difference between a two-second reply and a two-minute one, decided by how
 * long somebody happened to pause. Thirty minutes covers a normal working
 * session. It is a string because that is the format Ollama's API takes.
 */
export const KEEP_ALIVE = '30m';

/**
 * The longest ordinary reply to ask for.
 *
 * The setting defaults to 4096, which is a reasonable ceiling for a cloud
 * model and a disaster for a local one: a model generating four thousand
 * tokens at a few tokens a second takes minutes, and conversation almost
 * never needs more than a few hundred. This caps what conversation asks for
 * without touching the setting, so a deliberate long-form request can still
 * raise it.
 */
export const CONVERSATIONAL_TOKEN_CAP = 512;

/** The cap to actually send: the user's setting, or the conversational cap. */
export function replyTokenCap(setting: number | undefined, conversational: boolean): number {
  if (setting === undefined) return CONVERSATIONAL_TOKEN_CAP;
  return conversational ? Math.min(setting, CONVERSATIONAL_TOKEN_CAP) : setting;
}
