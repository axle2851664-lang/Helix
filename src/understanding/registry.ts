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
  | 'list';

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
   */
  implied: readonly string[];
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
      // Phrases that mean the Notepad without naming it. The bare verb forms
      // - "write down", "jot down" - carry whatever follows them as the note,
      // which is what makes "write down eggs, milk and bread" one request.
      'write down', 'note down', 'jot down', 'get this down',
      'write this down', 'write that down', 'note this down', 'jot this down',
      'jot that down', 'write something down', 'note something down',
      'jot something down', 'need to write', 'make a note', 'take a note',
      'save this for later', 'keep this for later',
      "so i don't forget", 'so i do not forget', 'so i dont forget',
      'things i wrote', 'stuff i saved', 'what i wrote', 'what i saved',
      'saved information', 'what i saved earlier', 'saved earlier',
      // Asking after something written down, without the word "note" in it.
      'what did i write', 'what did i note', 'what did i jot',
      'what did i put down', 'did i write', 'i wrote about',
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
      'do you remember', 'do you still have', 'what do you know about me',
      'what did i tell you', 'i told you about',
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
    implied: ['take it with me', 'take it with you', 'onto the stick', 'on a usb'],
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
    id: 'files',
    label: 'Files',
    aliases: ['files', 'documents', 'library', 'file'],
    implied: ['in my files', 'my documents'],
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
    for (const phrase of capability.implied) {
      for (const word of phrase.split(/\s+/)) words.add(word);
    }
  }

  return [...words];
}

export function capability(id: string): Capability | undefined {
  return CAPABILITIES.find((entry) => entry.id === id);
}
