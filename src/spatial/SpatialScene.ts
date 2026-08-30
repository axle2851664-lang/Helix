import type { EventBus } from '../core/EventBus.js';

/**
 * Spatial object state (spec 12).
 *
 * Positions are normalised 0..1 against the viewport, so an object stays where
 * the user put it when the window resizes and when the camera resolution
 * differs from the display. Gestures produce normalised coordinates too, which
 * means the same numbers drive both gesture and mouse input - the fallback is
 * genuinely the same code path, not a parallel implementation.
 */

export interface SpatialObject {
  id: string;
  label: string;
  /** Normalised centre, 0..1 of the viewport. */
  x: number;
  y: number;
  /** Relative size, 1 being the natural size. */
  scale: number;
  /** Rotation in radians. */
  rotation: number;
  /** Asset backing this object, when it came from a project. */
  assetId?: string;
  projectId?: string;
  /** Object-URL or data source for rendering. */
  src?: string;
}

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `obj_${random}`;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 6;

/** Keep an object at least partly on screen, so it cannot be lost off an edge. */
function clampPosition(value: number): number {
  return Math.min(1.05, Math.max(-0.05, value));
}

export class SpatialScene {
  #objects: SpatialObject[] = [];
  #selectedId: string | null = null;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(bus?: EventBus) {
    this.#bus = bus;
  }

  get objects(): readonly SpatialObject[] {
    return this.#objects;
  }

  get selectedId(): string | null {
    return this.#selectedId;
  }

  get selected(): SpatialObject | null {
    return this.#objects.find((object) => object.id === this.#selectedId) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not corrupt scene state.
      }
    }
  }

  add(object: Omit<SpatialObject, 'id'> & { id?: string }): SpatialObject {
    const created: SpatialObject = {
      id: object.id ?? newId(),
      label: object.label,
      x: clampPosition(object.x),
      y: clampPosition(object.y),
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, object.scale)),
      rotation: object.rotation,
      ...(object.assetId !== undefined ? { assetId: object.assetId } : {}),
      ...(object.projectId !== undefined ? { projectId: object.projectId } : {}),
      ...(object.src !== undefined ? { src: object.src } : {}),
    };
    this.#objects = [...this.#objects, created];
    this.#notify();
    return created;
  }

  get(id: string): SpatialObject | undefined {
    return this.#objects.find((object) => object.id === id);
  }

  /**
   * The object under a normalised point, topmost first.
   *
   * `radius` is the hit area in normalised units, scaled by the object's own
   * scale so a larger object is easier to grab - which is what the user
   * expects, and what makes pinching a small object at arm's length workable.
   */
  hitTest(point: { x: number; y: number }, radius = 0.09): SpatialObject | null {
    for (let i = this.#objects.length - 1; i >= 0; i -= 1) {
      const object = this.#objects[i];
      if (!object) continue;
      const reach = radius * Math.max(object.scale, 0.4);
      if (Math.hypot(object.x - point.x, object.y - point.y) <= reach) return object;
    }
    return null;
  }

  select(id: string | null): void {
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.#bus?.emit('SPATIAL_OBJECT_SELECTED', { objectId: id });
    this.#notify();
  }

  move(id: string, x: number, y: number): void {
    const object = this.get(id);
    if (!object) return;
    const nextX = clampPosition(x);
    const nextY = clampPosition(y);
    if (object.x === nextX && object.y === nextY) return;

    this.#objects = this.#objects.map((candidate) =>
      candidate.id === id ? { ...candidate, x: nextX, y: nextY } : candidate,
    );
    this.#bus?.emit('SPATIAL_OBJECT_MOVED', { objectId: id, position: [nextX, nextY, 0] });
    this.#notify();
  }

  setScale(id: string, scale: number): void {
    const object = this.get(id);
    if (!object) return;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    if (object.scale === next) return;

    this.#objects = this.#objects.map((candidate) =>
      candidate.id === id ? { ...candidate, scale: next } : candidate,
    );
    this.#bus?.emit('SPATIAL_OBJECT_SCALED', { objectId: id, scale: next });
    this.#notify();
  }

  setRotation(id: string, rotation: number): void {
    const object = this.get(id);
    if (!object) return;
    this.#objects = this.#objects.map((candidate) =>
      candidate.id === id ? { ...candidate, rotation } : candidate,
    );
    this.#bus?.emit('SPATIAL_OBJECT_ROTATED', { objectId: id, rotation: [0, 0, rotation] });
    this.#notify();
  }

  /** Copy an object, offset slightly so the duplicate is visibly distinct. */
  duplicate(id: string): SpatialObject | null {
    const object = this.get(id);
    if (!object) return null;

    const copy = this.add({
      ...object,
      id: newId(),
      label: object.label,
      x: object.x + 0.06,
      y: object.y + 0.06,
    });
    this.select(copy.id);
    return copy;
  }

  remove(id: string): boolean {
    const before = this.#objects.length;
    this.#objects = this.#objects.filter((object) => object.id !== id);
    if (this.#objects.length === before) return false;

    if (this.#selectedId === id) {
      this.#selectedId = null;
      this.#bus?.emit('SPATIAL_OBJECT_SELECTED', { objectId: null });
    }
    this.#notify();
    return true;
  }

  clear(): void {
    this.#objects = [];
    this.#selectedId = null;
    this.#notify();
  }

  /** Bring an object to the front, so a dragged object is not hidden. */
  bringToFront(id: string): void {
    const object = this.get(id);
    if (!object) return;
    this.#objects = [...this.#objects.filter((candidate) => candidate.id !== id), object];
    this.#notify();
  }
}
