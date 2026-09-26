/**
 * Recognising a request about the mailbox.
 *
 * This exists because of a specific, serious failure. Asked "what's unread on
 * my gmail right now", Helix answered "I'm checking your Gmail inbox. As of
 * now, you have several unread messages" - and had done nothing of the kind.
 * The phrase did not match the inbox tool, so it fell through to the language
 * model, which produced a plausible sentence about a mailbox it cannot see.
 *
 * A fabricated inbox is the single worst thing this codebase can produce. It
 * is believed exactly when it matters, it cannot be detected by the person
 * reading it, and "several unread messages" is indistinguishable from a real
 * answer. So the matching here is deliberately generous: a false match costs
 * a redundant tool run, and a miss costs a lie.
 *
 * The matcher is not the whole defence - the prompt forbids the model from
 * claiming to have read mail at all - but it is the first wall.
 */

export type MailIntent =
  | { kind: 'unread' }
  | { kind: 'read'; which: MailTarget }
  | { kind: 'archive'; which: MailTarget }
  | { kind: 'trash'; which: MailTarget }
  | { kind: 'star'; which: MailTarget }
  | { kind: 'markRead'; which: MailTarget };

/**
 * Which messages are meant.
 *
 * `listed` means "the ones just shown", which is the only target a
 * conversation can name without risking the wrong message. Anything vaguer is
 * refused rather than guessed: acting on the wrong mail cannot be taken back,
 * and the user would have no way of knowing it happened.
 */
export type MailTarget =
  | { of: 'all-listed' }
  | { of: 'nth'; index: number }
  | { of: 'sender'; name: string };

/** Anything that plainly means the user's mailbox. */
const MAILBOX =
  /\b(?:inbox|gmail|e-?mails?|mail(?:box)?|messages?)\b/i;

/** Asking what is there, in any of the ways people ask it. */
const ASKING_UNREAD =
  /\b(?:unread|new|what(?:'s| is| are)?\s+(?:in|on|waiting)|any(?:thing)?\s+(?:new|waiting)|check|read|show|list|got)\b/i;

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1, '1st': 1, one: 1,
  second: 2, '2nd': 2, two: 2,
  third: 3, '3rd': 3, three: 3,
  fourth: 4, '4th': 4, four: 4,
  fifth: 5, '5th': 5, five: 5,
};

function target(text: string): MailTarget | null {
  const lower = text.toLowerCase();

  const from = /\bfrom\s+([a-z0-9@._' -]{2,40}?)(?:\s*$|[,.?!])/i.exec(text);
  if (from?.[1] !== undefined) return { of: 'sender', name: from[1].trim() };

  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b(?:the\\s+)?${word}\\s+(?:one|message|email|mail)?\\b`, 'i').test(lower)) {
      return { of: 'nth', index };
    }
  }

  const numbered = /\b(?:number|#)\s*(\d{1,2})\b/.exec(lower);
  if (numbered?.[1] !== undefined) return { of: 'nth', index: Number(numbered[1]) };

  if (/\b(?:them|all|those|these|everything|each)\b/i.test(lower)) return { of: 'all-listed' };

  return null;
}

/**
 * A verb that changes the mailbox, and what it means.
 *
 * "Delete" maps to trash rather than to a permanent removal, because that is
 * what the word means in Gmail: its own Delete button moves a message to
 * Trash, where it is recoverable for thirty days. A permanent delete is a
 * different, unrecoverable act and is not what anybody means when they say
 * "delete that email".
 */
const VERBS: ReadonlyArray<{ matches: RegExp; kind: MailIntent['kind'] }> = [
  { matches: /\b(?:delete|bin|trash|throw (?:it |them )?away|get rid of)\b/i, kind: 'trash' },
  { matches: /\barchive\b/i, kind: 'archive' },
  { matches: /\b(?:star|flag)\b/i, kind: 'star' },
  { matches: /\bmark(?:\s+(?:it|them|those))?\s+(?:as\s+)?read\b/i, kind: 'markRead' },
];

export function mailIntent(input: string, afterListing = false): MailIntent | null {
  const text = input.trim();
  if (text === '') return null;

  const mentionsMail = MAILBOX.test(text);

  // A verb needs a target and a reason to believe this is about mail. After a
  // listing, "archive them" is unambiguous; cold, it is not.
  for (const verb of VERBS) {
    if (!verb.matches.test(text)) continue;
    if (!mentionsMail && !afterListing) continue;

    const which = target(text);
    if (which === null) return null;
    return { kind: verb.kind, which } as MailIntent;
  }

  // "Read them" straight after a listing means the messages just shown.
  if (afterListing && /\b(?:read|open)\b/i.test(text)) {
    const which = target(text) ?? { of: 'all-listed' };
    return { kind: 'read', which };
  }

  if (mentionsMail && /\b(?:read|open)\b/i.test(text)) {
    const which = target(text);
    if (which !== null) return { kind: 'read', which };
  }

  if (mentionsMail && ASKING_UNREAD.test(text)) return { kind: 'unread' };

  return null;
}
