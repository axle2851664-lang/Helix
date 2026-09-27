import { useEffect, useRef } from 'react';
import type { ReactorSegment, SegmentState } from './capabilities.js';

/**
 * The sphere at the centre of the screen, drawn as a field of points.
 *
 * It is not decoration, and that distinction is the whole design of this
 * file. `capabilities.ts` opens with a warning worth repeating: a HUD is
 * where invented telemetry creeps into a project - spinning numbers, power
 * levels, a gauge that is really a sine wave - and once one dial is made up,
 * nobody can tell which of the others are real.
 *
 * So every point here belongs to one subsystem. The sphere is divided into
 * latitude bands, one per capability, and a band is bright when that
 * subsystem genuinely works, half-lit when it works with a caveat, and nearly
 * dark when it does not. A dim sphere means Helix can do little; a bright one
 * means it can do a lot. Nothing is computed for effect.
 *
 * The two movements are also measurements. The slow turn is the only thing
 * that is merely time passing; the swell is the microphone, and it moves only
 * while Helix is genuinely listening - an idle animation that looked like
 * input would be the same lie as a fake gauge, told more subtly.
 *
 * On cost: this machine has no usable GPU and a CPU that manages single-digit
 * tokens a second, so the frame rate is capped and the point count is modest.
 * A canvas that repaints sixty times a second would be taking cycles from the
 * only thing on screen that matters.
 */

/** Enough to read as a surface, few enough to cost nothing. */
const POINTS = 900;

/** Twenty-four is smooth for a slow rotation and 60% of the work of forty. */
const FRAME_MS = 1000 / 24;

/** One full turn. Slow enough to notice only if you look. */
const TURN_MS = 48_000;

const BRIGHTNESS: Readonly<Record<SegmentState, number>> = {
  ready: 1,
  caveat: 0.52,
  unavailable: 0.16,
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
      grain: 0.55 + ((Math.sin(index * 12.9898) * 43758.5453) % 1 + 1) / 2 * 0.45,
    });
  }

  return points;
}

interface SphereFieldProps {
  segments: readonly ReactorSegment[];
  /** 0..1, measured. Only used while listening. */
  level: number;
  listening: boolean;
  reduceMotion: boolean;
  size?: number;
}

export function SphereField({
  segments,
  level,
  listening,
  reduceMotion,
  size = 300,
}: SphereFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live values read inside the animation loop, so changing them does not
  // tear down and rebuild the loop on every render.
  const live = useRef({ segments, level, listening, reduceMotion });
  live.current = { segments, level, listening, reduceMotion };

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
    const radius = size * 0.37;
    const points = lattice(POINTS, Math.max(1, live.current.segments.length));

    let frame = 0;
    let last = 0;
    let smoothed = 0;
    const started = performance.now();

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      last = now;

      const { segments: current, level: mic, listening: hearing, reduceMotion: still } =
        live.current;

      // Eased, so the surface breathes with the voice instead of flickering
      // on every sample.
      const target = hearing ? Math.min(1, Math.max(0, mic * 6)) : 0;
      smoothed += (target - smoothed) * 0.18;

      const turn = still ? 0.6 : ((now - started) / TURN_MS) * Math.PI * 2;
      const tilt = -0.28;
      const swell = 1 + smoothed * 0.07;

      context.clearRect(0, 0, size, size);

      for (const point of points) {
        // Rotate about the vertical axis, then tilt the pole towards us.
        const x = point.x * Math.cos(turn) - point.z * Math.sin(turn);
        const z = point.x * Math.sin(turn) + point.z * Math.cos(turn);
        const y = point.y * Math.cos(tilt) - z * Math.sin(tilt);
        const depth = point.y * Math.sin(tilt) + z * Math.cos(tilt);

        const segment = current[point.band];
        const lit = segment ? BRIGHTNESS[segment.state] : BRIGHTNESS.unavailable;

        // Points on the far side stay, faintly. A sphere with a hollow back
        // reads as a bowl.
        const facing = (depth + 1) / 2;
        const alpha = lit * point.grain * (0.16 + facing * 1.05) * (facing < 0.5 ? 0.4 : 1);
        if (alpha < 0.02) continue;

        const screenX = centre + x * radius * swell;
        const screenY = centre + y * radius * swell;
        const dot = 0.55 + facing * 0.85;

        context.globalAlpha = Math.min(1, alpha);
        context.fillStyle = '#ffffff';
        context.beginPath();
        context.arc(screenX, screenY, dot, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className="hx-sphere"
      style={{ width: size, height: size }}
      // The ring beside it already carries every segment in words, and the
      // hidden list repeats them. Another copy here would be read aloud twice.
      aria-hidden="true"
    />
  );
}
