/**
 * The reactor: what Helix can actually do, drawn as a ring.
 *
 * A HUD is where invented telemetry creeps into a project. Spinning numbers,
 * power levels, a CPU gauge that is really a sine wave - they look like the
 * reference and they mean nothing, and once one dial is decorative a user has
 * no way to know which of the others are real.
 *
 * So every segment on this ring maps to one subsystem whose availability is
 * measured elsewhere and passed in, and carries the reason in words. Nothing
 * here is computed for effect. If a segment is dark, something is genuinely
 * switched off, and the ring says which and why.
 *
 * Three states rather than two, because "works" and "does not work" cannot
 * describe browser speech recognition: it works perfectly and sends your audio
 * to Google. That belongs in its own state with the caveat attached, not
 * quietly filed under working.
 */

export type SegmentState = 'ready' | 'caveat' | 'unavailable';

export interface ReactorSegment {
  id: string;
  /** Drawn beside the ring, so colour is never the only signal. */
  label: string;
  state: SegmentState;
  /** Why it is in that state. Always present; shown on hover and to readers. */
  reason: string;
}

export interface ReactorInput {
  online: boolean;
  languageProvider: string;
  /** From VoiceManager, which knows what is actually loadable in this build. */
  hearingBlocker: string | null;
  hearingProvider: string;
  speechBlocker: string | null;
  visionProvider: string;
  gestureProvider: string;
  memoryAllowed: boolean;
  /** False when storage is session-only, e.g. private browsing. */
  durableStorage: boolean;
  projectCount: number;
  searchableFiles: number;
}

/**
 * Turn measured state into the ring.
 *
 * The order is fixed, so a segment does not move between renders - a dial that
 * changes position is unreadable at a glance.
 */
export function reactorSegments(input: ReactorInput): ReactorSegment[] {
  return [
    {
      id: 'reason',
      label: 'REASONING',
      // Never "ready": a model is selected, but nothing connects to it, and a
      // lit segment here would promise an answer Helix cannot produce.
      ...(input.languageProvider === 'none'
        ? { state: 'unavailable' as const, reason: 'No language provider selected.' }
        : {
            state: 'unavailable' as const,
            reason: 'A provider is selected, but the connection is not built and no key is held.',
          }),
    },
    {
      id: 'hearing',
      label: 'HEARING',
      ...hearingState(input),
    },
    {
      id: 'speech',
      label: 'SPEECH',
      ...(input.speechBlocker === null
        ? { state: 'ready' as const, reason: 'Speech output is available.' }
        : { state: 'unavailable' as const, reason: input.speechBlocker }),
    },
    {
      id: 'sight',
      label: 'SIGHT',
      ...(input.visionProvider === 'none'
        ? { state: 'unavailable' as const, reason: 'No vision provider selected.' }
        : {
            state: 'unavailable' as const,
            reason: 'A provider is selected, but no vision provider is implemented yet.',
          }),
    },
    {
      id: 'hands',
      label: 'HANDS',
      ...(input.gestureProvider === 'none'
        ? { state: 'unavailable' as const, reason: 'Hand tracking is switched off.' }
        : {
            state: 'caveat' as const,
            reason: 'MediaPipe runs on this machine, and needs the camera switched on.',
          }),
    },
    {
      id: 'memory',
      label: 'MEMORY',
      ...memoryState(input),
    },
    {
      id: 'files',
      label: 'FILES',
      ...filesState(input),
    },
    {
      id: 'reach',
      label: 'REACH',
      // Not a missing key, and not a setting: the page cannot reach an outside
      // origin at all. Stating it as "not configured" would invite someone to
      // go looking for a configuration that would not help.
      state: 'unavailable',
      reason: input.online
        ? "The machine is online, but this build cannot reach any outside origin - connect-src is 'self'."
        : 'Offline, and this build could not reach an outside origin in any case.',
    },
  ];
}

function hearingState(input: ReactorInput): { state: SegmentState; reason: string } {
  if (input.hearingBlocker !== null) {
    return { state: 'unavailable', reason: input.hearingBlocker };
  }
  if (input.hearingProvider === 'browser') {
    return {
      state: 'caveat',
      reason: 'Browser speech works, and sends your audio to Google to do it.',
    };
  }
  return { state: 'ready', reason: 'Whisper, running on this machine. No audio leaves it.' };
}

function memoryState(input: ReactorInput): { state: SegmentState; reason: string } {
  if (!input.memoryAllowed) {
    return { state: 'unavailable', reason: 'Long-term memory is switched off in Settings.' };
  }
  if (!input.durableStorage) {
    return {
      state: 'caveat',
      reason: 'Storage is session-only here, so anything kept is lost when this tab closes.',
    };
  }
  return { state: 'ready', reason: 'Kept on this machine, and only what you ask for.' };
}

function filesState(input: ReactorInput): { state: SegmentState; reason: string } {
  if (input.projectCount === 0) {
    return { state: 'unavailable', reason: 'No projects yet, so there is nothing to search.' };
  }
  if (input.searchableFiles === 0) {
    return {
      state: 'caveat',
      reason: 'Projects exist, but no file has yielded searchable text yet.',
    };
  }
  return { state: 'ready', reason: 'Indexed and searchable, without a model or a network.' };
}

/* ------------------------------------------------------------------ */
/* Geometry. Separated out because arc maths fails silently: a wrong  */
/* sweep flag draws a plausible ring that is subtly inside out.       */
/* ------------------------------------------------------------------ */

export interface Point {
  x: number;
  y: number;
}

/** Degrees, clockwise from twelve o'clock, which is how the ring is read. */
export function polarToCartesian(cx: number, cy: number, radius: number, degrees: number): Point {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

export interface SegmentAngle {
  start: number;
  end: number;
}

/**
 * Evenly divide the circle, leaving a gap between segments.
 *
 * The gap is taken out of each segment rather than added between them, so the
 * ring always closes at exactly 360 degrees however many segments there are.
 */
export function segmentAngles(count: number, gapDegrees = 6): SegmentAngle[] {
  if (count <= 0) return [];

  const step = 360 / count;
  const gap = Math.min(gapDegrees, step * 0.6);

  return Array.from({ length: count }, (_, index) => ({
    start: index * step + gap / 2,
    end: (index + 1) * step - gap / 2,
  }));
}

/**
 * An SVG arc along a circle, for stroking. Not a filled wedge: the ring is a
 * stroke so its width is one number to change rather than two radii to keep
 * in step.
 */
export function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startDegrees: number,
  endDegrees: number,
): string {
  const start = polarToCartesian(cx, cy, radius, startDegrees);
  const end = polarToCartesian(cx, cy, radius, endDegrees);
  const largeArc = endDegrees - startDegrees > 180 ? 1 : 0;

  return [
    'M',
    round(start.x),
    round(start.y),
    'A',
    round(radius),
    round(radius),
    0,
    largeArc,
    1,
    round(end.x),
    round(end.y),
  ].join(' ');
}

/** Two decimal places: enough for sub-pixel accuracy, short enough to read. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
