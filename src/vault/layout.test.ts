import { describe, expect, it } from 'vitest';
import { ForceLayout, createLayoutNodes, radiusForDegree } from './layout.js';
import { VaultGraph, type VaultDocument } from './VaultGraph.js';
import { generateDemoVault } from './demoVault.js';
import { placeLabels, truncateLabel, type LabelCandidate } from '../ui/graph/labels.js';

const doc = (path: string, content: string): VaultDocument => ({
  path,
  fileName: path.split('/').pop() as string,
  content,
  sizeBytes: content.length,
});

describe('radiusForDegree', () => {
  it('grows with connections so hubs are visibly bigger', () => {
    expect(radiusForDegree(20)).toBeGreaterThan(radiusForDegree(2));
  });

  // Square root, not linear: a 40-link node must not be ten times the width.
  it('grows sub-linearly', () => {
    const small = radiusForDegree(4);
    const large = radiusForDegree(40);
    expect(large / small).toBeLessThan(3);
  });

  it('gives an isolated node a visible radius', () => {
    expect(radiusForDegree(0)).toBeGreaterThan(0);
  });
});

describe('createLayoutNodes', () => {
  const graph = VaultGraph.build(generateDemoVault());

  // A graph that rearranges itself on every reload cannot be discussed.
  it('is deterministic for the same vault', () => {
    const a = createLayoutNodes(graph.nodes);
    const b = createLayoutNodes(graph.nodes);
    expect(b.map((n) => [n.id, n.x, n.y])).toEqual(a.map((n) => [n.id, n.x, n.y]));
  });

  it('spreads nodes out rather than stacking them', () => {
    const nodes = createLayoutNodes(graph.nodes);
    const positions = new Set(nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
    // Nearly all distinct: a few collisions are tolerable, a pile is not.
    expect(positions.size).toBeGreaterThan(nodes.length * 0.9);
  });
});

describe('ForceLayout', () => {
  const graph = VaultGraph.build(generateDemoVault());

  /**
   * The sliders move forces on a layout the user is already looking at, so
   * configure has to do two things: take the new value, and wake a settled
   * layout up. Without the second, dragging a slider on a still graph would
   * appear to do nothing at all.
   */
  it('revives a settled layout when the forces change', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();
    expect(layout.settled).toBe(true);

    layout.configure({ repulsion: 5000 });

    expect(layout.settled).toBe(false);
    expect(layout.alpha).toBeGreaterThanOrEqual(0.35);
  });

  it('keeps the positions it had when forces change', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    const before = layout.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }));
    layout.configure({ repulsion: 5000 });
    const after = layout.nodes;

    // Rebuilding instead of mutating would scatter the galaxy on every drag.
    expect(after).toHaveLength(before.length);
    expect(after[0]?.x).toBe(before[0]?.x);
    expect(after[0]?.y).toBe(before[0]?.y);
  });

  it('settles from its initial state', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);

    expect(layout.settled).toBe(false);
    layout.settle();
    expect(layout.settled).toBe(true);
  });

  it('keeps every node finite while settling', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x), node.id).toBe(true);
      expect(Number.isFinite(node.y), node.id).toBe(true);
    }
  });

  it('produces the same layout every run', () => {
    const first = new ForceLayout();
    first.load(graph.nodes, graph.edges);
    first.settle(120);

    const second = new ForceLayout();
    second.load(graph.nodes, graph.edges);
    second.settle(120);

    expect(second.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)])).toEqual(
      first.nodes.map((n) => [n.id, Math.round(n.x), Math.round(n.y)]),
    );
  });

  // Coincident nodes have no direction to separate along; the code nudges them
  // rather than dividing by zero and producing NaN.
  it('separates exactly coincident nodes without producing NaN', () => {
    const layout = new ForceLayout();
    const stacked = [
      { id: 'a', title: 'A', type: 'note' as const, degree: 0, missing: false },
      { id: 'b', title: 'B', type: 'note' as const, degree: 0, missing: false },
    ];
    layout.load(stacked, []);
    // Force them onto the same point.
    layout.pin('a', 0, 0);
    layout.pin('b', 0, 0);
    layout.unpin('a');
    layout.unpin('b');

    layout.settle(60);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('pulls connected nodes closer than unconnected ones', () => {
    const linked = VaultGraph.build([
      doc('Notes/A.md', '# A\n\n[[B]]'),
      doc('Notes/B.md', '# B\n\n[[A]]'),
      doc('Notes/Far.md', '# Far'),
    ]);

    const layout = new ForceLayout();
    layout.load(linked.nodes, linked.edges);
    layout.settle(400);

    const a = layout.get('a');
    const b = layout.get('b');
    const far = layout.get('far');
    if (!a || !b || !far) throw new Error('nodes missing');

    const linkedDistance = Math.hypot(a.x - b.x, a.y - b.y);
    const looseDistance = Math.min(
      Math.hypot(a.x - far.x, a.y - far.y),
      Math.hypot(b.x - far.x, b.y - far.y),
    );
    expect(linkedDistance).toBeLessThan(looseDistance);
  });

  it('holds a pinned node exactly where it was put', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    const target = graph.nodes[0] as { id: string };

    layout.pin(target.id, 123, -45);
    layout.settle(80);

    const node = layout.get(target.id);
    expect(node?.x).toBe(123);
    expect(node?.y).toBe(-45);
  });

  it('releases a node when unpinned', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    const target = graph.nodes[0] as { id: string };

    layout.pin(target.id, 500, 500);
    layout.unpin(target.id);
    layout.settle(120);

    const node = layout.get(target.id);
    expect(node?.x).not.toBe(500);
  });

  it('hit-tests a node at its position', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    const target = graph.nodes[0] as { id: string };
    layout.pin(target.id, 200, 200);

    expect(layout.hitTest(200, 200)?.id).toBe(target.id);
    expect(layout.hitTest(2000, 2000)).toBeNull();
  });

  it('reports bounds that contain every node', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();

    const bounds = layout.bounds();
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(node.x).toBeLessThanOrEqual(bounds.maxX);
    }
  });

  it('handles an empty graph', () => {
    const layout = new ForceLayout();
    layout.load([], []);
    expect(() => layout.settle(10)).not.toThrow();
    expect(layout.bounds()).toBeTruthy();
  });

  it('ignores edges whose endpoints were filtered out', () => {
    const layout = new ForceLayout();
    const single = [{ id: 'a', title: 'A', type: 'note' as const, degree: 1, missing: false }];
    layout.load(single, [{ source: 'a', target: 'gone', weight: 1 }]);
    expect(() => layout.settle(20)).not.toThrow();
  });

  it('reheats after settling, so a filter change re-animates', () => {
    const layout = new ForceLayout();
    layout.load(graph.nodes, graph.edges);
    layout.settle();
    expect(layout.settled).toBe(true);

    layout.reheat();
    expect(layout.settled).toBe(false);
  });

  /**
   * The performance claim behind using a spatial grid. A graph an order of
   * magnitude larger must not cost two orders of magnitude more time.
   */
  it('scales close to linearly with node count', () => {
    const build = (count: number) => {
      const nodes = Array.from({ length: count }, (_, i) => ({
        id: `n${i}`,
        title: `N${i}`,
        type: 'note' as const,
        degree: 2,
        missing: false,
      }));
      const edges = Array.from({ length: count - 1 }, (_, i) => ({
        source: `n${i}`,
        target: `n${i + 1}`,
        weight: 1,
      }));
      return { nodes, edges };
    };

    const time = (count: number) => {
      const { nodes, edges } = build(count);
      const layout = new ForceLayout();
      layout.load(nodes, edges);
      const started = performance.now();
      layout.settle(30);
      return performance.now() - started;
    };

    // Warm the JIT so the first measurement is not penalised.
    time(200);

    const small = Math.max(time(300), 0.5);
    const large = time(3000);

    // Ten times the nodes, well under a hundred times the work.
    expect(large / small).toBeLessThan(40);
  });
});

describe('label placement', () => {
  const candidate = (
    id: string,
    x: number,
    y: number,
    priority: number,
    width = 60,
  ): LabelCandidate => ({ id, text: id, x, y, radius: 6, priority, width });

  it('places a label for an isolated node', () => {
    const placed = placeLabels([candidate('a', 100, 100, 5)]);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.id).toBe('a');
  });

  // The whole point: overlapping text is worse than fewer labels.
  it('skips a label that would collide with one already placed', () => {
    const placed = placeLabels([
      candidate('hub', 100, 100, 20),
      candidate('overlapping', 104, 100, 3),
    ]);

    expect(placed).toHaveLength(1);
    expect(placed[0]?.id).toBe('hub');
  });

  it('gives the most-connected node the space', () => {
    const placed = placeLabels([
      candidate('small', 100, 100, 1),
      candidate('big', 102, 100, 50),
    ]);

    expect(placed[0]?.id).toBe('big');
  });

  it('places labels that do not collide', () => {
    const placed = placeLabels([
      candidate('a', 100, 100, 5),
      candidate('b', 400, 400, 5),
    ]);
    expect(placed).toHaveLength(2);
  });

  it('skips labels outside the viewport before any collision work', () => {
    const placed = placeLabels([candidate('offscreen', -900, -900, 10)], {
      viewport: { width: 800, height: 600 },
    });
    expect(placed).toEqual([]);
  });

  it('honours the label cap', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      candidate(`n${i}`, i * 200, i * 200, 5),
    );
    expect(placeLabels(many, { maxLabels: 10 })).toHaveLength(10);
  });

  it('drops labels below the priority floor', () => {
    const placed = placeLabels([candidate('quiet', 100, 100, 0)], { minPriority: 1 });
    expect(placed).toEqual([]);
  });

  // Sort ties must be stable, or labels flicker in and out between frames.
  it('is stable across repeated calls', () => {
    const items = [
      candidate('a', 100, 100, 5),
      candidate('b', 103, 100, 5),
      candidate('c', 106, 100, 5),
    ];
    expect(placeLabels(items).map((l) => l.id)).toEqual(placeLabels(items).map((l) => l.id));
  });

  it('truncates a long title rather than overflowing', () => {
    expect(truncateLabel('a'.repeat(40), 10)).toHaveLength(10);
    expect(truncateLabel('short', 10)).toBe('short');
  });
});
