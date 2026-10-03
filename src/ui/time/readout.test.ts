import { describe, expect, it } from 'vitest';
import { countdownReadout, elapsedReadout } from './readout.js';

describe('countdownReadout', () => {
  it('reads minutes and seconds, and adds hours only when there are some', () => {
    expect(countdownReadout(5 * 60_000).main).toBe('05:00');
    expect(countdownReadout(90_000).main).toBe('01:30');
    expect(countdownReadout(3_600_000).main).toBe('01:00:00');
  });

  /**
   * The bug this rounding exists to prevent. Truncating leaves a ten-second
   * timer showing 00:00 for a full second before it rings, so it looks like
   * it finished at nine and then hung.
   */
  it('rounds up, so it reaches zero exactly when the timer does', () => {
    expect(countdownReadout(10_000).main).toBe('00:10');
    expect(countdownReadout(9_300).main).toBe('00:10');
    expect(countdownReadout(1).main).toBe('00:01');
    expect(countdownReadout(0).main).toBe('00:00');
  });

  it('never shows a negative time', () => {
    expect(countdownReadout(-5_000).main).toBe('00:00');
    expect(countdownReadout(-5_000).fraction).toBe('00');
  });

  it('shows hundredths', () => {
    expect(countdownReadout(90_250).fraction).toBe('25');
  });
});

describe('elapsedReadout', () => {
  /** A stopwatch at 4.9 seconds has not reached five. Rounding up would show
      a time that has not happened. */
  it('truncates, unlike the countdown', () => {
    expect(elapsedReadout(4_900).main).toBe('00:04');
    expect(elapsedReadout(0).main).toBe('00:00');
    expect(elapsedReadout(59_999).main).toBe('00:59');
    expect(elapsedReadout(60_000).main).toBe('01:00');
  });

  it('adds hours once there are some', () => {
    expect(elapsedReadout(3_661_000).main).toBe('01:01:01');
  });

  it('shows hundredths', () => {
    expect(elapsedReadout(1_234).fraction).toBe('23');
  });
});
