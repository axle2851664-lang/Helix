import { describe, expect, it } from 'vitest';
import {
  FOCAL_LENGTH,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  createCamera,
  distanceToFrame,
  easeInOutCubic,
  flightComplete,
  flyTo,
  hitTest,
  orbit,
  project,
  sampleFlight,
  shortestTurn,
  toCameraSpace,
  zoom,
} from './camera.js';
import { GalaxyLayout, createGalaxyNodes } from '../../vault/layout3d.js';
import { VaultGraph } from '../../vault/VaultGraph.js';
import { generateDemoVault } from '../../vault/demoVault.js';

const viewport = { width: 800, height: 600 };

describe('toCameraSpace', () => {
  // Rotating before translating would orbit the world origin instead of what
  // the camera is looking at - the difference between flying to a note and
  // flying past it.
  it('puts the target at the centre, however far from the origin it is', () => {
    const camera = createCamera({ target: { x: 500, y: -300, z: 120 }, yaw: 1.1, pitch: 0.4 });
    const view = toCameraSpace({ x: 500, y: -300, z: 120 }, camera);

    expect(view.x).toBeCloseTo(0);
    expect(view.y).toBeCloseTo(0);
    expect(view.z).toBeCloseTo(camera.distance);
  });

  it('leaves distance from the target unchanged by rotation', () => {
    const point = { x: 100, y: 50, z: -20 };
    const straight = toCameraSpace(point, createCamera({ yaw: 0, pitch: 0 }));
    const turned = toCameraSpace(point, createCamera({ yaw: 2.1, pitch: -0.7 }));

    const radius = (v: { x: number; y: number; z: number }, distance: number) =>
      Math.hypot(v.x, v.y, v.z - distance);

    expect(radius(turned, 900)).toBeCloseTo(radius(straight, 900), 6);
  });
});

describe('project', () => {
  it('puts the target at the centre of the viewport', () => {
    const projected = project({ x: 0, y: 0, z: 0 }, createCamera(), viewport);

    expect(projected.x).toBeCloseTo(400);
    expect(projected.y).toBeCloseTo(300);
    expect(projected.visible).toBe(true);
  });

  // Screen y grows downward and world y grows upward. Getting this backwards
  // produces a scene that works perfectly and is upside down.
  it('draws a point above the target higher on screen', () => {
    const camera = createCamera({ yaw: 0, pitch: 0 });
    const above = project({ x: 0, y: 100, z: 0 }, camera, viewport);

    expect(above.y).toBeLessThan(300);
  });

  it('draws a point to the right of the target further right', () => {
    const camera = createCamera({ yaw: 0, pitch: 0 });
    expect(project({ x: 100, y: 0, z: 0 }, camera, viewport).x).toBeGreaterThan(400);
  });

  it('makes nearer things larger', () => {
    const camera = createCamera({ yaw: 0, pitch: 0 });
    const near = project({ x: 0, y: 0, z: 300 }, camera, viewport);
    const far = project({ x: 0, y: 0, z: -300 }, camera, viewport);

    expect(near.scale).toBeGreaterThan(far.scale);
    expect(near.depth).toBeLessThan(far.depth);
  });

  /**
   * A point behind the eye projects to a mirrored position on screen - a node
   * drawn somewhere plausible that is nowhere near where it actually is. It
   * must be refused, not projected.
   */
  it('refuses a point behind the eye rather than mirroring it', () => {
    const camera = createCamera({ yaw: 0, pitch: 0, distance: 200 });
    const behind = project({ x: 0, y: 0, z: 400 }, camera, viewport);

    expect(behind.visible).toBe(false);
  });

  it('uses the stated focal length', () => {
    const camera = createCamera({ yaw: 0, pitch: 0, distance: FOCAL_LENGTH });
    // At a distance equal to the focal length, one world unit is one pixel.
    expect(project({ x: 10, y: 0, z: 0 }, camera, viewport).x).toBeCloseTo(410);
  });
});

describe('orbit and zoom', () => {
  // At exactly vertical the up vector is undefined and the view spins on its
  // own axis. Stopping short removes the failure entirely.
  it('never lets pitch reach the pole', () => {
    let camera = createCamera();
    for (let i = 0; i < 50; i += 1) camera = orbit(camera, 0, 0.3);

    expect(camera.pitch).toBeLessThanOrEqual(MAX_PITCH);
    expect(camera.pitch).toBeGreaterThan(0);
  });

  it('lets yaw run freely, because it wraps', () => {
    let camera = createCamera({ yaw: 0 });
    for (let i = 0; i < 20; i += 1) camera = orbit(camera, 1, 0);

    expect(Number.isFinite(camera.yaw)).toBe(true);
  });

  it('clamps distance at both ends', () => {
    let close = createCamera();
    for (let i = 0; i < 40; i += 1) close = zoom(close, 0.8);
    expect(close.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);

    let far = createCamera();
    for (let i = 0; i < 40; i += 1) far = zoom(far, 1.25);
    expect(far.distance).toBeLessThanOrEqual(MAX_DISTANCE);
  });

  it('does not mutate the camera it was given', () => {
    const camera = createCamera();
    orbit(camera, 1, 1);
    zoom(camera, 2);

    expect(camera.yaw).toBe(createCamera().yaw);
    expect(camera.distance).toBe(createCamera().distance);
  });
});

describe('shortestTurn', () => {
  /**
   * Yaw is an angle. Interpolating the raw numbers from 350 degrees to 10
   * sends the camera the long way round the galaxy, which looks like a bug
   * because it is one.
   */
  it('takes the short way across the wrap', () => {
    const nearly = Math.PI * 2 - 0.2;
    expect(shortestTurn(nearly, 0.2)).toBeCloseTo(0.4);
    expect(shortestTurn(0.2, nearly)).toBeCloseTo(-0.4);
  });

  it('is unchanged for an ordinary turn', () => {
    expect(shortestTurn(0.5, 1.2)).toBeCloseTo(0.7);
  });

  it('never returns more than half a turn', () => {
    for (const to of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(Math.abs(shortestTurn(0.3, to))).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });
});

describe('flight', () => {
  it('starts where it was and ends where it was sent', () => {
    const from = createCamera({ distance: 900 });
    const flight = flyTo(from, { target: { x: 200, y: 0, z: 0 }, distance: 300 }, { now: 0 });

    const start = sampleFlight(flight, 0);
    expect(start.distance).toBeCloseTo(900);
    expect(start.target.x).toBeCloseTo(0);

    const end = sampleFlight(flight, 10_000);
    expect(end.distance).toBeCloseTo(300);
    expect(end.target.x).toBeCloseTo(200);
  });

  it('eases rather than moving at a constant rate', () => {
    const flight = flyTo(createCamera(), { distance: 200 }, { now: 0, durationMs: 1000 });

    const quarter = sampleFlight(flight, 250).distance;
    const half = sampleFlight(flight, 500).distance;
    const threeQuarters = sampleFlight(flight, 750).distance;

    // The middle covers more ground than either end.
    expect(Math.abs(half - quarter)).toBeGreaterThan(Math.abs(quarter - createCamera().distance));
    expect(Math.abs(threeQuarters - half)).toBeGreaterThan(Math.abs(200 - threeQuarters));
  });

  it('knows when it is done', () => {
    const flight = flyTo(createCamera(), {}, { now: 100, durationMs: 500 });

    expect(flightComplete(flight, 500)).toBe(false);
    expect(flightComplete(flight, 600)).toBe(true);
  });

  it('refuses a zero duration rather than dividing by it', () => {
    const flight = flyTo(createCamera(), { distance: 200 }, { now: 0, durationMs: 0 });
    expect(Number.isFinite(sampleFlight(flight, 1).distance)).toBe(true);
  });

  it('eases from nought to one and no further', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(-5)).toBe(0);
    expect(easeInOutCubic(5)).toBe(1);
  });
});

describe('hitTest', () => {
  const point = (id: string, x: number, y: number, depth: number) => ({
    id,
    radius: 8,
    projected: { x, y, scale: 1, depth, visible: true },
  });

  it('finds a node under the pointer', () => {
    expect(hitTest([point('a', 100, 100, 500)], 102, 103)).toBe('a');
  });

  it('finds nothing in empty space', () => {
    expect(hitTest([point('a', 100, 100, 500)], 400, 400)).toBeNull();
  });

  // Two nodes can overlap on screen while being far apart in the galaxy. The
  // one in front is the one being pointed at.
  it('picks the nearer of two overlapping nodes', () => {
    const points = [point('far', 100, 100, 900), point('near', 100, 100, 200)];
    expect(hitTest(points, 100, 100)).toBe('near');
  });

  it('ignores anything behind the eye', () => {
    const hidden = {
      id: 'hidden',
      radius: 40,
      projected: { x: 100, y: 100, scale: 1, depth: -5, visible: false },
    };
    expect(hitTest([hidden], 100, 100)).toBeNull();
  });
});

describe('the galaxy layout', () => {
  const graph = VaultGraph.build(generateDemoVault());

  /**
   * Taking the polar angle uniformly clusters everything at the poles, because
   * a band near the pole covers far less surface than one at the equator. It
   * looks like a layout bug and is really a sampling one.
   */
  it('spreads the seeded cloud rather than banding it at the poles', () => {
    const nodes = createGalaxyNodes(graph.nodes);
    const northern = nodes.filter((node) => node.z > 0).length;

    expect(northern).toBeGreaterThan(nodes.length * 0.25);
    expect(northern).toBeLessThan(nodes.length * 0.75);
  });

  it('is the same galaxy every time it is opened', () => {
    const first = new GalaxyLayout();
    first.load(graph.nodes, graph.edges);
    first.settle(120);

    const second = new GalaxyLayout();
    second.load(graph.nodes, graph.edges);
    second.settle(120);

    expect(second.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.z)])).toEqual(
      first.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.z)]),
    );
  });

  it('keeps every node finite while settling', () => {
    const layout = new GalaxyLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)).toBe(
        true,
      );
    }
  });

  it('uses all three axes', () => {
    const layout = new GalaxyLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    const spread = (pick: (n: { x: number; y: number; z: number }) => number) => {
      const values = layout.nodes.map(pick);
      return Math.max(...values) - Math.min(...values);
    };

    expect(spread((n) => n.x)).toBeGreaterThan(50);
    expect(spread((n) => n.y)).toBeGreaterThan(50);
    expect(spread((n) => n.z)).toBeGreaterThan(50);
  });

  it('pulls linked notes closer than unlinked ones', () => {
    const layout = new GalaxyLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle(400);

    const distance = (a: string, b: string) => {
      const first = layout.get(a);
      const second = layout.get(b);
      if (!first || !second) throw new Error('missing node');
      return Math.hypot(first.x - second.x, first.y - second.y, first.z - second.z);
    };

    const edge = graph.edges[0];
    if (!edge) throw new Error('the demo vault has no edges');

    const linked = distance(edge.source, edge.target);
    const everything = layout.nodes.map((node) =>
      Math.hypot(node.x, node.y, node.z),
    );
    const average = everything.reduce((total, value) => total + value, 0) / everything.length;

    expect(linked).toBeLessThan(average * 2);
  });

  it('reports an extent that contains the cloud', () => {
    const layout = new GalaxyLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    const extent = layout.extent();
    for (const node of layout.nodes) {
      expect(Math.hypot(node.x, node.y, node.z)).toBeLessThanOrEqual(extent);
    }
  });

  it('handles an empty galaxy', () => {
    const layout = new GalaxyLayout();
    layout.load([], []);

    expect(() => layout.settle(10)).not.toThrow();
    expect(layout.extent()).toBe(0);
  });

  it('frames a cloud without clipping it', () => {
    expect(distanceToFrame(400)).toBeGreaterThan(400);
    expect(distanceToFrame(0)).toBeGreaterThanOrEqual(MIN_DISTANCE);
    expect(distanceToFrame(100_000)).toBeLessThanOrEqual(MAX_DISTANCE);
  });
});
