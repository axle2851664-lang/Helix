/**
 * Recognising when someone tells Havoc something about themselves.
 *
 * WHY THIS EXISTS. Long-term memory was reachable only through an explicit
 * "remember that ...", which is a rule with a good reason behind it - Havoc
 * does not keep a journal of what you said - and a bad consequence nobody had
 * noticed:
 *
 *   User: Ok my name is Michael
 *   Havoc: I am here.
 *   User: So what is my name
 *   Havoc: I am Havoc.
 *
 * Nothing was stored, because "my name is Michael" starts with neither
 * "remember" nor "note that", and nothing was recalled, because "what is my
 * name" was not a phrasing the recall path knew. The user had told Havoc their
 * name three times and Havoc had discarded it three times.
 *
 * WHERE THE LINE IS NOW. Telling an assistant your name *is* asking it to know
 * your name. That is the whole of the change: a small, closed set of
 * self-disclosures - who you are, where you are, what you do, a fact about
 * your own life stated as a fact - counts as an explicit instruction to
 * remember, because in ordinary speech it is one.
 *
 * WHAT HAS NOT CHANGED, and must not:
 *
 *   - Nothing else is stored. There is still no path from a conversation to a
 *     memory. Havoc does not keep what you asked it, what it answered, or
 *     anything you said that was not about you.
 *   - Storing is visible. Havoc says what it kept, in the reply, every time.
 *     A memory the user did not notice being made is a memory they cannot
 *     choose to delete.
 *   - The off switch still governs. With long-term memory disabled nothing
 *     here writes anything.
 *   - Credentials are still refused by `MemoryManager` before any write, and
 *     that check runs on this path exactly as it does on every other.
 */

/** What kind of fact this is, which is also how it is found again. */
export type FactKind = 'name' | 'location' | 'birthday' | 'work' | 'contact' | 'other';

export interface PersonalFact {
  kind: FactKind;
  /** The fact as Havoc will hold it: a sentence, in the second person. */
  content: string;
  /** The part the user supplied, for the confirmation. */
  value: string;
}

/** Strip the wake word and the politeness, which attach to everything. */
function normalise(said: string): string {
  return said
    .trim()
    .replace(/^(?:hey\s+|ok(?:ay)?\s+|so\s+|and\s+)?havoc[,:]?\s*/i, '')
    .replace(/^(?:ok(?:ay)?|so|well|right|hey)[,\s]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim quoting and punctuation off a captured value.
 *
 * Runs twice, because they nest: `"Michael".` has the full stop outside the
 * closing quote, so one pass strips the leading quote, finds no trailing one,
 * removes the stop, and leaves `Michael"` behind. A test caught that.
 */
function tidy(value: string): string {
  let out = value.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    out = out
      .replace(/^["'“‘]+|["'”’]+$/g, '')
      .replace(/[.,;:!?]+$/, '')
      .trim();
  }
  return out;
}

interface Rule {
  pattern: RegExp;
  kind: FactKind;
  /** Builds the sentence Havoc will hold, from the captured value. */
  say: (value: string) => string;
}

/**
 * The closed set. Order matters only where two could match the same sentence,
 * and the specific forms are deliberately listed before the generic one at the
 * end - "my name is Michael" is a name, not an unclassified "my X is Y".
 */
const RULES: readonly Rule[] = [
  {
    pattern: /^(?:my name is|my name's|i'?m called|i am called|call me|i go by)\s+(.+)$/i,
    kind: 'name',
    say: (value) => `Their name is ${value}.`,
  },
  // Split so the preposition survives. "They live in 1937 Riddell RD" is
  // wrong in a way anyone would notice, and it is read back to the user.
  {
    pattern: /^(?:i live at|my address is)\s+(.+)$/i,
    kind: 'location',
    say: (value) => `They live at ${value}.`,
  },
  {
    pattern: /^(?:i live in|i'?m from|i am from)\s+(.+)$/i,
    kind: 'location',
    say: (value) => `They live in ${value}.`,
  },
  {
    pattern: /^(?:my birthday is|my birthday's|i was born on|i was born in)\s+(.+)$/i,
    kind: 'birthday',
    say: (value) => `Their birthday is ${value}.`,
  },
  {
    pattern: /^(?:i work at|i work for|i work as|my job is|i'?m a|i am a|i'?m an|i am an)\s+(.+)$/i,
    kind: 'work',
    say: (value) => `They work as ${value}.`,
  },
  {
    pattern: /^(?:my (?:email|e-mail|phone|number|phone number) is)\s+(.+)$/i,
    kind: 'contact',
    say: (value) => `Their contact detail: ${value}.`,
  },
  {
    // The generic form, last. "my sister is called Ada", "my favourite colour
    // is blue" - a fact about the user's own life, stated as a fact.
    pattern: /^my ([a-z][a-z' -]{1,28}?) (?:is|are)\s+(.+)$/i,
    kind: 'other',
    say: (value) => value,
  },
];

/**
 * Things that look like "my X is Y" and are not facts about the user.
 *
 * The generic rule is the useful one and also the only one that can misfire,
 * so the words that introduce an opinion, a question or a plan are excluded.
 * Getting this wrong stores a sentence the user has to go and delete, which is
 * annoying rather than dangerous - but annoying enough to be worth a list.
 */
const NOT_A_FACT: ReadonlySet<string> = new Set([
  'question',
  'point',
  'guess',
  'problem',
  'issue',
  'concern',
  'worry',
  'understanding',
  'assumption',
  'plan',
  'goal',
  'advice',
  'answer',
  'reply',
  'thinking',
  'feeling',
  'bad',
  'fault',
  'mistake',
]);

/** A statement the user made about themselves, or null. */
export function personalFact(said: string): PersonalFact | null {
  const text = normalise(said);
  if (text === '') return null;

  // A question is never a disclosure, whatever it looks like afterwards.
  if (/\?\s*$/.test(text) || /^(?:what|who|where|when|why|how|do|does|did|is|are|can)\b/i.test(text)) {
    return null;
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    if (rule.kind === 'other') {
      const subject = tidy(match[1] ?? '').toLowerCase();
      const value = tidy(match[2] ?? '');
      if (subject === '' || value === '' || NOT_A_FACT.has(subject)) return null;
      return {
        kind: 'other',
        value,
        content: `Their ${subject} is ${value}.`,
      };
    }

    const value = tidy(match[1] ?? '');
    if (value === '') return null;
    return { kind: rule.kind, value, content: rule.say(value) };
  }

  return null;
}

export interface PersonalQuestion {
  kind: FactKind;
  /** What to search memory for. */
  subject: string;
}

const QUESTIONS: ReadonlyArray<{ pattern: RegExp; kind: FactKind; subject: string }> = [
  { pattern: /^(?:what'?s|what is) my name\b/i, kind: 'name', subject: 'name' },
  { pattern: /^(?:do you know|can you remember) my name\b/i, kind: 'name', subject: 'name' },
  { pattern: /^who am i\b/i, kind: 'name', subject: 'name' },
  { pattern: /^(?:where do i live|where am i from)\b/i, kind: 'location', subject: 'live' },
  { pattern: /^(?:when is|when'?s) my birthday\b/i, kind: 'birthday', subject: 'birthday' },
  { pattern: /^(?:what do i do for (?:work|a living)|where do i work)\b/i, kind: 'work', subject: 'work' },
];

/**
 * Generic: "what is my favourite colour", "what's my dog".
 *
 * Capped at two words, which is what stops it swallowing a question that only
 * begins the same way. "What is my storage ceiling doing" matched an earlier
 * version and was read as a question about the user - it is a question about
 * the machine. Nobody asks about themselves in more than two words here.
 */
const GENERIC_QUESTION = /^(?:what'?s|what is|what are) my ([a-z][a-z'-]*(?: [a-z][a-z'-]*)?)$/i;

/** A question about the user themselves, or null. */
export function personalQuestion(said: string): PersonalQuestion | null {
  const text = normalise(said).replace(/\?+$/, '').trim();
  if (text === '') return null;

  for (const question of QUESTIONS) {
    if (question.pattern.test(text)) {
      return { kind: question.kind, subject: question.subject };
    }
  }

  const generic = GENERIC_QUESTION.exec(text);
  const subject = tidy(generic?.[1] ?? '');
  if (subject !== '') return { kind: 'other', subject };

  return null;
}


/**
 * A stored fact, turned round to be said to the person it is about.
 *
 * Facts are held in the third person because that is how they read in a
 * model's context - "Their name is Michael" alongside other notes about the
 * user. Said back to that same user they have to be second person, or Havoc
 * answers "what is my name" with "Their name is Michael", which sounds like it
 * is talking about somebody else.
 */
export function toSecondPerson(content: string): string {
  return content
    .replace(/^Their\b/, 'Your')
    .replace(/^They\b/, 'You')
    .replace(/^They're\b/, "You're");
}
