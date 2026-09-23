/**
 * Recognising a request to email somebody, and refusing to guess who.
 *
 * The hard rule here is the one `OutboundDraft` already states about
 * recipients: "never resolved from a nickname silently". Helix holds no
 * contacts. "Email Marlow" therefore names nobody, and the only honest
 * responses are to ask for the address or to refuse - never to pick the
 * likeliest Marlow. A message sent to the wrong person cannot be recalled,
 * and the user would have no way of knowing it happened.
 *
 * So an address must appear in the request, in full. That is a slightly
 * awkward thing to type and it is the correct trade.
 */

export interface EmailIntent {
  /** A real address, taken from the request rather than inferred. */
  to: string;
  /** What the message should be about, for the model to draft from. */
  about: string;
  /** Text the user dictated verbatim, which is used instead of drafting. */
  verbatim?: string;
  /** An explicit subject, when one was given. */
  subject?: string;
}

/**
 * Deliberately conservative. It is the shape of an address rather than a
 * verdict on deliverability - Gmail decides that, and a rejected send is
 * visible, whereas a message quietly sent to a typo is not.
 */
const ADDRESS = /\b([^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+\.[A-Za-z]{2,})\b/;

const OPENERS =
  /^(?:can you |could you |would you |please |helix,? )*(?:send (?:an? )?(?:email|e-mail)(?: to)?|email|e-mail|write (?:an? )?(?:email|e-mail)(?: to)?|draft (?:an? )?(?:email|e-mail)(?: to)?)\b/i;

/** "saying ..." is dictation; "about ..." is a topic to be drafted from. */
const VERBATIM = /\b(?:saying|that says|with the message|tell(?:ing)? (?:them|him|her))\b\s*(.+)$/i;
const TOPIC = /\b(?:about|re|regarding|asking|to ask|concerning)\b\s*(.+)$/i;
/**
 * An unquoted subject stops at the word that starts the body topic. Without
 * that, "subject: Invoice 88 about the overdue payment" put the whole
 * remainder in the header and left the body with nothing to say.
 */
const SUBJECT =
  /\bsubject\s*[:=]\s*(?:["“”']([^"“”']{1,120})["“”']|([^"“”']{1,120}?)(?=\s+\b(?:about|re|regarding|asking|concerning|saying|that says)\b|$))/i;

export type EmailParse =
  | { kind: 'intent'; intent: EmailIntent }
  | { kind: 'no-address'; because: string }
  | null;

export function emailIntent(input: string): EmailParse {
  const text = input.trim();
  if (text === '') return null;
  if (!OPENERS.test(text)) return null;

  const rest = text.replace(OPENERS, '').trim();

  const found = ADDRESS.exec(rest);
  if (found?.[1] === undefined) {
    return {
      kind: 'no-address',
      because:
        'I hold no contacts, so I cannot turn a name into an address. Give me the address in full and I will draft it.',
    };
  }

  const to = found[1];
  // Everything except the address, so the topic does not swallow it.
  const remainder = (rest.slice(0, found.index) + ' ' + rest.slice(found.index + to.length))
    .replace(/\s+/g, ' ')
    .trim();

  const subjectMatch = SUBJECT.exec(remainder);
  const statedSubject = subjectMatch?.[1] ?? subjectMatch?.[2];
  const withoutSubject = subjectMatch
    ? remainder.replace(subjectMatch[0], '').replace(/\s+/g, ' ').trim()
    : remainder;

  const dictated = VERBATIM.exec(withoutSubject);
  const topic = TOPIC.exec(withoutSubject);

  const about = (dictated?.[1] ?? topic?.[1] ?? withoutSubject).replace(/^[,:\s-]+/, '').trim();
  if (about === '' && statedSubject === undefined) return null;

  return {
    kind: 'intent',
    intent: {
      to,
      about: about === '' ? (statedSubject ?? '') : about,
      ...(dictated?.[1] !== undefined ? { verbatim: dictated[1].trim() } : {}),
      ...(statedSubject !== undefined ? { subject: statedSubject.trim() } : {}),
    },
  };
}

/** What the model is told when asked to write the message. */
export function emailPrompt(about: string): { system: string; user: string } {
  return {
    system: [
      'Write a short, plain email body. No greeting line inventing a name you were not given, no signature, no subject line.',
      'Be direct and concrete. Do not pad and do not restate the request.',
      'Write only the body. No commentary before or after it.',
    ].join(' '),
    user: about,
  };
}

/** A subject drawn from the topic, when the user did not give one. */
export function subjectFrom(about: string): string {
  const first = about.split(/[.!?\n]/)[0]?.trim() ?? '';
  const trimmed = first === '' ? about.trim() : first;
  if (trimmed === '') return '(no subject)';
  const capped = trimmed.length > 78 ? `${trimmed.slice(0, 75).trimEnd()}...` : trimmed;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
