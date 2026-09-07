import { useCallback, useEffect, useRef } from 'react';
import { ForceLayout } from '../../vault/layout.js';
import { placeLabels, truncateLabel, type LabelCandidate } from './labels.js';
import type { NoteType, VaultEdge, VaultNode } from '../../vault/VaultGraph.js';

/**
 * The vault graph, drawn on a canvas.
 *
 * Canvas rather than SVG: SVG needs a DOM node per circle and per line, and
 * stalls well before a real note collection gets interesting. One canvas and a
 * draw loop stays flat as the graph grows.
 */

const TYPE_COLOURS: Record<NoteType, string> = {
  client: '#e0243c',
  project: '#e08a24',
  meeting: '#4ba3e3',
  invoice: '#35c759',
  note: '#8c8794',
  missing: '#55505a',
};

/** Everything unrelated to the hovered node drops to this. */
const DIMMED_ALPHA = 0.1;

/** A pulse travels a random edge this often while the graph is idle. */
const PULSE_INTERVAL_MS = 3200;
const PULSE_DURATION_MS = 1400;

interface Pulse {
  edge: VaultEdge;
  startedAt: number;
}

export interface GraphCanvasProps {
  nodes: readonly VaultNode[];
  edges: readonly VaultEdge[];
  focusedId: string | null;
  /** Node ids on the traced shortest path, if any. */
  pathIds: readonly string[];
  onFocus: (id: string | null) => void;
  /** Shift-click: trace a path from the focused node to this one. */
  onTrace: (id: string) => void;
  /** Live force settings; omitted leaves the layout's own defaults. */
  forces?: { repulsion: number; attraction: number };
}

export function GraphCanvas({
  nodes,
  edges,
  focusedId,
  pathIds,
  onFocus,
  onTrace,
  forces,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef(new ForceLayout());
  const frameRef = useRef<number | null>(null);

  // View transform, and interaction state. Kept in refs so the draw loop reads
  // them without re-subscribing every frame.
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<{ kind: 'pan' | 'node'; id?: string; lastX: number; lastY: number } | null>(
    null,
  );
  const pulsesRef = useRef<Pulse[]>([]);
  const lastPulseRef = useRef(0);
  const needsFitRef = useRef(true);

  // Latest props for the draw loop, without restarting it each render.
  const propsRef = useRef({ nodes, edges, focusedId, pathIds });
  propsRef.current = { nodes, edges, focusedId, pathIds };

  // --- layout ---
  useEffect(() => {
    const layout = layoutRef.current;
    layout.load(nodes, edges);
    // Settle before the first paint so the graph appears arranged rather than
    // exploding outward while the user watches.
    layout.settle();

    // Defer the fit: on first render the canvas has no measured size yet, and
    // fitting to zero produces a cramped pile in the corner.
    needsFitRef.current = true;
  }, [nodes, edges]);

  // Forces are applied separately from loading, so moving a slider re-settles
  // the graph the user is looking at rather than rebuilding it from scratch.
  useEffect(() => {
    if (forces) layoutRef.current.configure(forces);
  }, [forces]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - view.x) / view.scale,
      y: (clientY - rect.top - view.y) / view.scale,
    };
  }, []);

  // --- draw loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const draw = () => {
      const layout = layoutRef.current;
      const { nodes: currentNodes, edges: currentEdges, focusedId: focus, pathIds: path } =
        propsRef.current;

      // Keep breathing: the layout never fully stops, so the graph feels alive.
      layout.step();

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio;
        canvas.height = height * ratio;
      }

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (needsFitRef.current && width > 0 && height > 0 && currentNodes.length > 0) {
        needsFitRef.current = false;
        const bounds = layout.bounds();
        const spanX = bounds.maxX - bounds.minX || 1;
        const spanY = bounds.maxY - bounds.minY || 1;
        const fitted = Math.min((width * 0.88) / spanX, (height * 0.88) / spanY, 2.2);
        viewRef.current = {
          scale: fitted,
          x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * fitted,
          y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * fitted,
        };
      }

      const view = viewRef.current;
      const hovered = hoverRef.current;
      const byId = new Map(currentNodes.map((node) => [node.id, node]));
      const pathSet = new Set(path);

      // Which nodes stay lit: the hovered one and its neighbours, or the
      // traced path when one exists.
      const lit = new Set<string>();
      if (hovered) {
        lit.add(hovered);
        for (const edge of currentEdges) {
          if (edge.source === hovered) lit.add(edge.target);
          if (edge.target === hovered) lit.add(edge.source);
        }
      }
      const dimming = hovered !== null || pathSet.size > 0;

      const screen = (x: number, y: number) => ({
        x: x * view.scale + view.x,
        y: y * view.scale + view.y,
      });

      const isLit = (id: string) =>
        !dimming || lit.has(id) || pathSet.has(id) || id === focus;

      // --- edges ---
      context.lineCap = 'round';
      for (const edge of currentEdges) {
        const a = layout.get(edge.source);
        const b = layout.get(edge.target);
        if (!a || !b) continue;

        const onPath =
          pathSet.has(edge.source) && pathSet.has(edge.target) &&
          Math.abs(path.indexOf(edge.source) - path.indexOf(edge.target)) === 1;
        const active = onPath || (isLit(edge.source) && isLit(edge.target));

        const from = screen(a.x, a.y);
        const to = screen(b.x, b.y);

        context.globalAlpha = onPath ? 0.95 : active ? 0.28 : DIMMED_ALPHA * 0.6;
        context.strokeStyle = onPath ? '#e0243c' : '#ffffff';
        context.lineWidth = onPath ? 2.2 : Math.min(edge.weight, 3) * 0.6;

        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }

      // --- idle pulses along random links ---
      const now = performance.now();
      if (
        currentEdges.length > 0 &&
        now - lastPulseRef.current > PULSE_INTERVAL_MS &&
        !dimming
      ) {
        lastPulseRef.current = now;
        const edge = currentEdges[Math.floor(Math.random() * currentEdges.length)];
        if (edge) pulsesRef.current.push({ edge, startedAt: now });
      }

      pulsesRef.current = pulsesRef.current.filter(
        (pulse) => now - pulse.startedAt < PULSE_DURATION_MS,
      );

      for (const pulse of pulsesRef.current) {
        const a = layout.get(pulse.edge.source);
        const b = layout.get(pulse.edge.target);
        if (!a || !b) continue;

        const progress = (now - pulse.startedAt) / PULSE_DURATION_MS;
        const from = screen(a.x, a.y);
        const to = screen(b.x, b.y);
        const px = from.x + (to.x - from.x) * progress;
        const py = from.y + (to.y - from.y) * progress;

        // Fades in and out rather than appearing and vanishing.
        context.globalAlpha = Math.sin(progress * Math.PI) * 0.7;
        context.fillStyle = '#e0243c';
        context.beginPath();
        context.arc(px, py, 2.4, 0, Math.PI * 2);
        context.fill();
      }

      // --- nodes ---
      const labelCandidates: LabelCandidate[] = [];
      context.font = '11px ui-monospace, monospace';

      for (const node of currentNodes) {
        const position = layout.get(node.id);
        if (!position) continue;

        const point = screen(position.x, position.y);
        const radius = position.radius * Math.min(view.scale, 1.4);

        // Skip anything off-screen before drawing it.
        if (
          point.x + radius < 0 ||
          point.y + radius < 0 ||
          point.x - radius > width ||
          point.y - radius > height
        ) {
          continue;
        }

        const active = isLit(node.id);
        context.globalAlpha = active ? 1 : DIMMED_ALPHA;

        // Hovering lifts the node: a soft halo, not a size jump, so the layout
        // does not appear to shift under the cursor.
        if (node.id === hovered || node.id === focus) {
          context.beginPath();
          context.arc(point.x, point.y, radius + 7, 0, Math.PI * 2);
          context.fillStyle = 'rgba(224, 36, 60, 0.18)';
          context.fill();
        }

        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fillStyle = TYPE_COLOURS[node.type];
        context.fill();

        // A missing note is drawn hollow: it is referenced but not written.
        if (node.missing) {
          context.globalAlpha = active ? 0.9 : DIMMED_ALPHA;
          context.strokeStyle = '#0b0708';
          context.lineWidth = 2;
          context.stroke();
        }

        if (node.id === focus) {
          context.globalAlpha = 1;
          context.strokeStyle = '#ffffff';
          context.lineWidth = 2;
          context.beginPath();
          context.arc(point.x, point.y, radius + 3, 0, Math.PI * 2);
          context.stroke();
        }

        if (active) {
          const text = truncateLabel(node.title);
          labelCandidates.push({
            id: node.id,
            text,
            x: point.x,
            y: point.y,
            radius,
            priority: node.degree,
            width: context.measureText(text).width,
          });
        }
      }

      // --- labels, most-connected first, collisions rejected ---
      const labels = placeLabels(labelCandidates, { viewport: { width, height } });
      context.globalAlpha = 1;
      context.fillStyle = '#ececee';
      context.textBaseline = 'top';

      for (const label of labels) {
        const node = byId.get(label.id);
        context.globalAlpha = node && node.missing ? 0.55 : 0.85;
        context.fillText(label.text, label.x, label.y);
      }

      context.globalAlpha = 1;
      frameRef.current = requestAnimationFrame(draw);
    };

    frameRef.current = requestAnimationFrame(draw);

    const observer = new ResizeObserver(() => {
      needsFitRef.current = true;
    });
    observer.observe(canvas);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      observer.disconnect();
    };
  }, []);

  // --- interaction ---
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const world = toWorld(event.clientX, event.clientY);
    const hit = layoutRef.current.hitTest(world.x, world.y);

    if (hit) {
      if (event.shiftKey) {
        onTrace(hit.id);
        return;
      }
      onFocus(hit.id);
      dragRef.current = { kind: 'node', id: hit.id, lastX: event.clientX, lastY: event.clientY };
      layoutRef.current.pin(hit.id, world.x, world.y);
    } else {
      dragRef.current = { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;

    if (!drag) {
      const world = toWorld(event.clientX, event.clientY);
      const hit = layoutRef.current.hitTest(world.x, world.y);
      hoverRef.current = hit?.id ?? null;
      event.currentTarget.style.cursor = hit ? 'pointer' : 'grab';
      return;
    }

    if (drag.kind === 'pan') {
      viewRef.current.x += event.clientX - drag.lastX;
      viewRef.current.y += event.clientY - drag.lastY;
    } else if (drag.id) {
      const world = toWorld(event.clientX, event.clientY);
      layoutRef.current.pin(drag.id, world.x, world.y);
    }

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.kind === 'node' && drag.id) {
      layoutRef.current.unpin(drag.id);
      // Let the graph re-settle around where the node was dropped.
      layoutRef.current.reheat(0.25);
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(4, Math.max(0.15, view.scale * factor));

    // Zoom toward the cursor, not the origin, so the point under the pointer
    // stays put.
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    view.x = px - ((px - view.x) / view.scale) * next;
    view.y = py - ((py - view.y) / view.scale) * next;
    view.scale = next;
  };

  return (
    <canvas
      ref={canvasRef}
      className="hx-graph__canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        hoverRef.current = null;
      }}
      onWheel={onWheel}
      aria-label="Vault graph"
    />
  );
}
