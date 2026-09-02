/**
 * Keeping the voice, when the words come from a model.
 *
 * `voice.ts` composes Helix's own scripted sentences, so those cannot drift.
 * A language model's sentences can, and on a small local model they do. The
 * measured case that produced this file: qwen2.5:7b, given the full persona
 * prompt, answered "Helix, are you there?" with
 *
 *     Affirmative, sir. Ready to assist.
 *
 * which is precisely the terminal register the brief rules out. A 3B follows
 * a persona instruction less reliably still. Prompting alone is therefore not
 * a mechanism - it is a request, and a small model is free to decline it.
 *
 * So the register is checked in code as well as asked for in the prompt.
 *
 * The line this file does not cross: it deletes and substitutes from a fixed,
 * closed set of phrases, and it never adds a claim, a fact, a number or a
 * sentence of its own. Removing "Affirmative," from the front of a reply
 * changes how Helix sounds. Writing a new sentence would change what Helix
 * said, and that is the one thing a personality layer must never do.
 *
 * When a repair would leave nothing behind, the original is kept. A reply
 * consisting only of "Acknowledged." is entirely fault, and returning an empty
 * string would turn a bad answer into no answer.
 */

/** A way the voice went wrong. */
export type RegisterFault =
  | 'terminal'
  | 'archaic'
  | 'disclaimer'
  | 'address-repeat'
  | 'address-rate'
  | 'service-tag'
  | 'emoji';

export interface RegisterFinding {
  fault: RegisterFault;
  /** The text that triggered it, so a test failure names the actual phrase. */
  found: string;
}

export interface RepairedReply {
  text: string;
  /** What was corrected. Empty when the model got it right unaided. */
  findings: readonly RegisterFinding[];
  /** True when a repair was declined because it would have emptied the reply. */
  wholesale: boolean;
}

/**
 * Openers that make Helix sound like a console rather than a person.
 *
 * Only stripped at the very start of a reply. "Executing" in the middle of a
 * sentence about a program is an ordinary English word, and a matcher that
 * cannot tell the difference would edit the user's meaning.
 */
const TERMINAL_OPENERS = [
  'affirmative',
  'acknowledged',
  'request received',
  'command received',
  'command completed',
  'command acknowledged',
  'query received',
  'input received',
  'processing request',
  'processing your request',
  'processing',
  'executing',
  'initiating',
  'standing by',
  'roger that',
  'roger',
] as const;

/** Costume-drama address. Substituted rather than deleted: it means something. */
const ARCHAIC_ADDRESS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bmy lord\b/gi, 'sir'],
  [/\bmilord\b/gi, 'sir'],
  [/\byour lordship\b/gi, 'sir'],
];

/** Flourishes with no content at all, so removing them removes nothing. */
const ARCHAIC_FLOURISHES = [
  /\bas you (?:command|wish)\b[,.!]?\s*/gi,
  /\byour wish is my command\b[,.!]?\s*/gi,
  /\bat once,?\s*(?:milord|my lord|master|sir)\b[,.!]?\s*/gi,
  /\bindubitably\b[,.!]?\s*/gi,
  /\bmost splendid\b[,.!]?\s*/gi,
];

/**
 * The model talking about being a model.
 *
 * Whole sentences, because half of one reads worse than all of it. The pattern
 * is anchored to a sentence start so it cannot swallow a sentence in which the
 * user was genuinely asking about language models.
 */
const DISCLAIMER =
  /(?:^|(?<=[.!?]\s))as an? (?:ai|artificial intelligence|language model|assistant)\b[^.!?]*[.!?]\s*/gi;

/**
 * The offer of further service, tacked onto the end of a reply.
 *
 * Not archaic and not terminal, which is why it survived the first pass. It is
 * the third way this goes wrong and the one a small model reaches for by
 * default: three of six measured replies ended with one of these, including
 * "You're welcome, sir. How may I assist you further?" for a plain thank-you.
 *
 * They carry nothing. A good assistant does not ask permission to keep being
 * useful, and the prompt asks for brevity; a trailing service tag is the
 * opposite of both. Removed only as a final sentence, so a genuine mid-reply
 * offer to do something specific is untouched.
 */
const SERVICE_TAGS = [
  /\s*(?:is there )?anything else (?:i can (?:assist|help) (?:you )?with|you (?:need|require))\s*[?.!]?\s*$/i,
  /**
   * "How may I assist you further / today / this evening?", and the same
   * without the "you".
   *
   * The trailing qualifier was a fixed list of three - further, today, with
   * that - and the model produced "what can I assist with today", then "how
   * may I assist you this evening". Chasing one suffix at a time was always
   * going to lose.
   *
   * What it is not allowed to become is `\w+`, matching anything. "How can I
   * help you fix the printer?" is a real offer to do a specific thing, and a
   * pattern loose enough to catch every pleasantry would delete it. So the
   * trailing words come from a closed list of fillers: extend the list when a
   * new one turns up, and content is never at risk.
   */
  /\s*(?:how|what) (?:may|can) i (?:assist|help)(?:\s+(?:you|with|further|else|today|tonight|now|then|this|next|morning|afternoon|evening|day))*\s*[?.!]?\s*$/i,
  /\s*(?:please )?let me know (?:if|how) (?:i can (?:be of )?(?:assist|help|service)|you(?:'d| would) like to proceed)[^.!?]*[?.!]?\s*$/i,
  /\s*i(?:'m| am) (?:here|at your (?:service|disposal))(?: (?:if|should) you need (?:me|anything))?\s*[?.!]?\s*$/i,
];

const EMOJI = /\p{Extended_Pictographic}️?/gu;

/** `sir` as a form of address, with any comma that attaches it. */
const ADDRESS_OCCURRENCE = /(,\s*)?\bsir\b([,.!?]?)/gi;

/**
 * Capitalise the opening word, but only when it is safely a word.
 *
 * Stripping an opener leaves the next word at the front of the sentence, and
 * that word should be capitalised - except when it is a filename. The first
 * version of this raised "report-q3.pdf" to "Report-q3.pdf", which is a
 * different filename, and a test caught it. Anything carrying a digit, a dot
 * or a slash is left exactly as the model wrote it.
 */
function capitaliseFirst(text: string): string {
  const first = text.charAt(0);
  if (first === '' || first !== first.toLowerCase()) return text;

  const opening = /^\S+/.exec(text)?.[0] ?? '';
  if (!/^[a-z']+[,.!?:;]?$/i.test(opening)) return text;

  return first.toUpperCase() + text.slice(1);
}

/**
 * Strip a terminal opener, and the address that came with it.
 *
 * "Affirmative, sir. Ready to assist." loses the whole opening clause rather
 * than becoming ", sir. Ready to assist." - the address belongs to the phrase
 * being removed, and the rate rule in `voice.ts` would rather it were absent
 * than stranded.
 */
function matchTerminalOpener(text: string): { remainder: string; found: string } | null {
  for (const opener of TERMINAL_OPENERS) {
    // The trailing boundary matters: without it "roger" matches the front of
    // a name, and the reply loses its first three letters.
    const pattern = new RegExp('^\\s*' + opener + '\\b(?:,\\s*sir)?\\s*[,.:!-]?\\s*', 'i');
    const match = pattern.exec(text);
    if (match) {
      return { remainder: text.slice(match[0].length).trim(), found: match[0].trim() };
    }
  }
  return null;
}

/**
 * The opener removed, or null when there is nothing usable left without it.
 *
 * A reply of "Acknowledged." is still a fault - `matchTerminalOpener` reports
 * it - but there is no repair to make, only a whole reply that should not have
 * been sent. That case is flagged rather than blanked.
 */
function stripTerminalOpener(text: string): { text: string; found: string } | null {
  const match = matchTerminalOpener(text);
  if (!match || match.remainder === '') return null;
  return { text: capitaliseFirst(match.remainder), found: match.found };
}

/**
 * Reduce the address to at most one occurrence per reply.
 *
 * The prompt asks for roughly a third of replies to carry it and never twice
 * in the same one; a small model reliably obliges on the first half of that
 * instruction and ignores the second. The first occurrence is the one kept,
 * because it is almost always the natural one.
 */
function collapseAddress(text: string, keepFirst: boolean): { text: string } | null {
  const matches = [...text.matchAll(ADDRESS_OCCURRENCE)];
  if (matches.length === 0) return null;
  if (matches.length === 1 && keepFirst) return null;

  let seen = 0;
  const collapsed = text.replace(ADDRESS_OCCURRENCE, (whole: string, _lead: string, trail: string) => {
    seen += 1;
    if (seen === 1 && keepFirst) return whole;
    // Keep whatever punctuation ended the clause; only the address goes.
    return trail === ',' ? '' : trail;
  });

  return { text: collapsed.replace(/\s{2,}/g, ' ').trim() };
}

/**
 * A trailing offer of service, and what is left without it.
 *
 * Null when there is nothing before it. A reply that is only a service tag is
 * a bad reply, but deleting it leaves the user with silence, and silence is
 * worse than filler.
 */
function matchServiceTag(text: string): { remainder: string; found: string } | null {
  for (const pattern of SERVICE_TAGS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const remainder = text.slice(0, match.index).trim();
    if (remainder === '') return null;
    return { remainder, found: match[0].trim() };
  }
  return null;
}

/** Everything wrong with this reply, without changing it. */
export function inspect(text: string): RegisterFinding[] {
  const findings: RegisterFinding[] = [];

  const opener = matchTerminalOpener(text);
  if (opener) findings.push({ fault: 'terminal', found: opener.found });

  for (const [pattern] of ARCHAIC_ADDRESS) {
    const match = new RegExp(pattern.source, 'i').exec(text);
    if (match) findings.push({ fault: 'archaic', found: match[0] });
  }
  for (const pattern of ARCHAIC_FLOURISHES) {
    const match = new RegExp(pattern.source, 'i').exec(text);
    if (match) findings.push({ fault: 'archaic', found: match[0].trim() });
  }

  const disclaimer = new RegExp(DISCLAIMER.source, 'i').exec(text);
  if (disclaimer) findings.push({ fault: 'disclaimer', found: disclaimer[0].trim() });

  if ([...text.matchAll(ADDRESS_OCCURRENCE)].length > 1) {
    findings.push({ fault: 'address-repeat', found: 'sir' });
  }

  const tag = matchServiceTag(text);
  if (tag) findings.push({ fault: 'service-tag', found: tag.found });

  const emoji = new RegExp(EMOJI.source, 'u').exec(text);
  if (emoji) findings.push({ fault: 'emoji', found: emoji[0] });

  return findings;
}

/**
 * Bring a model's reply into Helix's register.
 *
 * Deletion and fixed substitution only. Nothing here can invent a sentence,
 * and the findings are returned so the caller can see what the model needed
 * help with rather than being told everything was fine.
 */
export interface RepairOptions {
  /**
   * Whether this reply may carry the form of address.
   *
   * Defaults to true, which leaves the reply's own choice alone beyond the
   * one-per-reply rule. The orchestrator passes `allowAddressInReply()` from
   * `voice.ts`, so that the rate across replies is governed by the same
   * rolling window as Helix's own scripted sentences - a model given the rate
   * in words used the address in five replies out of six.
   */
  allowAddress?: boolean;
}

export function repair(text: string, options: RepairOptions = {}): RepairedReply {
  const allowAddress = options.allowAddress ?? true;

  const findings = inspect(text);
  const hasAddress = ADDRESS_OCCURRENCE.test(text);
  ADDRESS_OCCURRENCE.lastIndex = 0;

  if (!allowAddress && hasAddress) {
    findings.push({ fault: 'address-rate', found: 'sir' });
  }

  if (findings.length === 0) return { text, findings: [], wholesale: false };

  let working = text;
  let wholesale = false;

  const opener = stripTerminalOpener(working);
  if (opener) {
    working = opener.text;
  } else if (findings.some((finding) => finding.fault === 'terminal')) {
    // Only reachable when the opener was the entire reply.
    wholesale = true;
  }

  for (const [pattern, replacement] of ARCHAIC_ADDRESS) {
    working = working.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  for (const pattern of ARCHAIC_FLOURISHES) {
    working = working.replace(new RegExp(pattern.source, pattern.flags), '');
  }

  working = working.replace(new RegExp(DISCLAIMER.source, DISCLAIMER.flags), '');
  working = working.replace(new RegExp(EMOJI.source, EMOJI.flags), '');

  const tag = matchServiceTag(working);
  if (tag) working = tag.remainder;

  const collapsed = collapseAddress(working, allowAddress);
  if (collapsed) working = collapsed.text;

  working = working
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
  working = capitaliseFirst(working);

  // The safeguard. A repaired reply that says nothing is worse than an
  // unrepaired one that says something badly.
  if (working === '') return { text, findings, wholesale: true };

  return { text: working, findings, wholesale };
}
