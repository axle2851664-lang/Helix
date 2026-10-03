/**
 * Noticing when the user changes their mind.
 *
 * People correct themselves constantly, and an assistant that treats every
 * correction as a brand-new request makes them start over:
 *
 *   User:  Open my Blender notes.
 *   Helix: Opening them.
 *   User:  No, I meant the Helix notes.
 *
 * Read as a fresh request that second line is fine - it names a subject. But
 *
 *   User:  No, the other one.
 *   User:  Actually, forget that.
 *   User:  Wait, make it simpler.
 *
 * are not fresh requests at all. They modify, redirect or cancel the thing
 * just done, and they only mean anything against it.
 *
 * WHAT EACH ONE MEANS TO THE LAYER ABOVE:
 *
 *   REPLACE  the target was wrong, the verb stands. Redo with the new target.
 *   CANCEL   drop it. Nothing further happens, and Helix says so plainly
 *            rather than silently doing nothing.
 *   REPEAT   do the last action again.
 *   REVISE   same object, changed instruction - "make it simpler".
 *
 * A correction is detected here and acted on by the resolver, which has the
 * conversation state. This file only reads the sentence.
 */

export type CorrectionKind = 'replace' | 'cancel' | 'repeat' | 'revise';

export interface Correction {
  kind: CorrectionKind;
  /** The sentence with the correction marker removed, where one remains. */
  remainder: string;
  /** The phrase that marked it, for the log. */
  marker: string;
}

/**
 * Softeners that precede a correction without being one.
 *
 * "Actually, forget that" is a cancellation and "actually, the other one" is a
 * redirection - the word "actually" says only that a correction is coming. It
 * is peeled off first, so what follows is classified on its own merits.
 * Without this, everything beginning "wait," was read as a redirection,
 * including "wait, make it simpler", which is a revision.
 */
const SOFTENERS = /^(?:actually|wait|hold on|hang on|sorry|oh|erm|um)[,\s]+/i;

const CANCEL = [
  /^(?:never\s*mind|forget (?:it|that|about it)|cancel(?: that)?|stop|drop it|leave it|don'?t bother)\b/i,
  /^no,?\s*(?:never\s*mind|forget it|don'?t)\b/i,
];

const REPEAT = [
  /^(?:do (?:it|that) again|again|repeat(?: that)?|once more|same again|try again)\b/i,
];

/**
 * A redirection. The marker is stripped and what is left is the new request,
 * which may be a bare target ("the Helix notes") rather than a full sentence.
 */
const REPLACE = [
  /^(?:no,?\s*)?i\s+meant\s+/i,
  /^no,?\s+/i,
  /^actually,?\s+/i,
  /^wait,?\s+/i,
  /^sorry,?\s+(?:i meant\s+)?/i,
  /^not that(?: one)?,?\s*/i,
  /^use (?:the )?other\b/i,
];

const REVISE = [
  /^(?:make|do) (?:it|that|this)\s+/i,
  /^(?:change|adjust|tweak|edit) (?:it|that|this)\b/i,
  /^(?:try|do) (?:something|it) (?:else|differently|another way)\b/i,
  /^(?:shorter|simpler|longer|bigger|smaller)\b/i,
];

/**
 * Words that carry no instruction on their own.
 *
 * "No, it's yes" was being read as a redirection: the "no" matched, and what
 * was left - "it's yes" - named nothing, so the layer helpfully carried the
 * previous action forward and opened Files again. The user was correcting
 * Helix's English, not asking for anything.
 *
 * A redirection has to redirect *to* something. When everything after the
 * marker is noise, there is no correction here at all.
 */
const NOISE: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ye', 'no', 'nope', 'nah', 'ok', 'okay', 'k',
  'sure', 'fine', 'right', 'alright', 'alr', 'cool', 'nice', 'good', 'great',
  'thanks', 'thank', 'thx', 'ta', 'cheers', 'please', 'lol', 'haha', 'bro',
  'bruh', 'mate', 'dude', 'huh', 'hmm', 'um', 'uh', 'er', 'oh', 'ah', 'well',
  'it', 'its', "it's", 'that', 'this', 'is', 'was', 'the', 'a', 'an', 'i',
  'you', 'me', 'my', 'your', 'bet', 'word', 'facts', 'true',
]);

/** True when a phrase is nothing but filler, affirmation or punctuation. */
export function isNoise(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 0 || words.every((word) => NOISE.has(word));
}

function firstMatch(text: string, patterns: readonly RegExp[]): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

/** Is this sentence a correction to what just happened? */
export function findCorrection(text: string): Correction | null {
  const whole = text.trim();
  if (whole === '') return null;

  const softener = SOFTENERS.exec(whole);
  const trimmed = softener ? whole.slice(softener[0].length).trim() : whole;
  const marked = (marker: string): string => (softener ? `${softener[0].trim()} ${marker}`.trim() : marker);
  if (trimmed === '') return null;

  const cancel = firstMatch(trimmed, CANCEL);
  /**
   * A cancellation only cancels when it is the whole instruction.
   *
   * "Stop" and "cancel that" abort what was asked for. "Stop the timer" and
   * "cancel the alarm" name a thing to act on, and are requests - but both
   * begin with a marker, so matching the marker alone read them as aborts and
   * discarded the rest of the sentence. The result was that every way of
   * stopping a timer declined, while "pause the timer" worked, which is a
   * difference no user could be expected to discover.
   *
   * So anything beyond the marker that is not filler means this is a
   * sentence, not an abort. `isNoise` already knows what filler is, and is
   * reused rather than a second list of small words being invented here.
   */
  if (cancel && isNoise(trimmed.slice(cancel[0].length))) {
    return { kind: 'cancel', remainder: '', marker: marked(cancel[0].trim()) };
  }

  const repeat = firstMatch(trimmed, REPEAT);
  if (repeat) {
    return { kind: 'repeat', remainder: '', marker: marked(repeat[0].trim()) };
  }

  const revise = firstMatch(trimmed, REVISE);
  if (revise) {
    return {
      kind: 'revise',
      remainder: trimmed.slice(revise[0].length).trim(),
      marker: marked(revise[0].trim()),
    };
  }

  const replace = firstMatch(trimmed, REPLACE);
  if (replace) {
    const remainder = trimmed.slice(replace[0].length).trim();
    // "No." on its own is a refusal, not a redirection to something unnamed,
    // and "no, it's yes" redirects to nothing either.
    if (remainder === '' || isNoise(remainder)) return null;
    return { kind: 'replace', remainder, marker: marked(replace[0].trim()) };
  }

  /**
   * A softener with something after it and no other marker is a redirection:
   * "actually, the Helix notes" changes the target and nothing else.
   */
  if (softener && !isNoise(trimmed)) {
    return { kind: 'replace', remainder: trimmed, marker: softener[0].trim() };
  }

  return null;
}
