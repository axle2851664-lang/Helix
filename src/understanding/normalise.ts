/**
 * Getting a sentence into a shape the rest of the layer can reason about.
 *
 * This is the first stage and the least clever one, deliberately. It does not
 * try to understand anything; it removes the noise that stops later stages
 * recognising what they already know - the wake word, the politeness, the
 * punctuation, and above all the damage that speech-to-text does to ordinary
 * words.
 *
 * ON TYPOS, WHICH ARE MOSTLY NOT TYPOS. Dictation is the main way anyone talks
 * to Havoc, and a speech recogniser does two things reliably: it splits
 * compound words ("notepad" becomes "note pad", then "not pad"), and it
 * produces a near-miss on an uncommon one ("noats", "helux"). Neither is the
 * user making a mistake, so failing on them is Havoc's fault rather than
 * theirs. Both are repaired here, before anything tries to match.
 *
 * The repair is deliberately conservative. A correction is only made towards a
 * word the system actually knows - the vocabulary comes from the capability
 * registry - and only when the word is close enough that no other known word
 * is closer. Guessing aggressively would turn a sentence about a "note" into
 * one about a "node", which is worse than not understanding it at all.
 */

/**
 * Compounds a speech recogniser reliably splits, and the word meant.
 *
 * Applied before tokenising, because "note pad" is two tokens that must become
 * one. Ordered longest first so "my note book" does not become "my notebook"
 * only after "note" has already been corrected to something else.
 */
const SPLIT_COMPOUNDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnote\s+pad\b/gi, 'notepad'],
  [/\bnot\s+pad\b/gi, 'notepad'],
  [/\bnote\s+book\b/gi, 'notebook'],
  [/\bflash\s+drive\b/gi, 'flashdrive'],
  [/\bnote\s+pads\b/gi, 'notepad'],
];

/** Filler that carries no meaning and only confuses a matcher. */
const FILLER: readonly RegExp[] = [
  /^(?:hey\s+|ok(?:ay)?\s+|so\s+|um+\s+|uh+\s+|well\s+|right\s+)?havoc[,:]?\s*/i,
  /^(?:please|could you|can you|would you|will you|i want you to|i'?d like you to|i need you to)\s+/i,
  /^(?:um+|uh+|er+|so|well|ok(?:ay)?|right|yeah|hey)[,\s]+/i,
  /\s+(?:please|thanks|thank you|mate|pal)\s*$/i,
];

export interface Normalised {
  /** Lowercased, filler removed, compounds rejoined, typos repaired. */
  text: string;
  /** The same, as tokens. */
  tokens: string[];
  /** What the user actually typed, untouched. */
  original: string;
  /** Words that were corrected, as [wrong, right], for the log and for tests. */
  repairs: Array<[string, string]>;
}

/**
 * Levenshtein distance, bounded.
 *
 * Bounded because the only question ever asked is "is this within one or two
 * edits", and a full matrix on every token against every vocabulary word is
 * work done to produce a number that is then thrown away. Returns `limit + 1`
 * as soon as it can prove the distance exceeds the limit.
 */
export function editDistance(a: string, b: string, limit = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < best) best = value;
    }

    // Every path through this row already costs more than the limit allows.
    if (best > limit) return limit + 1;
    previous = current;
  }

  return previous[b.length] ?? limit + 1;
}

/**
 * How far a word may be from a known one before the correction is a guess.
 *
 * Scaled by length, because one edit in a three-letter word changes it
 * completely ("not" is not a near-miss of "note" in any useful sense - it is
 * an ordinary English word) while one edit in "notepad" almost certainly is.
 */
function allowance(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length === 4) return 1;
  // Two, from five letters up. "noats" is two edits from "notes" - a
  // recogniser mishearing a vowel and a consonant is one mistake to a person
  // and two to an edit-distance - and one edit would never reach it.
  return 2;
}

/**
 * Repair a token towards the vocabulary, or leave it alone.
 *
 * Returns the correction only when it is unambiguous: one known word is
 * closest, and nothing else ties with it. A tie means the evidence does not
 * pick a winner, and inventing one is how "node" becomes "note".
 */
function repair(word: string, vocabulary: readonly string[]): string | null {
  if (vocabulary.includes(word)) return null;

  const limit = allowance(word);
  if (limit === 0) return null;

  let best: string | null = null;
  let bestDistance = limit + 1;
  let bestLengthGap = Number.POSITIVE_INFINITY;
  let tied = false;

  for (const candidate of vocabulary) {
    /**
     * The opening has to survive.
     *
     * A recogniser mishears vowels and endings; it very rarely loses the
     * first consonant. Without this constraint "second" repaired to "record"
     * - two substitutions apart, both six letters - and "the second one"
     * became "the record one", which the matcher then read as a request to
     * write a note. One line of evidence, and it removes almost every false
     * repair there is.
     */
    const shared = word.length >= 5 ? 2 : 1;
    if (candidate.slice(0, shared) !== word.slice(0, shared)) continue;

    const distance = editDistance(word, candidate, limit);
    if (distance > limit) continue;

    /**
     * Length is the tie-break, and it is a real signal rather than a coin
     * toss: a recogniser mishearing a word preserves its length far better
     * than it preserves its letters. "noats" is two edits from both "notes"
     * and "note", and it is obviously the five-letter one.
     */
    const lengthGap = Math.abs(candidate.length - word.length);

    if (distance < bestDistance || (distance === bestDistance && lengthGap < bestLengthGap)) {
      bestDistance = distance;
      bestLengthGap = lengthGap;
      best = candidate;
      tied = false;
    } else if (distance === bestDistance && lengthGap === bestLengthGap && candidate !== best) {
      tied = true;
    }
  }

  // Still level after that, so the evidence genuinely does not pick a winner.
  return tied ? null : best;
}

/**
 * Words that are ordinary English and must never be "corrected".
 *
 * Without this, "not" becomes "note", "this" becomes "that", and a sentence
 * changes meaning on its way through a normaliser. These are common enough
 * that a near-miss against a capability word is a coincidence, not a typo.
 */
const PROTECTED: ReadonlySet<string> = new Set([
  'not', 'now', 'no', 'note', 'one', 'once', 'on', 'open', 'own', 'to', 'too',
  'the', 'that', 'this', 'these', 'those', 'them', 'then', 'there', 'their',
  'what', 'when', 'where', 'who', 'why', 'how', 'was', 'want', 'wait',
  'make', 'made', 'more', 'most', 'my', 'me', 'it', 'is', 'in', 'into',
  'find', 'fine', 'for', 'from', 'file', 'files', 'save', 'same', 'send',
  'do', 'does', 'did', 'don', 'and', 'add', 'all', 'any', 'are',
  // Ordinary words that sit one edit from a capability word. Without these,
  // "node" becomes "note" and a sentence changes meaning inside a normaliser.
  'node', 'nodes', 'nope', 'mode', 'code', 'none', 'done', 'bone', 'tone',
  'home', 'hope', 'move', 'name', 'names', 'game', 'date', 'gate', 'late',
  // Ordinals, which a reference can be built from and a repair must not eat.
  'first', 'second', 'third', 'fourth', 'last', 'other', 'same', 'next',
  'rate', 'site', 'size', 'line', 'like', 'live', 'love', 'nose', 'lost',
  'host', 'post', 'most', 'must', 'just', 'dive', 'five', 'give', 'have',
]);

export function normalise(input: string, vocabulary: readonly string[] = []): Normalised {
  const original = input;

  let text = input.trim();
  for (const [pattern, word] of SPLIT_COMPOUNDS) text = text.replace(pattern, word);

  // Filler is stripped repeatedly: "ok havoc, could you ..." has three layers.
  let previous = '';
  while (previous !== text) {
    previous = text;
    for (const pattern of FILLER) text = text.replace(pattern, '');
    text = text.trim();
  }

  text = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const repairs: Array<[string, string]> = [];
  const tokens = text.split(' ').filter(Boolean).map((word) => {
    if (PROTECTED.has(word)) return word;
    const fixed = repair(word, vocabulary);
    if (fixed === null) return word;
    repairs.push([word, fixed]);
    return fixed;
  });

  return { text: tokens.join(' '), tokens, original, repairs };
}
