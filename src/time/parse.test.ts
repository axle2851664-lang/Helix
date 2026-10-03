import { describe, expect, it } from 'vitest';
import { formatDuration, parseClockTime, parseDuration, parseLabel } from './parse.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('parseDuration', () => {
  it('reads the plain forms', () => {
    expect(parseDuration('5 minutes')).toBe(5 * MINUTE);
    expect(parseDuration('set a timer for 10 minutes')).toBe(10 * MINUTE);
    expect(parseDuration('90 seconds')).toBe(90 * SECOND);
    expect(parseDuration('2 hours')).toBe(2 * HOUR);
  });

  it('reads abbreviations', () => {
    expect(parseDuration('5m')).toBe(5 * MINUTE);
    expect(parseDuration('30s')).toBe(30 * SECOND);
    expect(parseDuration('1h')).toBe(HOUR);
    expect(parseDuration('45 min')).toBe(45 * MINUTE);
    expect(parseDuration('20 secs')).toBe(20 * SECOND);
  });

  it('reads numbers that were written out', () => {
    expect(parseDuration('five minutes')).toBe(5 * MINUTE);
    expect(parseDuration('twenty minutes')).toBe(20 * MINUTE);
    expect(parseDuration('an hour')).toBe(HOUR);
    expect(parseDuration('a minute')).toBe(MINUTE);
  });

  it('adds the parts of a compound duration', () => {
    expect(parseDuration('1 hour 30 minutes')).toBe(HOUR + 30 * MINUTE);
    expect(parseDuration('two minutes 30 seconds')).toBe(2 * MINUTE + 30 * SECOND);
    expect(parseDuration('1 hour and 5 minutes')).toBe(HOUR + 5 * MINUTE);
  });

  it('reads fractions', () => {
    expect(parseDuration('half an hour')).toBe(30 * MINUTE);
    expect(parseDuration('half a minute')).toBe(30 * SECOND);
    expect(parseDuration('two and a half minutes')).toBe(2 * MINUTE + 30 * SECOND);
    expect(parseDuration('quarter of an hour')).toBe(15 * MINUTE);
  });

  it('reads the colon form a stopwatch uses', () => {
    expect(parseDuration('1:30')).toBe(MINUTE + 30 * SECOND);
    expect(parseDuration('10:00')).toBe(10 * MINUTE);
    expect(parseDuration('1:30:00')).toBe(HOUR + 30 * MINUTE);
  });

  /**
   * The refusal that matters most. "5" is five minutes to most people and "90"
   * is ninety seconds to about half of them - there is no default that is not
   * wrong some of the time, and a timer running for the wrong length is worse
   * than one that was never set, because the user walks away believing it.
   */
  it('refuses a bare number rather than guessing a unit', () => {
    expect(parseDuration('set a timer for 5')).toBeNull();
    expect(parseDuration('90')).toBeNull();
    expect(parseDuration('set a timer')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('says it the way a person would', () => {
    expect(formatDuration(5 * MINUTE)).toBe('5 minutes');
    expect(formatDuration(MINUTE)).toBe('1 minute');
    expect(formatDuration(90 * SECOND)).toBe('1 minute and 30 seconds');
    expect(formatDuration(HOUR + 30 * MINUTE)).toBe('1 hour and 30 minutes');
    expect(formatDuration(0)).toBe('0 seconds');
  });

  /** A readout, not a sentence: nobody says "one hour two minutes three
      seconds" out loud. */
  it('drops the seconds once there is an hour', () => {
    expect(formatDuration(HOUR + 2 * MINUTE + 3 * SECOND)).toBe('1 hour and 2 minutes');
  });
});

describe('parseClockTime', () => {
  // A Tuesday morning, nine o'clock.
  const nineAm = new Date(2026, 9, 6, 9, 0, 0, 0);

  const reading = (date: Date | null) =>
    date === null ? null : `${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

  it('takes the meridiem as given', () => {
    expect(reading(parseClockTime('wake me at 7:30 am', nineAm))).toBe('7 7:30');
    expect(reading(parseClockTime('alarm for 6pm', nineAm))).toBe('6 18:00');
    expect(reading(parseClockTime('11 pm', nineAm))).toBe('6 23:00');
  });

  it('handles noon and midnight, including the 12s', () => {
    expect(reading(parseClockTime('noon', nineAm))).toBe('6 12:00');
    expect(reading(parseClockTime('midnight', nineAm))).toBe('7 0:00');
    expect(reading(parseClockTime('12 am', nineAm))).toBe('7 0:00');
    expect(reading(parseClockTime('12 pm', nineAm))).toBe('6 12:00');
  });

  /**
   * "Set an alarm for 7" at 9am means seven in the evening; the same words at
   * 9pm mean seven tomorrow morning. Always assuming am would be twelve hours
   * wrong half the time.
   */
  it('picks whichever reading comes round first when no meridiem is given', () => {
    expect(reading(parseClockTime('set an alarm for 7', nineAm))).toBe('6 19:00');
    const ninePm = new Date(2026, 9, 6, 21, 0, 0, 0);
    expect(reading(parseClockTime('set an alarm for 7', ninePm))).toBe('7 7:00');
  });

  /** A time that has passed today is tomorrow: an alarm for a moment already
      gone is not an alarm. */
  it('rolls over to tomorrow', () => {
    expect(reading(parseClockTime('7:30 am', new Date(2026, 9, 6, 8, 0)))).toBe('7 7:30');
  });

  it('answers null when nothing names a time, and refuses an impossible one', () => {
    expect(parseClockTime('set an alarm', nineAm)).toBeNull();
    expect(parseClockTime('', nineAm)).toBeNull();
    expect(parseClockTime('at 25:00', nineAm)).toBeNull();
  });
});

describe('parseLabel', () => {
  it('takes a trailing name', () => {
    expect(parseLabel('set a timer for 10 minutes for the pasta')).toBe('the pasta');
    expect(parseLabel('timer called laundry')).toBe('laundry');
  });

  /** Without this, "a timer for 5 minutes" would be labelled "5 minutes". */
  it('does not mistake the duration for a name', () => {
    expect(parseLabel('set a timer for 5 minutes')).toBeNull();
    expect(parseLabel('set an alarm for 7:30 am')).toBeNull();
    expect(parseLabel('set a timer for 5')).toBeNull();
    expect(parseLabel('start a stopwatch')).toBeNull();
  });
});
