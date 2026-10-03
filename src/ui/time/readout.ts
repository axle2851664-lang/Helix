/**
 * Turning a span of milliseconds into the digits on the clock face.
 *
 * Pure and separate from the component, because a readout that is wrong by a
 * second at the boundary is the kind of thing nobody notices in review and
 * everybody notices on screen.
 */

export interface Readout {
  /** The large part: HH:MM:SS, or MM:SS when there is no hour to show. */
  main: string;
  /** The small part beneath - hundredths, or milliseconds. */
  fraction: string;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * A countdown, as a timer reads.
 *
 * Rounded up, not down, which is the whole subtlety here. A timer with 4.3
 * seconds left reads "4" if you truncate - so it shows 0 for a whole second
 * before it rings, and a ten-second timer appears to finish at nine. Ceiling
 * means the display changes to 0 exactly when the timer is done.
 */
export function countdownReadout(remainingMs: number): Readout {
  const clamped = Math.max(0, remainingMs);
  const seconds = Math.ceil(clamped / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return {
    main: hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`
      : `${pad(minutes)}:${pad(seconds % 60)}`,
    // Counting down, so the hundredths run down too - 99 to 00 within the
    // second. Truncating here would make it read 00 for the first hundredth
    // of every second while the seconds digit had not changed yet.
    fraction: pad(Math.floor((clamped % 1000) / 10)),
  };
}

/**
 * Time elapsed, as a stopwatch reads.
 *
 * Truncated, unlike the countdown: a stopwatch at 4.9 seconds has not reached
 * five, and rounding up would have it show a time that has not happened.
 */
export function elapsedReadout(elapsedMs: number): Readout {
  const clamped = Math.max(0, elapsedMs);
  const total = Math.floor(clamped / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  return {
    main: hours > 0
      ? `${pad(hours)}:${pad(minutes)}:${pad(total % 60)}`
      : `${pad(minutes)}:${pad(total % 60)}`,
    fraction: pad(Math.floor((clamped % 1000) / 10)),
  };
}
