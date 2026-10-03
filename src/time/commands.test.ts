import { describe, expect, it } from 'vitest';
import { understand } from '../understanding/understand.js';
import { ConversationState } from '../understanding/state.js';

/**
 * What Helix understands when someone asks for a timer.
 *
 * Through the real understanding layer, not a mock of it. These are the
 * phrasings the feature exists to serve, and each one declined at some point
 * while it was being built - "stop the timer" was read as an abort, and
 * "what alarms are set" as a question to decline. A table of them is the only
 * thing that keeps that from happening again quietly.
 */

function read(text: string, focusKind?: string) {
  const state = new ConversationState();
  if (focusKind !== undefined) {
    state.focusOn({ kind: focusKind, id: 'x', label: `the ${focusKind}` });
  }
  const step = understand(text, state).steps[0];
  if (step === undefined) return null;
  return step.outcome === 'act' && step.match
    ? { capability: step.match.capability.id, verb: step.match.verb }
    : null;
}

describe('setting one', () => {
  it.each([
    'set a timer for 5 minutes',
    'timer for 10 minutes',
    'set a timer for 90 seconds',
    'set a timer for an hour and a half',
    'remind me in 20 minutes',
    'give me a timer for 2 minutes 30 seconds',
  ])('%s is a timer', (phrase) => {
    expect(read(phrase)).toEqual({ capability: 'timer', verb: 'create' });
  });

  it.each([
    'set an alarm for 7:30 am',
    'wake me at 6am',
    'alarm for noon',
    'wake me up at 7',
  ])('%s is an alarm', (phrase) => {
    expect(read(phrase)).toEqual({ capability: 'alarm', verb: 'create' });
  });

  it.each(['start a stopwatch', 'time me', 'start the stopwatch'])(
    '%s is a stopwatch',
    (phrase) => {
      expect(read(phrase)).toEqual({ capability: 'stopwatch', verb: 'create' });
    },
  );

  /**
   * The clock and the timer are different questions, and while the clock
   * claimed "timer" as one of its own nouns "set a timer for 5 minutes" showed
   * the time and set nothing.
   */
  it('still tells the clock apart from a timer', () => {
    expect(read('what time is it')).toEqual({ capability: 'clock', verb: 'open' });
    expect(read('show me the time')).toEqual({ capability: 'clock', verb: 'open' });
  });
});

describe('acting on one', () => {
  it.each([
    ['pause the timer', 'timer', 'pause'],
    ['stop the timer', 'timer', 'pause'],
    ['resume the timer', 'timer', 'resume'],
    ['reset the timer', 'timer', 'reset'],
    ['cancel the timer', 'timer', 'close'],
    ['how long is left', 'timer', 'read'],
    ['stop the stopwatch', 'stopwatch', 'pause'],
    ['reset the stopwatch', 'stopwatch', 'reset'],
    ['how long has it been', 'stopwatch', 'read'],
    ['cancel the alarm', 'alarm', 'close'],
    ['what alarms are set', 'alarm', 'list'],
    ['which alarms are set', 'alarm', 'list'],
    ['are there any alarms', 'alarm', 'list'],
  ])('%s is %s/%s', (phrase, capability, verb) => {
    expect(read(phrase)).toEqual({ capability, verb });
  });

  /**
   * "Stop the stopwatch" means hold it so the reading can be read. Throwing
   * the reading away is the one thing the person who timed something does not
   * want, so 'stop' is a pause here and cancelling needs saying outright.
   */
  it('stopping a stopwatch holds it rather than discarding the reading', () => {
    expect(read('stop the stopwatch')?.verb).toBe('pause');
    expect(read('cancel the stopwatch')?.verb).toBe('close');
  });
});

describe('without naming it', () => {
  it('acts on whatever is in focus', () => {
    expect(read('stop it', 'timer')).toEqual({ capability: 'timer', verb: 'pause' });
    expect(read('cancel that', 'timer')).toEqual({ capability: 'timer', verb: 'close' });
    expect(read('stop it', 'stopwatch')).toEqual({ capability: 'stopwatch', verb: 'pause' });
    expect(read('reset it', 'timer')).toEqual({ capability: 'timer', verb: 'reset' });
  });

  /** With nothing running, "stop it" is still the abort it has always been. */
  it('is an abort when nothing is running', () => {
    expect(read('stop it')).toBeNull();
    expect(read('cancel that')).toBeNull();
  });

  /**
   * The guard on the change that made the above work. "Never mind" is an
   * abort in every context - a timer being in focus must not turn a change of
   * mind into a command.
   */
  it('leaves a genuine change of mind alone', () => {
    expect(read('never mind', 'timer')).toBeNull();
    expect(read('forget it', 'timer')).toBeNull();
    expect(read('never mind')).toBeNull();
  });

  /** And a note in focus does not make "stop it" mean anything. */
  it('does not reach for something that is not running', () => {
    expect(read('stop it', 'notepad')).toBeNull();
  });
});
