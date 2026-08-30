/**
 * Hand tracking provider interface (spec 11).
 *
 * Helix has no hand-tracking implementation. MediaPipe is not bundled, and the
 * specification is explicit that gestures must not be faked with mouse events:
 * a pinch simulated from a click would look like working hand tracking while
 * teaching the user nothing about whether their camera can actually do it.
 *
 * So this file defines the contract and nothing else. `NullGestureProvider`
 * reports unavailability; the mouse and keyboard remain the real, supported
 * way to manipulate spatial objects, as the fallback the specification
 * requires rather than as a disguise for gestures.
 */

/** Normalised 0..1 coordinates, so they survive any preview size. */
export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D extends Point2D {
  /** Relative depth where the provider reports it; null when it does not. */
  z: number | null;
}

export type Handedness = 'left' | 'right' | 'unknown';

/** One tracked hand. Landmark order follows the provider's own convention. */
export interface TrackedHand {
  handedness: Handedness;
  /** 0..1 tracking confidence, or null when the provider does not report it. */
  confidence: number | null;
  landmarks: Point3D[];
  /** Centre of the palm, for coarse positioning. */
  palm: Point2D;
}

export interface PinchState {
  active: boolean;
  /** Distance between thumb and index tip, normalised. Null when no hand. */
  distance: number | null;
  /** Midpoint of the pinch, used as the grab anchor. */
  position: Point2D | null;
}

/** Two-handed manipulation, for scale and rotation. */
export interface TwoHandState {
  active: boolean;
  /** Distance between hands, normalised. Drives scale. */
  separation: number | null;
  /** Angle between hands in radians. Drives rotation. */
  angle: number | null;
}

export interface GestureFrame {
  hands: TrackedHand[];
  pinch: PinchState;
  twoHand: TwoHandState;
  /** True when a hand is open, i.e. a release. */
  openHand: boolean;
  timestamp: number;
}

export interface GestureAvailability {
  available: boolean;
  reason?: string;
}

export interface GestureProvider {
  readonly id: string;
  readonly name: string;
  /** Whether frames are processed on the machine or sent elsewhere. */
  readonly processing: 'on-device' | 'remote' | 'unknown';

  isAvailable(): GestureAvailability;

  /**
   * Begin tracking from a live video element. Resolves once the model is
   * loaded and the first frame has been processed, so a "tracking" indicator
   * cannot appear before tracking is genuinely running.
   */
  start(video: HTMLVideoElement, onFrame: (frame: GestureFrame) => void): Promise<void>;
  stop(): void;
  readonly tracking: boolean;
}

/**
 * The provider in use when no hand tracking is installed, which is always, for
 * now. It refuses rather than emitting synthetic frames.
 */
export class NullGestureProvider implements GestureProvider {
  readonly id = 'none';
  readonly name = 'No hand tracking';
  readonly processing = 'unknown' as const;
  readonly tracking = false;

  static readonly REASON =
    'Hand tracking is not available. MediaPipe is not bundled with Helix yet, and ' +
    'gestures are deliberately not simulated from mouse input.';

  isAvailable(): GestureAvailability {
    return { available: false, reason: NullGestureProvider.REASON };
  }

  async start(): Promise<void> {
    throw new Error(NullGestureProvider.REASON);
  }

  stop(): void {
    // Nothing is running.
  }
}
