import { useEffect, useRef } from 'react';

/**
 * The core: the only thing on the home screen.
 *
 * A sphere of points, wrapped in a contained field of golden-orange energy -
 * hundreds of particles on their own orbits, sparks that flare and die, wispy
 * arcs cutting across the shell, and thin lines spiralling out from the
 * surface into the dark. Chaotic up close, organised at a distance, because
 * every one of them is on a circular orbit and it is only the spread of radii,
 * inclinations and speeds that makes it look like turbulence.
 *
 * ON THE COLOUR. The rest of Havoc is monochrome, deliberately: the status
 * dots were turned to brightness so that no hue anywhere carries meaning on
 * its own. The core is now the single exception and the only coloured thing on
 * the screen, which is what makes it the focal point rather than merely the
 * largest object. Nothing about the colour encodes a fact - it is the same
 * gold in every state - so the monochrome rule it breaks is a stylistic one,
 * not the accessibility one.
 *
 * WHAT THE FIELD IS ALLOWED TO MEAN. `capabilities.ts` opens by warning that a
 * HUD is where invented telemetry creeps into a project, and once one dial is
 * made up nobody can tell which of the others are real. An energy field is not
 * a dial - nobody reads a spark as a number - but the rule behind the warning
 * still applies, so the field encodes exactly two things and neither is a
 * magnitude:
 *
 *   STATE, through the table in MOTION: how dense the field is, how fast it
 *   churns, how hot it burns, whether it pulses. Six states that a person can
 *   tell apart, from facts the program already holds and cannot fake.
 *
 *   SWELL, through the microphone while listening and word onsets while
 *   speaking. Both are real events from the audio path. In the other four
 *   states the swell is zero.
 *
 * The particles' own motion is not a measurement and does not pretend to be
 * one. It is weather.
 *
 * MEANWHILE THE SPHERE STILL REPORTS. Every point on the surface belongs to
 * one capability band, bright when that subsystem genuinely works and nearly
 * dark when it does not, exactly as it did when there was a ring of arcs
 * around it. A dim core inside a bright field still means Havoc can do little.
 *
 * ON COST. This machine has no usable GPU, so: the frame rate is capped at 24,
 * every orbit is precomputed into an orthonormal basis so a position is six
 * multiplies rather than three matrix rotations, particles are drawn with
 * fillRect rather than arc (which is several times faster for a two-pixel
 * dot), the glow and the sparks are sprites built once and blitted, and the
 * whole field is composited additively so overlapping orbits concentrate
 * brightness near the core for free rather than being shaded to.
 */

/** What Havoc is doing, which is the only state the field encodes. */
export type CoreState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'speaking'
  | 'awaiting'
  | 'error';

/** Points on the sphere's surface. Enough to read as a surface. */
const POINTS = 900;

/**
 * Particles in the field.
 *
 * Six hundred is where it stops reading as "some dots" and starts reading as a
 * medium. Below about three hundred the eye follows individual particles,
 * which turns the field into a mobile.
 */
export const PARTICLES = 900;

/** Wispy arcs cutting across the shell. */
export const ARCS = 34;

/** Segments per arc. Enough that a great-circle chord reads as a curve. */
const ARC_SEGMENTS = 9;

/** Thin lines spiralling out of the surface. */
export const SPIRALS = 18;

const SPIRAL_STEPS = 44;

/** Twenty-four is smooth for this and 60% of the work of forty. */
const FRAME_MS = 1000 / 24;

/** One full turn of the sphere. Slow enough to notice only if you look. */
const TURN_MS = 48_000;

/**
 * The resting radius of the sphere, as a fraction of the canvas.
 *
 * Small, and smaller than it was, because the canvas is now mostly field: the
 * particles reach out to 2.3 times this and have to fit, and the swell has to
 * have somewhere to go. An earlier version rested at 0.37 with nothing around
 * it, and the swell clipped flat against the edge - Havoc speaking produced no
 * visible change at all.
 */
const REST_RADIUS = 0.19;

/** How much the sphere grows at full swell. Visible across the room. */
const SWELL = 0.34;

/** How far out the field reaches, as a multiple of the core's rest radius. */
export const FIELD_REACH = 2.3;

/**
 * How much of the swell the field takes, where the sphere takes all of it.
 *
 * The sphere surges and the field around it barely moves. That is both the
 * better reading - the core pushing against something rather than the whole
 * picture zooming - and the thing that keeps the outermost particles inside
 * the canvas at full swell. An assertion caught the alternative: with the
 * field scaling with the sphere, the outer orbits ran 673px wide in a 560px
 * canvas and the faintest particles were being clipped away.
 */
const FIELD_SWELL = 0.3;

/**
 * The size of the core, as fractions of the canvas, at a given swell.
 *
 * Exported and pure because the one thing that has to be true here is
 * arithmetic rather than taste: at full swell the sphere and the whole field
 * around it must still fit inside the canvas.
 */
export function coreGeometry(
  size: number,
  swell: number,
): { radius: number; field: number; aura: number } {
  const held = Math.min(1, Math.max(0, swell));
  const rest = size * REST_RADIUS;
  // What the orbits are measured against. Barely moves - see FIELD_SWELL.
  const field = rest * (1 + held * SWELL * FIELD_SWELL);

  return {
    // The sphere, which takes the whole swell.
    radius: rest * (1 + held * SWELL),
    field,
    // The outer edge of the field: always well outside the sphere, never
    // outside the canvas.
    aura: field * FIELD_REACH * 2,
  };
}

export interface StateMotion {
  /** Resting brightness of the whole field. */
  aura: number;
  /** Pulse period in milliseconds, or null for a field that does not pulse. */
  pulse: number | null;
  /** How far the pulse travels. */
  depth: number;
  /** Multiplies the sphere's rotation. */
  spin: number;
  /** Scales the sphere's surface brightness. */
  lit: number;
  /**
   * Colour temperature, 0..1. One means white-gold; zero means a dim ember.
   * Never encodes a quantity - it separates a stopped core from a live one.
   */
  heat: number;
  /** Fraction of the particles drawn, so a quiet state is a sparser field. */
  density: number;
  /** Multiplies every orbital speed. */
  churn: number;
}

/**
 * How each state looks and moves, as data rather than as a switch buried in
 * the loop.
 *
 * Written out because the seven states have to be told apart at a glance, and
 * a table is the only way to see that they actually differ.
 */
export const MOTION: Readonly<Record<CoreState, StateMotion>> = {
  // Banked. The screen at rest should look like a system idling, not one
  // working: sparse, slow, warm rather than bright.
  idle: { aura: 0.74, pulse: 9000, depth: 0.2, spin: 1, lit: 1, heat: 0.62, density: 0.7, churn: 0.6 },
  // Open and waiting. Denser and brighter than idle, so a microphone that is
  // live is never mistaken for one that is not.
  listening: { aura: 0.95, pulse: null, depth: 0, spin: 1, lit: 1, heat: 0.82, density: 0.88, churn: 0.95 },
  // Working it out: a slow, deep swell through the whole field. Unhurried on
  // purpose - a fast pulse reads as urgency, and thinking is not urgent.
  thinking: { aura: 0.88, pulse: 2600, depth: 0.45, spin: 1.6, lit: 1, heat: 0.74, density: 0.82, churn: 1.3 },
  // Doing something: fast, dense and hot. This is the state that must never be
  // confused with the one above, because it has already started changing
  // things - so it differs in rhythm and speed, not only in brightness.
  executing: { aura: 1.05, pulse: 1100, depth: 0.28, spin: 2.4, lit: 1, heat: 0.95, density: 1, churn: 2.1 },
  // Talking. The rhythm comes from the words, so the field does not pulse
  // underneath them - a pulse mixed into a measured swell is an invented
  // signal the user cannot separate from the real one.
  speaking: { aura: 1.1, pulse: null, depth: 0, spin: 1.2, lit: 1, heat: 1, density: 1, churn: 1.1 },
  // Stopped, and waiting on an answer. Held bright and completely still. The
  // stillness is what separates it from thinking, which is the distinction
  // that matters: one of them will carry on by itself and one will not.
  awaiting: { aura: 0.98, pulse: null, depth: 0, spin: 0, lit: 1, heat: 0.86, density: 0.74, churn: 0 },
  // Failed. Dim, sparse, cold and entirely still - the absence of everything
  // is the signal, and it survives for anyone who cannot see the colour
  // because the state is also written in words beneath the core.
  error: { aura: 0.3, pulse: null, depth: 0, spin: 0, lit: 0.45, heat: 0.08, density: 0.34, churn: 0 },
};

/* ------------------------------------------------------------------ */
/* Colour                                                             */
/* ------------------------------------------------------------------ */

/**
 * The fire, from the middle outwards.
 *
 * White-gold at the surface through amber to a deep orange at the edge of the
 * field. `heat` pulls the whole ramp back towards a dull ember, which is what
 * makes a stopped core look stopped rather than merely dimmer.
 */
export function fire(t: number, heat: number): [number, number, number] {
  const held = Math.min(1, Math.max(0, t));
  // Three stops, interpolated. More would not be visible at this size.
  const stops: Array<[number, number, number]> = [
    [255, 244, 214],
    [255, 172, 68],
    [255, 104, 22],
  ];
  const span = held * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(span));
  const f = span - index;
  const a = stops[index] as [number, number, number];
  const b = stops[index + 1] as [number, number, number];

  const ember: [number, number, number] = [124, 52, 18];
  const warmth = Math.min(1, Math.max(0, heat));

  return [
    Math.round((a[0] + (b[0] - a[0]) * f) * warmth + ember[0] * (1 - warmth)),
    Math.round((a[1] + (b[1] - a[1]) * f) * warmth + ember[1] * (1 - warmth)),
    Math.round((a[2] + (b[2] - a[2]) * f) * warmth + ember[2] * (1 - warmth)),
  ];
}

const rgba = (c: [number, number, number], alpha: number): string =>
  `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;

/* ------------------------------------------------------------------ */
/* The shapes, precomputed once                                       */
/* ------------------------------------------------------------------ */

/**
 * A deterministic pseudo-random source.
 *
 * Seeded rather than Math.random so the field is identical on every mount.
 * A core that rearranged itself each time the screen was opened would read as
 * a redraw rather than as the same object still running.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Two perpendicular unit vectors spanning an orbital plane. */
interface Orbit {
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
}

/**
 * An orbital plane from two angles.
 *
 * Precomputed into a basis so that a position on the orbit costs six
 * multiplies and two adds, rather than building and applying two rotation
 * matrices per particle per frame.
 */
function orbit(inclination: number, node: number): Orbit {
  const ci = Math.cos(inclination);
  const si = Math.sin(inclination);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  return {
    ux: cn, uy: 0, uz: -sn,
    vx: sn * si, vy: ci, vz: cn * si,
  };
}

interface Particle extends Orbit {
  /** Multiple of the sphere's radius. */
  radius: number;
  /** Radians per millisecond. */
  speed: number;
  phase: number;
  size: number;
  /** How strongly this one flares, and how often. Zero for most of them. */
  flare: number;
  flareRate: number;
  flarePhase: number;
}

function makeParticles(count: number, random: () => number): Particle[] {
  const out: Particle[] = [];

  for (let i = 0; i < count; i += 1) {
    // Biased inwards: cube-rooting a uniform value concentrates the field near
    // the surface and thins it towards the edge, which is what makes the core
    // read as the source rather than the centre of a uniform cloud.
    const t = Math.cbrt(random());
    const radius = 1.04 + t * (FIELD_REACH - 1.04);

    // One particle in nine flares. Any more and the field twinkles like a
    // christmas tree; any fewer and nothing ever catches the eye.
    const flares = random() < 0.16;

    out.push({
      ...orbit(Math.acos(2 * random() - 1), random() * Math.PI * 2),
      radius,
      // Inner orbits run faster, as they would. It costs nothing and it is the
      // single biggest reason the field reads as a system rather than a
      // texture sliding past.
      speed: ((0.00022 + random() * 0.00028) / Math.pow(radius, 1.4)) * (random() < 0.5 ? -1 : 1),
      phase: random() * Math.PI * 2,
      size: 0.8 + random() * 1.3,
      flare: flares ? 0.6 + random() * 0.4 : 0,
      flareRate: 0.0006 + random() * 0.0016,
      flarePhase: random() * Math.PI * 2,
    });
  }

  return out;
}

interface Arc extends Orbit {
  radius: number;
  speed: number;
  phase: number;
  /** How much of the circle this arc covers, in radians. */
  span: number;
  width: number;
  alpha: number;
}

function makeArcs(count: number, random: () => number): Arc[] {
  const out: Arc[] = [];

  for (let i = 0; i < count; i += 1) {
    const radius = 1.02 + Math.cbrt(random()) * (FIELD_REACH - 1.1);
    out.push({
      ...orbit(Math.acos(2 * random() - 1), random() * Math.PI * 2),
      radius,
      speed: ((0.00016 + random() * 0.00022) / Math.pow(radius, 1.2)) * (random() < 0.5 ? -1 : 1),
      phase: random() * Math.PI * 2,
      // Short. A long arc closes into a visible ring, and a ring is the thing
      // this screen spent a commit removing.
      span: 0.3 + random() * 0.85,
      width: 0.5 + random() * 0.7,
      alpha: 0.22 + random() * 0.4,
    });
  }

  return out;
}

interface Spiral extends Orbit {
  /** Where it leaves the surface and where it ends. */
  from: number;
  to: number;
  turns: number;
  speed: number;
  phase: number;
  alpha: number;
}

function makeSpirals(count: number, random: () => number): Spiral[] {
  const out: Spiral[] = [];

  for (let i = 0; i < count; i += 1) {
    out.push({
      ...orbit(Math.acos(2 * random() - 1), random() * Math.PI * 2),
      from: 1.0 + random() * 0.15,
      to: 1.5 + random() * (FIELD_REACH - 1.5),
      turns: 0.5 + random() * 1.1,
      speed: (0.00012 + random() * 0.0002) * (random() < 0.5 ? -1 : 1),
      phase: random() * Math.PI * 2,
      alpha: 0.14 + random() * 0.24,
    });
  }

  return out;
}

interface Point {
  x: number; y: number; z: number;
  /** Fixed per-point jitter, so the surface reads as texture not as a grid. */
  grain: number;
}

/**
 * A Fibonacci lattice: the standard way to scatter points evenly on a sphere.
 *
 * Random points clump and a latitude/longitude grid crowds at the poles.
 * Neither looks like a surface.
 */
function lattice(count: number): Point[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Point[] = [];

  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * index;

    points.push({
      x: Math.cos(theta) * radius,
      y,
      z: Math.sin(theta) * radius,
      grain: 0.55 + (((Math.sin(index * 12.9898) * 43758.5453) % 1) + 1) / 2 * 0.45,
    });
  }

  return points;
}

/** A soft round blob, built once and blitted wherever a glow is needed. */
function glowSprite(diameter: number, colour: [number, number, number]): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = diameter;
  sprite.height = diameter;

  const context = sprite.getContext('2d');
  if (!context) return sprite;

  const centre = diameter / 2;
  const gradient = context.createRadialGradient(centre, centre, 0, centre, centre, centre);
  gradient.addColorStop(0, rgba(colour, 1));
  gradient.addColorStop(0.25, rgba(colour, 0.45));
  gradient.addColorStop(0.6, rgba(colour, 0.1));
  gradient.addColorStop(1, rgba(colour, 0));

  context.fillStyle = gradient;
  context.fillRect(0, 0, diameter, diameter);
  return sprite;
}

/* ------------------------------------------------------------------ */
/* The component                                                      */
/* ------------------------------------------------------------------ */

export interface CoreProps {
  state: CoreState;
  /**
   * 0..1, measured. The microphone while listening, word onsets while
   * speaking, and zero otherwise - never a number invented to make the core
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
  state,
  level,
  reduceMotion,
  onActivate,
  label,
  size = 560,
}: CoreProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live values read inside the animation loop, so changing them does not tear
  // down and rebuild the loop on every render.
  const live = useRef({ state, level, reduceMotion });
  live.current = { state, level, reduceMotion };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const maybeContext = canvas.getContext('2d');
    if (!maybeContext) return;
    // Bound to a non-null type once, here. The paint helpers below are nested
    // function declarations, and TypeScript will not carry a narrowing into
    // one of those - so without this every line of drawing needs a guard.
    const context: CanvasRenderingContext2D = maybeContext;

    // Capped at 2: beyond that the extra pixels cost real time and nobody can
    // see the difference on a field of one-pixel points.
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    context.scale(ratio, ratio);

    const centre = size / 2;
    const random = seeded(0x9e3779b9);
    const points = lattice(POINTS);
    const particles = makeParticles(PARTICLES, random);
    const arcs = makeArcs(ARCS, random);
    const spirals = makeSpirals(SPIRALS, random);

    // Two glows rather than one. The wide halo is the field bleeding into the
    // dark; the tight one sits on the sphere and is what makes the core read
    // as the source of the energy rather than a hole in the middle of it.
    const halo = glowSprite(Math.round(size), [255, 140, 44]);
    const heart = glowSprite(Math.round(size / 2), [255, 214, 140]);
    const spark = glowSprite(20, [255, 236, 200]);

    // Scratch, reused every frame. Allocating these per frame is the one thing
    // here that would actually show up as jank.
    const sx = new Float32Array(PARTICLES);
    const sy = new Float32Array(PARTICLES);
    const sd = new Float32Array(PARTICLES);
    const sa = new Float32Array(PARTICLES);
    const ss = new Float32Array(PARTICLES);
    const st = new Float32Array(PARTICLES);

    let frame = 0;
    let last = 0;
    let swell = 0;
    let spun = 0;
    let clock = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < FRAME_MS) return;
      const elapsed = last === 0 ? FRAME_MS : Math.min(120, now - last);
      last = now;

      const { state: phase, level: measured, reduceMotion: still } = live.current;
      const motion = MOTION[phase];

      /**
       * The swell, and the reason it is asymmetric.
       *
       * It rises fast and falls slowly. A symmetric ease makes speech look like
       * a sine wave - the core is already shrinking by the time the word lands.
       * Rising in two frames and falling over ten makes each word a beat.
       */
      const target =
        phase === 'listening' || phase === 'speaking' ? Math.min(1, Math.max(0, measured)) : 0;
      swell += (target - swell) * (target > swell ? 0.4 : 0.08);

      // Integrated rather than derived from the clock, so a change of speed
      // never makes the field jump to a new arrangement.
      if (!still) {
        clock += elapsed * motion.churn;
        spun += (elapsed / TURN_MS) * Math.PI * 2 * motion.spin;
      }
      const turn = still ? 0.6 : spun;
      const tilt = -0.28;
      const ct = Math.cos(tilt);
      const stl = Math.sin(tilt);

      const beat =
        motion.pulse === null || still
          ? 0
          : (Math.sin((now / motion.pulse) * Math.PI * 2) + 1) / 2;
      const energy = Math.min(
        1.4,
        motion.aura * (1 - motion.depth / 2 + beat * motion.depth) + swell * 0.55,
      );

      const { radius, field, aura } = coreGeometry(size, swell);

      context.clearRect(0, 0, size, size);
      // Everything in the field adds rather than covers, so overlapping orbits
      // concentrate brightness near the core for free.
      context.globalCompositeOperation = 'lighter';

      /* ---- the glow, under everything ---- */
      const warmth = 0.35 + motion.heat * 0.65;
      context.globalAlpha = Math.min(1, 0.82 * energy * warmth);
      context.drawImage(halo, centre - aura / 2, centre - aura / 2, aura, aura);

      const heartSize = radius * 3.4;
      context.globalAlpha = Math.min(1, 0.7 * energy * warmth);
      context.drawImage(
        heart,
        centre - heartSize / 2,
        centre - heartSize / 2,
        heartSize,
        heartSize,
      );
      context.globalAlpha = 1;

      /* ---- project every particle once ---- */
      const drawn = Math.round(PARTICLES * motion.density);
      for (let i = 0; i < drawn; i += 1) {
        const p = particles[i] as Particle;
        const angle = p.phase + clock * p.speed;
        const ca = Math.cos(angle);
        const sn = Math.sin(angle);
        const r = p.radius * field;

        // Position on the orbit, then the scene's own tilt.
        const x = (p.ux * ca + p.vx * sn) * r;
        const yRaw = (p.uy * ca + p.vy * sn) * r;
        const zRaw = (p.uz * ca + p.vz * sn) * r;
        const y = yRaw * ct - zRaw * stl;
        const depth = yRaw * stl + zRaw * ct;

        // 0 at the back, 1 at the front.
        const facing = (depth / (FIELD_REACH * field) + 1) / 2;

        // Brighter near the core, thinner towards the edge - the thing that
        // makes this read as a contained system rather than a cloud.
        const fall = Math.pow(1 - (p.radius - 1.04) / (FIELD_REACH - 1.04), 1.7);

        let alpha = fall * (0.3 + facing * 1.15) * energy * 1.9;

        // The flare. A slow sine per particle, sharpened so it spends most of
        // its time dark and briefly goes very bright.
        if (p.flare > 0) {
          const f = Math.pow((Math.sin(p.flarePhase + clock * p.flareRate) + 1) / 2, 7);
          alpha += f * p.flare * energy;
          st[i] = f * p.flare;
        } else {
          st[i] = 0;
        }

        sx[i] = centre + x;
        sy[i] = centre + y;
        sd[i] = depth;
        sa[i] = Math.min(1, alpha);
        ss[i] = p.size * (0.85 + facing * 1.05);
      }

      /* ---- back half, then the sphere, then the front half ---- */
      paintParticles(false);
      paintSpirals(false);
      paintArcs(false);

      paintSphere();

      paintSpirals(true);
      paintArcs(true);
      paintParticles(true);

      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';

      function paintParticles(front: boolean): void {
        for (let i = 0; i < drawn; i += 1) {
          if (front !== sd[i]! >= 0) continue;
          const alpha = sa[i]!;
          if (alpha < 0.015) continue;

          const p = particles[i] as Particle;
          // Colour by how far out it is: white-gold at the surface, deep
          // orange at the edge.
          const shade = fire((p.radius - 1.04) / (FIELD_REACH - 1.04), motion.heat);
          const dot = ss[i]!;

          // A flaring particle gets a blitted glow; an ordinary one is a
          // rectangle, which is several times cheaper than an arc at this size
          // and indistinguishable below three pixels.
          const flaring = st[i]!;
          if (flaring > 0.1) {
            const halo_ = 5 + flaring * 13;
            context.globalAlpha = Math.min(1, flaring * energy * 1.5);
            context.drawImage(spark, sx[i]! - halo_ / 2, sy[i]! - halo_ / 2, halo_, halo_);
          }

          context.globalAlpha = alpha;
          context.fillStyle = rgba(shade, 1);
          context.fillRect(sx[i]! - dot / 2, sy[i]! - dot / 2, dot, dot);
        }
      }

      function paintArcs(front: boolean): void {
        for (const arc of arcs) {
          const start = arc.phase + clock * arc.speed;
          const mid = start + arc.span / 2;
          const midDepth =
            ((arc.uy * Math.cos(mid) + arc.vy * Math.sin(mid)) * stl +
              (arc.uz * Math.cos(mid) + arc.vz * Math.sin(mid)) * ct);
          if (front !== midDepth >= 0) continue;

          const r = arc.radius * field;
          const shade = fire((arc.radius - 1.02) / (FIELD_REACH - 1.02), motion.heat);

          context.beginPath();
          for (let s = 0; s <= ARC_SEGMENTS; s += 1) {
            const a = start + (arc.span * s) / ARC_SEGMENTS;
            const ca = Math.cos(a);
            const sn = Math.sin(a);
            const yRaw = (arc.uy * ca + arc.vy * sn) * r;
            const zRaw = (arc.uz * ca + arc.vz * sn) * r;
            const px = centre + (arc.ux * ca + arc.vx * sn) * r;
            const py = centre + yRaw * ct - zRaw * stl;
            if (s === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          }

          const facing = (midDepth / (FIELD_REACH * field) + 1) / 2;
          context.globalAlpha = Math.min(1, arc.alpha * (0.15 + facing * 0.95) * energy * 1.15);
          context.strokeStyle = rgba(shade, 1);
          context.lineWidth = arc.width;
          context.stroke();
        }
      }

      function paintSpirals(front: boolean): void {
        for (const spiral of spirals) {
          const start = spiral.phase + clock * spiral.speed;
          const midDepth =
            ((spiral.uy * Math.cos(start) + spiral.vy * Math.sin(start)) * stl +
              (spiral.uz * Math.cos(start) + spiral.vz * Math.sin(start)) * ct);
          if (front !== midDepth >= 0) continue;

          const shade = fire(0.55, motion.heat);
          context.beginPath();
          for (let s = 0; s <= SPIRAL_STEPS; s += 1) {
            const t = s / SPIRAL_STEPS;
            // Radius grows while the angle advances: a line leaving the
            // surface rather than a circle around it.
            const r = (spiral.from + (spiral.to - spiral.from) * t) * field;
            const a = start + spiral.turns * Math.PI * 2 * t;
            const ca = Math.cos(a);
            const sn = Math.sin(a);
            const yRaw = (spiral.uy * ca + spiral.vy * sn) * r;
            const zRaw = (spiral.uz * ca + spiral.vz * sn) * r;
            const px = centre + (spiral.ux * ca + spiral.vx * sn) * r;
            const py = centre + yRaw * ct - zRaw * stl;
            if (s === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          }

          context.globalAlpha = Math.min(1, spiral.alpha * energy * 1.05);
          context.strokeStyle = rgba(shade, 1);
          context.lineWidth = 0.7;
          context.stroke();
        }
      }

      function paintSphere(): void {
        for (const point of points) {
          // Rotate about the vertical axis, then tilt the pole towards us.
          const x = point.x * Math.cos(turn) - point.z * Math.sin(turn);
          const z = point.x * Math.sin(turn) + point.z * Math.cos(turn);
          const y = point.y * ct - z * stl;
          const depth = point.y * stl + z * ct;

          /**
           * Uniform. The sphere used to be brighter at the latitudes whose
           * subsystem worked and nearly dark at the ones that did not - a
           * capability readout wearing the core's clothes. It is gone: the
           * core is a presence, not a status display, and what it has to
           * say about itself it says through `state` below.
           */
          const lit = motion.lit;

          // Points on the far side stay, faintly. A sphere with a hollow back
          // reads as a bowl.
          const facing = (depth + 1) / 2;
          const alpha = lit * point.grain * (0.16 + facing * 1.05) * (facing < 0.5 ? 0.4 : 1);
          if (alpha < 0.02) continue;

          // Hottest at the surface: the core is where the energy comes from.
          const shade = fire(0.06 + (1 - facing) * 0.3, motion.heat);
          const dot = 0.75 + facing * 1.15;

          context.globalAlpha = Math.min(1, alpha * (0.8 + energy * 0.7));
          context.fillStyle = rgba(shade, 1);
          context.fillRect(
            centre + x * radius - dot / 2,
            centre + y * radius - dot / 2,
            dot,
            dot,
          );
        }
      }
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
      <canvas
        ref={canvasRef}
        className="hx-core__canvas"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    </button>
  );
}
