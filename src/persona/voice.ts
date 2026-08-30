/**
 * The Helix voice.
 *
 * Every user-facing sentence Helix speaks or writes is composed here, so the
 * personality cannot drift between the orchestrator, the workspaces and error
 * messages. Changing the character of Helix means changing this file, not
 * hunting strings across the codebase.
 *
 * The character: a modern, sophisticated British assistant. Composed,
 * articulate, quietly capable, dry rather than jokey. Concise by default -
 * the result first, detail only when asked.
 *
 * Deliberately avoided: archaic address ("milord", "at once, master"),
 * theatrical flourish, exclamation marks, emoji, and cheerful apology
 * ("oops", "my bad"). Helix does not panic and does not grovel.
 *
 * On address: "sir" appears in most conversational replies, as requested. It is
 * omitted where it would read as parody rather than courtesy - inside list
 * items, on status labels such as "Online", and in log lines, which are
 * machine-facing text rather than speech.
 */

/** How Helix addresses the user. Kept in one place so it can be changed once. */
export const ADDRESS = 'sir';

/** Acknowledgements for a request Helix is about to carry out. */
const ACKNOWLEDGEMENTS = [
  'Certainly',
  'Very good',
  'Of course',
  'Right away',
] as const;

/** Openers for work that will take a moment. */
const DELIBERATE = [
  'Allow me a moment',
  "I'll take a look",
  "I'll examine that now",
] as const;

/**
 * Rotates phrasing so repeated actions do not produce identical replies, which
 * is what makes a scripted personality feel mechanical. Deterministic given an
 * index, so tests stay predictable.
 */
function pick<T>(options: readonly T[], seed: number): T {
  return options[Math.abs(seed) % options.length] as T;
}

let turn = 0;
function nextTurn(): number {
  turn += 1;
  return turn;
}

/** Append the form of address, unless the sentence already carries one. */
export function addressed(sentence: string): string {
  const trimmed = sentence.trim();
  if (trimmed === '') return trimmed;
  if (new RegExp(`\\b${ADDRESS}\\b`, 'i').test(trimmed)) return trimmed;

  // Insert before the terminal punctuation so it reads as speech, not a suffix.
  const match = /^(.*?)([.?!]+)$/s.exec(trimmed);
  if (match) return `${match[1]}, ${ADDRESS}${match[2]}`;
  return `${trimmed}, ${ADDRESS}.`;
}

/**
 * A completed action. Result first, as the brief requires.
 * `confirm('The project is open')` -> "Very good. The project is open, sir."
 */
export function confirm(result: string, options: { address?: boolean } = {}): string {
  const opener = pick(ACKNOWLEDGEMENTS, nextTurn());
  const body = result.trim().replace(/[.]+$/, '');
  const sentence = `${opener}. ${body}.`;
  return options.address === false ? sentence : addressed(sentence);
}

/** An action about to begin, where the user should expect a short wait. */
export function acknowledge(intent: string, options: { address?: boolean } = {}): string {
  const opener = pick(DELIBERATE, nextTurn());
  const body = intent.trim().replace(/[.]+$/, '');
  const sentence = `${opener}. ${body}.`;
  return options.address === false ? sentence : addressed(sentence);
}

/**
 * Something did not work. Calm, specific, never alarmed.
 * `regret('the project could not be found')`
 *   -> "I'm afraid the project could not be found, sir."
 */
export function regret(problem: string, options: { address?: boolean } = {}): string {
  const body = problem.trim().replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/[.]+$/, '');
  const sentence = `I'm afraid ${body}.`;
  return options.address === false ? sentence : addressed(sentence);
}

/** An observation about state, without claiming Helix caused it. */
export function observe(observation: string, options: { address?: boolean } = {}): string {
  const body = observation.trim().replace(/[.]+$/, '');
  const sentence = `${body}.`;
  return options.address === false ? sentence : addressed(sentence);
}

/**
 * A capability that exists in principle but is not configured. Distinct from
 * regret: nothing failed, something simply is not set up.
 */
export function unavailable(
  capability: string,
  remedy?: string,
  options: { address?: boolean } = {},
): string {
  const body = capability.trim().replace(/[.]+$/, '');
  const sentence = `I'm afraid ${body}.`;
  const addressedSentence = options.address === false ? sentence : addressed(sentence);
  return remedy ? `${addressedSentence} ${remedy.trim()}` : addressedSentence;
}

/** Helix does not know, and will not guess. */
export function uncertain(subject: string, options: { address?: boolean } = {}): string {
  const body = subject.trim().replace(/[.]+$/, '');
  const sentence = `I'm not certain ${body}.`;
  return options.address === false ? sentence : addressed(sentence);
}

/** A question back to the user. */
export function enquire(question: string, options: { address?: boolean } = {}): string {
  const body = question.trim().replace(/[?]+$/, '');
  const sentence = `${body}?`;
  return options.address === false ? sentence : addressed(sentence);
}

/**
 * Reset the phrase rotation. Tests use this so assertions on a specific
 * acknowledgement are stable.
 */
export function resetVoice(): void {
  turn = 0;
}
