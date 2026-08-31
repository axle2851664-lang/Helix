import { useMemo, useState } from 'react';
import { GraphCanvas } from './GraphCanvas.js';
import { Icon } from '../components/Icon.js';
import { VaultGraph, type NoteType, type VaultNode } from '../../vault/VaultGraph.js';
import { generateDemoVault } from '../../vault/demoVault.js';
import { isDemo } from '../../vault/config.js';

/**
 * The vault graph workspace: canvas in the centre, inspector left, filters
 * right, matching the layout in the brief.
 *
 * The graph is built once from the configured vault. In demo mode that is the
 * seeded fixtures, so the arrangement is identical every run.
 */

const TYPE_LABELS: Record<NoteType, string> = {
  client: 'Clients',
  project: 'Projects',
  meeting: 'Meetings',
  invoice: 'Invoices',
  note: 'Notes',
  missing: 'Not written',
};

const TYPE_COLOURS: Record<NoteType, string> = {
  client: '#e0243c',
  project: '#e08a24',
  meeting: '#4ba3e3',
  invoice: '#35c759',
  note: '#8c8794',
  missing: '#55505a',
};

const ALL_TYPES: NoteType[] = ['client', 'project', 'meeting', 'invoice', 'note', 'missing'];

export function GraphWorkspace() {
  // Built once: rebuilding on every render would restart the layout.
  const graph = useMemo(() => VaultGraph.build(generateDemoVault()), []);

  const [hidden, setHidden] = useState<Set<NoteType>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pathIds, setPathIds] = useState<string[]>([]);

  const stats = useMemo(() => graph.stats(), [graph]);

  const visible = useMemo(() => {
    const nodes = graph.nodes.filter((node) => !hidden.has(node.type));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges };
  }, [graph, hidden]);

  const focused = focusedId ? graph.get(focusedId) : undefined;

  const toggleType = (type: NoteType) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  /** Shift-click traces from the focused note to the clicked one. */
  const trace = (id: string) => {
    if (!focusedId || focusedId === id) {
      setFocusedId(id);
      setPathIds([]);
      return;
    }
    const path = graph.shortestPath(focusedId, id);
    setPathIds(path.map((node) => node.id));
  };

  const focus = (id: string | null) => {
    setFocusedId(id);
    setPathIds([]);
  };

  return (
    <div className="hx-graph">
      {/* ---------------- left: inspector and hubs ---------------- */}
      <aside className="hx-graph__side">
        <section className="hx-panel">
          <h2 className="hx-panel__title">Inspector</h2>
          {focused ? (
            <>
              <div className="hx-graph__title">{focused.title}</div>
              <div className="hx-graph__meta">
                <span className="hx-tag" style={{ color: TYPE_COLOURS[focused.type] }}>
                  {TYPE_LABELS[focused.type]}
                </span>
                <span>{focused.degree} links</span>
              </div>

              {focused.missing ? (
                <p className="hx-muted">
                  This note is linked to but has never been written, sir.
                </p>
              ) : (
                <>
                  <p className="hx-graph__path">{focused.path}</p>
                  <pre className="hx-graph__content">{focused.content}</pre>
                </>
              )}

              <h3 className="hx-panel__title">Links out</h3>
              <NodeList
                nodes={graph.outgoing(focused.id)}
                empty="Nothing."
                onSelect={focus}
              />

              <h3 className="hx-panel__title">Links in</h3>
              <NodeList
                nodes={graph.incoming(focused.id)}
                empty="Nothing."
                onSelect={focus}
              />
            </>
          ) : (
            <p className="hx-muted">
              Click a node to inspect it, sir. Shift-click a second to trace the shortest path
              between them.
            </p>
          )}
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Top hubs</h2>
          <ol className="hx-hublist">
            {graph.hubs(10).map((node) => (
              <li key={node.id}>
                <button type="button" className="hx-hublist__row" onClick={() => focus(node.id)}>
                  <span
                    className="hx-hublist__dot"
                    style={{ background: TYPE_COLOURS[node.type] }}
                  />
                  <span className="hx-hublist__name">{node.title}</span>
                  <span className="hx-hublist__count">{node.degree}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      </aside>

      {/* ---------------- centre: the graph ---------------- */}
      <div className="hx-graph__stage">
        <GraphCanvas
          nodes={visible.nodes}
          edges={visible.edges}
          focusedId={focusedId}
          pathIds={pathIds}
          onFocus={focus}
          onTrace={trace}
        />

        {pathIds.length > 0 && (
          <div className="hx-graph__path-banner">
            <Icon name="activity" size={14} />
            {pathIds.length === 1
              ? 'Same note.'
              : `${pathIds.length - 1} ${pathIds.length === 2 ? 'hop' : 'hops'}: ` +
                pathIds.map((id) => graph.get(id)?.title ?? id).join(' → ')}
            <button type="button" className="hx-btn hx-btn--quiet" onClick={() => setPathIds([])}>
              Clear
            </button>
          </div>
        )}

        {pathIds.length === 0 && focusedId && (
          <div className="hx-graph__hint">Shift-click another node to trace a path.</div>
        )}
      </div>

      {/* ---------------- right: filters ---------------- */}
      <aside className="hx-graph__side hx-graph__side--right">
        <section className="hx-panel">
          <h2 className="hx-panel__title">Filter</h2>
          {ALL_TYPES.map((type) => {
            const count = stats.byType[type];
            if (count === 0) return null;
            const on = !hidden.has(type);
            return (
              <button
                key={type}
                type="button"
                className={`hx-filter${on ? ' hx-filter--on' : ''}`}
                onClick={() => toggleType(type)}
                aria-pressed={on}
              >
                <span className="hx-filter__dot" style={{ background: TYPE_COLOURS[type] }} />
                <span className="hx-filter__name">{TYPE_LABELS[type]}</span>
                <span className="hx-filter__count">{count}</span>
              </button>
            );
          })}
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Vault</h2>
          <div className="hx-row">
            <span className="hx-row__label">Showing</span>
            <span className="hx-row__value">
              {visible.nodes.length} of {stats.nodes}
            </span>
          </div>
          <div className="hx-row">
            <span className="hx-row__label">Links</span>
            <span className="hx-row__value">{visible.edges.length}</span>
          </div>
          <div className="hx-row">
            <span className="hx-row__label">Orphans</span>
            <span className="hx-row__value">{stats.orphans}</span>
          </div>
          <p className="hx-settings__note">
            {isDemo()
              ? 'Demo fixtures, sir. Invented, seeded, and identical every run - safe to record.'
              : 'Your configured folders.'}
          </p>
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Controls</h2>
          <ul className="hx-list">
            <li>Drag the background to pan, scroll to zoom.</li>
            <li>Drag a node to move it; it settles back in.</li>
            <li>Click to inspect, shift-click to trace a path.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function NodeList({
  nodes,
  empty,
  onSelect,
}: {
  nodes: readonly VaultNode[];
  empty: string;
  onSelect: (id: string) => void;
}) {
  if (nodes.length === 0) return <p className="hx-muted">{empty}</p>;
  return (
    <ul className="hx-linklist">
      {nodes.map((node) => (
        <li key={node.id}>
          <button type="button" className="hx-linklist__row" onClick={() => onSelect(node.id)}>
            <span className="hx-linklist__dot" style={{ background: TYPE_COLOURS[node.type] }} />
            {node.title}
            {node.missing && <span className="hx-tag">not written</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
