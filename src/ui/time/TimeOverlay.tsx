import { useEffect, useRef, useState } from 'react';

/**
 * The time, read from the machine and from nowhere else.
 *
 * WHERE THE NUMBER COMES FROM. `Date.now()`, every animation frame, in the
 * browser. No model is asked, nothing is estimated, nothing is cached and no
 * timestamp is stored. A language model cannot know the time - it has no clock
 * - and a model that answers the question anyway is inventing a number that
 * looks exactly like a real one. This component exists so that question never
 * reaches one.
 *
 * ON PRECISION, AND NOT CLAIMING MORE THAN THERE IS. Milliseconds are shown
 * because the clock genuinely reports them, but browsers deliberately coarsen
 * `Date.now()` as a side-channel defence - commonly to 1ms, and to much less
 * in some configurations. So the resolution is *measured* at mount rather than
 * assumed, and the display says what it found. Showing three digits that only
 * ever move in steps of five would be a precision claim the machine cannot
 * support, which is the one thing this screen must not do.
 *
 * ON COST. One `requestAnimationFrame` loop, which the browser already runs
 * and which stops by itself when the tab is hidden. No timer at millisecond
 * resolution, no polling, no network. The frame rate bounds how often the
 * digits are read; the clock itself is exact at the moment it is read.
 */

/**
 * How many samples to take when measuring the clock's real resolution.
 *
 * Enough to see the step size between distinct readings, cheap enough to run
 * once at mount without being noticeable.
 */
const RESOLUTION_SAMPLES = 2000;

/**
 * The smallest gap the clock actually reports, in milliseconds.
 *
 * Measured by reading it in a tight loop and recording the smallest non-zero
 * difference between consecutive distinct values. A browser that coarsens to
 * 1ms gives 1; one that coarsens further gives that larger number, and the
 * display then says so rather than implying a precision that is not there.
 */
export function measureClockResolution(now: () => number = Date.now): number {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = now();

  for (let i = 0; i < RESOLUTION_SAMPLES; i += 1) {
    const current = now();
    const step = current - previous;
    if (step > 0 && step < smallest) smallest = step;
    previous = current;
  }

  return Number.isFinite(smallest) ? smallest : 1;
}

/** Two digits, always. */
const pad2 = (value: number): string => String(value).padStart(2, '0');

export interface TimeOverlayProps {
  onClose: () => void;
}

export function TimeOverlay({ onClose }: TimeOverlayProps) {
  const [now, setNow] = useState<Date>(() => new Date());
  const [resolution, setResolution] = useState<number | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /**
   * The loop. Reads the system clock each frame and nothing else.
   *
   * requestAnimationFrame rather than a 1ms interval: the browser is already
   * painting at the display's rate, a timer faster than that cannot produce a
   * visible change, and a 1ms interval on a machine with no GPU is a
   * measurable amount of someone's CPU spent on digits nobody can read.
   */
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      setNow(new Date());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Measured once, after the first paint, so the clock is on screen
  // immediately rather than waiting on a benchmark.
  useEffect(() => {
    const idle = window.setTimeout(() => setResolution(measureClockResolution()), 0);
    return () => window.clearTimeout(idle);
  }, []);

  // Escape closes, as it does everywhere else in Helix.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const milliseconds = now.getMilliseconds();

  return (
    <div className="hx-time" role="dialog" aria-label="The time">
      {/* Clicking anywhere dismisses. Nothing here changes anything, so
          leaving costs nothing and needs no confirmation. */}
      <button type="button" className="hx-time__scrim" aria-label="Close the clock" onClick={onClose} />

      <div className="hx-time__face">
        <div
          className="hx-time__clock"
          aria-label={`${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`}
        >
          <span className="hx-time__unit">{pad2(now.getHours())}</span>
          {/*
            Drawn, not typed. A colon at this weight came out of the font
            stack as a tofu box, and two dots are what a colon is anyway.
          */}
          <span className="hx-time__colon" aria-hidden="true" />
          <span className="hx-time__unit">{pad2(now.getMinutes())}</span>
          <span className="hx-time__colon" aria-hidden="true" />
          <span className="hx-time__unit">{pad2(now.getSeconds())}</span>
          <span className="hx-time__ms">{String(milliseconds).padStart(3, '0')}</span>
        </div>

        <div className="hx-time__date">
          {now.toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </div>

        {/*
          What this number is, and how good it is. Said plainly because the
          alternative - three digits racing with no explanation - implies a
          precision the machine may not have.
        */}
        <div className="hx-time__source">
          <span>System clock</span>
          <span className="hx-time__dot" aria-hidden="true" />
          <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          {resolution !== null && (
            <>
              <span className="hx-time__dot" aria-hidden="true" />
              <span>
                {resolution <= 1
                  ? 'to the millisecond'
                  : `this browser reports it in ${resolution}ms steps`}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
