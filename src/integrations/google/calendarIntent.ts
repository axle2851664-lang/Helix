/**
 * Recognising a request about the calendar.
 *
 * Matched in code rather than emitted by the model, for the reason the docs
 * and phone intents are: a structured command assembled from generated text
 * is generated text being executed, and putting a wrongly-parsed event on a
 * real calendar at a real time is a mistake the user finds out about by
 * missing something.
 *
 * Two intents, kept apart because they carry different risk. Reading is
 * harmless and needs no confirmation. Creating changes something outside
 * Helix, so it goes through `calendar.create`, whose confirmation is where a
 * misread day gets caught. The `when` text is passed through untouched - this
 * parser deliberately does not try to understand it, because the strict
 * parser behind the action is the one place that should decide whether a
 * phrase names a time at all.
 */

export type CalendarIntent =
  | { kind: 'read'; days: number }
  | { kind: 'create'; summary: string; when: string; location?: string };

/** "what's on my calendar", "am I free tomorrow", "what does my week look like". */
const READ =
  /\b(?:what(?:'s| is| does)?\s+(?:on\s+)?(?:my\s+)?(?:calendar|schedule|agenda|day|week)|my\s+(?:calendar|schedule|agenda)|am\s+i\s+free|what\s+have\s+i\s+got\s+on|anything\s+on\s+(?:my\s+)?(?:calendar|schedule))\b/i;

/** Phrasings that put something on the calendar. */
const CREATE_OPENERS = [
  'put on my calendar',
  'put it on my calendar',
  'add to my calendar',
  'add an event',
  'add event',
  'schedule',
  'book',
  'create an event',
  'create a calendar event',
  'make a calendar event',
  'put',
  'add',
];

/**
 * A read phrase wins over a create one when both appear: "what's on my
 * calendar, add nothing" is a question. Creation requires a time phrase,
 * which is what separates "add milk to the list" from "add lunch at 1pm".
 */
const WHEN_SPLIT =
  /\s+\b(?:on|at|for|tomorrow|today|tonight|next|this)\b/i;

function daysAsked(lower: string): number {
  if (/\b(?:week|this week|next week)\b/.test(lower)) return 7;
  if (/\b(?:month)\b/.test(lower)) return 30;
  if (/\b(?:today|tonight)\b/.test(lower)) return 1;
  if (/\btomorrow\b/.test(lower)) return 2;
  return 7;
}

export function calendarIntent(input: string): CalendarIntent | null {
  const text = input.trim().replace(/[?!.]+$/, '');
  if (text === '') return null;
  const lower = text.toLowerCase();

  const mentionsCalendar = /\b(?:calendar|schedule|agenda)\b/i.test(lower);

  if (READ.test(lower) && !/\b(?:add|put|book|create|make)\b/i.test(lower)) {
    return { kind: 'read', days: daysAsked(lower) };
  }

  const opener = [...CREATE_OPENERS]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => lower.startsWith(candidate));
  if (opener === undefined) return null;

  // A bare "put"/"add" is only a calendar request when it says so. Without
  // that, "add milk to the shopping list" would book a meeting called milk.
  if ((opener === 'put' || opener === 'add' || opener === 'book') && !mentionsCalendar) {
    if (opener === 'book' && !/\b(?:at|on|for|tomorrow|today|tonight|next)\b/i.test(lower)) {
      return null;
    }
    if (opener !== 'book') return null;
  }

  let rest = text
    .slice(opener.length)
    .replace(/^\s*(?:an?\s+event\s+)?(?:called|titled|named)\s+/i, '')
    .replace(/\s+(?:to|on|in)\s+my\s+(?:calendar|schedule|agenda)\b/i, '')
    .trim();
  if (rest === '') return null;

  // Where, if stated, comes off before the time so it does not end up inside it.
  let location: string | undefined;
  const at = /\s+\bat\s+(?:the\s+)?([A-Z][\w' -]{2,60})\s*$/.exec(rest);
  if (at?.[1] !== undefined && !/\d/.test(at[1])) {
    location = at[1].trim();
    rest = rest.slice(0, at.index).trim();
  }

  const split = WHEN_SPLIT.exec(rest);
  if (split === null || split.index === 0) return null;

  const summary = rest.slice(0, split.index).trim();
  const when = rest.slice(split.index).trim();
  if (summary === '' || when === '') return null;

  return {
    kind: 'create',
    summary,
    when,
    ...(location !== undefined ? { location } : {}),
  };
}
