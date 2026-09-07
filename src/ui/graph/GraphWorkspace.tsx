import { useEffect, useMemo, useState } from 'react';
import { GraphCanvas } from './GraphCanvas.js';
import { GalaxyCanvas } from './GalaxyCanvas.js';
import { Icon } from '../components/Icon.js';
import { VaultGraph, type NoteType, type VaultNode } from '../../vault/VaultGraph.js';
import { generateDemoVault } from '../../vault/demoVault.js';
import { REAL_VAULT, isDemo, realVaultBlocker } from '../../vault/config.js';
import { useHelix } from '../HelixProvider.js';
import type { VaultDocument } from '../../vault/VaultGraph.js';

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
  const { platform } = useHelix();

  // In real mode the documents are read from disk, so they arrive after the
  // first render; in demo mode they are synchronous fixtures. Null means "not
  // read yet", which is what separates loading from a genuinely empty vault.
  const [documents, setDocuments] = useState<readonly VaultDocument[] | null>(
    isDemo() ? generateDemoVault() : null
  );

  useEffect(() => {
    if (isDemo()) return;

    let cancelled = false;
    void platform
      .readVaultDocuments({
        roots: REAL_VAULT.roots,
        maxFileBytes: REAL_VAULT.maxFileBytes,
        ignoredDirectories: REAL_VAULT.ignoredDirectories,
      })
      .then((files) => {
        if (cancelled) return;
        setDocuments(
          files.map((file) => ({
            path: file.path,
            fileName: file.fileName,
            content: file.content,
            sizeBytes: file.sizeBytes,
          }))
        );
      });

    // A vault read that outlives the screen must not set state on the way out.
    return () => {
      cancelled = true;
    };
  }, [platform]);

  // Rebuilt only when the documents change: rebuilding on every render would
  // restart the layout.
  const graph = useMemo(() => VaultGraph.build(documents ?? []), [documents]);

  // The flat graph is kept, not replaced. It is better for tracing a path
  // and reading many labels at once; the galaxy is better for finding your
  // way around and for watching the view travel to a note.
  const [view, setView] = useState<'flat' | 'galaxy'>('flat');
  const [flyToId, setFlyToId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<NoteType>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pathIds, setPathIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  // Sliders in the reference are Repel and Link length. Link length is the
  // inverse of spring stiffness: a longer link is a weaker pull.
  const [repel, setRepel] = useState(2400);
  const [linkLength, setLinkLength] = useState(50);

  const forces = useMemo(
    () => ({ repulsion: repel, attraction: 0.012 - (linkLength / 100) * 0.011 }),
    [repel, linkLength]
  );

  const stats = useMemo(() => graph.stats(), [graph]);

  /**
   * Why the graph looks the way it does. An empty galaxy has several very
   * different causes - still reading, no folders configured, a host that
   * cannot reach a filesystem, or genuinely no notes - and showing nothing
   * without saying which is the state this screen was worst at.
   */
  const vaultNote = useMemo(() => {
    if (isDemo()) {
      return 'Demo fixtures, sir. Invented, seeded, and identical every run - safe to record.';
    }
    const blocker = realVaultBlocker();
    if (blocker) return blocker;
    if (!platform.capabilities.filesystem.available) {
      return platform.capabilities.filesystem.reason ?? 'This host cannot read your folders.';
    }
    if (documents === null) return 'Reading your folders...';
    if (documents.length === 0) {
      return `No notes found in ${REAL_VAULT.roots.join(', ')}. Markdown and text files only.`;
    }
    return `${documents.length} file${documents.length === 1 ? '' : 's'} from ${REAL_VAULT.roots.join(', ')}.`;
  }, [documents, platform]);

  const visible = useMemo(() => {
    const nodes = graph.nodes.filter((node) => !hidden.has(node.type));
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges };
  }, [graph, hidden]);

  const focused = focusedId ? graph.get(focusedId) : undefined;

  /** Title search. Empty query means no list, not every note. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    return graph.nodes
      .filter((node) => node.title.toLowerCase().includes(needle))
      .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title))
      .slice(0, 12);
  }, [graph, query]);

  /** Most-connected notes, which is the fastest way into an unfamiliar vault. */
  const hubs = useMemo(() => graph.hubs(8), [graph]);

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
    // In the galaxy, selecting a note is also an instruction to go and look at
    // it. A new object each time, so choosing the same note twice flies again
    // rather than being swallowed as an unchanged value.
    if (id && view === 'galaxy') setFlyToId(id);
  };

  return (
    <div className="hx-graph">
      {/* ---------------- left: inspector and hubs ---------------- */}
      <aside className="hx-graph__side">
        <section className="hx-panel">
          <h2 className="hx-panel__title">Search</h2>
          <input
            className="hx-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the vault..."
            aria-label="Search notes by title"
          />
          {query.trim() !== '' && (
            <NodeList nodes={matches} empty="No note by that name." onSelect={focus} />
          )}
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Top hubs</h2>
          <NodeList
            nodes={hubs}
            empty="Nothing linked yet."
            onSelect={focus}
          />
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Forces</h2>
          <label className="hx-field">
            <span className="hx-field__label">Repel</span>
            <input
              type="range"
              min={400}
              max={6000}
              step={100}
              value={repel}
              onChange={(event) => setRepel(Number(event.target.value))}
            />
          </label>
          <label className="hx-field">
            <span className="hx-field__label">Link length</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={linkLength}
              onChange={(event) => setLinkLength(Number(event.target.value))}
            />
          </label>
        </section>

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
        <div className="hx-graph__views" role="group" aria-label="Graph view">
          <button
            type="button"
            className={`hx-chip${view === 'flat' ? ' hx-chip--on' : ''}`}
            aria-pressed={view === 'flat'}
            onClick={() => setView('flat')}
          >
            Flat
          </button>
          <button
            type="button"
            className={`hx-chip${view === 'galaxy' ? ' hx-chip--on' : ''}`}
            aria-pressed={view === 'galaxy'}
            onClick={() => {
              setView('galaxy');
              if (focusedId) setFlyToId(focusedId);
            }}
          >
            Galaxy
          </button>
        </div>

        {view === 'flat' ? (
          <GraphCanvas
            nodes={visible.nodes}
            edges={visible.edges}
            focusedId={focusedId}
            pathIds={pathIds}
            onFocus={focus}
            onTrace={trace}
            forces={forces}
          />
        ) : (
          <GalaxyCanvas
            nodes={visible.nodes}
            edges={visible.edges}
            focusedId={focusedId}
            flyToId={flyToId}
            onFocus={focus}
          />
        )}

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

        {pathIds.length === 0 && focusedId && view === 'flat' && (
          <div className="hx-graph__hint">Shift-click another node to trace a path.</div>
        )}
        {view === 'galaxy' && (
          <div className="hx-graph__hint">
            Drag to orbit, scroll to zoom. Choosing a note flies you to it.
          </div>
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
          <p className="hx-settings__note">{vaultNote}</p>
        </section>

        <section className="hx-panel">
          <h2 className="hx-panel__title">Controls</h2>
          {view === 'flat' ? (
            <ul className="hx-list">
              <li>Drag the background to pan, scroll to zoom.</li>
              <li>Drag a node to move it; it settles back in.</li>
              <li>Click to inspect, shift-click to trace a path.</li>
            </ul>
          ) : (
            <ul className="hx-list">
              <li>Drag to orbit the galaxy, scroll to move in and out.</li>
              <li>Click a note, or one in the lists here, to fly to it.</li>
              <li>Path tracing is on the flat view, which is better at it.</li>
            </ul>
          )}
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
