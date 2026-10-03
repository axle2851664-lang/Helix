/**
 * Reading durations and times out of what someone said.
 *
 * Pure, and separate from the thing that keeps time, because this is the part
 * with the bugs in it. "Set a timer for 5" is five minutes; "set a timer for
 * 90" is ninety seconds to about half the people who say it and ninety minutes
 * to the other half, so it is refused rather than guessed. A timer that runs
 * for the wrong length is worse than one that was never set, because the user
 * walks away believing it.
 *
 * No model is asked. A duration is arithmetic, and a model that gets it wrong
 * produces a number that looks exactly as plausible as the right one.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Written-out numbers, as far as anyone says them to a timer.
 *
 * "a" and "an" are deliberately absent. They were here as 1, which made
 * "set a timer for 10 minutes" eleven minutes - the article counted as a
 * number and the ten was added to it - and "half an hour" ninety. An article
 * means "one of" only when a unit follows it directly, which the loop handles
 * by ignoring the word and letting a bare unit stand for one of itself.
 */
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  ninety: 90,
};

const UNITS: Array<{ match: RegExp; ms: number }> = [
  { match: /^(hours?|hrs?|h)$/, ms: HOUR },
  { match: /^(minutes?|mins?|m)$/, ms: MINUTE },
  { match: /^(seconds?|secs?|s)$/, ms: SECOND },
];

function unitOf(word: string): number | null {
  for (const unit of UNITS) {
    if (unit.match.test(word)) return unit.ms;
  }
  return null;
}

function amount(word: string): number | null {
  if (/^\d+(\.\d+)?$/.test(word)) return Number(word);
  return WORDS[word] ?? null;
}

/**
 * How long, in milliseconds, or null when the text does not say.
 *
 * Accepts the forms people actually use: "5 minutes", "5m", "90 seconds",
 * "an hour", "1 hour 30 minutes", "half an hour", "two and a half minutes",
 * "1:30" (minutes and seconds, as a stopwatch reads).
 *
 * Returns null rather than a default for a bare number with no unit. There is
 * no safe default: the one guess that is right for "set a timer for 5" is
 * wrong for "set a timer for 90", and a timer running for the wrong length is
 * the worst outcome available here.
 */
export function parseDuration(text: string): number | null {
  const words = text
    .toLowerCase()
    // Keep the colon: it carries the mm:ss form.
    .replace(/[^a-z0-9:.\s]/g, ' ')
    // "5m" and "30s" are one token as typed and two as meant. Without this
    // split, every abbreviation attached to its number read as no duration
    // at all.
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter((word) => word !== '');

  // mm:ss or hh:mm:ss, which is how a stopwatch reads and how people type it.
  for (const word of words) {
    const colon = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(word);
    if (!colon) continue;
    const first = Number(colon[1]);
    const second = Number(colon[2]);
    const third = colon[3];
    return third === undefined
      ? first * MINUTE + second * SECOND
      : first * HOUR + second * MINUTE + Number(third) * SECOND;
  }

  let total = 0;
  let pending: number | null = null;
  /** Set by "half", which multiplies what follows or adds to what came before. */
  let half = false;
  /** The last unit seen, so a trailing "and a half" has something to halve. */
  let lastUnit: number | null = null;

  for (const word of words) {
    if (word === 'half') {
      half = true;
      continue;
    }
    // Articles and glue. An article is not the number one - see WORDS.
    if (word === 'a' || word === 'an' || word === 'and' || word === 'the'
      || word === 'for' || word === 'of') continue;
    if (word === 'quarter') {
      // "quarter of an hour". Treated like half: a fraction of what follows.
      pending = (pending ?? 0) + 0.25;
      continue;
    }

    const unit = unitOf(word);
    if (unit !== null) {
      if (half && pending === null) {
        // "half an hour".
        total += unit / 2;
      } else if (half && pending !== null) {
        // "two and a half minutes".
        total += (pending + 0.5) * unit;
      } else if (pending !== null) {
        total += pending * unit;
      } else {
        // A unit with no number, as in "a minute" after the article was
        // stripped - one of them.
        total += unit;
      }
      pending = null;
      half = false;
      lastUnit = unit;
      continue;
    }

    const value = amount(word);
    if (value !== null) {
      // The later number wins. Two numbers with no unit between them is not a
      // duration anyone means, and adding them made an article plus a number
      // read as their sum.
      pending = value;
    }
  }

  // "a minute and a half": the fraction arrives after its unit has already
  // been counted, so it halves the last unit seen rather than being dropped.
  if (half && pending === null && lastUnit !== null) total += lastUnit / 2;

  // A trailing number with no unit. Deliberately dropped rather than assumed:
  // see the note above.
  return total > 0 ? Math.round(total) : null;
}

/** For speech: the duration said the way a person would say it. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];
  const plural = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? '' : 's'}`;
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (minutes > 0) parts.push(plural(minutes, 'minute'));
  // Seconds are dropped once there is an hour on the clock: "1 hour 2 minutes
  // 3 seconds" is a readout, not a sentence.
  if (seconds > 0 && hours === 0) parts.push(plural(seconds, 'second'));

  if (parts.length === 0) return '0 seconds';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * A wall-clock time, resolved to the next time it comes round.
 *
 * "7:30" at nine in the morning means half past seven tomorrow, because an
 * alarm set for a moment that has passed is not an alarm. Said with "am" or
 * "pm" the hour is taken as given; without one, the reading that is soonest in
 * the future wins - which is what someone means by "wake me at 7".
 *
 * Returns null when the text names no time. Nothing is defaulted: an alarm at
 * a guessed hour is the same failure as a timer of a guessed length.
 */
export function parseClockTime(text: string, now: Date = new Date()): Date | null {
  const lower = text.toLowerCase();

  if (/\bnoon|\bmidday\b/.test(lower)) return nextAt(now, 12, 0);
  if (/\bmidnight\b/.test(lower)) return nextAt(now, 0, 0);

  // 7, 7:30, 7.30, with an optional meridiem that may be separated or not.
  const match = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(lower);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.replace(/\./g, '');

  if (hour > 23 || minute > 59) return null;

  if (meridiem === 'am') {
    // 12am is midnight.
    hour = hour === 12 ? 0 : hour;
  } else if (meridiem === 'pm') {
    hour = hour === 12 ? 12 : hour + 12;
    if (hour > 23) return null;
  } else if (hour <= 12) {
    /**
     * No meridiem, and an ambiguous hour. Pick whichever of the two readings
     * comes round first - "set an alarm for 7" at 9am is seven in the evening,
     * and at 9pm is seven in the morning, which is what a person means both
     * times. Guessing "am" always would set an alarm twelve hours wrong half
     * the time.
     */
     const morning = nextAt(now, hour === 12 ? 0 : hour, minute);
     const evening = nextAt(now, hour === 12 ? 12 : hour + 12, minute);
     return morning.getTime() <= evening.getTime() ? morning : evening;
  }

  return nextAt(now, hour, minute);
}

/** The next time the clock reads this, today or tomorrow. */
function nextAt(now: Date, hour: number, minute: number): Date {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * The label someone gave a timer, or null.
 *
 * "set a timer for 10 minutes for the pasta" -> "the pasta". Only a trailing
 * "for ..." or "called ..." counts, and only when what follows is not itself
 * a duration, or "a timer for 5 minutes" would be labelled "5 minutes".
 */
export function parseLabel(text: string): string | null {
  /**
   * The *last* such phrase, not the first, which is what the leading greedy
   * `.*` buys. "a timer for 10 minutes for the pasta" has two, and matching
   * the first captured "10 minutes for the pasta" - which parses as a
   * duration, so every labelled timer came back unlabelled. Anchoring at the
   * end is not enough on its own: the leftmost match still reaches it.
   */
  const match = /.*\b(?:for|called|named|labelled|labeled)\s+([^,.]+)$/i.exec(text.trim());
  const candidate = match?.[1]?.trim();
  if (candidate === undefined || candidate === '') return null;
  if (parseDuration(candidate) !== null) return null;
  if (parseClockTime(candidate) !== null) return null;
  // A bare number is not a name.
  if (/^\d+$/.test(candidate)) return null;
  return candidate;
}
