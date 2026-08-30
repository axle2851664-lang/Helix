import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type {
  GestureAvailability,
  GestureFrame,
  GestureProvider,
  Handedness,
  Point3D,
  TrackedHand,
} from './types.js';
import { buildHand, recognize } from './recognize.js';

/**
 * Hand tracking via MediaPipe Hand Landmarker (spec 11).
 *
 * Runs entirely on the machine: the WASM runtime and the model are served from
 * Helix's own origin, not a CDN. That is required by the application's content
 * security policy, which permits no external origins, and it means camera
 * frames never leave the device - unlike speech recognition, this genuinely is
 * on-device.
 *
 * The model is not committed to the repository. `npm run fetch:models`
 * downloads it into `public/models/`, and this provider reports the file as
 * missing rather than failing obscurely if that step has not been run.
 */

const WASM_PATH = './mediapipe/wasm';
const MODEL_PATH = './models/hand_landmarker.task';

export class MediaPipeGestureProvider implements GestureProvider {
  readonly id = 'mediapipe';
  readonly name = 'MediaPipe Hands';
  // Frames are processed in WASM on this machine and never transmitted.
  readonly processing = 'on-device' as const;

  #landmarker: HandLandmarker | null = null;
  #running = false;
  #rafId: number | null = null;
  #lastVideoTime = -1;
  /** Carried between frames so pinch hysteresis works across the stream. */
  #wasPinching = false;

  get tracking(): boolean {
    return this.#running;
  }

  isAvailable(): GestureAvailability {
    if (typeof WebAssembly === 'undefined') {
      return { available: false, reason: 'This browser has no WebAssembly support.' };
    }
    if (typeof window === 'undefined' || !window.isSecureContext) {
      return {
        available: false,
        reason: 'Hand tracking requires a secure context (HTTPS or localhost).',
      };
    }
    return { available: true };
  }

  /** Load the model. Separated so the UI can show progress before tracking. */
  async load(): Promise<void> {
    if (this.#landmarker) return;

    let vision;
    try {
      vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    } catch (error) {
      throw new Error(
        'The hand tracking runtime could not be loaded. Run "npm run fetch:models" to install it.',
        { cause: error },
      );
    }

    try {
      this.#landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        // Raised from the defaults: a false hand causes objects to jump, which
        // is worse than briefly losing tracking.
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
    } catch (error) {
      throw new Error(
        'The hand tracking model could not be loaded. Run "npm run fetch:models" to download it.',
        { cause: error },
      );
    }
  }

  async start(video: HTMLVideoElement, onFrame: (frame: GestureFrame) => void): Promise<void> {
    const availability = this.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Hand tracking is unavailable.');
    }

    await this.load();
    if (this.#running) return;
    this.#running = true;

    const tick = () => {
      if (!this.#running || !this.#landmarker) return;

      // Only detect on a new video frame; re-running on the same frame wastes
      // GPU time and produces identical results.
      if (video.currentTime !== this.#lastVideoTime && video.readyState >= 2) {
        this.#lastVideoTime = video.currentTime;

        try {
          const result = this.#landmarker.detectForVideo(video, performance.now());
          const hands: TrackedHand[] = [];

          result.landmarks.forEach((landmarks, index) => {
            const points: Point3D[] = landmarks.map((point) => ({
              x: point.x,
              y: point.y,
              z: typeof point.z === 'number' ? point.z : null,
            }));

            const category = result.handedness[index]?.[0];
            const handedness: Handedness =
              category?.categoryName === 'Left'
                ? 'left'
                : category?.categoryName === 'Right'
                  ? 'right'
                  : 'unknown';

            const hand = buildHand(points, handedness, category?.score ?? null);
            if (hand) hands.push(hand);
          });

          const frame = recognize(hands, {
            wasPinching: this.#wasPinching,
            timestamp: performance.now(),
          });
          this.#wasPinching = frame.pinch.active;
          onFrame(frame);
        } catch {
          // A single dropped frame is not worth stopping tracking for.
        }
      }

      this.#rafId = requestAnimationFrame(tick);
    };

    this.#rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.#running = false;
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    this.#lastVideoTime = -1;
    this.#wasPinching = false;
  }

  /** Release the model. The landmarker holds GPU resources. */
  dispose(): void {
    this.stop();
    this.#landmarker?.close();
    this.#landmarker = null;
  }
}
