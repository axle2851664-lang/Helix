import { describe, expect, it } from 'vitest';
import {
  buildHand,
  extendedFingerCount,
  isOpenPalm,
  LANDMARK,
  palmCentre,
  pinchDistance,
  PINCH_ENGAGE,
  PINCH_RELEASE,
  recognize,
} from './recognize.js';
import type { Point3D, TrackedHand } from './types.js';

/**
 * Builds a synthetic 21-landmark hand.
 *
 * The hand sits around `centre`, with the thumb and index tips placed a chosen
 * distance apart so pinch can be driven precisely, and fingers either extended
 * or curled. This is what lets gesture behaviour be verified without a camera.
 */
function makeHand(options: {
  centre?: { x: number; y: number };
  /** Thumb-to-index gap, in the same units as the 0.1 hand span below. */
  pinchGap?: number;
  fingersExtended?: boolean;
} = {}): Point3D[] {
  const centre = options.centre ?? { x: 0.5, y: 0.5 };
  const gap = options.pinchGap ?? 0.1;
  const extended = options.fingersExtended ?? true;

  const points: Point3D[] = Array.from({ length: 21 }, () => ({
    x: centre.x,
    y: centre.y,
    z: null,
  }));

  const set = (index: number, x: number, y: number) => {
    points[index] = { x, y, z: null };
  };

  // Wrist below, knuckles at centre: a hand span of 0.1.
  set(LANDMARK.WRIST, centre.x, centre.y + 0.1);
  for (const knuckle of [
    LANDMARK.INDEX_MCP,
    LANDMARK.MIDDLE_MCP,
    LANDMARK.RING_MCP,
    LANDMARK.PINKY_MCP,
  ]) {
    set(knuckle, centre.x, centre.y);
  }

  // Middle joints sit between wrist and where an extended tip would be.
  const pipOffset = extended ? 0.04 : 0.08;
  const tipOffset = extended ? 0.08 : 0.02;
  for (const [tip, pip] of [
    [LANDMARK.INDEX_TIP, LANDMARK.INDEX_PIP],
    [LANDMARK.MIDDLE_TIP, LANDMARK.MIDDLE_PIP],
    [LANDMARK.RING_TIP, LANDMARK.RING_PIP],
    [LANDMARK.PINKY_TIP, LANDMARK.PINKY_PIP],
  ] as const) {
    set(pip, centre.x, centre.y - pipOffset);
    set(tip, centre.x, centre.y - tipOffset);
  }

  // Thumb and index tips separated horizontally by the requested gap.
  set(LANDMARK.THUMB_TIP, centre.x - gap / 2, centre.y - tipOffset);
  set(LANDMARK.INDEX_TIP, centre.x + gap / 2, centre.y - tipOffset);

  return points;
}

const asHand = (landmarks: Point3D[]): TrackedHand =>
  buildHand(landmarks, 'right', 0.9) as TrackedHand;

describe('palmCentre', () => {
  it('averages the knuckles and wrist', () => {
    const centre = palmCentre(makeHand({ centre: { x: 0.3, y: 0.4 } }));
    expect(centre?.x).toBeCloseTo(0.3, 5);
    expect(centre?.y).toBeGreaterThan(0.4);
  });

  it('returns null for empty landmarks', () => {
    expect(palmCentre([])).toBeNull();
  });
});

describe('pinchDistance', () => {
  // Normalised by hand span, so the same gesture reads the same at any range.
  it('is scale invariant', () => {
    const near = pinchDistance(makeHand({ pinchGap: 0.02 }));
    const far = pinchDistance(makeHand({ pinchGap: 0.02, centre: { x: 0.8, y: 0.8 } }));
    expect(near).toBeCloseTo(far as number, 5);
  });

  it('grows as the fingers separate', () => {
    const closed = pinchDistance(makeHand({ pinchGap: 0.01 })) as number;
    const open = pinchDistance(makeHand({ pinchGap: 0.09 })) as number;
    expect(open).toBeGreaterThan(closed);
  });

  it('returns null when landmarks are missing', () => {
    expect(pinchDistance([])).toBeNull();
  });
});

describe('finger extension', () => {
  it('counts four extended fingers on an open hand', () => {
    expect(extendedFingerCount(makeHand({ fingersExtended: true }))).toBe(4);
  });

  it('counts none on a closed hand', () => {
    expect(extendedFingerCount(makeHand({ fingersExtended: false }))).toBe(0);
  });
});

describe('isOpenPalm', () => {
  it('is true for an open hand with the thumb clear', () => {
    expect(isOpenPalm(makeHand({ fingersExtended: true, pinchGap: 0.09 }))).toBe(true);
  });

  it('is false for a closed hand', () => {
    expect(isOpenPalm(makeHand({ fingersExtended: false }))).toBe(false);
  });

  // A pinching hand can still have fingers extended; it must not read as a palm.
  it('is false while pinching, even with fingers extended', () => {
    expect(isOpenPalm(makeHand({ fingersExtended: true, pinchGap: 0.005 }))).toBe(false);
  });
});

describe('recognize', () => {
  it('reports no pinch for an open hand', () => {
    const frame = recognize([asHand(makeHand({ pinchGap: 0.09 }))]);
    expect(frame.pinch.active).toBe(false);
  });

  it('reports a pinch for closed fingers', () => {
    const frame = recognize([asHand(makeHand({ pinchGap: 0.01 }))]);
    expect(frame.pinch.active).toBe(true);
    expect(frame.pinch.position).not.toBeNull();
  });

  it('places the pinch point between thumb and index', () => {
    const frame = recognize([asHand(makeHand({ centre: { x: 0.4, y: 0.6 }, pinchGap: 0.01 }))]);
    expect(frame.pinch.position?.x).toBeCloseTo(0.4, 3);
  });

  /**
   * Hysteresis is the whole reason there are two thresholds. A hand resting
   * between them would otherwise flicker between grabbed and released, and drop
   * whatever is being dragged.
   */
  describe('pinch hysteresis', () => {
    const between = (PINCH_ENGAGE + PINCH_RELEASE) / 2;
    // handSpan is 0.1 in the synthetic hand, so gap = ratio * 0.1.
    const gapFor = (ratio: number) => ratio * 0.1;

    it('does not engage at a distance between the thresholds', () => {
      const frame = recognize([asHand(makeHand({ pinchGap: gapFor(between) }))], {
        wasPinching: false,
      });
      expect(frame.pinch.active).toBe(false);
    });

    it('stays engaged at that same distance once pinching', () => {
      const frame = recognize([asHand(makeHand({ pinchGap: gapFor(between) }))], {
        wasPinching: true,
      });
      expect(frame.pinch.active).toBe(true);
    });

    it('releases once past the looser threshold', () => {
      const frame = recognize([asHand(makeHand({ pinchGap: gapFor(PINCH_RELEASE + 0.1) }))], {
        wasPinching: true,
      });
      expect(frame.pinch.active).toBe(false);
    });
  });

  it('reports an open hand', () => {
    const frame = recognize([asHand(makeHand({ fingersExtended: true, pinchGap: 0.09 }))]);
    expect(frame.openHand).toBe(true);
  });

  it('reports two-hand separation and angle', () => {
    const left = asHand(makeHand({ centre: { x: 0.3, y: 0.5 }, pinchGap: 0.09 }));
    const right = asHand(makeHand({ centre: { x: 0.7, y: 0.5 }, pinchGap: 0.09 }));
    const frame = recognize([left, right]);

    expect(frame.twoHand.active).toBe(true);
    expect(frame.twoHand.separation).toBeCloseTo(0.4, 2);
    expect(frame.twoHand.angle).toBeCloseTo(0, 2);
  });

  it('handles no hands at all', () => {
    const frame = recognize([]);
    expect(frame.pinch.active).toBe(false);
    expect(frame.openHand).toBe(false);
    expect(frame.twoHand.active).toBe(false);
  });
});
