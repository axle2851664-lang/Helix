import { useEffect, useRef } from 'react';
import {
  createCamera,
  distanceToFrame,
  flightComplete,
  flyTo,
  hitTest,
  orbit,
  project,
  sampleFlight,
  zoom,
  type Camera,
  type Flight,
  type Projected,
} from './camera.js';
import { GalaxyLayout } from '../../vault/layout3d.js';
import type { NoteType, VaultEdge, VaultNode } from '../../vault/VaultGraph.js';

/**
 * The knowledge galaxy.
 *
 * Notes as points in space, drawn back to front so depth reads correctly, with
 * the camera flying to whichever note is being talked about. The flight is the
 * point of the whole thing: an answer that says where it came from is worth
 * more than one that does not, and watching the view travel to the note makes
 * the source impossible to miss.
 *
 * Everything that could be wrong in a way that still looks plausible - the
 * projection, the depth ordering, the flight easing - lives in `camera.ts` and
 * is tested there. This file draws, and does nothing clever.
 */

const TYPE_COLOURS: Record<NoteType, string> = {
  client: '#e0243c',
  project: '#e08a24',
  meeting: '#4ba3e3',
  invoice: '#35c759',
  note: '#8c8794',
  missing: '#55505a',
};

/** Below this the label is unreadable and only adds noise. */
const LABEL_SCALE_FLOOR = 0.9;
const MAX_LABELS = 26;

export interface GalaxyCanvasProps {
  nodes: readonly VaultNode[];
  edges: readonly VaultEdge[];
  focusedId: string | null;
  /** Set to fly the camera to a note. */
  flyToId: string | null;
  onFocus: (id: string | null) => void;
}

export function GalaxyCanvas({ nodes, edges, focusedId, flyToId, onFocus }: GalaxyCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef(new GalaxyLayout());
  const cameraRef = useRef<Camera>(createCamera());
  const flightRef = useRef<Flight | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const projectedRef = useRef(new Map<string, Projected>());
  const needsFitRef = useRef(true);

  // Rebuilt only when the graph itself changes: reloading on every render
  // would restart the settling and the galaxy would never come to rest.
  useEffect(() => {
    layoutRef.current.load(nodes, edges);
    layoutRef.current.settle(160);
    needsFitRef.current = true;
  }, [nodes, edges]);

  /** Fly to a note when asked. */
  useEffect(() => {
    if (!flyToId) return;
    const node = layoutRef.current.get(flyToId);
    if (!node) return;

    flightRef.current = flyTo(
      cameraRef.current,
      {
        target: { x: node.x, y: node.y, z: node.z },
        // Close enough to read it, far enough to keep its neighbours in frame.
        distance: 320,
      },
      { now: performance.now() },
    );
  }, [flyToId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frame = 0;
    let running = true;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = () => {
      if (!running) return;
      const now = performance.now();
      const layout = layoutRef.current;
      const rect = canvas.getBoundingClientRect();
      const viewport = { width: rect.width, height: rect.height };

      if (!layout.settled) layout.step();

      // Fit once the canvas has a real size. Doing it earlier fits to zero and
      // leaves the galaxy in a pinhole in the corner.
      if (needsFitRef.current && viewport.width > 0) {
        cameraRef.current = createCamera({
          distance: distanceToFrame(layout.extent()),
        });
        needsFitRef.current = false;
      }

      const flight = flightRef.current;
      if (flight) {
        cameraRef.current = sampleFlight(flight, now);
        if (flightComplete(flight, now)) flightRef.current = null;
      }

      const camera = cameraRef.current;
      context.clearRect(0, 0, viewport.width, viewport.height);

      // Project once, reuse for edges, nodes, labels and hit-testing.
      const projected = new Map<string, Projected>();
      for (const node of layout.nodes) {
        projected.set(node.id, project({ x: node.x, y: node.y, z: node.z }, camera, viewport));
      }
      projectedRef.current = projected;

      const focused = focusedId ?? hoveredRef.current;
      const connected = new Set<string>();
      if (focused) {
        connected.add(focused);
        for (const edge of edges) {
          if (edge.source === focused) connected.add(edge.target);
          if (edge.target === focused) connected.add(edge.source);
        }
      }

      // --- edges, behind everything ---
      context.lineWidth = 1;
      for (const edge of edges) {
        const from = projected.get(edge.source);
        const to = projected.get(edge.target);
        if (!from?.visible || !to?.visible) continue;

        const lit = focused ? connected.has(edge.source) && connected.has(edge.target) : false;
        context.strokeStyle = lit
          ? 'rgba(224, 36, 60, 0.5)'
          : focused
            ? 'rgba(255, 255, 255, 0.03)'
            : 'rgba(255, 255, 255, 0.07)';

        context.beginPath();
        context.moveTo(from.x, from.y);
        context.lineTo(to.x, to.y);
        context.stroke();
      }

      // --- nodes, furthest first, so nearer ones paint over them ---
      const ordered = [...layout.nodes]
        .map((node) => ({ node, point: projected.get(node.id) }))
        .filter((entry): entry is { node: (typeof layout.nodes)[number]; point: Projected } =>
          entry.point !== undefined && entry.point.visible,
        )
        .sort((a, b) => b.point.depth - a.point.depth);

      const byId = new Map(nodes.map((node) => [node.id, node]));

      for (const { node, point } of ordered) {
        const source = byId.get(node.id);
        if (!source) continue;

        const dimmed = focused !== null && !connected.has(node.id);
        const radius = Math.max(1.2, node.radius * point.scale);

        context.globalAlpha = dimmed ? 0.12 : 1;
        context.fillStyle = TYPE_COLOURS[source.type];
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();

        if (node.id === focused) {
          context.globalAlpha = 1;
          context.strokeStyle = '#ffffff';
          context.lineWidth = 1.5;
          context.beginPath();
          context.arc(point.x, point.y, radius + 4, 0, Math.PI * 2);
          context.stroke();
        }
      }

      // --- labels, nearest and largest first, capped ---
      context.globalAlpha = 1;
      context.font = '11px ui-sans-serif, system-ui, sans-serif';
      context.textAlign = 'center';

      const labelled = ordered
        .slice()
        .reverse()
        .filter(({ point }) => point.scale > LABEL_SCALE_FLOOR)
        .slice(0, MAX_LABELS);

      for (const { node, point } of labelled) {
        const source = byId.get(node.id);
        if (!source) continue;
        if (focused !== null && !connected.has(node.id)) continue;

        context.fillStyle = 'rgba(236, 236, 238, 0.82)';
        context.fillText(
          source.title.length > 22 ? `${source.title.slice(0, 21)}…` : source.title,
          point.x,
          point.y - Math.max(1.2, node.radius * point.scale) - 6,
        );
      }

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [nodes, edges, focusedId]);

  /* ------------------------------ input ------------------------------ */

  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const pointFor = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const hitAt = (x: number, y: number): string | null =>
    hitTest(
      [...projectedRef.current.entries()].map(([id, point]) => ({
        id,
        projected: point,
        radius: layoutRef.current.get(id)?.radius ?? 4,
      })),
      x,
      y,
    );

  return (
    <canvas
      ref={canvasRef}
      className="hx-galaxy__canvas"
      onMouseDown={(event) => {
        const point = pointFor(event);
        dragRef.current = { ...point, moved: false };
      }}
      onMouseMove={(event) => {
        const point = pointFor(event);
        const drag = dragRef.current;

        if (drag) {
          const dx = point.x - drag.x;
          const dy = point.y - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;

          // Dragging takes the camera, so a flight in progress is abandoned:
          // fighting the user for control is worse than not flying.
          flightRef.current = null;
          cameraRef.current = orbit(cameraRef.current, dx * 0.006, -dy * 0.006);
          dragRef.current = { x: point.x, y: point.y, moved: drag.moved };
          return;
        }
        hoveredRef.current = hitAt(point.x, point.y);
      }}
      onMouseUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag?.moved) return;

        const point = pointFor(event);
        onFocus(hitAt(point.x, point.y));
      }}
      onMouseLeave={() => {
        dragRef.current = null;
        hoveredRef.current = null;
      }}
      onWheel={(event) => {
        flightRef.current = null;
        cameraRef.current = zoom(cameraRef.current, event.deltaY > 0 ? 1.12 : 0.89);
      }}
    />
  );
}
