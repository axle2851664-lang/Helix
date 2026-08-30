import type { GestureFrame, Handedness, Point2D, Point3D, TrackedHand } from './types.js';

/**
 * Gesture recognition from hand landmarks (spec 11).
 *
 * Deliberately pure: landmarks in, gesture state out. No camera, no MediaPipe,
 * no DOM. That separation is what makes the behaviour testable - the maths
 * below is verified against synthetic hands, so a pinch threshold or a palm
 * test can be checked without a webcam in the room.
 *
 * Landmark indices follow the MediaPipe hand model, which numbers 21 points
 * per hand. Only the ones used here are named.
 */

export const LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
} as const;

/**
 * Pinch thresholds, as a fraction of hand size rather than absolute distance,
 * so they hold whether the hand is near the camera or far from it.
 *
 * Two thresholds, not one: a pinch engages at the tighter value and only
 * releases at the looser one. A single threshold makes a hand hovering at the
 * boundary flicker between grabbed and released, which drops whatever is being
 * dragged.
 */
export const PINCH_ENGAGE = 0.32;
export const PINCH_RELEASE = 0.45;

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * A scale reference for the hand: wrist to middle-finger knuckle. Used to
 * normalise finger distances so gestures behave the same at any camera range.
 */
export function handSpan(landmarks: readonly Point3D[]): number {
  const wrist = landmarks[LANDMARK.WRIST];
  const middle = landmarks[LANDMARK.MIDDLE_MCP];
  if (!wrist || !middle) return 0;
  // Floor prevents a division blow-up when the hand is nearly edge-on.
  return Math.max(distance(wrist, middle), 0.001);
}

/** Centre of the palm, averaged over the knuckles and the wrist. */
export function palmCentre(landmarks: readonly Point3D[]): Point2D | null {
  const points = [
    landmarks[LANDMARK.WRIST],
    landmarks[LANDMARK.INDEX_MCP],
    landmarks[LANDMARK.MIDDLE_MCP],
    landmarks[LANDMARK.RING_MCP],
    landmarks[LANDMARK.PINKY_MCP],
  ].filter((point): point is Point3D => point !== undefined);

  if (points.length === 0) return null;
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/** Normalised thumb-to-index distance. Null when the landmarks are missing. */
export function pinchDistance(landmarks: readonly Point3D[]): number | null {
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  if (!thumb || !index) return null;
  return distance(thumb, index) / handSpan(landmarks);
}

/**
 * Is a finger extended? True when its tip is further from the wrist than its
 * middle joint, which holds regardless of hand rotation.
 */
export function fingerExtended(
  landmarks: readonly Point3D[],
  tipIndex: number,
  pipIndex: number,
): boolean {
  const wrist = landmarks[LANDMARK.WRIST];
  const tip = landmarks[tipIndex];
  const pip = landmarks[pipIndex];
  if (!wrist || !tip || !pip) return false;
  return distance(wrist, tip) > distance(wrist, pip);
}

/** How many of the four fingers (excluding thumb) are extended. */
export function extendedFingerCount(landmarks: readonly Point3D[]): number {
  const fingers: Array<[number, number]> = [
    [LANDMARK.INDEX_TIP, LANDMARK.INDEX_PIP],
    [LANDMARK.MIDDLE_TIP, LANDMARK.MIDDLE_PIP],
    [LANDMARK.RING_TIP, LANDMARK.RING_PIP],
    [LANDMARK.PINKY_TIP, LANDMARK.PINKY_PIP],
  ];
  return fingers.filter(([tip, pip]) => fingerExtended(landmarks, tip, pip)).length;
}

/**
 * An open palm: all four fingers extended and the hand not pinching.
 * This is the gesture that reveals object actions, so it is deliberately
 * strict - a partially open hand mid-pinch must not trigger it.
 */
export function isOpenPalm(landmarks: readonly Point3D[]): boolean {
  if (extendedFingerCount(landmarks) < 4) return false;
  const pinch = pinchDistance(landmarks);
  // A pinching hand can have fingers extended; require the thumb clear.
  return pinch === null ? false : pinch > PINCH_RELEASE;
}

export function buildHand(
  landmarks: readonly Point3D[],
  handedness: Handedness,
  confidence: number | null,
): TrackedHand | null {
  const palm = palmCentre(landmarks);
  if (!palm) return null;
  return { handedness, confidence, landmarks: [...landmarks], palm };
}

/**
 * Derive a full gesture frame from tracked hands.
 *
 * `wasPinching` implements the hysteresis: pass the previous frame's pinch
 * state so an engaged pinch holds until the looser release threshold.
 */
export function recognize(
  hands: readonly TrackedHand[],
  options: { wasPinching?: boolean; timestamp?: number } = {},
): GestureFrame {
  const timestamp = options.timestamp ?? Date.now();
  const threshold = options.wasPinching ? PINCH_RELEASE : PINCH_ENGAGE;

  const first = hands[0];
  const second = hands[1];

  let pinchActive = false;
  let pinchValue: number | null = null;
  let pinchPosition: Point2D | null = null;

  if (first) {
    pinchValue = pinchDistance(first.landmarks);
    if (pinchValue !== null && pinchValue < threshold) {
      pinchActive = true;
      const thumb = first.landmarks[LANDMARK.THUMB_TIP];
      const index = first.landmarks[LANDMARK.INDEX_TIP];
      pinchPosition = thumb && index ? midpoint(thumb, index) : first.palm;
    }
  }

  let separation: number | null = null;
  let angle: number | null = null;
  if (first && second) {
    separation = distance(first.palm, second.palm);
    angle = Math.atan2(second.palm.y - first.palm.y, second.palm.x - first.palm.x);
  }

  return {
    hands: [...hands],
    pinch: { active: pinchActive, distance: pinchValue, position: pinchPosition },
    twoHand: { active: hands.length >= 2, separation, angle },
    // An open palm on any hand counts, so either hand can reveal actions.
    openHand: hands.some((hand) => isOpenPalm(hand.landmarks)),
    timestamp,
  };
}
