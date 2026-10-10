/**
 * How big a model is, read from its name.
 *
 * WHY THIS EXISTS. A conversation went like this, on llama3.2:1b:
 *
 *   User:  How do i give you permission
 *   Havoc: You can type "I do not want to give you access" at any time.
 *   User:  where is the menu
 *   Havoc: it's not available on your system.
 *   User:  how do i make it available
 *   Havoc: you need to configure the system to display the menu.
 *   User:  where do i do that
 *   Havoc: there is no option to configure it.
 *
 * Havoc has guards for most of that now, and they catch a great deal. What
 * they cannot do is make a one-billion-parameter model hold a conversation.
 * The user spent twenty turns believing the program was broken, and the honest
 * answer was that the model was far too small for what was being asked of it -
 * which nothing told them.
 *
 * So when a guard rejects a reply, Havoc says which model produced it and, if
 * it is undersized, says that plainly. Not as a nag on every turn: only when
 * something has already visibly gone wrong, which is when the information is
 * actually worth having.
 *
 * ON READING IT FROM THE NAME. Ollama tags carry the parameter count by
 * convention - "llama3.2:1b", "qwen2.5:7b", "phi3:3.8b" - and that convention
 * is reliable enough to act on. Where a name says nothing, this returns null
 * and Havoc says nothing about size, because a guess here would be the
 * invented telemetry the rest of the codebase refuses.
 */

/**
 * Billions of parameters, or null when the name does not say.
 *
 * Deliberately strict: the number has to be attached to a "b" and separated
 * from the rest of the name, so "llama3.2" does not read as 3.2 billion and
 * "bert" does not read as anything at all.
 */
export function parameterBillions(model: string): number | null {
  const match = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/i.exec(model);
  const value = match?.[1] === undefined ? Number.NaN : Number.parseFloat(match[1]);
  return Number.isFinite(value) && value > 0 && value < 10_000 ? value : null;
}

/**
 * Below this, a model cannot be relied on to hold a conversation.
 *
 * Four is a judgement, not a measurement, and it is worth saying which. Models
 * below about this size follow an instruction some of the time, lose the
 * thread over a few turns, and fill silence with whatever is in front of them.
 * Everything in this codebase that guards a reply - the register repair, the
 * prompt-echo detector, the invented-state check - exists because of models in
 * that range. Above it they are rarely needed.
 */
export const RELIABLE_BILLIONS = 4;

export function isUndersized(model: string): boolean {
  const size = parameterBillions(model);
  return size !== null && size < RELIABLE_BILLIONS;
}

/**
 * One line about the model, for a reply that has already gone wrong.
 *
 * Returns null when there is nothing worth saying - an unknown size, or one
 * big enough that the size is not the explanation.
 */
export function sizeNote(model: string): string | null {
  const size = parameterBillions(model);
  if (size === null || size >= RELIABLE_BILLIONS) return null;

  return `${model} is a ${size}-billion-parameter model, which is too small to hold a conversation reliably. A larger one, or an API key, is set in Models.`;
}
