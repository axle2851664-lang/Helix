import type { GestureFrame } from '../gestures/types.js';
import type { SpatialScene } from './SpatialScene.js';

/**
 * Maps gestures onto scene actions (spec 11, 12).
 *
 * Two interactions, as requested:
 *
 * 1. **Pinch and drag moves an object.** A pinch that closes over an object
 *    grabs it; the object follows the pinch until the hand opens. Only the
 *    grabbed object moves - the rest of the scene and the interface stay put,
 *    which the specification calls out explicitly.
 *
 * 2. **An open palm held over an object opens its action menu.** It is a
 *    dwell, not an instant trigger: a palm passing across the view would
 *    otherwise open menus continuously. The dwell also means a destructive
 *    action is never one accidental gesture away - the menu appears, and
 *    deleting still needs a deliberate second action.
 *
 * What the menu *contains* is not decided here, and neither is what happens
 * when an item is chosen. This class reports that a menu should be open over a
 * given object; the action registry says which actions apply to it, and the
 * action runner performs the chosen one with whatever permission or
 * confirmation it requires. Moving objects is direct manipulation and stays
 * here; anything with consequences goes through the pipeline, which is the
 * specification's rule that Helix acts through a central action system rather
 * than reaching into state from wherever the gesture happened to be handled.
 *
 * Pure with respect to time: `update` takes the frame's timestamp rather than
 * reading the clock, so dwell behaviour is testable without waiting.
 */

export type GestureMode = 'idle' | 'dragging' | 'menu';

export interface ActionMenuState {
  objectId: string;
  /** Normalised position to anchor the menu. */
  x: number;
  y: number;
}

export interface ControllerState {
  mode: GestureMode;
  /** The object being dragged, if any. */
  draggingId: string | null;
  /** The action menu, when an open palm has dwelled over an object. */
  menu: ActionMenuState | null;
  /** 0..1 progress toward opening the menu, for a visible dwell indicator. */
  dwellProgress: number;
}

/** How long an open palm must rest over an object before the menu appears. */
export const PALM_DWELL_MS = 700;

export interface GestureControllerOptions {
  scene: SpatialScene;
  dwellMs?: number;
  /** Mirrors the camera image horizontally, matching a selfie-view preview. */
  mirrored?: boolean;
}

export class GestureController {
  readonly #scene: SpatialScene;
  readonly #dwellMs: number;
  readonly #mirrored: boolean;
  readonly #listeners = new Set<(state: ControllerState) => void>();

  #mode: GestureMode = 'idle';
  #draggingId: string | null = null;
  #menu: ActionMenuState | null = null;

  /** Offset from the pinch point to the object centre, so it does not jump. */
  #grabOffset = { x: 0, y: 0 };
  #wasPinching = false;
  #dwellStartedAt: number | null = null;
  #dwellObjectId: string | null = null;
  #dwellProgress = 0;

  constructor(options: GestureControllerOptions) {
    this.#scene = options.scene;
    this.#dwellMs = options.dwellMs ?? PALM_DWELL_MS;
    this.#mirrored = options.mirrored ?? true;
  }

  get state(): ControllerState {
    return {
      mode: this.#mode,
      draggingId: this.#draggingId,
      menu: this.#menu,
      dwellProgress: this.#dwellProgress,
    };
  }

  /** True when the previous frame was pinching, for recognition hysteresis. */
  get wasPinching(): boolean {
    return this.#wasPinching;
  }

  subscribe(listener: (state: ControllerState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const state = this.state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // A broken listener must not break gesture handling.
      }
    }
  }

  /**
   * The camera preview is mirrored, so a hand moving right appears to move
   * right on screen. Landmark x must be flipped to match what the user sees.
   */
  #toScreen(point: { x: number; y: number }): { x: number; y: number } {
    return { x: this.#mirrored ? 1 - point.x : point.x, y: point.y };
  }

  /** Feed one gesture frame. Returns the resulting state. */
  update(frame: GestureFrame): ControllerState {
    const previousMode = this.#mode;
    const previousMenu = this.#menu;
    const previousDwell = this.#dwellProgress;

    // --- pinch and drag ---
    if (frame.pinch.active && frame.pinch.position) {
      const point = this.#toScreen(frame.pinch.position);

      if (this.#draggingId === null) {
        const hit = this.#scene.hitTest(point);
        if (hit) {
          this.#draggingId = hit.id;
          // Preserve the grab offset so the object does not snap its centre to
          // the fingers the instant it is picked up.
          this.#grabOffset = { x: hit.x - point.x, y: hit.y - point.y };
          this.#scene.select(hit.id);
          this.#scene.bringToFront(hit.id);
          this.#mode = 'dragging';
          // Starting a drag dismisses any open menu.
          this.#menu = null;
          this.#resetDwell();
        }
      } else {
        this.#scene.move(
          this.#draggingId,
          point.x + this.#grabOffset.x,
          point.y + this.#grabOffset.y,
        );
      }

      this.#wasPinching = true;
      if (this.#mode !== previousMode || this.#menu !== previousMenu) this.#notify();
      return this.state;
    }

    // Pinch released: drop whatever was held.
    if (this.#draggingId !== null) {
      this.#draggingId = null;
      this.#mode = 'idle';
    }
    this.#wasPinching = false;

    // --- open palm dwell reveals actions ---
    if (frame.openHand && frame.hands.length > 0) {
      const palm = this.#toScreen(frame.hands[0]?.palm ?? { x: 0.5, y: 0.5 });
      const hit = this.#scene.hitTest(palm);

      if (hit) {
        if (this.#dwellObjectId !== hit.id) {
          // Moving to a different object restarts the dwell.
          this.#dwellObjectId = hit.id;
          this.#dwellStartedAt = frame.timestamp;
        }
        const elapsed = frame.timestamp - (this.#dwellStartedAt ?? frame.timestamp);
        this.#dwellProgress = Math.min(1, elapsed / this.#dwellMs);

        if (this.#dwellProgress >= 1) {
          this.#menu = { objectId: hit.id, x: hit.x, y: hit.y };
          this.#mode = 'menu';
          this.#scene.select(hit.id);
        }

        if (this.#mode !== previousMode || this.#dwellProgress !== previousDwell) this.#notify();
        return this.state;
      }
    }

    // No qualifying gesture. An open menu stays until dismissed or acted on,
    // so the user can lower their hand and choose with the mouse.
    this.#resetDwell();
    if (this.#mode === 'dragging') this.#mode = this.#menu ? 'menu' : 'idle';
    if (this.#mode !== previousMode || this.#dwellProgress !== previousDwell) this.#notify();
    return this.state;
  }

  #resetDwell(): void {
    this.#dwellStartedAt = null;
    this.#dwellObjectId = null;
    this.#dwellProgress = 0;
  }

  /**
   * Open the action menu directly, without a dwell.
   *
   * This is the mouse fallback for holding a palm over an object: a
   * right-click reaches the same menu and the same actions, so the two input
   * methods cannot drift apart in what they can do.
   */
  openMenuFor(objectId: string): boolean {
    const object = this.#scene.get(objectId);
    if (!object) return false;

    this.#menu = { objectId, x: object.x, y: object.y };
    this.#mode = 'menu';
    this.#draggingId = null;
    this.#resetDwell();
    this.#notify();
    return true;
  }

  dismissMenu(): void {
    if (!this.#menu && this.#mode !== 'menu') return;
    this.#menu = null;
    this.#mode = 'idle';
    this.#resetDwell();
    this.#notify();
  }

  /** Drop all interaction state, e.g. when tracking stops. */
  reset(): void {
    this.#draggingId = null;
    this.#menu = null;
    this.#mode = 'idle';
    this.#wasPinching = false;
    this.#resetDwell();
    this.#notify();
  }
}
