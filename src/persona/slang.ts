/**
 * Recognising a request to put something into slang.
 *
 * The whole requirement is in the word "only": Helix translates into slang
 * when asked to, and never otherwise. So the interesting work here is not the
 * translating, it is refusing. Almost every sentence containing the word
 * "slang" is *about* slang rather than a request to produce it - "what does
 * this slang mean", "slang is regional", "define that slang" - and a matcher
 * that fires on the word would have Helix answering in slang to a question
 * about linguistics.
 *
 * The rule that falls out of that: a request must name the act, not the
 * subject. Something has to be *put into* or *translated into* slang before
 * this fires.
 */

export type SlangRequest =
  | { asked: false }
  | {
      asked: true;
      /**
       * The text to translate, or null when the request points at something
       * already said ("say that in slang") and the caller must supply it.
       */
      subject: string | null;
    };

/**
 * Verbs that turn "slang" from a topic into an instruction.
 *
 * Deliberately a closed list. Adding "make it" or "do it" would catch
 * "what would make it slang?", which is a question.
 */
const ACTS = [
  'translate',
  'put',
  'say',
  'rewrite',
  'rephrase',
  'write',
  'convert',
  'turn',
  'render',
];

/** Words that mean the speaker is asking about slang, not asking for it. */
const ASKING_ABOUT =
  /\b(?:what|which|why|how|who|when|where|does|do|is|are|was|were|define|meaning|means|explain|difference)\b/i;

/** "... in slang", "... into slang", "... as slang", "... in slang terms". */
const INTO_SLANG = /\b(?:in|into|as|to)\s+(?:some\s+|more\s+|proper\s+)?slang\b/i;

/**
 * "in slang: ..." - the colon does the work the verb usually does, and this
 * is how people actually type it.
 */
const SLANG_PREFIX = /^\s*(?:in|into|as)\s+slang\s*:/i;

/** "the slang version of X", "a slang version". */
const SLANG_VERSION = /\bslang\s+(?:version|translation|form)\b/i;

/**
 * A subject that is entirely a pointer at something already said.
 *
 * Anchored, not a word search. "that is incorrect" contains "that" and is the
 * text to translate; "that" alone is a pointer at the previous reply. A
 * heuristic on length got this wrong, which is why it is an exact match now.
 */
const REFERS_BACK =
  /^(?:that|this|it|the last (?:one|bit|message|thing)|what you (?:just )?said|your (?:last )?(?:answer|reply|message))$/i;

function quoted(text: string): string | null {
  const match = /["“”'‘’]([^"“”'‘’]{2,})["“”'‘’]/.exec(text);
  return match?.[1]?.trim() ?? null;
}

/**
 * Pull out what is to be translated.
 *
 * Quoted text wins, because quoting is the least ambiguous way anyone says
 * "this bit". Otherwise the words after a colon, and otherwise whatever sits
 * before the "in slang" phrase.
 */
function extractSubject(text: string): { subject: string | null; wasQuoted: boolean } {
  const inQuotes = quoted(text);
  // Quoting is the explicit "this bit" signal, so it is never re-read as a
  // pointer at something else.
  if (inQuotes) return { subject: inQuotes, wasQuoted: true };

  const colon = /:\s*(.+)$/.exec(text);
  if (colon?.[1]) {
    const after = colon[1].trim();
    if (after !== '' && !INTO_SLANG.test(after)) return { subject: after, wasQuoted: false };
  }

  // "translate good morning into slang" -> "good morning"
  const before = text.split(INTO_SLANG)[0] ?? '';
  const stripped = before
    .replace(
      new RegExp(`^\\s*(?:can you|could you|please|helix)?\\s*(?:${ACTS.join('|')})\\b`, 'i'),
      '',
    )
    .replace(/^\s*(?:this|that|it|the following|the phrase|the sentence)\s*/i, '')
    .replace(/\s+(?:for me|please)\s*$/i, '')
    .trim();

  return { subject: stripped === '' ? null : stripped, wasQuoted: false };
}

/**
 * Was this a request to produce slang?
 *
 * Errs towards no. A missed request costs the user one rephrase; a false
 * positive has Helix answering a serious question in slang, which is the
 * failure the "only when asked" rule exists to prevent.
 */
export function slangRequest(input: string): SlangRequest {
  const text = input.trim();
  if (text === '') return { asked: false };

  const mentionsSlang = /\bslang\b/i.test(text);
  if (!mentionsSlang) return { asked: false };

  const namesTheAct =
    SLANG_PREFIX.test(text) ||
    SLANG_VERSION.test(text) ||
    (INTO_SLANG.test(text) &&
      new RegExp(`\\b(?:${ACTS.join('|')})\\b`, 'i').test(text.split(INTO_SLANG)[0] ?? ''));

  if (!namesTheAct) return { asked: false };

  // "what is that in slang" reads as an act, but it is a question about the
  // words rather than an instruction - except when the question *is* the
  // instruction, which is what a leading "can you"/"could you" signals.
  const polite = /^\s*(?:can|could|would|will)\s+you\b/i.test(text);
  if (!polite && ASKING_ABOUT.test(text.split(INTO_SLANG)[0] ?? text)) {
    // "how would you say that in slang" is still a request; "what does that
    // mean in slang" is not. The difference is whether a translating verb
    // survives once the question word is removed.
    const withoutQuestion = text.replace(ASKING_ABOUT, ' ');
    if (!new RegExp(`\\b(?:${ACTS.join('|')})\\b`, 'i').test(withoutQuestion.split(INTO_SLANG)[0] ?? '')) {
      return { asked: false };
    }
  }

  const { subject, wasQuoted } = extractSubject(text);
  if (subject !== null && !wasQuoted && REFERS_BACK.test(subject.trim())) {
    // A pointer at the previous reply, not the text itself.
    return { asked: true, subject: null };
  }

  return { asked: true, subject };
}

/**
 * What the model is told.
 *
 * Narrow on purpose. The instruction is to restate one piece of text, not to
 * answer it, continue it, or comment on it - a model handed a sentence tends
 * to reply to it, and a slang *reply* is not a slang *translation*.
 */
export function slangPrompt(subject: string): { system: string; user: string } {
  return {
    system: [
      'Rewrite the text the user gives you in casual, current slang.',
      'Keep the meaning exactly. Do not answer it, continue it, or comment on it.',
      'Do not add information that is not in the original.',
      'Reply with the rewritten text and nothing else - no preamble, no quotation marks, no explanation.',
      'Keep it good-natured. No slurs.',
    ].join(' '),
    user: subject,
  };
}
