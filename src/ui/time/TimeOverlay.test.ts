import { describe, expect, it } from 'vitest';
import {
  friendlyZoneName,
  measureClockResolution,
  systemPrefers12Hour,
} from './TimeOverlay.js';

/**
 * The component itself is not rendered here - the test environment is node,
 * with no DOM and no requestAnimationFrame. What is tested is the part that
 * can be quietly wrong: the three pure functions that decide what the screen
 * claims about the machine's clock.
 */

describe('measureClockResolution', () => {
  it('reports the step size of a coarse clock rather than assuming 1ms', () => {
    // A clock that only ever moves in 100ms jumps, like a hardened browser.
    let reading = 0;
    const coarse = () => {
      reading += 1;
      return Math.floor(reading / 50) * 100;
    };
    expect(measureClockResolution(coarse)).toBe(100);
  });

  it('reports 1 for a clock that moves every millisecond', () => {
    let reading = 0;
    expect(measureClockResolution(() => (reading += 1))).toBe(1);
  });

  /**
   * A clock that never changes across the whole sample gives no step to
   * measure. Falling back to 1 understates nothing and overstates nothing:
   * the caveat line only appears above 1, so a frozen reading stays quiet
   * rather than printing "in Infinityms steps".
   */
  it('falls back to 1 when the clock never moves', () => {
    expect(measureClockResolution(() => 1_700_000_000_000)).toBe(1);
  });
});

describe('systemPrefers12Hour', () => {
  const resolved = (options: Partial<Intl.ResolvedDateTimeFormatOptions>) => () =>
    options as Intl.ResolvedDateTimeFormatOptions;

  it('takes hour12 when the engine reports it', () => {
    expect(systemPrefers12Hour(resolved({ hour12: true }))).toBe(true);
    expect(systemPrefers12Hour(resolved({ hour12: false }))).toBe(false);
  });

  /** Not every engine fills hour12 in, and a missing answer must not
      silently become "no". */
  it('falls back to the hour cycle', () => {
    expect(systemPrefers12Hour(resolved({ hourCycle: 'h12' }))).toBe(true);
    expect(systemPrefers12Hour(resolved({ hourCycle: 'h11' }))).toBe(true);
    expect(systemPrefers12Hour(resolved({ hourCycle: 'h23' }))).toBe(false);
  });

  it('reads the unambiguous clock when the engine cannot answer', () => {
    expect(
      systemPrefers12Hour(() => {
        throw new Error('no Intl');
      }),
    ).toBe(false);
  });

  /** Whatever this machine says, it must be a boolean and must not throw. */
  it('answers for the real system', () => {
    expect(typeof systemPrefers12Hour()).toBe('boolean');
  });
});

describe('friendlyZoneName', () => {
  const at = new Date('2026-10-03T22:02:47Z');
  const named = (value: string) => () => value;

  it('drops the season word, because it is the same zone either way', () => {
    expect(friendlyZoneName(at, named('10/3/2026, Pacific Daylight Time'))).toBe('Pacific Time');
    expect(friendlyZoneName(at, named('10/3/2026, Pacific Standard Time'))).toBe('Pacific Time');
    expect(friendlyZoneName(at, named('03/10/2026, British Summer Time'))).toBe('British Time');
  });

  it('keeps a name that has no season in it', () => {
    expect(friendlyZoneName(at, named('10/3/2026, Central European Time'))).toBe(
      'Central European Time',
    );
  });

  /**
   * Absent rather than guessed. An offset like GMT+2 is not a zone name, and
   * printing one would be clutter where the spec asked for a name; printing
   * an invented one would be worse.
   */
  it('answers null rather than substituting something when no name comes back', () => {
    expect(friendlyZoneName(at, named('10/3/2026, GMT+2'))).toBeNull();
    expect(friendlyZoneName(at, named('10/3/2026'))).toBeNull();
    expect(
      friendlyZoneName(at, () => {
        throw new Error('no Intl');
      }),
    ).toBeNull();
  });

  /** On the real platform this is either a name or nothing - never a crash. */
  it('answers for the real system', () => {
    const zone = friendlyZoneName();
    expect(zone === null || zone.length > 0).toBe(true);
  });
});
