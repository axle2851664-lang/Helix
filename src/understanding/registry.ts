/**
 * What Helix can actually do, described as data.
 *
 * WHY THIS EXISTS. Every capability used to describe itself inside its own
 * matcher, as a list of phrases and a `lower.includes(...)`. Sixteen tools,
 * sixteen private vocabularies, and no way to ask the system a question as
 * basic as "what can you do with notes?" - the answer was spread across a
 * thousand lines of a single file. Worse, a phrase the author did not think of
 * was simply not understood, and adding one meant editing a matcher.
 *
 * The registry inverts that. A capability declares its subject words, its
 * verbs, what each verb needs and whether it is destructive; the matcher in
 * `match.ts` is generic and reads this. Adding a capability is adding an entry
 * here, and every stage downstream - typo repair, disambiguation, confirmation,
 * the "what can you do" answer - picks it up for free.
 *
 * THE SHAPE OF THE IDEA. A request is a VERB applied to a SUBJECT, sometimes
 * with a TARGET. "Pull up my notebook" is open + notepad. "Jot this down" is
 * create + notepad. "Bring up what I wrote about Blender" is search + notepad,
 * target "Blender". Decomposing it this way is what lets the layer understand
 * phrasings nobody wrote down: any of eleven open-verbs against any of nine
 * notepad-nouns is ninety-nine phrasings from twenty words, and none of them
 * had to be predicted.
 *
 * WHAT THIS IS NOT. It is not semantic understanding in the neural sense.
 * There is no embedding model here and none is pretended at - Helix has no
 * embedding provider, and inventing one would be the fake capability the brief
 * forbids. What it is, is lexical understanding done properly: decomposition,
 * synonym sets, fuzzy matching and context, which between them cover the
 * natural phrasings people actually use without anyone enumerating sentences.
 */

/** What a verb does to a subject, in the abstract. */
export type Verb =
  | 'open'
  | 'create'
  | 'search'
  | 'read'
  | 'append'
  | 'edit'
  | 'delete'
  | 'save'
  | 'export'
  | 'list'
  | 'close';

/** How sure the layer has to be before the verb runs without asking. */
export type Risk =
  /** Reversible and cheap. Do it. */
  | 'safe'
  /** Changes stored data but can be undone by the user. Do it, and say so. */
  | 'notable'
  /** Irreversible. Always goes through the confirmation pipeline. */
  | 'destructive';

export interface CapabilityVerb {
  verb: Verb;
  /** Words that mean this verb. Matched against the sentence, in any order. */
  words: readonly string[];
  risk: Risk;
  /**
   * True when the verb is meaningless without something to act on - "delete"
   * needs to know what. Drives the clarifying question rather than a guess.
   */
  needsTarget: boolean;
  /** One line, for "what can you do" and for the disambiguation prompt. */
  summary: string;
}

export interface ImpliedPhrase {
  phrase: string;
  /** The verb this phrasing means, when the words alone are ambiguous. */
  verb?: Verb;
}

export interface Capability {
  id: string;
  label: string;
  /**
   * Nouns that name this capability. The plain words people use, including
   * the ones a speech recogniser mangles - `normalise` corrects towards these.
   */
  aliases: readonly string[];
  /**
   * Phrases that imply the capability without naming it. "Write this down"
   * names no noun at all and is unmistakably the Notepad.
   *
   * A phrase may carry its own verb, because some of them settle a question
   * the words alone cannot. "Bring the panel back" contains an opening verb
   * and the word "back", and "back" otherwise means close - so the phrase has
   * to say which it is rather than leaving the matcher to weigh two signals
   * that point opposite ways.
   */
  implied: readonly ImpliedPhrase[];
  verbs: readonly CapabilityVerb[];
  /** Which verb a bare mention means. "Notepad" alone means open it. */
  bare: Verb;
}

const OPEN_WORDS = [
  'open', 'show', 'display', 'bring', 'pull', 'view', 'see', 'get', 'go',
  'launch', 'start', 'load', 'access', 'check',
] as const;

const FIND_WORDS = [
  'find', 'search', 'look', 'locate', 'retrieve', 'recall', 'dig', 'fetch',
  'what', 'which', 'did', 'any',
] as const;

const MAKE_WORDS = [
  'create', 'make', 'new', 'write', 'jot', 'add', 'start', 'draft', 'note',
  'record', 'put', 'save', 'store', 'keep', 'take',
] as const;

/**
 * Dismissing something that is on screen.
 *
 * Distinct from DELETE_WORDS, and the distinction matters: closing a panel
 * destroys nothing, so it needs none of the confirmation a deletion does.
 * "Get rid of the sidebar" and "get rid of that note" use the same words and
 * mean very different things - which is why the capability decides, not the
 * verb list.
 */
const CLOSE_WORDS = [
  'close', 'hide', 'dismiss', 'remove', 'get rid', 'put away', 'collapse',
  'minimise', 'minimize', 'stop', 'exit', 'back', 'return', 'done', 'enough',
  'away',
] as const;

const DELETE_WORDS = [
  'delete', 'remove', 'erase', 'bin', 'trash', 'discard', 'scrap', 'clear',
  'throw', 'get rid',
] as const;

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'notepad',
    label: 'Notepad',
    // Real words only. Misspellings and dictation damage are the
    // normaliser's job - listing them here would mean every new way of
    // mishearing "notes" needed a registry edit.
    aliases: [
      'notepad', 'notebook', 'notes', 'note', 'journal', 'jotter', 'scratchpad',
    ],
    implied: [
      { phrase: "write down" },
      { phrase: "jot down" },
      { phrase: "write down eggs, milk and bread" },
      { phrase: 'write down' },
      { phrase: 'note down' },
      { phrase: 'jot down' },
      { phrase: 'get this down' },
      { phrase: 'write this down' },
      { phrase: 'write that down' },
      { phrase: 'note this down' },
      { phrase: 'jot this down' },
      { phrase: 'jot that down' },
      { phrase: 'write something down' },
      { phrase: 'note something down' },
      { phrase: 'jot something down' },
      { phrase: 'need to write' },
      { phrase: 'make a note' },
      { phrase: 'take a note' },
      { phrase: 'save this for later' },
      { phrase: 'keep this for later' },
      { phrase: "so i don't forget" },
      { phrase: 'so i do not forget' },
      { phrase: 'so i dont forget' },
      { phrase: 'things i wrote' },
      { phrase: 'stuff i saved' },
      { phrase: 'what i wrote' },
      { phrase: 'what i saved' },
      { phrase: 'saved information' },
      { phrase: 'what i saved earlier' },
      { phrase: 'saved earlier' },
      { phrase: "note" },
      { phrase: 'what did i write' },
      { phrase: 'what did i note' },
      { phrase: 'what did i jot' },
      { phrase: 'what did i put down' },
      { phrase: 'did i write' },
      { phrase: 'i wrote about' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS, 'read', 'list'],
        risk: 'safe',
        needsTarget: false,
        summary: 'open the Notepad',
      },
      {
        verb: 'search',
        words: [...FIND_WORDS, 'about', 'regarding', 'mentioning'],
        risk: 'safe',
        needsTarget: true,
        summary: 'find a note',
      },
      {
        verb: 'create',
        words: [...MAKE_WORDS],
        risk: 'notable',
        needsTarget: false,
        summary: 'write a new note',
      },
      {
        verb: 'append',
        words: ['add', 'append', 'put', 'include', 'stick'],
        risk: 'notable',
        needsTarget: false,
        summary: 'add to a note',
      },
      {
        verb: 'delete',
        words: [...DELETE_WORDS],
        risk: 'destructive',
        needsTarget: true,
        summary: 'delete a note',
      },
      {
        verb: 'export',
        words: ['export', 'back up', 'backup', 'copy', 'download'],
        risk: 'safe',
        needsTarget: false,
        summary: 'take your notes with you',
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    aliases: ['memory', 'memories', 'remember', 'recall'],
    implied: [
      { phrase: 'do you remember' },
      { phrase: 'do you still have' },
      { phrase: 'what do you know about me' },
      { phrase: 'what did i tell you' },
      { phrase: 'i told you about' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS, 'list'],
        risk: 'safe',
        needsTarget: false,
        summary: 'show what Helix remembers',
      },
      {
        verb: 'search',
        words: [...FIND_WORDS],
        risk: 'safe',
        needsTarget: true,
        summary: 'recall something',
      },
      {
        verb: 'delete',
        words: [...DELETE_WORDS, 'forget'],
        risk: 'destructive',
        needsTarget: true,
        summary: 'forget something',
      },
    ],
  },
  {
    id: 'portable',
    label: 'Take It With You',
    aliases: ['flashdrive', 'usb', 'stick', 'portable', 'drive'],
    implied: [
      { phrase: 'take it with me' },
      { phrase: 'take it with you' },
      { phrase: 'onto the stick' },
      { phrase: 'on a usb' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS],
        risk: 'safe',
        needsTarget: false,
        summary: 'open the flash-drive screen',
      },
      {
        verb: 'export',
        words: ['export', 'copy', 'back up', 'backup', 'put', 'move', 'transfer'],
        risk: 'safe',
        needsTarget: false,
        summary: 'copy Helix onto a disk',
      },
    ],
  },
  {
    /**
     * The sidebar. Opening and closing it is pure UI: no data is touched, so
     * it is always safe and never needs confirmation.
     */
    id: 'sidebar',
    label: 'the sidebar',
    aliases: [
      'sidebar', 'sidebars', 'panel', 'panels', 'menu', 'controls', 'nav',
      'navigation', 'drawer',
    ],
    implied: [
      { phrase: 'show me my controls', verb: 'open' },
      // "Back" means close everywhere else, so these say which they are.
      { phrase: 'bring the panel back', verb: 'open' },
      { phrase: 'bring the sidebar back', verb: 'open' },
      { phrase: 'bring it back', verb: 'open' },
      { phrase: 'i want the sidebar', verb: 'open' },
      { phrase: 'i want the panel', verb: 'open' },
      { phrase: 'my controls', verb: 'open' },
      { phrase: 'put the panel away', verb: 'close' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS, 'want', 'need'],
        risk: 'safe',
        needsTarget: false,
        summary: 'show the sidebar',
      },
      {
        verb: 'close',
        words: [...CLOSE_WORDS],
        risk: 'safe',
        needsTarget: false,
        summary: 'hide the sidebar',
      },
    ],
  },
  {
    /**
     * The clock. The time itself never comes from a model - see TimeOverlay -
     * so this capability only decides whether the display is up.
     */
    id: 'clock',
    label: 'the clock',
    aliases: ['clock', 'time', 'timer', 'watch'],
    implied: [
      // Questions, which the question guard would otherwise decline. Asking
      // what the time is *is* a request to be shown it.
      { phrase: 'what time is it', verb: 'open' },
      { phrase: 'what is the time', verb: 'open' },
      { phrase: "what's the time", verb: 'open' },
      { phrase: 'what time', verb: 'open' },
      { phrase: 'the exact time', verb: 'open' },
      { phrase: 'current time', verb: 'open' },
      { phrase: 'time is it', verb: 'open' },
      { phrase: 'tell me the time', verb: 'open' },
      { phrase: 'got the time', verb: 'open' },
      { phrase: 'have the time', verb: 'open' },
      // Dismissals that name nothing. They only resolve to the clock when it
      // is what is in focus - see the focus carry in understand.ts.
      { phrase: 'go back', verb: 'close' },
      { phrase: 'return to helix', verb: 'close' },
      { phrase: "that's enough", verb: 'close' },
      { phrase: 'thats enough', verb: 'close' },
      { phrase: 'close that', verb: 'close' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS, 'tell', 'give', 'what'],
        risk: 'safe',
        needsTarget: false,
        summary: 'show the time',
      },
      {
        verb: 'close',
        words: [...CLOSE_WORDS],
        risk: 'safe',
        needsTarget: false,
        summary: 'close the clock',
      },
    ],
  },
  {
    id: 'files',
    label: 'Files',
    aliases: ['files', 'documents', 'library', 'file'],
    implied: [
      { phrase: 'in my files' },
      { phrase: 'my documents' },
    ],
    bare: 'open',
    verbs: [
      {
        verb: 'open',
        words: [...OPEN_WORDS],
        risk: 'safe',
        needsTarget: false,
        summary: 'open Files',
      },
      {
        verb: 'search',
        words: [...FIND_WORDS],
        risk: 'safe',
        needsTarget: true,
        summary: 'search inside your files',
      },
    ],
  },
];

/** Every word the normaliser may correct a typo towards. */
export function vocabulary(): string[] {
  const words = new Set<string>();

  for (const capability of CAPABILITIES) {
    for (const alias of capability.aliases) {
      for (const word of alias.split(/\s+/)) words.add(word);
    }
    for (const verb of capability.verbs) {
      for (const word of verb.words) {
        for (const part of word.split(/\s+/)) words.add(part);
      }
    }
    for (const implied of capability.implied) {
      for (const word of implied.phrase.split(/\s+/)) words.add(word);
    }
  }

  return [...words];
}

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((entry) => entry.id === id);
}
