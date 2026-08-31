import type { VaultEdge, VaultNode } from './VaultGraph.js';

/**
 * Force-directed layout for the vault graph.
 *
 * The cost that matters is repulsion. Every node pushing every other node is
 * O(n squared), which stalls well before a real note collection gets
 * interesting. Instead nodes are binned into a uniform spatial grid and only
 * compared against neighbours within a cutoff radius, which makes the work
 * proportional to node count for any realistically spread-out graph.
 *
 * Pure and deterministic: positions are seeded from node identity rather than
 * Math.random, so the same vault produces the same layout every run. A graph
 * that rearranges itself on every reload is impossible to talk about.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Drawn radius, derived from connection count. */
  radius: number;
  degree: number;
  /** Held in place while being dragged. */
  pinned: boolean;
}

export interface LayoutOptions {
  /** Repulsion beyond this distance is ignored; the basis of the grid. */
  cutoff?: number;
  repulsion?: number;
  /** Spring stiffness along edges. */
  attraction?: number;
  /** Pull toward the origin, so disconnected parts do not drift away. */
  gravity?: number;
  damping?: number;
}

const DEFAULTS = {
  cutoff: 180,
  repulsion: 2400,
  attraction: 0.006,
  gravity: 0.012,
  damping: 0.86,
} as const;

/** Radius from connection count, so hubs are visibly bigger. */
export function radiusForDegree(degree: number): number {
  // Square root, not linear: a node with 40 links should read as bigger than
  // one with 4, without being ten times the width and swamping the view.
  return 4 + Math.sqrt(degree) * 3.2;
}

/** Deterministic 0..1 from a string, so layouts are reproducible. */
export function hashUnit(text: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

export function createLayoutNodes(nodes: readonly VaultNode[]): LayoutNode[] {
  // Seeded ring placement: spread out enough that repulsion has somewhere to
  // push, and identical between runs.
  return nodes.map((node) => {
    const angle = hashUnit(node.id, 1) * Math.PI * 2;
    const distance = 60 + hashUnit(node.id, 2) * 340;
    return {
      id: node.id,
      x: Math.cos(angle) * distance,
      y: Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      radius: radiusForDegree(node.degree),
      degree: node.degree,
      pinned: false,
    };
  });
}

/**
 * A uniform grid over the nodes, binned by the repulsion cutoff.
 *
 * With a cell the size of the cutoff, every node that could possibly repel
 * another is in the same cell or one of the eight around it, so the search is
 * a fixed nine-cell scan rather than a walk over the whole graph.
 */
class SpatialGrid {
  readonly #cells = new Map<string, LayoutNode[]>();
  readonly #size: number;

  constructor(nodes: readonly LayoutNode[], cellSize: number) {
    this.#size = cellSize;
    for (const node of nodes) {
      const key = this.#key(node.x, node.y);
      const cell = this.#cells.get(key);
      if (cell) cell.push(node);
      else this.#cells.set(key, [node]);
    }
  }

  #key(x: number, y: number): string {
    return `${Math.floor(x / this.#size)},${Math.floor(y / this.#size)}`;
  }

  /** Nodes in this node's cell and the eight surrounding it. */
  near(node: LayoutNode): LayoutNode[] {
    const cx = Math.floor(node.x / this.#size);
    const cy = Math.floor(node.y / this.#size);
    const found: LayoutNode[] = [];

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = this.#cells.get(`${cx + dx},${cy + dy}`);
        if (cell) found.push(...cell);
      }
    }
    return found;
  }

  get cellCount(): number {
    return this.#cells.size;
  }
}

export class ForceLayout {
  readonly #options: Required<LayoutOptions>;
  #nodes: LayoutNode[] = [];
  #index = new Map<string, LayoutNode>();
  #edges: VaultEdge[] = [];
  /** Falls toward zero as the layout settles, then holds for the drift. */
  #alpha = 1;

  constructor(options: LayoutOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get nodes(): readonly LayoutNode[] {
    return this.#nodes;
  }

  get alpha(): number {
    return this.#alpha;
  }

  /** True once the layout has stopped moving meaningfully. */
  get settled(): boolean {
    return this.#alpha <= 0.02;
  }

  get(id: string): LayoutNode | undefined {
    return this.#index.get(id);
  }

  load(nodes: readonly VaultNode[], edges: readonly VaultEdge[]): void {
    this.#nodes = createLayoutNodes(nodes);
    this.#index = new Map(this.#nodes.map((node) => [node.id, node]));
    // Edges to nodes that are filtered out would pull against nothing.
    this.#edges = edges.filter(
      (edge) => this.#index.has(edge.source) && this.#index.has(edge.target),
    );
    this.#alpha = 1;
  }

  /** Restart the settling motion, e.g. after a filter change. */
  reheat(alpha = 0.6): void {
    this.#alpha = Math.max(this.#alpha, alpha);
  }

  pin(id: string, x: number, y: number): void {
    const node = this.#index.get(id);
    if (!node) return;
    node.pinned = true;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
  }

  unpin(id: string): void {
    const node = this.#index.get(id);
    if (node) node.pinned = false;
  }

  /** Advance the simulation one frame. */
  step(): void {
    const { cutoff, repulsion, attraction, gravity, damping } = this.#options;
    // A floor rather than zero: the graph keeps breathing once settled, which
    // reads as alive without ever drifting anywhere.
    const alpha = Math.max(this.#alpha, 0.008);
    const grid = new SpatialGrid(this.#nodes, cutoff);

    // --- repulsion, only within the cutoff ---
    for (const node of this.#nodes) {
      if (node.pinned) continue;

      for (const other of grid.near(node)) {
        if (other === node) continue;

        let dx = node.x - other.x;
        let dy = node.y - other.y;
        let distanceSquared = dx * dx + dy * dy;

        // Exactly coincident nodes have no direction to separate along;
        // nudge them deterministically rather than dividing by zero.
        if (distanceSquared === 0) {
          dx = (hashUnit(node.id, 3) - 0.5) * 0.01;
          dy = (hashUnit(node.id, 4) - 0.5) * 0.01;
          distanceSquared = dx * dx + dy * dy || 1e-6;
        }

        if (distanceSquared > cutoff * cutoff) continue;

        const distance = Math.sqrt(distanceSquared);
        const force = (repulsion * alpha) / distanceSquared;
        node.vx += (dx / distance) * force;
        node.vy += (dy / distance) * force;
      }
    }

    // --- attraction along edges ---
    for (const edge of this.#edges) {
      const source = this.#index.get(edge.source);
      const target = this.#index.get(edge.target);
      if (!source || !target) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const force = attraction * alpha * Math.min(edge.weight, 3);

      if (!source.pinned) {
        source.vx += dx * force;
        source.vy += dy * force;
      }
      if (!target.pinned) {
        target.vx -= dx * force;
        target.vy -= dy * force;
      }
    }

    // --- gravity and integration ---
    for (const node of this.#nodes) {
      if (node.pinned) continue;

      node.vx -= node.x * gravity * alpha;
      node.vy -= node.y * gravity * alpha;

      node.vx *= damping;
      node.vy *= damping;

      node.x += node.vx;
      node.y += node.vy;
    }

    if (this.#alpha > 0.02) this.#alpha *= 0.97;
  }

  /** Run many steps at once, to settle before the first paint. */
  settle(steps = 220): void {
    for (let i = 0; i < steps; i += 1) this.step();
  }

  /** The node under a point, topmost first. Null when the point is empty. */
  hitTest(x: number, y: number, slack = 6): LayoutNode | null {
    for (let i = this.#nodes.length - 1; i >= 0; i -= 1) {
      const node = this.#nodes[i];
      if (!node) continue;
      if (Math.hypot(node.x - x, node.y - y) <= node.radius + slack) return node;
    }
    return null;
  }

  /** Bounding box of the laid-out graph, for fitting it to the viewport. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    if (this.#nodes.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of this.#nodes) {
      minX = Math.min(minX, node.x - node.radius);
      minY = Math.min(minY, node.y - node.radius);
      maxX = Math.max(maxX, node.x + node.radius);
      maxY = Math.max(maxY, node.y + node.radius);
    }
    return { minX, minY, maxX, maxY };
  }
}
