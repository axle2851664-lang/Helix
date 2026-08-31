import { hashUnit, radiusForDegree } from './layout.js';
import type { VaultEdge, VaultNode } from './VaultGraph.js';

/**
 * The galaxy: the same force model as the flat graph, with a third axis.
 *
 * A separate file rather than a generalised N-dimensional layout. The flat
 * graph works, is tested, and is what most people will use; making it generic
 * to serve this would put every 2D behaviour at risk to save a page of
 * arithmetic. The duplication is the cheaper of the two costs, and the shared
 * parts - the seeded hash and the radius curve - are imported rather than
 * copied so the two cannot drift on the things that must agree.
 *
 * Seeded exactly like the flat layout, so the galaxy is the same galaxy every
 * time it is opened. Somewhere you have to be able to learn your way around
 * is the entire point of arranging notes in space; one that reshuffles on
 * every visit is a screensaver.
 */

export interface GalaxyNode {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  degree: number;
}

export interface GalaxyOptions {
  cutoff?: number;
  repulsion?: number;
  attraction?: number;
  gravity?: number;
  damping?: number;
}

const DEFAULTS = {
  cutoff: 220,
  // Higher than the flat layout: a third axis gives nodes somewhere else to
  // go, so the same figure produces a noticeably tighter cloud.
  repulsion: 5200,
  attraction: 0.008,
  gravity: 0.014,
  damping: 0.86,
} as const;

/**
 * Seeded points on a sphere.
 *
 * Spread by the inverse cosine rather than by a uniform angle: taking the
 * angle directly clusters everything at the poles, because a band near the
 * pole covers far less surface than one at the equator. It looks like a bug
 * in the layout when it is really a bug in the sampling.
 */
export function createGalaxyNodes(nodes: readonly VaultNode[]): GalaxyNode[] {
  return nodes.map((node) => {
    const theta = hashUnit(node.id, 1) * Math.PI * 2;
    const phi = Math.acos(2 * hashUnit(node.id, 2) - 1);
    const distance = 120 + hashUnit(node.id, 3) * 380;

    return {
      id: node.id,
      x: Math.sin(phi) * Math.cos(theta) * distance,
      y: Math.sin(phi) * Math.sin(theta) * distance,
      z: Math.cos(phi) * distance,
      vx: 0,
      vy: 0,
      vz: 0,
      radius: radiusForDegree(node.degree),
      degree: node.degree,
    };
  });
}

/**
 * A uniform grid in three dimensions.
 *
 * Same reasoning as the flat one: with cells the size of the repulsion cutoff,
 * everything that could push a node is in its own cell or one of the
 * twenty-six around it, so the scan is fixed rather than a walk over the
 * whole graph.
 */
class Grid3D {
  readonly #cells = new Map<string, GalaxyNode[]>();
  readonly #size: number;

  constructor(nodes: readonly GalaxyNode[], cellSize: number) {
    this.#size = cellSize;
    for (const node of nodes) {
      const key = this.#key(node.x, node.y, node.z);
      const cell = this.#cells.get(key);
      if (cell) cell.push(node);
      else this.#cells.set(key, [node]);
    }
  }

  #key(x: number, y: number, z: number): string {
    return `${Math.floor(x / this.#size)},${Math.floor(y / this.#size)},${Math.floor(z / this.#size)}`;
  }

  near(node: GalaxyNode): GalaxyNode[] {
    const cx = Math.floor(node.x / this.#size);
    const cy = Math.floor(node.y / this.#size);
    const cz = Math.floor(node.z / this.#size);
    const found: GalaxyNode[] = [];

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const cell = this.#cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (cell) found.push(...cell);
        }
      }
    }
    return found;
  }
}

export class GalaxyLayout {
  readonly #options: Required<GalaxyOptions>;
  #nodes: GalaxyNode[] = [];
  #index = new Map<string, GalaxyNode>();
  #edges: VaultEdge[] = [];
  #alpha = 1;

  constructor(options: GalaxyOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get nodes(): readonly GalaxyNode[] {
    return this.#nodes;
  }

  get settled(): boolean {
    return this.#alpha <= 0.02;
  }

  get(id: string): GalaxyNode | undefined {
    return this.#index.get(id);
  }

  load(nodes: readonly VaultNode[], edges: readonly VaultEdge[]): void {
    this.#nodes = createGalaxyNodes(nodes);
    this.#index = new Map(this.#nodes.map((node) => [node.id, node]));
    this.#edges = edges.filter(
      (edge) => this.#index.has(edge.source) && this.#index.has(edge.target),
    );
    this.#alpha = 1;
  }

  reheat(alpha = 0.6): void {
    this.#alpha = Math.max(this.#alpha, alpha);
  }

  step(): void {
    const { cutoff, repulsion, attraction, gravity, damping } = this.#options;
    const alpha = Math.max(this.#alpha, 0.006);
    const grid = new Grid3D(this.#nodes, cutoff);

    for (const node of this.#nodes) {
      for (const other of grid.near(node)) {
        if (other === node) continue;

        let dx = node.x - other.x;
        let dy = node.y - other.y;
        let dz = node.z - other.z;
        let distanceSquared = dx * dx + dy * dy + dz * dz;

        // Coincident nodes have no direction to separate along. Nudged
        // deterministically rather than dividing by zero and turning the whole
        // cloud into NaN, which is unrecoverable once it starts.
        if (distanceSquared === 0) {
          dx = (hashUnit(node.id, 4) - 0.5) * 0.01;
          dy = (hashUnit(node.id, 5) - 0.5) * 0.01;
          dz = (hashUnit(node.id, 6) - 0.5) * 0.01;
          distanceSquared = dx * dx + dy * dy + dz * dz || 1e-6;
        }

        if (distanceSquared > cutoff * cutoff) continue;

        const distance = Math.sqrt(distanceSquared);
        const force = (repulsion * alpha) / distanceSquared;
        node.vx += (dx / distance) * force;
        node.vy += (dy / distance) * force;
        node.vz += (dz / distance) * force;
      }
    }

    for (const edge of this.#edges) {
      const source = this.#index.get(edge.source);
      const target = this.#index.get(edge.target);
      if (!source || !target) continue;

      const force = attraction * alpha * Math.min(edge.weight, 3);
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dz = target.z - source.z;

      source.vx += dx * force;
      source.vy += dy * force;
      source.vz += dz * force;
      target.vx -= dx * force;
      target.vy -= dy * force;
      target.vz -= dz * force;
    }

    for (const node of this.#nodes) {
      node.vx -= node.x * gravity * alpha;
      node.vy -= node.y * gravity * alpha;
      node.vz -= node.z * gravity * alpha;

      node.vx *= damping;
      node.vy *= damping;
      node.vz *= damping;

      node.x += node.vx;
      node.y += node.vy;
      node.z += node.vz;
    }

    if (this.#alpha > 0.02) this.#alpha *= 0.97;
  }

  settle(steps = 220): void {
    for (let i = 0; i < steps; i += 1) this.step();
  }

  /** Radius of the cloud from its centre, for framing it in view. */
  extent(): number {
    let furthest = 0;
    for (const node of this.#nodes) {
      furthest = Math.max(furthest, Math.hypot(node.x, node.y, node.z) + node.radius);
    }
    return furthest;
  }
}
