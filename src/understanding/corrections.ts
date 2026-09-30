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
  if (cancel) {
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
    // "No." on its own is a refusal, not a redirection to something unnamed.
    if (remainder === '') return null;
    return { kind: 'replace', remainder, marker: marked(replace[0].trim()) };
  }

  /**
   * A softener with something after it and no other marker is a redirection:
   * "actually, the Helix notes" changes the target and nothing else.
   */
  if (softener) return { kind: 'replace', remainder: trimmed, marker: softener[0].trim() };

  return null;
}
