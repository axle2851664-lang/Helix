/**
 * The galaxy camera: orbit, perspective, and flight to a node.
 *
 * Kept entirely separate from anything that draws, because camera maths fails
 * quietly. A wrong sign produces a scene that looks like a scene - it orbits,
 * it has depth, the nodes move - and is inside out, and nobody notices until
 * they try to point at something specific. So every part of it is a pure
 * function with a test that says which way round it should be.
 *
 * No 3D library. This is one rotation, one perspective divide and an easing
 * curve; a renderer would be several hundred kilobytes to do arithmetic that
 * fits on a screen, and it would bring its own scene graph to reconcile with
 * the force layout that already exists.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Camera {
  /** The point the camera looks at and orbits around. */
  target: Vec3;
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  /** Rotation above and below the horizon, radians. */
  pitch: number;
  /** How far back the eye sits from the target. */
  distance: number;
}

export interface Projected {
  /** Screen pixels. */
  x: number;
  y: number;
  /** Size multiplier from perspective: nearer is larger. */
  scale: number;
  /** Distance from the eye, for painter's-algorithm ordering. */
  depth: number;
  /** False when the point is behind the eye and must not be drawn. */
  visible: boolean;
}

/**
 * Pitch stops short of the poles.
 *
 * At exactly vertical the up vector is undefined and the view spins on its own
 * axis - the classic gimbal flip. Stopping a few degrees short costs nothing
 * anyone will notice and removes the failure entirely.
 */
export const MAX_PITCH = (85 * Math.PI) / 180;

export const MIN_DISTANCE = 120;
export const MAX_DISTANCE = 4000;

/** Focal length in pixels. Larger is a longer lens and less dramatic depth. */
export const FOCAL_LENGTH = 900;

export function createCamera(overrides: Partial<Camera> = {}): Camera {
  return {
    target: { x: 0, y: 0, z: 0 },
    yaw: 0.6,
    pitch: 0.35,
    distance: 900,
    ...overrides,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * World point into the camera's own frame.
 *
 * Translate so the target is the origin, spin by yaw, tilt by pitch, then push
 * the eye back along z. Order matters: rotating before translating would orbit
 * the world origin rather than whatever the camera is looking at, which is
 * the difference between flying to a note and flying past it.
 */
export function toCameraSpace(point: Vec3, camera: Camera): Vec3 {
  const dx = point.x - camera.target.x;
  const dy = point.y - camera.target.y;
  const dz = point.z - camera.target.z;

  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x1 = dx * cosYaw - dz * sinYaw;
  const z1 = dx * sinYaw + dz * cosYaw;

  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const y2 = dy * cosPitch - z1 * sinPitch;
  const z2 = dy * sinPitch + z1 * cosPitch;

  // Depth counts away from the eye, and world z counts toward it: a node with
  // a larger z is nearer the viewer, which is the convention everything else
  // in this file and the renderer assumes. Adding rather than subtracting here
  // produces a scene that orbits correctly and is inside out.
  return { x: x1, y: y2, z: camera.distance - z2 };
}

/**
 * Camera frame to screen.
 *
 * Anything at or behind the eye is marked invisible rather than projected: a
 * point with a negative depth produces a mirrored position on screen, which
 * draws a node in a plausible place that is nowhere near where it is.
 */
export function project(
  point: Vec3,
  camera: Camera,
  viewport: { width: number; height: number },
): Projected {
  const view = toCameraSpace(point, camera);
  const near = 1;

  if (view.z <= near) {
    return { x: 0, y: 0, scale: 0, depth: view.z, visible: false };
  }

  const scale = FOCAL_LENGTH / view.z;
  return {
    x: viewport.width / 2 + view.x * scale,
    // Screen y grows downward; world y grows upward.
    y: viewport.height / 2 - view.y * scale,
    scale,
    depth: view.z,
    visible: true,
  };
}

export function orbit(camera: Camera, deltaYaw: number, deltaPitch: number): Camera {
  return {
    ...camera,
    yaw: camera.yaw + deltaYaw,
    pitch: clamp(camera.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH),
  };
}

export function zoom(camera: Camera, factor: number): Camera {
  return {
    ...camera,
    distance: clamp(camera.distance * factor, MIN_DISTANCE, MAX_DISTANCE),
  };
}

/* ------------------------------------------------------------------ */
/* Flight                                                             */
/* ------------------------------------------------------------------ */

export interface Flight {
  from: Camera;
  to: Camera;
  startedAt: number;
  durationMs: number;
}

export const DEFAULT_FLIGHT_MS = 900;

/** Slow at both ends, quick in the middle. */
export function easeInOutCubic(t: number): number {
  const clamped = clamp(t, 0, 1);
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/**
 * Take the short way round.
 *
 * Yaw is an angle, so 350 degrees to 10 degrees is a twenty-degree turn and
 * not a three-hundred-and-forty-degree one. Interpolating the raw numbers
 * sends the camera the long way round the galaxy, which looks like a bug
 * because it is one.
 */
export function shortestTurn(from: number, to: number): number {
  const full = Math.PI * 2;
  let delta = (to - from) % full;

  if (delta > Math.PI) delta -= full;
  if (delta < -Math.PI) delta += full;
  return delta;
}

export function flyTo(
  from: Camera,
  to: Partial<Camera>,
  options: { now?: number; durationMs?: number } = {},
): Flight {
  return {
    from,
    to: { ...from, ...to },
    startedAt: options.now ?? 0,
    durationMs: Math.max(1, options.durationMs ?? DEFAULT_FLIGHT_MS),
  };
}

/** Where the camera is partway through a flight. */
export function sampleFlight(flight: Flight, now: number): Camera {
  const progress = easeInOutCubic((now - flight.startedAt) / flight.durationMs);
  const { from, to } = flight;
  const mix = (a: number, b: number) => a + (b - a) * progress;

  return {
    target: {
      x: mix(from.target.x, to.target.x),
      y: mix(from.target.y, to.target.y),
      z: mix(from.target.z, to.target.z),
    },
    yaw: from.yaw + shortestTurn(from.yaw, to.yaw) * progress,
    pitch: mix(from.pitch, to.pitch),
    distance: mix(from.distance, to.distance),
  };
}

export function flightComplete(flight: Flight, now: number): boolean {
  return now >= flight.startedAt + flight.durationMs;
}

/**
 * Pick the node nearest a click.
 *
 * Depth is the tie-breaker, not the distance in pixels alone: two nodes can
 * overlap on screen while being far apart in the galaxy, and the one in front
 * is the one being pointed at.
 */
export function hitTest(
  points: ReadonlyArray<{ id: string; projected: Projected; radius: number }>,
  x: number,
  y: number,
  slack = 6,
): string | null {
  let best: { id: string; depth: number } | null = null;

  for (const point of points) {
    if (!point.projected.visible) continue;

    const reach = point.radius * point.projected.scale + slack;
    const dx = point.projected.x - x;
    const dy = point.projected.y - y;
    if (dx * dx + dy * dy > reach * reach) continue;

    if (best === null || point.projected.depth < best.depth) {
      best = { id: point.id, depth: point.projected.depth };
    }
  }
  return best?.id ?? null;
}

/** A distance that frames a cluster of this radius without clipping it. */
export function distanceToFrame(radius: number): number {
  return clamp(Math.max(radius, 40) * 3.2, MIN_DISTANCE, MAX_DISTANCE);
}
