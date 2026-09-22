import { describe, expect, it } from 'vitest';
import { calendarIntent } from './calendarIntent.js';

describe('calendarIntent', () => {
  it('reads the calendar when asked what is on it', () => {
    for (const phrase of [
      "what's on my calendar",
      'what is on my calendar this week?',
      'my schedule',
      'am I free tomorrow',
      'anything on my calendar',
    ]) {
      expect(calendarIntent(phrase)?.kind, phrase).toBe('read');
    }
  });

  it('scales the window to the question', () => {
    const week = calendarIntent("what's on my calendar this week");
    const day = calendarIntent('am I free today');
    expect(week).toEqual({ kind: 'read', days: 7 });
    expect(day).toEqual({ kind: 'read', days: 1 });
  });

  it('splits a created event into a summary and an untouched time phrase', () => {
    expect(calendarIntent('schedule lunch with Marlow tomorrow at 1pm')).toEqual({
      kind: 'create',
      summary: 'lunch with Marlow',
      when: 'tomorrow at 1pm',
    });
  });

  it('adds to the calendar when the request says calendar', () => {
    const intent = calendarIntent('add dentist to my calendar on Thursday at 9am');
    expect(intent?.kind).toBe('create');
    expect(intent).toMatchObject({ summary: 'dentist' });
  });

  /**
   * The failure that would matter: a shopping list turning into a meeting.
   * A bare "add"/"put" with no mention of a calendar is not a booking.
   */
  it('refuses a bare add that is not about the calendar', () => {
    expect(calendarIntent('add milk to the shopping list')).toBeNull();
    expect(calendarIntent('put the file on the desktop')).toBeNull();
  });

  it('refuses a creation with no time in it', () => {
    expect(calendarIntent('add an event to my calendar')).toBeNull();
    expect(calendarIntent('schedule')).toBeNull();
  });

  it('never leaves an empty summary or an empty time', () => {
    for (const phrase of ['schedule at 3pm', 'schedule tomorrow']) {
      expect(calendarIntent(phrase), phrase).toBeNull();
    }
  });

  it('takes a named place off the end rather than folding it into the time', () => {
    const intent = calendarIntent('schedule standup tomorrow at 9am at Grafton House');
    expect(intent).toMatchObject({ location: 'Grafton House' });
    expect((intent as { when: string }).when).not.toContain('Grafton');
  });

  it('ignores anything it does not recognise', () => {
    expect(calendarIntent('')).toBeNull();
    expect(calendarIntent('how are you')).toBeNull();
  });
});
