import type { MemoryRecord } from './types.js';

/**
 * Which remembered facts may be put in front of a language model.
 *
 * THE FAILURE THIS COMES FROM.
 *
 *   User: hello havoc
 *   Havoc: 1937 Riddell RD
 *   User: is that my address?
 *   Havoc: no
 *   User: What is that
 *   Havoc: your computer's location.
 *
 * A greeting, answered with a street address and then a confabulation about
 * where it came from. Nothing in Havoc reads a real location - there is no
 * geolocation call anywhere in it - so that was either a fact the user had
 * told Havoc, read back unprompted, or one the model invented outright.
 *
 * Both are the same design fault, and it was mine: every remembered fact was
 * being pasted into the system prompt on every single turn, a greeting
 * included. It is the fourth time in this codebase that a weak model with
 * nothing to say has emitted whatever was most salient in its context - first
 * the prompt's own rules, then a list of refusals, then six synthetic turns,
 * now the user's personal data. The first three were embarrassing. This one is
 * a privacy leak.
 *
 * THE DISTINCTION THIS MODULE DRAWS. The user asked Havoc to know private
 * things about them, and Havoc should. But "know" has to mean "can tell you
 * when you ask" - not "has it loaded into a text generator's working memory
 * where it can fall out at any moment".
 *
 * So the most sensitive facts are answerable and never volunteered. Ask "where
 * do I live" and the memory tool answers it exactly, deterministically, with
 * no model involved at all. Say "hello" and it is not in the context for
 * anything to blurt.
 */

/**
 * Fact kinds that never enter a model's context.
 *
 * A name does: Havoc using it in conversation is the point of knowing it, and
 * a name read out unprompted is awkward rather than harmful. An address, a
 * phone number or an email is a different category - it is the thing you would
 * mind being said aloud in a room, or being carried in a log.
 */
const SENSITIVE_KINDS: ReadonlySet<string> = new Set(['location', 'contact']);

/**
 * Content that is sensitive whatever it is tagged.
 *
 * Memories stored through the older "remember that ..." path carry no kind at
 * all, so a tag check alone would let an explicitly-remembered address
 * straight through. The user typing "remember my address is ..." chose to
 * store it; they did not choose to have it recited at a greeting.
 */
function looksSensitive(content: string): boolean {
  return (
    // A street address: a number followed by words and a thoroughfare.
    /\b\d+\s+[A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*)*\s+(?:rd|road|st|street|ave|avenue|dr|drive|ln|lane|blvd|boulevard|way|close|court|ct|place|pl|terrace|crescent)\b/i.test(
      content,
    ) ||
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(content) ||
    // A run of digits long enough to be a phone number or an account.
    /(?:\+?\d[\d ()–-]{7,}\d)/.test(content) ||
    /\b(?:postcode|post code|zip code|sort code|passport|national insurance)\b/i.test(content)
  );
}

/** True when this memory must never be pasted into a model's context. */
export function isSensitiveMemory(record: Pick<MemoryRecord, 'content' | 'tags'>): boolean {
  if (record.tags?.some((tag) => SENSITIVE_KINDS.has(tag)) === true) return true;
  return looksSensitive(record.content);
}

/**
 * The facts that may go in front of a model, in order.
 *
 * Returns nothing at all for a local model. That is the same judgement made
 * about the persona demonstrations: the local path is where every one of these
 * failures has happened, its context budget is the tightest, and it loses
 * least by going without - because a direct question ("what is my name") is
 * answered by the memory tool before a model is ever reached, exactly and
 * without one.
 */
export function promptableMemories(
  records: readonly MemoryRecord[],
  options: { local: boolean; limit?: number },
): string[] {
  if (options.local) return [];

  return records
    .filter((record) => !isSensitiveMemory(record))
    .slice(0, options.limit ?? 20)
    .map((record) => record.content);
}


/**
 * Did this reply volunteer something private that nobody asked for?
 *
 * The belt to the braces above. Filtering what goes into the context stops the
 * commonest leak; this catches the rest - a fact that arrived through the
 * conversation history, or one the model retained from earlier in the session.
 *
 * `asked` is what stops it firing on success. When the user has asked where
 * they live, a reply containing where they live is the correct answer, and a
 * guard that could not tell the difference would break the feature it is
 * protecting. The memory tool answers those directly anyway, so by the time a
 * model is involved the question was almost certainly about something else.
 *
 * Matching is on the distinctive part of the fact rather than the whole
 * sentence, because the model paraphrases: it stored "They live at 1937
 * Riddell RD" and said "1937 Riddell RD".
 */
export function volunteersPrivateFact(
  reply: string,
  records: readonly MemoryRecord[],
  options: { asked: boolean },
): { leaked: boolean; found?: string } {
  if (options.asked) return { leaked: false };

  const haystack = reply.toLowerCase();

  for (const record of records) {
    if (!isSensitiveMemory(record)) continue;

    for (const fragment of distinctiveParts(record.content)) {
      if (haystack.includes(fragment.toLowerCase())) {
        return { leaked: true, found: fragment };
      }
    }
  }

  return { leaked: false };
}

/**
 * The parts of a fact that identify it.
 *
 * Whole-sentence matching would never fire, because Havoc stores "Their
 * contact detail: ..." and a model repeats the detail alone. Runs of three or
 * more words, and anything containing a digit or an @, are what carry the
 * identifying content; short common words are not, and matching on those would
 * flag any reply containing "the" or "at".
 */
function distinctiveParts(content: string): string[] {
  const words = content.split(/\s+/).filter(Boolean);
  const parts: string[] = [];

  /**
   * Single tokens that identify on their own.
   *
   * A run of three words cannot catch an email or a phone number: Havoc stores
   * "Their contact detail: michael@example.com" and a model writes "you can be
   * reached at michael@example.com", which shares exactly one token with it.
   * A test caught that. These carry enough entropy that matching one is never
   * a coincidence.
   */
  for (const word of words) {
    const bare = word.replace(/^[("'\u201c]+|[).,;:!?"'\u201d]+$/g, '');
    if (bare.length < 6) continue;
    if (bare.includes('@') || /^\+?[\d()\u2013-]{7,}$/.test(bare)) parts.push(bare);
  }

  for (let size = Math.min(6, words.length); size >= 3; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const run = words.slice(i, i + size).join(' ');
      // A run is only worth matching if it carries something specific.
      if (/\d/.test(run) || run.includes('@') || /[A-Z][a-z]/.test(run)) parts.push(run);
    }
  }

  return parts;
}
