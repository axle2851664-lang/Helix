import { describe, expect, it } from 'vitest';
import { MOTION, coreGeometry } from './Core.js';
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
      const signature = [motion.aura, motion.pulse, motion.depth, motion.spin, motion.lit].join('/');
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
