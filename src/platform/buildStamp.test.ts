import { describe, expect, it } from 'vitest';
import { builtAt, describeBuild } from './buildStamp.js';

/**
 * The stamp that tells a fresh build from an installed one.
 *
 * Vitest shares the application's Vite config, so the injected constant is
 * present here too - which makes this a real test of the value rather than
 * only of the guard.
 */
describe('the build stamp', () => {
  it('is injected at build time, not left undefined', () => {
    const when = builtAt();
    expect(when).toBeInstanceOf(Date);
    expect(Number.isNaN((when as Date).getTime())).toBe(false);
  });

  it('calls a build made now "today"', () => {
    expect(describeBuild()).toContain('today');
  });

  /** The whole point: an old bundle has to announce its age. */
  it('counts the days for a build left behind', () => {
    const when = builtAt() as Date;
    const sixDaysOn = new Date(when.getTime() + 6 * 86_400_000);

    expect(describeBuild(sixDaysOn)).toContain('6 days ago');
  });

  it('says yesterday rather than 1 days ago', () => {
    const when = builtAt() as Date;
    expect(describeBuild(new Date(when.getTime() + 86_400_000))).toContain('yesterday');
  });

  /** A diagnostic that throws when it cannot diagnose is worse than none. */
  it('never throws', () => {
    expect(() => describeBuild()).not.toThrow();
    expect(() => builtAt()).not.toThrow();
  });
});
