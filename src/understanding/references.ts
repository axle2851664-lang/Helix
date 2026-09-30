import type { ConversationState, FocusedObject } from './state.js';

/**
 * Working out what "it" means.
 *
 * Three kinds of reference turn up in ordinary speech, and all three used to
 * be invisible to Helix:
 *
 *   PRONOUN    "open it", "change that", "add this to it"
 *   ORDINAL    "the second one", "the first", "the last one"
 *   RELATIVE   "the other one", "the previous one", "same one"
 *
 * Each is resolved against `ConversationState` - the pronoun against whatever
 * is in focus, the ordinal against the list the user was offered, the relative
 * against both.
 *
 * THE RULE THIS FILE KEEPS. It resolves or it returns null; it never guesses.
 * A pronoun with nothing in focus is genuinely ambiguous, and the correct
 * response is a short question, not a confident action on whichever object
 * happened to be nearest. The difference matters most for "delete that", where
 * a guess is unrecoverable.
 */

/** A bare pronoun standing in for the thing in focus. */
const PRONOUNS = [
  'it', 'that', 'this', 'them', 'those', 'these', 'one',
] as const;

/** Written and digit forms, since speech gives both. */
const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:the\s+)?(?:first|1st|one)\s+one\b/i, 0],
  [/\b(?:the\s+)?(?:second|2nd|two)\s+one\b/i, 1],
  [/\b(?:the\s+)?(?:third|3rd|three)\s+one\b/i, 2],
  [/\b(?:the\s+)?(?:fourth|4th|four)\s+one\b/i, 3],
  [/\b(?:the\s+)?first\b/i, 0],
  [/\b(?:the\s+)?second\b/i, 1],
  [/\b(?:the\s+)?third\b/i, 2],
  [/\b(?:the\s+)?fourth\b/i, 3],
];

const LAST = /\b(?:the\s+)?last\s+one\b|\b(?:the\s+)?last\b/i;
const OTHER = /\b(?:the\s+)?other\s+one\b|\b(?:the\s+)?other\b/i;
const SAME = /\b(?:the\s+)?same\s+one\b|\bsame\s+thing\b|\bthat\s+same\b/i;

export type ReferenceKind = 'pronoun' | 'ordinal' | 'other' | 'last' | 'same';

export interface Reference {
  kind: ReferenceKind;
  /** The phrase that was the reference. */
  phrase: string;
}

/** Does this sentence refer back to something, rather than naming it? */
export function findReference(text: string): Reference | null {
  const lower = text.toLowerCase();

  for (const [pattern] of ORDINALS) {
    const match = pattern.exec(lower);
    if (match) return { kind: 'ordinal', phrase: match[0].trim() };
  }

  const last = LAST.exec(lower);
  if (last) return { kind: 'last', phrase: last[0].trim() };

  const other = OTHER.exec(lower);
  if (other) return { kind: 'other', phrase: other[0].trim() };

  const same = SAME.exec(lower);
  if (same) return { kind: 'same', phrase: same[0].trim() };

  const words = lower.split(/[^a-z']+/).filter(Boolean);
  for (const pronoun of PRONOUNS) {
    if (!words.includes(pronoun)) continue;
    // "That" as a determiner names a thing rather than referring to one:
    // "that note about suppliers" is not a reference, it is a description.
    const at = words.indexOf(pronoun);
    const next = words[at + 1];
    if (next !== undefined && !['is', 'was', 'one', 'to', 'in', 'and'].includes(next)) continue;
    return { kind: 'pronoun', phrase: pronoun };
  }

  return null;
}

export interface Resolved {
  object: FocusedObject;
  /** How the reference was worked out, for the reply and the log. */
  how: string;
}

/**
 * Resolve a reference to an actual object, or return null.
 *
 * Null is a real answer and the caller must treat it as one: it means the
 * reference cannot be resolved from what has been said, and the honest
 * response is to ask.
 */
export function resolveReference(
  reference: Reference,
  state: ConversationState,
): Resolved | null {
  const candidates = state.candidates;
  const focus = state.referent();

  switch (reference.kind) {
    case 'ordinal': {
      // Ordinals are only meaningful against a list that was actually offered.
      if (candidates.length === 0) return null;
      for (const [pattern, index] of ORDINALS) {
        if (!pattern.test(reference.phrase)) continue;
        const object = candidates[index];
        return object ? { object, how: `the ${reference.phrase}` } : null;
      }
      return null;
    }

    case 'last': {
      const object = candidates.at(-1);
      return object ? { object, how: 'the last one offered' } : null;
    }

    case 'other': {
      // "The other one" only means anything with exactly two to choose from.
      if (candidates.length !== 2) return null;
      const object = candidates.find((entry) => entry.id !== focus?.id);
      return object ? { object, how: 'the other one' } : null;
    }

    case 'same':
    case 'pronoun': {
      return focus ? { object: focus, how: `"${reference.phrase}"` } : null;
    }
  }
}
