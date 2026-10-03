import { useCallback, useEffect, useRef, useState } from 'react';

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
 * in some configurations. So the resolution is *measured* at mount, and a note
 * appears only when the clock is coarser than the three digits imply. When it
 * is genuinely accurate to the millisecond the screen says nothing, because
 * then there is nothing to warn about and the layout is meant to be bare.
 *
 * ON COST. One `requestAnimationFrame` loop, which the browser already runs
 * and which stops by itself when the tab is hidden. No timer at millisecond
 * resolution, no polling, no network. The frame rate bounds how often the
 * digits are read; the clock itself is exact at the moment it is read.
 *
 * ON THE LAYOUT. A built layout, not a widget: the time dominates the screen,
 * milliseconds sit under it as a clearly secondary line, then the day, the
 * date and the zone, each smaller than the last. No card, no panel, no
 * border. The interface behind stays faintly visible - dimmed, not erased -
 * so the clock reads as Helix having turned itself into a time display rather
 * than as a window that opened on top of one.
 */

/**
 * How many samples to take when measuring the clock's real resolution.
 *
 * Enough to see the step size between distinct readings, cheap enough to run
 * once at mount without being noticeable.
 */
const RESOLUTION_SAMPLES = 2000;

/**
 * How long the exit takes. Must match `hx-time-out` in the stylesheet, which
 * is why it is a named constant rather than a number in two places: when they
 * disagree the overlay either unmounts mid-animation or lingers after it.
 */
const EXIT_MS = 260;

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

/**
 * Does this machine show time on a twelve-hour clock?
 *
 * Read from the system's own locale rather than from a Helix setting, because
 * there is no Helix setting and inventing one would be a second place to
 * answer a question the operating system has already answered. `hourCycle` is
 * the modern field; `hour12` is checked too because not every engine fills it
 * in, and a missing answer must not silently become "no".
 */
export function systemPrefers12Hour(
  resolved: () => Intl.ResolvedDateTimeFormatOptions = () =>
    Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions(),
): boolean {
  try {
    const options = resolved();
    if (options.hour12 !== undefined) return options.hour12;
    return options.hourCycle === 'h12' || options.hourCycle === 'h11';
  } catch {
    // An engine that cannot answer gets the 24-hour reading, which is the
    // unambiguous one.
    return false;
  }
}

/**
 * The timezone, named the way a person would name it.
 *
 * "Pacific Time", not "America/Los_Angeles" and not "GMT-7". The long name
 * includes whether daylight saving is in force - "Pacific Daylight Time" -
 * which is true but is the sort of technical detail this screen is meant to
 * leave out, so the season word is dropped and the rest is kept as the
 * platform gave it. Nothing is substituted or guessed: if no name comes back,
 * the line is simply absent.
 */
export function friendlyZoneName(
  at: Date = new Date(),
  format: (date: Date) => string = (date) =>
    new Intl.DateTimeFormat(undefined, { timeZoneName: 'long' }).format(date),
): string | null {
  let named: string;
  try {
    named = format(at);
  } catch {
    return null;
  }

  // The zone name is the tail of the formatted string, after the date part.
  const match = /(?:,\s*|\s)([A-Za-z][^,]*(?:Time|Zone|Zeit|Hora|Heure)[^,]*)$/.exec(named);
  const zone = match?.[1]?.trim();
  if (!zone) return null;

  // "Pacific Daylight Time" and "Pacific Standard Time" are the same zone to
  // anyone reading a clock.
  return zone.replace(/\s+(Daylight|Standard|Summer)\s+/i, ' ');
}

export interface TimeOverlayProps {
  onClose: () => void;
}

export function TimeOverlay({ onClose }: TimeOverlayProps) {
  const [now, setNow] = useState<Date>(() => new Date());
  const [resolution, setResolution] = useState<number | null>(null);
  /** True once the exit has begun. The overlay stays mounted through it. */
  const [leaving, setLeaving] = useState(false);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /**
   * Begin the exit, then unmount.
   *
   * The entrance is a sequence, so the departure is one too - reversed and
   * quicker, because a screen being dismissed should not make the user wait
   * for choreography. Guarded against running twice: a click on the scrim
   * followed by Escape would otherwise schedule two unmounts.
   */
  const leave = useCallback(() => {
    setLeaving((already) => {
      if (already) return already;
      window.setTimeout(() => closeRef.current(), EXIT_MS);
      return true;
    });
  }, []);

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
        leave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leave]);

  const twelveHour = systemPrefers12Hour();
  const hours24 = now.getHours();
  // 12, not 0, at midnight and noon.
  const hours = twelveHour ? hours24 % 12 || 12 : hours24;
  const suffix = twelveHour ? (hours24 < 12 ? 'AM' : 'PM') : null;

  const clock = `${pad2(hours)}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const zone = friendlyZoneName(now);

  return (
    <div
      className={`hx-time${leaving ? ' hx-time--leaving' : ''}`}
      role="dialog"
      aria-label="The time"
    >
      {/* Clicking anywhere dismisses. Nothing here changes anything, so
          leaving costs nothing and needs no confirmation. */}
      <button type="button" className="hx-time__scrim" aria-label="Close the clock" onClick={leave} />

      <div className="hx-time__face">
        {/*
          One accessible string for the whole reading. A screen reader
          announcing six separate digit groups as they tick is unusable, so
          the parts are hidden and the row speaks once.
        */}
        <div
          className="hx-time__clock"
          aria-label={suffix === null ? clock : `${clock} ${suffix}`}
          role="timer"
        >
          <span className="hx-time__unit" aria-hidden="true">{pad2(hours)}</span>
          {/*
            Drawn, not typed. A colon at this weight came out of the font
            stack as a tofu box, and two dots are what a colon is anyway.
          */}
          <span className="hx-time__colon" aria-hidden="true" />
          <span className="hx-time__unit" aria-hidden="true">{pad2(now.getMinutes())}</span>
          <span className="hx-time__colon" aria-hidden="true" />
          <span className="hx-time__unit" aria-hidden="true">{pad2(now.getSeconds())}</span>
          {suffix !== null && (
            <span className="hx-time__suffix" aria-hidden="true">{suffix}</span>
          )}
        </div>

        {/*
          Its own line, under the clock and much smaller: the hierarchy is the
          point. These digits are not part of the time, they are how precisely
          it is known, and running them inline at full size made the row look
          like a nine-digit number.

          aria-hidden, and not for brevity: three digits changing every frame
          is an endless stream of announcements in a screen reader, and the
          figure is already covered by the clock's own label.
        */}
        <div className="hx-time__ms" aria-hidden="true">
          {String(now.getMilliseconds()).padStart(3, '0')}
        </div>

        <div className="hx-time__when">
          <div className="hx-time__day">
            {now.toLocaleDateString(undefined, { weekday: 'long' })}
          </div>
          <div className="hx-time__date">
            {now.toLocaleDateString(undefined, {
              month: 'long',
              day: '2-digit',
              year: 'numeric',
            })}
          </div>
          {zone !== null && <div className="hx-time__zone">{zone}</div>}
        </div>

        {/*
          Only when the three digits above would be overstating things. A
          browser that reports the clock in 100ms steps shows a number that
          moves in jumps, and saying so is the difference between a measured
          figure and a decorative one. Silent in the ordinary case, because
          the ordinary case needs no footnote and this screen is meant to be
          bare.
        */}
        {resolution !== null && resolution > 1 && (
          <div className="hx-time__caveat">
            this system reports the clock in {resolution}ms steps
          </div>
        )}
      </div>
    </div>
  );
}
