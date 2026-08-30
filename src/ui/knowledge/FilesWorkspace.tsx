import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { formatBytes } from '../../projects/validation.js';
import type { IndexedDocument, KnowledgeHit } from '../../knowledge/KnowledgeIndex.js';
import type { ProjectAsset } from '../../projects/types.js';

/**
 * Indexed files and knowledge search (spec 12, 6D).
 *
 * Lists every imported file and whether it is searchable, with the specific
 * reason when it is not. A PDF or photograph is stored perfectly well but
 * cannot be read without a dependency Helix does not have; saying so here is
 * what stops search silently never finding those files.
 */
export function FilesWorkspace() {
  const { knowledge, projects, activity } = useHelix();

  const [documents, setDocuments] = useState<IndexedDocument[]>([]);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [docs, projectList] = await Promise.all([knowledge.list(), projects.listProjects()]);
    const all: ProjectAsset[] = [];
    for (const project of projectList) {
      all.push(...(await projects.listAssets(project.id)));
    }
    setDocuments(docs);
    setAssets(all);
  }, [knowledge, projects]);

  useEffect(() => {
    void refresh();
    const offKnowledge = knowledge.subscribe(() => void refresh());
    const offProjects = projects.subscribe(() => void refresh());
    return () => {
      offKnowledge();
      offProjects();
    };
  }, [refresh, knowledge, projects]);

  /** Assets that have never been through the indexer. */
  const unindexed = assets.filter(
    (asset) => !documents.some((document) => document.assetId === asset.id),
  );
  const searchable = documents.filter((document) => document.indexed);
  const unreadable = documents.filter((document) => !document.indexed);

  const indexAll = async () => {
    setBusy(true);
    const token = activity.begin('searching', { label: 'Indexing files...' });
    try {
      const projectList = await projects.listProjects();
      for (const project of projectList) {
        token.update(project.name);
        await knowledge.indexProject(project.id);
      }
      token.end('completed');
    } catch {
      token.end('failed');
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    if (query.trim() === '') {
      setHits(null);
      return;
    }
    setHits(await knowledge.search(query, { limit: 10 }));
  };

  return (
    <div className="hx-page">
      {assets.length === 0 ? (
        <div className="hx-panel hx-empty">
          <Icon name="folder" size={26} />
          <p>No files yet.</p>
          <p className="hx-muted">Import some from Upload Project to make them searchable.</p>
        </div>
      ) : (
        <>
          <section className="hx-panel">
            <h2 className="hx-panel__title">Search file contents</h2>
            <div className="hx-field__actions">
              <input
                className="hx-input"
                value={query}
                placeholder="reactor, deadline, recipe..."
                aria-label="Search file contents"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch();
                }}
              />
              <button type="button" className="hx-btn" onClick={() => void runSearch()}>
                Search
              </button>
              {hits !== null && (
                <button
                  type="button"
                  className="hx-btn hx-btn--quiet"
                  onClick={() => {
                    setHits(null);
                    setQuery('');
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="hx-settings__note">
              Keyword search across indexed text. Semantic search needs an embedding provider and
              is not available.
            </p>

            {hits !== null &&
              (hits.length === 0 ? (
                <p className="hx-muted">
                  Nothing in {searchable.length} indexed{' '}
                  {searchable.length === 1 ? 'file' : 'files'} matches &ldquo;{query}&rdquo;.
                </p>
              ) : (
                <ul className="hx-hitlist">
                  {hits.map((hit) => (
                    <li className="hx-hitlist__row" key={`${hit.assetId}-${hit.chunkIndex}`}>
                      <div className="hx-hitlist__file">
                        <Icon name="folder" size={14} /> {hit.fileName}
                      </div>
                      <p className="hx-hitlist__snippet">{hit.snippet}</p>
                      <div className="hx-hitlist__meta">
                        matched {hit.matched.join(', ')}
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          <section className="hx-panel">
            <div className="hx-settings__head">
              <h2 className="hx-panel__title">
                {searchable.length} searchable &middot; {assets.length} stored
              </h2>
              <button
                type="button"
                className="hx-btn"
                disabled={busy || unindexed.length === 0}
                onClick={() => void indexAll()}
              >
                {busy
                  ? 'Indexing...'
                  : unindexed.length > 0
                    ? `Index ${unindexed.length} new`
                    : 'All indexed'}
              </button>
            </div>

            {unindexed.length > 0 && (
              <div className="hx-notice">
                {unindexed.length} {unindexed.length === 1 ? 'file has' : 'files have'} not been
                indexed yet.
              </div>
            )}

            <ul className="hx-filelist">
              {assets.map((asset) => {
                const document = documents.find((entry) => entry.assetId === asset.id);
                const state = !document
                  ? 'pending'
                  : document.indexed
                    ? 'indexed'
                    : 'unreadable';
                return (
                  <li className="hx-filelist__row" key={asset.id}>
                    <span className={`hx-dot hx-dot--${
                      state === 'indexed' ? 'ok' : state === 'pending' ? 'off' : 'warn'
                    }`} />
                    <div className="hx-filelist__body">
                      <div className="hx-filelist__name">{asset.fileName}</div>
                      <div className="hx-filelist__meta">
                        {asset.kind} &middot; {formatBytes(asset.sizeBytes)}
                        {state === 'indexed' &&
                          ` · ${document?.chunks.length} ${
                            document?.chunks.length === 1 ? 'section' : 'sections'
                          } indexed`}
                        {state === 'pending' && ' · not indexed yet'}
                      </div>
                      {state === 'unreadable' && document?.reason && (
                        <div className="hx-filelist__reason">{document.reason}</div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {unreadable.length > 0 && (
            <section className="hx-panel">
              <h2 className="hx-panel__title">Why some files are not searchable</h2>
              <p className="hx-settings__note">
                These are stored safely and remain part of their project. Helix simply cannot read
                their text yet, so search will not find them.
              </p>
              <ul className="hx-list">
                {[...new Set(unreadable.map((document) => document.reason))]
                  .filter(Boolean)
                  .map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
