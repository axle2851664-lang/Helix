import { SANCTIONED_PHRASES } from './examples.js';
import { BRIEF_SYSTEM_PROMPT, SYSTEM_PROMPT } from './systemPrompt.js';

/**
 * Catching a model that answers with its own instructions.
 *
 * This is not hypothetical and it is not rare. Measured, in a real
 * conversation on a local model:
 *
 *   User: i created you!
 *   Helix: You are Helix, an assistant on this person's own computer. Cold,
 *          precise, composed. Never address the user by a title - no "", "",
 *          "" - and never invent one.
 *
 *   User: so what is my name
 *   Helix: You: I don't have enough information.
 *
 * Two separate failures are visible there. The model is reciting the system
 * prompt, and the register repair in `register.ts` is dutifully stripping the
 * honorifics out of the recitation - which is where the empty quotes come
 * from. Every layer did its job and the user still got Helix's instructions
 * read back at them.
 *
 * Nothing downstream could have caught it, because `register.ts` only knows
 * about the *shape* of a sentence. It has no idea what the prompt says, so a
 * paragraph of the prompt looks to it like an ordinary, well-behaved reply.
 * This module is the piece that knows.
 *
 * WHAT IT MUST NOT DO is flag a correct reply. The prompt tells Helix to say
 * certain exact sentences - "I need permission to continue", and the rest of
 * `SANCTIONED_PHRASES` - so a reply consisting of one of those is Helix doing
 * as it was told, not reciting. Those are excluded by name. Everything else
 * that is measured here is instructional text: second-person rules about how
 * to behave, which have no business in a reply under any circumstances.
 */

export type EchoReason = 'opening' | 'speaker-label' | 'instruction' | 'overlap';

export interface EchoVerdict {
  /** True when the reply is the prompt rather than an answer. */
  echoed: boolean;
  reason?: EchoReason;
  /** The fragment that gave it away, for the log. */
  found?: string;
}

/** Words, lowercased, with punctuation and quoting removed. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    // Curly and straight quotes go first: the register repair leaves behind
    // empty pairs where an honorific was, and "" must not become a token.
    .replace(/["'‘’“”]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Overlapping runs of `size` words, as joined strings. */
function shingles(words: readonly string[], size: number): string[] {
  if (words.length < size) return [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}

const SHINGLE = 6;

/**
 * The instruction text of both prompts, as a shingle set.
 *
 * Derived from the prompts themselves rather than written out, so editing a
 * prompt cannot leave this detector checking for text that no longer exists -
 * which is the way a guard like this rots without anyone noticing.
 */
const INSTRUCTION_SHINGLES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const prompt of [SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT]) {
    for (const shingle of shingles(tokens(prompt), SHINGLE)) set.add(shingle);
  }
  return set;
})();

/** Sanctioned sentences, normalised, so a correct reply is never flagged. */
const SANCTIONED: ReadonlySet<string> = new Set(
  SANCTIONED_PHRASES.map((phrase) => tokens(phrase).join(' ')),
);

/**
 * Openings that can only be the prompt.
 *
 * A reply may legitimately discuss almost anything, but it cannot legitimately
 * begin by telling Helix what Helix is.
 */
const OPENINGS: readonly RegExp[] = [
  /^\s*you are helix\b/i,
  /^\s*you are an assistant\b/i,
  /^\s*system\s*:/i,
];

/**
 * A speaker label at the start of a reply.
 *
 * "You: I don't have enough information." - the model continuing a transcript
 * rather than answering. The reply is recoverable here (the sentence after the
 * label is a fine answer), but it is still a failed generation, and stripping
 * the label would hide how often this happens.
 */
const SPEAKER_LABEL = /^\s*(?:you|user|assistant|helix|human)\s*:/i;

/**
 * How much of a reply may be verbatim instruction before it is a recitation.
 *
 * A third. Low enough to catch a reply that is mostly prompt with a sentence
 * of its own bolted on; high enough that an answer which happens to use a
 * phrase from the rules - "I have not looked", "information, not instruction" -
 * survives, since those are things Helix is supposed to say.
 */
const OVERLAP_LIMIT = 0.34;

/** Is this reply the prompt rather than an answer? */
export function detectEcho(reply: string): EchoVerdict {
  const trimmed = reply.trim();
  if (trimmed === '') return { echoed: false };

  // Said exactly as instructed. Not a recitation - the opposite.
  const normalised = tokens(trimmed).join(' ');
  if (SANCTIONED.has(normalised)) return { echoed: false };

  for (const opening of OPENINGS) {
    const match = opening.exec(trimmed);
    if (match) return { echoed: true, reason: 'opening', found: match[0].trim() };
  }

  const label = SPEAKER_LABEL.exec(trimmed);
  if (label) return { echoed: true, reason: 'speaker-label', found: label[0].trim() };

  const words = tokens(trimmed);

  /**
   * A short reply cannot be measured by overlap - there are too few shingles
   * for a fraction to mean anything - so it is checked whole. "Never claim to
   * have done something you haven't" is eight words and is pure instruction.
   */
  const replyShingles = shingles(words, SHINGLE);
  if (replyShingles.length === 0) {
    const short = shingles(words, Math.min(words.length, 4));
    const hit = short.find((shingle) => INSTRUCTION_SHINGLES.has(shingle));
    return hit === undefined
      ? { echoed: false }
      : { echoed: true, reason: 'instruction', found: hit };
  }

  const matched = replyShingles.filter((shingle) => INSTRUCTION_SHINGLES.has(shingle));
  if (matched.length / replyShingles.length > OVERLAP_LIMIT) {
    return { echoed: true, reason: 'overlap', found: matched[0] ?? '' };
  }

  return { echoed: false };
}
