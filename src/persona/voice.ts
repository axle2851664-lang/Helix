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
 * On address: "sir" appears in roughly a third of conversational replies.
 *
 * This is a deliberate change from the earlier instruction, which was to use
 * it in almost every sentence. Doing that turned out to read as parody rather
 * than courtesy - "Yes sir." / "Certainly sir." / "Of course sir." in
 * succession sounds like a machine performing deference rather than a person
 * being polite. A real assistant addresses you when it is natural to: opening
 * a reply, confirming something, delivering news. Not four times a minute.
 *
 * The rate is enforced rather than left to chance, because a rule applied by
 * feel drifts. `addressed()` consults a rolling window of recent replies and
 * declines to add the address when the recent rate is already at target. It is
 * still omitted entirely where it would be absurd - inside list items, on
 * status labels such as "Online", and in log lines, which are machine-facing
 * text rather than speech.
 */

/** How Helix addresses the user. Kept in one place so it can be changed once. */
export const ADDRESS = 'sir';

/**
 * Target share of conversational replies carrying the address.
 *
 * A third: frequent enough to be characteristic, sparse enough that it never
 * lands twice in a row by default.
 */
export const ADDRESS_RATE = 0.33;

/** How many recent replies the rate is measured over. */
const ADDRESS_WINDOW = 12;

/** true where the address was used, newest last. */
let addressHistory: boolean[] = [];

/** Share of the recent window that carried the address. */
export function recentAddressRate(): number {
  if (addressHistory.length === 0) return 0;
  const used = addressHistory.filter(Boolean).length;
  return used / addressHistory.length;
}

function recordAddress(used: boolean): void {
  addressHistory.push(used);
  if (addressHistory.length > ADDRESS_WINDOW) addressHistory.shift();
}

/**
 * Should this reply carry the address?
 *
 * Rate-based rather than random: randomness produces runs, and a run of four
 * is exactly the effect being avoided. Never twice in immediate succession.
 */
function shouldAddress(): boolean {
  if (addressHistory.at(-1) === true) return false;
  return recentAddressRate() < ADDRESS_RATE;
}

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

/**
 * May a reply Helix did not compose keep its form of address?
 *
 * The rate rule above governs Helix's own scripted sentences, and a language
 * model's replies were outside it entirely - which showed. Measured on
 * qwen2.5:3b with the full persona prompt, and with that prompt asking in
 * plain words for roughly a third: "sir" appeared in five replies out of six.
 *
 * The same rolling window therefore governs both, so the two halves of Helix's
 * voice cannot drift apart. The outcome is recorded either way, because a
 * window that only counted the replies it approved would never fall back below
 * target and would refuse the address forever after.
 */
export function allowAddressInReply(replyHasAddress: boolean): boolean {
  if (!replyHasAddress) {
    recordAddress(false);
    return false;
  }

  const allowed = shouldAddress();
  recordAddress(allowed);
  return allowed;
}

/** Append the form of address, unless the sentence already carries one. */
export function addressed(sentence: string, options: { force?: boolean } = {}): string {
  const trimmed = sentence.trim();
  if (trimmed === '') return trimmed;

  // Already addressed: count it, and leave it alone.
  if (new RegExp(`\\b${ADDRESS}\\b`, 'i').test(trimmed)) {
    recordAddress(true);
    return trimmed;
  }

  if (!options.force && !shouldAddress()) {
    recordAddress(false);
    return trimmed;
  }
  recordAddress(true);

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
  addressHistory = [];
}
