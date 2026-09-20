/**
 * Reading a date and time out of ordinary speech.
 *
 * The rule here is stricter than anywhere else in Helix: **guessing is worse
 * than refusing.** A misread query returns the wrong search results and costs
 * a rephrase. A misread time puts an appointment in somebody's calendar an
 * hour, a day or a month from where they meant it, and they find out by
 * missing it.
 *
 * So this understands a small, unambiguous set and says no to everything
 * else. "Next Friday" is deliberately absent: it means the coming Friday to
 * some people and the one after to others, and there is no way to be right.
 */

export interface ParsedWhen {
  /** Local wall-clock start, as an ISO string without a zone suffix. */
  start: string;
  end: string;
  /** True when this is a whole day rather than a time. */
  allDay: boolean;
}

const DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localIso(date: Date): string {
  return `${dateOnly(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

/** "3pm", "15:00", "9.30am" -> minutes since midnight, or null. */
export function parseClock(text: string): number | null {
  const match = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!match?.[1]) return null;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.toLowerCase();

  if (!Number.isFinite(hour) || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  // Without am/pm a bare number under 8 is ambiguous - "meet at 3" almost
  // always means the afternoon, but almost is not good enough for a calendar.
  if (meridiem === undefined && hour < 8) return null;
  if (hour > 23) return null;

  return hour * 60 + minute;
}

/**
 * Which day, relative to now. Returns null when it cannot be certain.
 *
 * `now` is a parameter so this is testable without waiting for Tuesday.
 */
/**
 * Words that say outright that the speaker is not being precise.
 *
 * "Sometime Tuesday-ish" contains a real day name and means nothing of the
 * sort. Matching the day and booking it is worse than refusing, so vagueness
 * is detected and refused before anything else is read.
 */
const VAGUE = /\b(?:sometime|some time|-?ish\b|around|roughly|maybe|perhaps|or so|whenever)\b|-ish\b/i;

export function parseDay(text: string, now: Date): Date | null {
  const lower = text.toLowerCase();
  if (VAGUE.test(lower)) return null;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (/\btoday\b/.test(lower)) return base;
  if (/\btomorrow\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
    return base;
  }

  // An explicit date is unambiguous and always accepted.
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso?.[1] && iso[2] && iso[3]) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  // "next friday" is refused on purpose: it means the coming Friday to some
  // people and the one after to others.
  if (/\bnext\s+/.test(lower)) return null;

  // A stricter boundary than \b: "tuesday-ish" has a word boundary after
  // "tuesday" and is not a request to book Tuesday.
  const named = DAYS.findIndex((day) =>
    new RegExp(`(?:^|[^\\w-])(?:on\\s+)?${day}(?![\\w-])`).test(lower),
  );
  if (named >= 0) {
    // The coming one. Today does not count - "meet on Tuesday" said on a
    // Tuesday means the next one, in every office anyone has worked in.
    const ahead = (named - base.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + ahead);
    return base;
  }

  return null;
}

/** How long, in minutes. Defaults to an hour, which is what a meeting is. */
export function parseDuration(text: string): number {
  const hours = /\bfor\s+(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(text);
  if (hours?.[1]) return Math.round(Number(hours[1]) * 60);

  const minutes = /\bfor\s+(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b/i.exec(text);
  if (minutes?.[1]) return Number(minutes[1]);

  return 60;
}

/**
 * The whole thing, or null when Helix is not certain enough to book it.
 */
export function parseWhen(text: string, now: Date): ParsedWhen | null {
  const day = parseDay(text, now);
  if (day === null) return null;

  const clock = parseClock(text.replace(/\b\d{4}-\d{2}-\d{2}\b/, ' '));

  if (clock === null) {
    // A day with no time is a whole-day entry, which is a real thing to want
    // and unambiguous. The end date is exclusive, as Google expects.
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    return { start: dateOnly(day), end: dateOnly(next), allDay: true };
  }

  const start = new Date(day);
  start.setHours(Math.floor(clock / 60), clock % 60, 0, 0);

  const end = new Date(start);
  end.setMinutes(end.getMinutes() + parseDuration(text));

  return { start: localIso(start), end: localIso(end), allDay: false };
}
