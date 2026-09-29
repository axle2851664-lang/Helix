import { useEffect, useRef } from 'react';
import type { ReactorSegment, SegmentState } from './capabilities.js';

/**
 * The core: the only thing on the home screen.
 *
 * What was here before was a sphere inside a segmented capability ring, inside
 * a four-corner HUD, above a title, a subtitle and a row of suggestion chips.
 * All of it is gone. The brief was for a screen whose primary element is the
 * sphere and which carries no permanent dashboards, and a ring of arcs around
 * the sphere is a permanent dashboard drawn in a circle.
 *
 * The measurements did not go with the chrome. Every point on the sphere still
 * belongs to one subsystem - the lattice is divided into latitude bands, one
 * per capability - and a band is bright when that subsystem genuinely works,
 * half-lit when it works with a caveat, and nearly dark when it does not. A
 * dim sphere still means Helix can do little. What changed is that the reading
 * is now *in* the sphere rather than in a gauge beside it, and the words that
 * explain it are a click away in Diagnostics rather than permanently on
 * screen.
 *
 * THE AURA AND WHAT IT IS ALLOWED TO MEAN
 *
 * `capabilities.ts` opens with a warning this file has to honour: a HUD is
 * where invented telemetry creeps into a project, and once one dial is made
 * up, nobody can tell which of the others are real. An aura is exactly the
 * sort of thing that goes wrong that way - a glow that swells and settles
 * looks like it is reporting something.
 *
 * So the aura reports state and nothing else. Its brightness and its rhythm
 * are a function of which of six states Helix is in, and those six are
 * genuinely distinct things the rest of the program already knows. It never
 * encodes a magnitude, because there is no magnitude here that has been
 * measured. The one thing that does move with a measurement is the swell, and
 * the swell only moves for two reasons:
 *
 *   listening - the microphone level, from the provider that measures it.
 *   speaking  - word onsets, from the speech synthesiser's boundary events.
 *
 * Both are real events from the audio path. In the other four states the
 * swell is zero, and the sphere only breathes. An idle animation that looked
 * like input would be the same lie as a fake gauge, told more quietly.
 *
 * ON COST
 *
 * This machine has no usable GPU and a CPU that manages single-digit tokens a
 * second, so the frame rate is capped, the point count is modest and the aura
 * is a sprite drawn once at mount and blitted. A canvas that repaints sixty
 * times a second would be taking cycles from the only thing on screen that
 * matters.
 */

/** What Helix is doing, which is the only thing the aura encodes. */
export type CoreState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'awaiting'
  | 'error';

/** Enough to read as a surface, few enough to cost nothing. */
const POINTS = 900;

/** Twenty-four is smooth for a slow rotation and 60% of the work of forty. */
const FRAME_MS = 1000 / 24;

/** One full turn. Slow enough to notice only if you look. */
const TURN_MS = 48_000;

/**
 * The resting radius, as a fraction of the canvas.
 *
 * Deliberately small. It was 0.37, which left no room above it: the swell had
 * nowhere to go and clipped flat at the edge of the canvas, so growing while
 * speaking simply did not read. At 0.26 the sphere sits well inside its own
 * frame and the full swell fits.
 */
const REST_RADIUS = 0.26;

/** How much the sphere grows at full swell. Visible across the room. */
const SWELL = 0.34;

/**
 * The size of the core, as fractions of the canvas, at a given swell.
 *
 * Exported and pure because the one thing that has to be true here is
 * arithmetic rather than taste: at full swell, both the sphere and the aura
 * must still fit inside the canvas. This was got wrong before - the sphere was
 * drawn at 0.37 of the canvas and the swell had nowhere to go, so it clipped
 * flat against the edge and growing while speaking simply did not read. A
 * measurement caught it and an assertion now keeps it caught.
 */
export function coreGeometry(size: number, swell: number): { radius: number; aura: number } {
  const held = Math.min(1, Math.max(0, swell));
  return {
    radius: size * REST_RADIUS * (1 + held * SWELL),
    // Always larger than the sphere and never larger than the canvas, so the
    // glow reads as coming from behind the surface rather than as a disc
    // sitting on it.
    aura: size * (0.78 + 0.22 * held),
  };
}

const BRIGHTNESS: Readonly<Record<SegmentState, number>> = {
  ready: 1,
  caveat: 0.52,
  unavailable: 0.16,
};

/**
 * How each state moves, as data rather than as a switch buried in the loop.
 *
 * `aura` is the resting brightness of the glow. `pulse` is its period in
 * milliseconds, or null for a glow that does not pulse at all. `depth` is how
 * far the pulse travels, `spin` multiplies the rotation, and `lit` scales the
 * whole sphere.
 *
 * Written out because the six states have to be told apart at a glance, and a
 * table is the only way to see that they actually differ.
 */
export const MOTION: Readonly<
  Record<CoreState, { aura: number; pulse: number | null; depth: number; spin: number; lit: number }>
> = {
  // Barely there. The screen at rest should look like nothing is happening,
  // because nothing is.
  idle: { aura: 0.34, pulse: 11_000, depth: 0.22, spin: 1, lit: 1 },
  // Open and waiting. Brighter than idle so that a microphone which is live is
  // never mistaken for one that is not.
  listening: { aura: 0.72, pulse: null, depth: 0, spin: 1, lit: 1 },
  // Working it out: a slow, deep swell. Unhurried on purpose - a fast pulse
  // here reads as urgency, and thinking is not urgent.
  thinking: { aura: 0.56, pulse: 2600, depth: 0.5, spin: 1.6, lit: 1 },
  // Doing something: faster and shallower, a machine running rather than
  // deliberating. This is the state that must never be confused with the one
  // above, because one of them has already started changing things.
  executing: { aura: 0.7, pulse: 1100, depth: 0.3, spin: 2.4, lit: 1 },
  // Talking. The rhythm comes from the words, so the base does not pulse.
  speaking: { aura: 0.78, pulse: null, depth: 0, spin: 1.2, lit: 1 },
  // Stopped, and waiting on an answer. Held bright and completely still: the
  // stillness is what distinguishes it from thinking, which is the mistake
  // that matters - one of them will carry on by itself and one of them will
  // not.
  awaiting: { aura: 0.8, pulse: null, depth: 0, spin: 0, lit: 1 },
  // Stopped. Dim and entirely still: the absence of motion is the signal, and
  // it survives on a monochrome screen and for anyone who cannot see the
  // difference in brightness, because the state is also written in words.
  error: { aura: 0.14, pulse: null, depth: 0, spin: 0, lit: 0.45 },
};

interface Point {
  x: number;
  y: number;
  z: number;
  /** Index of the capability band this point belongs to. */
  band: number;
  /** Fixed per-point jitter, so the surface reads as texture not as a grid. */
  grain: number;
}

/**
 * A Fibonacci lattice: the standard way to scatter points evenly on a sphere.
 *
 * Random points clump, and a latitude/longitude grid crowds at the poles.
 * Neither looks like a surface. This gives an even, slightly irregular field,
 * which is what makes it read as texture rather than as a wireframe.
 */
function lattice(count: number, bands: number): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Point[] = [];

  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;

    // Bands run pole to pole, so each subsystem owns a horizontal slice and
    // the sphere reads top to bottom as the capability list does.
    const band = Math.min(bands - 1, Math.floor(((1 - y) / 2) * bands));

    points.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
      band,
      grain: 0.55 + (((Math.sin(index * 12.9898) * 43758.5453) % 1) + 1) / 2 * 0.45,
    });
  }

  return points;
}

/**
 * The aura, drawn once into an offscreen canvas and then blitted.
 *
 * A radial gradient is expensive to build and cheap to copy, and this one
 * never changes shape - only its scale and its opacity move. Building it per
 * frame was the single most expensive thing in an early version of this file,
 * and it was not close.
 */
function auraSprite(diameter: number): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = diameter;
  sprite.height = diameter;

  const context = sprite.getContext('2d');
  if (!context) return sprite;

  const centre = diameter / 2;
  const gradient = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
  // The inner stops are what give it a core rather than a uniform fog; the
  // long tail is what stops it ending in a visible circular edge.
  gradient.addColorStop(0, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(0.28, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, diameter, diameter);
  return sprite;
}

export interface CoreProps {
  segments: readonly ReactorSegment[];
  state: CoreState;
  /**
   * 0..1, measured. The microphone while listening, word onsets while
   * speaking, and zero otherwise - never a number invented to make the sphere
   * move.
   */
  level: number;
  reduceMotion: boolean;
  onActivate: () => void;
  /** What pressing the core does, for anyone who cannot see it. */
  label: string;
  size?: number;
}

export function Core({
  segments,
  state,
  level,
  reduceMotion,
  onActivate,
  label,
  size = 420,
}: CoreProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live values read inside the animation loop, so changing them does not tear
  // down and rebuild the loop on every render.
  const live = useRef({ segments, state, level, reduceMotion });
  live.current = { segments, state, level, reduceMotion };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Capped at 2: beyond that the extra pixels cost real time and nobody can
    // see the difference on a field of one-pixel points.
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context.scale(ratio, ratio);

    const centre = size / 2;
    const points = lattice(POINTS, Math.max(1, live.current.segments.length));
    const sprite = auraSprite(Math.round(size));

    let frame = 0;
    let last = 0;
    let swell = 0;
    let spun = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      const elapsed = last === 0 ? FRAME_MS : now - last;
      last = now;

      const { segments: current, state: phase, level: measured, reduceMotion: still } =
        live.current;
      const motion = MOTION[phase];

      /**
       * The swell, and the reason it is asymmetric.
       *
       * It rises fast and falls slowly. A symmetric ease makes speech look
       * like a sine wave - the sphere is already shrinking by the time the
       * word lands. Rising in two frames and falling over ten makes each word
       * read as a distinct beat, which is what a word is.
       */
      const target =
        phase === 'listening' || phase === 'speaking'
          ? Math.min(1, Math.max(0, measured))
          : 0;
      swell += (target - swell) * (target > swell ? 0.4 : 0.08);

      // Integrated rather than derived from the clock, so a change of speed
      // never makes the sphere jump to a new angle.
      spun += still ? 0 : (elapsed / TURN_MS) * Math.PI * 2 * motion.spin;
      const turn = still ? 0.6 : spun;
      const tilt = -0.28;

      const beat =
        motion.pulse === null || still
          ? 0
          : (Math.sin((now / motion.pulse) * Math.PI * 2) + 1) / 2;
      const glow = Math.min(1, motion.aura * (1 - motion.depth / 2 + beat * motion.depth) + swell * 0.5);

      context.clearRect(0, 0, size, size);

      // The aura first, under everything. Scaled with the swell so the glow
      // and the surface move together rather than sliding past each other.
      const { radius, aura } = coreGeometry(size, swell);
      context.globalAlpha = glow;
      context.drawImage(sprite, centre - aura / 2, centre - aura / 2, aura, aura);

      for (const point of points) {
        // Rotate about the vertical axis, then tilt the pole towards us.
        const x = point.x * Math.cos(turn) - point.z * Math.sin(turn);
        const z = point.x * Math.sin(turn) + point.z * Math.cos(turn);
        const y = point.y * Math.cos(tilt) - z * Math.sin(tilt);
        const depth = point.y * Math.sin(tilt) + z * Math.cos(tilt);

        const segment = current[point.band];
        const lit = (segment ? BRIGHTNESS[segment.state] : BRIGHTNESS.unavailable) * motion.lit;

        // Points on the far side stay, faintly. A sphere with a hollow back
        // reads as a bowl.
        const facing = (depth + 1) / 2;
        const alpha = lit * point.grain * (0.16 + facing * 1.05) * (facing < 0.5 ? 0.4 : 1);
        if (alpha < 0.02) continue;

        context.globalAlpha = Math.min(1, alpha);
        context.fillStyle = '#ffffff';
        context.beginPath();
        context.arc(centre + x * radius, centre + y * radius, 0.55 + facing * 0.85, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return (
    <button
      type="button"
      className="hx-core"
      onClick={onActivate}
      aria-label={label}
      style={{ width: size, height: size }}
    >
      {/*
        Nothing here is readable, and what it encodes is said in words by the
        state line beneath it and in full in Diagnostics. Announcing a canvas
        would only interrupt.
      */}
      <canvas ref={canvasRef} className="hx-core__canvas" style={{ width: size, height: size }} aria-hidden="true" />
    </button>
  );
}
