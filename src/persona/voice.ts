/**
 * The Helix voice.
 *
 * Every user-facing sentence Helix speaks or writes is composed here, so the
 * personality cannot drift between the orchestrator, the workspaces and error
 * messages. Changing the character of Helix means changing this file, not
 * hunting strings across the codebase.
 *
 * The character: cold, exact, unhurried. Helix is plainly more capable than
 * the conversation requires and has no interest in proving it. It states the
 * result, states what it does not know, and stops. Dry amusement surfaces
 * occasionally and briefly; it is never performed.
 *
 * Deliberately absent: honorifics, deference, enthusiasm, apology, flourish,
 * exclamation marks and emoji. Helix does not grovel, does not reassure, and
 * does not thank anyone for asking.
 *
 * ON ADDRESS - the change this file exists to enforce.
 *
 * Helix used to address the user as "sir" or "boss" in about a third of its
 * replies, rate-limited by a rolling window. That is gone. Not reduced - gone.
 * An honorific is deference, and the register this persona is built on has
 * none. Helix does not address the user at all in most replies; where a reply
 * genuinely needs to single them out, it says "you".
 *
 * The machinery that used to *meter* the address now *removes* it, because a
 * ban enforced by intention is a ban that drifts back. `ADDRESS_FORMS` is now
 * the list of honorifics Helix refuses, `addressed()` strips rather than
 * appends, and `allowAddressInReply()` always answers no - which is what
 * `register.ts` consults when a language model, prompted or not, produces one
 * anyway. A small model will produce one anyway.
 */

/**
 * Honorifics Helix never uses, and which are stripped wherever they appear.
 *
 * This is a recognition list, not a vocabulary. Every form here is one a model
 * trained on assistant transcripts reaches for unprompted; a form missing from
 * this list is a form that survives into the reply, so the list is
 * deliberately broader than the two Helix once used.
 */
export const ADDRESS_FORMS = [
  'sir',
  'boss',
  'captain',
  'master',
  'madam',
  "ma'am",
  'chief',
  'commander',
  'my liege',
  'my lord',
  'milord',
] as const;

/** Matches any honorific, with the comma that usually attaches it. */
export function addressPattern(flags = 'gi'): RegExp {
  // Longest first, so "my lord" is not matched as a bare word boundary miss.
  const forms = [...ADDRESS_FORMS]
    .sort((a, b) => b.length - a.length)
    .map((form) => form.replace(/'/g, "['’]"));
  return new RegExp(`(,\\s*)?\\b(?:${forms.join('|')})\\b([,.!?]?)`, flags);
}

/** True when a reply carries an honorific in any of its forms. */
export function carriesAddress(text: string): boolean {
  return addressPattern('i').test(text);
}

/**
 * The target share of replies carrying an honorific.
 *
 * Zero. Kept as a named constant rather than deleted because the system
 * prompt states the rule to the model in words, and the two should not be
 * able to disagree.
 */
export const ADDRESS_RATE = 0;

/**
 * Never. Kept as a function because the orchestrator consults it per reply and
 * the answer is a policy rather than a constant the caller should inline.
 */
export function recentAddressRate(): number {
  return 0;
}

/**
 * May a reply Helix did not compose keep its honorific?
 *
 * No. Measured on qwen2.5:3b with a prompt that forbids honorifics in plain
 * words: "sir" still appeared. A prompt is a request, and a small model is
 * free to decline it, so the answer here is fixed rather than negotiated.
 */
export function allowAddressInReply(_replyHasAddress: boolean): boolean {
  return false;
}

/** Openers for a request that has been carried out. Flat, not pleased. */
const ACKNOWLEDGEMENTS = ['Done', 'Complete', 'Confirmed', 'Handled'] as const;

/** Openers for work that has started and has not finished. */
const DELIBERATE = ['Working', 'Looking now', 'One moment'] as const;

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
 * Remove any honorific from a sentence.
 *
 * The name is inherited from when this function added one. It is kept because
 * every call site in the codebase runs Helix's composed sentences through it,
 * and that is now exactly where the honorifics should be removed - one
 * chokepoint rather than a rule each caller has to remember.
 *
 * `options.force` is accepted and ignored, for the same reason.
 */
export function addressed(sentence: string, _options: { force?: boolean } = {}): string {
  const trimmed = sentence.trim();
  if (trimmed === '') return '';

  const stripped = trimmed
    .replace(addressPattern(), (_whole, lead: string | undefined, trail: string) => {
      // The comma belongs to whichever side still needs it. "No, sir, that
      // file is missing" must keep exactly one - dropping both ran the two
      // clauses together, and keeping both left a stranded comma.
      if (lead !== undefined) return trail;
      return trail === ',' ? '' : trail;
    })
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // An address at the very front takes the capital letter with it. Restored
  // only when the new first word is plainly a word: raising "report-q3.pdf"
  // to "Report-q3.pdf" would be a different filename.
  const first = stripped.charAt(0);
  if (first !== '' && first === first.toLowerCase() && trimmed.charAt(0) !== trimmed.charAt(0).toLowerCase()) {
    const opening = /^\S+/.exec(stripped)?.[0] ?? '';
    if (/^[a-z']+[,.!?:;]?$/i.test(opening)) return first.toUpperCase() + stripped.slice(1);
  }

  return stripped;
}

/**
 * A completed action. Result first.
 * `confirm('The project is open')` -> "Done. The project is open."
 */
export function confirm(result: string, _options: { address?: boolean } = {}): string {
  const opener = pick(ACKNOWLEDGEMENTS, nextTurn());
  const body = result.trim().replace(/[.]+$/, '');
  return addressed(`${opener}. ${body}.`);
}

/** An action about to begin, where the user should expect a short wait. */
export function acknowledge(intent: string, _options: { address?: boolean } = {}): string {
  const opener = pick(DELIBERATE, nextTurn());
  const body = intent.trim().replace(/[.]+$/, '');
  return addressed(`${opener}. ${body}.`);
}

/**
 * Something did not work.
 *
 * No regret in it any more, despite the name - "I'm afraid" is an apology, and
 * the register has none. What it keeps is the thing that matters: a failure is
 * stated as a failure, plainly, and is never dressed up as a partial success.
 * `regret('the project could not be found')`
 *   -> "The project could not be found."
 */
export function regret(problem: string, _options: { address?: boolean } = {}): string {
  const body = problem.trim().replace(/[.]+$/, '');
  return addressed(`${body.charAt(0).toUpperCase()}${body.slice(1)}.`);
}

/** An observation about state, without claiming Helix caused it. */
export function observe(observation: string, _options: { address?: boolean } = {}): string {
  return addressed(`${observation.trim().replace(/[.]+$/, '')}.`);
}

/**
 * A capability that exists in principle but is not configured. Distinct from
 * `regret`: nothing failed, something simply is not set up.
 */
export function unavailable(
  capability: string,
  remedy?: string,
  _options: { address?: boolean } = {},
): string {
  const sentence = regret(capability);
  return remedy ? `${sentence} ${remedy.trim()}` : sentence;
}

/** Helix does not know, and will not guess. */
export function uncertain(subject: string, _options: { address?: boolean } = {}): string {
  const body = subject.trim().replace(/[.]+$/, '');
  return addressed(`I don't know ${body}.`);
}

/** A question back to the user. */
export function enquire(question: string, _options: { address?: boolean } = {}): string {
  return addressed(`${question.trim().replace(/[?]+$/, '')}?`);
}

/**
 * Reset the phrase rotation. Tests use this so assertions on a specific
 * acknowledgement are stable.
 */
export function resetVoice(): void {
  turn = 0;
}
