/**
 * Reading a Notepad instruction out of something the user said.
 *
 * Pure, synchronous and free of any model, which is the point: "write this
 * down" has to work when nothing is configured, offline, on a laptop with no
 * GPU. Everything here is literal pattern matching, and it is deliberately
 * conservative - nearly everything anyone says is not about the Notepad, and a
 * false positive hijacks a question Helix should simply have answered.
 *
 * ORDER IS THE DESIGN. The rules are tried in a fixed sequence and the first
 * one wins, because the phrasings overlap in ways that matter:
 *
 *   "delete my note about Blender" contains "note about", which the search
 *   rule matches. Read as a search it shows you the note; read as a delete it
 *   destroys it. Destructive rules are therefore tested first, so the
 *   ambiguous middle resolves towards the reading that asks before acting -
 *   never towards the one that acts.
 *
 *   "remember that I take my answers short" is a memory instruction with its
 *   own rules, its own refusals and its own screen. It is excluded here
 *   explicitly rather than by luck: routing it to both would store it twice,
 *   in two places, under two sets of rules.
 */

export type NotepadAction = 'open' | 'create' | 'append' | 'search' | 'delete' | 'export';

export interface NotepadIntent {
  action: NotepadAction;
  /**
   * What the action is about: a title, a search term, or the text to write.
   * Empty when the instruction named nothing - "open my notes" has no subject
   * and inventing one would be guessing at which note was meant.
   */
  subject: string;
}

/** Strip the wake word and the politeness, which attach to everything. */
function normalise(said: string): string {
  return said
    .trim()
    .replace(/^(?:hey\s+|ok\s+)?helix[,:]?\s*/i, '')
    .replace(/^(?:please|could you|can you|would you)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tidy a captured subject: trailing punctuation, surrounding quotes, filler. */
function subjectOf(raw: string | undefined): string {
  if (raw === undefined) return '';
  return raw
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/^(?:the|my|a|an)\s+/i, '')
    .trim();
}

/**
 * A rule: a pattern, the action it means, and which capture group holds the
 * subject. Written as data so the order is visible in one place rather than
 * being an emergent property of a long if-chain.
 */
interface Rule {
  pattern: RegExp;
  action: NotepadAction;
}

const RULES: readonly Rule[] = [
  // --- Destructive first. See the note on ordering above. ---
  { pattern: /^(?:delete|remove|throw away|get rid of|bin)\s+(?:the\s+|my\s+|that\s+|this\s+)?notes?\s+(?:called|titled|named|about|on)\s+(.+)$/i, action: 'delete' },
  { pattern: /^(?:delete|remove|throw away|get rid of|bin)\s+(?:the\s+|my\s+|that\s+|this\s+)?note\b(.*)$/i, action: 'delete' },

  // --- Export. Named before search so "back up my notes" is not read as a
  //     hunt for a note about backing up. ---
  { pattern: /^(?:export|back ?up|save a copy of|download)\s+(?:my\s+|the\s+)?note(?:s|pad|book)?\b(.*)$/i, action: 'export' },

  // --- Adding to what is already there. Before 'create', because "add this
  //     to my notes about suppliers" names an existing note and creating a
  //     second one with the same subject is how a notepad becomes useless. ---
  { pattern: /^(?:add|append)\s+(?:this|that|it)\s+to\s+(?:my\s+|the\s+)?notes?\s+(?:called|titled|named|about|on)\s+(.+)$/i, action: 'append' },

  // --- Creating. ---
  { pattern: /^(?:create|make|start|write|add|jot down|jot|take)\s+(?:me\s+)?(?:a|an|another)?\s*(?:new\s+)?note\s+(?:called|titled|named|about|on)\s+(.+)$/i, action: 'create' },
  { pattern: /^(?:create|make|start|write|add|jot down|jot|take)\s+(?:me\s+)?(?:a|an|another)?\s*(?:new\s+)?note\s+(?:that\s+)?(?:says?|saying|reading)\s+(.+)$/i, action: 'create' },
  { pattern: /^(?:write|note|jot|take)\s+(?:this|that|it)\s+down\b(.*)$/i, action: 'create' },
  { pattern: /^(?:write down|note down|make a note of|take a note of)\s+(.+)$/i, action: 'create' },
  { pattern: /^(?:add|put|save|store|keep)\s+(?:this|that|it)\s+(?:in|to|into)\s+(?:my\s+|the\s+)?note(?:s|pad|book)?\b(.*)$/i, action: 'create' },
  { pattern: /^(?:create|make|start|new)\s+(?:a\s+|an\s+)?(?:new\s+)?note(?:pad entry)?\b(.*)$/i, action: 'create' },

  // --- Searching. "What did I write about X" is a hunt, not a question. ---
  { pattern: /^(?:find|search|look for|look up|pull up|get)\s+(?:me\s+)?(?:my\s+|the\s+|a\s+|any\s+)?notes?\s+(?:about|on|for|mentioning|regarding|called|titled|named)\s+(.+)$/i, action: 'search' },
  { pattern: /^(?:search|look)\s+(?:through\s+)?(?:my\s+|the\s+)?note(?:s|pad|book)?\s+(?:for|about|on)\s+(.+)$/i, action: 'search' },
  { pattern: /^what did i (?:write|note|jot|put)(?: down)?\s+(?:about|on|regarding)\s+(.+)$/i, action: 'search' },
  { pattern: /^(?:do i have|have i got)\s+(?:a\s+|any\s+)?notes?\s+(?:about|on|for)\s+(.+)$/i, action: 'search' },

  // --- Opening. Last, because it is the loosest: a bare "notepad" means the
  //     screen, and anything more specific was caught above. ---
  { pattern: /^(?:open|show|show me|bring up|display|go to|read|list|view)\s+(?:me\s+)?(?:my\s+|the\s+)?note(?:s|pad|book)?\b(.*)$/i, action: 'open' },
  { pattern: /^(?:my\s+|the\s+)?note(?:s|pad|book)$/i, action: 'open' },
];

/**
 * Phrases that look like a Notepad instruction and belong to something else.
 *
 * Checked before the rules, so a memory instruction is never also a note.
 */
const NOT_NOTEPAD: readonly RegExp[] = [
  // Memory has its own rules, its own refusals and its own screen.
  /^remember\b/i,
  /^(?:don'?t |do not )?forget\b/i,
  /^what do you remember\b/i,
  // A question about the Notepad rather than an instruction to it. "How many
  // notes do I have" is answered from a count, not by opening the screen.
  /^how many notes\b/i,
  /^(?:what|where) is (?:the|my) notepad\b/i,
];

export function notepadIntent(said: string): NotepadIntent | null {
  const text = normalise(said);
  if (text === '') return null;

  for (const excluded of NOT_NOTEPAD) {
    if (excluded.test(text)) return null;
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return { action: rule.action, subject: subjectOf(match[1]) };
  }

  return null;
}
