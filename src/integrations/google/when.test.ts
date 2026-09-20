import { describe, expect, it } from 'vitest';
import { parseClock, parseDay, parseDuration, parseWhen } from './when.js';

// A Wednesday, so "on Friday" and "on Wednesday" both have obvious answers.
const NOW = new Date(2026, 8, 16, 10, 0, 0);

describe('the time', () => {
  it('reads the usual ways of writing one', () => {
    expect(parseClock('at 3pm')).toBe(15 * 60);
    expect(parseClock('at 9:30am')).toBe(9 * 60 + 30);
    expect(parseClock('at 15:00')).toBe(15 * 60);
    expect(parseClock('at 9.45am')).toBe(9 * 60 + 45);
    expect(parseClock('at 12am')).toBe(0);
    expect(parseClock('at 12pm')).toBe(12 * 60);
  });

  it('refuses a bare number that could be either half of the day', () => {
    // "Meet at 3" almost always means the afternoon. Almost is not good
    // enough for something you find out about by missing it.
    expect(parseClock('at 3')).toBeNull();
    expect(parseClock('at 7')).toBeNull();
    // Past eight there is no morning reading, so it is safe.
    expect(parseClock('at 9')).toBe(9 * 60);
  });

  it('refuses nonsense rather than wrapping it round', () => {
    expect(parseClock('at 25:00')).toBeNull();
    expect(parseClock('no time here')).toBeNull();
  });
});

describe('the day', () => {
  it('reads today and tomorrow', () => {
    expect(parseDay('today', NOW)?.getDate()).toBe(16);
    expect(parseDay('tomorrow', NOW)?.getDate()).toBe(17);
  });

  it('reads an explicit date, which is never ambiguous', () => {
    const day = parseDay('on 2026-10-02', NOW);
    expect(day?.getFullYear()).toBe(2026);
    expect(day?.getMonth()).toBe(9);
    expect(day?.getDate()).toBe(2);
  });

  it('takes a named day to mean the coming one', () => {
    // Wednesday the 16th, so Friday is the 18th.
    expect(parseDay('on Friday', NOW)?.getDate()).toBe(18);
  });

  it('never reads a named day as today', () => {
    // "Meet on Wednesday" said on a Wednesday means the next one.
    expect(parseDay('on Wednesday', NOW)?.getDate()).toBe(23);
  });

  it('refuses "next Friday", which genuinely means two different things', () => {
    expect(parseDay('next friday', NOW)).toBeNull();
    expect(parseDay('next week', NOW)).toBeNull();
  });

  it('refuses a day it cannot place', () => {
    expect(parseDay('sometime soon', NOW)).toBeNull();
    expect(parseDay('after the summer', NOW)).toBeNull();
  });
});

describe('how long', () => {
  it('defaults to an hour, which is what a meeting is', () => {
    expect(parseDuration('tomorrow at 3pm')).toBe(60);
  });

  it('reads a stated length', () => {
    expect(parseDuration('for 30 minutes')).toBe(30);
    expect(parseDuration('for 2 hours')).toBe(120);
    expect(parseDuration('for 1.5 hours')).toBe(90);
  });
});

describe('the whole thing', () => {
  it('builds a local start and end', () => {
    const when = parseWhen('tomorrow at 3pm for 30 minutes', NOW);
    expect(when).toEqual({
      start: '2026-09-17T15:00:00',
      end: '2026-09-17T15:30:00',
      allDay: false,
    });
  });

  it('treats a day with no time as a whole day, with an exclusive end', () => {
    // Google expects the end date to be the day after.
    expect(parseWhen('tomorrow', NOW)).toEqual({
      start: '2026-09-17',
      end: '2026-09-18',
      allDay: true,
    });
  });

  it('does not read the date as a time', () => {
    const when = parseWhen('2026-10-02 at 09:30', NOW);
    expect(when?.start).toBe('2026-10-02T09:30:00');
  });

  it('refuses everything it cannot be certain about', () => {
    for (const text of ['next friday at 3pm', 'sometime tuesday-ish', 'soon', '']) {
      expect(parseWhen(text, NOW)).toBeNull();
    }
  });
});
