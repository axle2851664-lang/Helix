import { describe, expect, it } from 'vitest';
import { ARCS, FIELD_REACH, MOTION, PARTICLES, SPIRALS, coreGeometry, fire } from './Core.js';
import type { CoreState } from './Core.js';

const STATES: CoreState[] = [
  'idle',
  'listening',
  'thinking',
  'executing',
  'speaking',
  'awaiting',
  'error',
];

describe('how big the core gets', () => {
  const SIZE = 420;

  it('grows with the swell', () => {
    expect(coreGeometry(SIZE, 1).radius).toBeGreaterThan(coreGeometry(SIZE, 0).radius);
  });

  /**
   * The bug this file exists to prevent, measured rather than imagined.
   *
   * The sphere used to rest at 0.37 of the canvas. The swell had nowhere to
   * go: it clipped flat against the edge, so Helix speaking produced no
   * visible change at all. It has to fit at full swell, with the aura around
   * it, or the growth is not growth.
   */
  it('still fits inside the canvas at full swell', () => {
    const { radius, aura } = coreGeometry(SIZE, 1);
    expect(radius * 2).toBeLessThan(SIZE);
    expect(aura).toBeLessThanOrEqual(SIZE);
  });

  it('keeps the aura outside the sphere at every swell', () => {
    for (const swell of [0, 0.25, 0.5, 0.75, 1]) {
      const { radius, aura } = coreGeometry(SIZE, swell);
      expect(aura, String(swell)).toBeGreaterThan(radius * 2);
    }
  });

  /**
   * Visible across the room rather than on inspection. A swell small enough
   * to need looking for is the same as no swell: the user asked for the
   * sphere to get bigger and smaller as Helix talks, and a 3% change does
   * not.
   */
  it('grows by enough to see', () => {
    const rest = coreGeometry(SIZE, 0).radius;
    const full = coreGeometry(SIZE, 1).radius;
    expect(full / rest).toBeGreaterThan(1.25);
  });

  it('clamps a level outside 0..1 rather than drawing off the canvas', () => {
    expect(coreGeometry(SIZE, 4).radius).toBe(coreGeometry(SIZE, 1).radius);
    expect(coreGeometry(SIZE, -2).radius).toBe(coreGeometry(SIZE, 0).radius);
  });

  it('scales with the canvas', () => {
    expect(coreGeometry(680, 0).radius).toBe(coreGeometry(340, 0).radius * 2);
  });
});

describe('how each state moves', () => {
  it('describes every state', () => {
    for (const state of STATES) expect(MOTION[state], state).toBeDefined();
  });

  /**
   * Six states that look the same are one state. Each pair has to differ in
   * something a person can see, and brightness alone is not enough - a pulse
   * period and a spin rate are the two that read at a glance.
   */
  it('gives no two states the same look', () => {
    const seen = new Map<string, CoreState>();
    for (const state of STATES) {
      const motion = MOTION[state];
      const signature = [
        motion.aura,
        motion.pulse,
        motion.depth,
        motion.spin,
        motion.lit,
        motion.heat,
        motion.density,
        motion.churn,
      ].join('/');
      expect(seen.get(signature), `${state} looks identical to ${seen.get(signature)}`).toBeUndefined();
      seen.set(signature, state);
    }
  });

  /**
   * The one pair that must not be confusable: thinking will finish by itself,
   * executing has already started changing things.
   */
  it('separates thinking from executing by rhythm, not only by brightness', () => {
    expect(MOTION.thinking.pulse).not.toBe(MOTION.executing.pulse);
    expect(MOTION.thinking.spin).not.toBe(MOTION.executing.spin);
    // Executing has already started changing things, so its field runs
    // visibly harder rather than merely a shade brighter.
    expect(MOTION.executing.churn).toBeGreaterThan(MOTION.thinking.churn);
  });

  /**
   * Nothing is happening, so nothing should be demanding attention. Idle must
   * be the quietest state on the screen.
   */
  it('makes idle the faintest of them all', () => {
    for (const state of STATES) {
      if (state === 'idle' || state === 'error') continue;
      expect(MOTION[state].aura, state).toBeGreaterThan(MOTION.idle.aura);
    }
  });

  /** Stopped is stopped. Motion here would read as work still going on. */
  it('holds the stopped states completely still', () => {
    for (const state of ['error', 'awaiting'] as const) {
      expect(MOTION[state].spin, state).toBe(0);
      expect(MOTION[state].pulse, state).toBeNull();
      // Nothing orbits either. A field still churning around a stopped core
      // reads as work going on.
      expect(MOTION[state].churn, state).toBe(0);
    }
  });

  /**
   * A failure has to be the coldest, sparsest thing on the screen. It is also
   * written in words beneath the core, because anyone who cannot see the
   * colour must still be able to tell.
   */
  it('makes a failure unmistakably cold and thin', () => {
    for (const state of STATES) {
      if (state === 'error') continue;
      expect(MOTION.error.heat, state).toBeLessThan(MOTION[state].heat);
      expect(MOTION.error.density, state).toBeLessThanOrEqual(MOTION[state].density);
    }
  });

  /** Nothing is happening, so the field should be the sparsest it ever is. */
  it('makes idle the quietest live state', () => {
    for (const state of STATES) {
      if (state === 'idle' || state === 'error') continue;
      expect(MOTION[state].density, state).toBeGreaterThan(MOTION.idle.density);
    }
  });

  /**
   * The two states that swell do so from a measurement, so their base must
   * not pulse as well - a pulse under a measured swell is an invented signal
   * mixed into a real one, and the user cannot tell them apart.
   */
  it('does not pulse underneath a measured swell', () => {
    expect(MOTION.listening.pulse).toBeNull();
    expect(MOTION.speaking.pulse).toBeNull();
  });
});


describe('the colour of the field', () => {
  /**
   * The ramp is the depth cue: white-gold where the energy comes from, deep
   * orange out at the edge. Flat colour would make the field read as a decal
   * over the sphere rather than as something around it.
   */
  it('runs from pale gold at the core to orange at the edge', () => {
    const core = fire(0, 1);
    const edge = fire(1, 1);

    // Blue is what separates a pale gold from an orange, and it has to fall.
    expect(core[2]).toBeGreaterThan(edge[2]);
    // Red stays high throughout: it is all fire.
    expect(core[0]).toBeGreaterThan(200);
    expect(edge[0]).toBeGreaterThan(200);
  });

  /**
   * `heat` is what makes a stopped core look stopped rather than dimmed. A
   * dimmer version of the same gold reads as "quieter"; an ember reads as
   * "out".
   */
  it('falls back to a dull ember when the heat goes out', () => {
    const live = fire(0.5, 1);
    const dead = fire(0.5, 0);

    expect(dead[0]).toBeLessThan(live[0]);
    expect(dead[1]).toBeLessThan(live[1]);
    // And it is still fire-coloured rather than grey: red leads.
    expect(dead[0]).toBeGreaterThan(dead[2]);
  });

  it('never produces a channel outside a byte', () => {
    for (const t of [-1, 0, 0.5, 1, 2]) {
      for (const heat of [0, 0.5, 1]) {
        for (const channel of fire(t, heat)) {
          expect(channel, `${t}/${heat}`).toBeGreaterThanOrEqual(0);
          expect(channel, `${t}/${heat}`).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});


describe('the field around the core', () => {
  /**
   * Density is the whole effect, and it is the first thing that gets quietly
   * tuned down when a frame budget gets tight. Below about three hundred the
   * eye starts following individual particles, which turns an energy field
   * into a mobile.
   */
  it('is made of hundreds of particles, not dozens', () => {
    expect(PARTICLES).toBeGreaterThanOrEqual(600);
  });

  it('carries arcs and spirals as well as particles', () => {
    expect(ARCS).toBeGreaterThan(20);
    expect(SPIRALS).toBeGreaterThan(8);
  });

  /**
   * The field has to extend well past the surface, or it is a shell sitting on
   * the sphere rather than energy coming off it. It also has to stop, because
   * a field with no edge is a background.
   */
  it('reaches well beyond the sphere and still ends', () => {
    expect(FIELD_REACH).toBeGreaterThan(1.8);
    expect(FIELD_REACH).toBeLessThan(3);

    // And what it reaches to has to fit, at full swell, inside the canvas.
    // This caught real clipping: with the field scaling with the sphere, the
    // outer orbits ran 673px wide in a 560px canvas.
    const { field, aura } = coreGeometry(560, 1);
    expect(field * FIELD_REACH * 2).toBeCloseTo(aura);
    expect(aura).toBeLessThanOrEqual(560);
  });

  /**
   * The sphere surges and the field barely moves. If the field took the whole
   * swell too, the core would not read as pushing against anything - the
   * whole picture would just zoom.
   */
  it('lets the sphere surge against a field that stays put', () => {
    const rest = coreGeometry(560, 0);
    const full = coreGeometry(560, 1);

    const sphereGrowth = full.radius / rest.radius;
    const fieldGrowth = full.field / rest.field;

    expect(sphereGrowth).toBeGreaterThan(fieldGrowth);
    expect(fieldGrowth).toBeGreaterThan(1);
  });
});
