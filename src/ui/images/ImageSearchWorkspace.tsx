import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { UNAVAILABLE_PROVIDERS } from '../../images/providers.js';
import type { ImageResult } from '../../images/types.js';

/**
 * Finding pictures on the web.
 *
 * Three things this screen insists on, all of them about not misleading:
 *
 * - **Every card carries its source and its licence.** A picture with neither
 *   is a picture you cannot credit or lawfully use, and a grid that omits them
 *   quietly turns a search into a free-image library, which it is not.
 *
 * - **"Unknown" is shown as unknown.** Most of the web has no stated licence.
 *   Saying nothing would read as permission; saying "unknown" is the truth and
 *   is what lets somebody decide for themselves.
 *
 * - **What cannot be searched is named.** Pinterest and Bing are on the brief
 *   and are not here, for reasons that are nothing to do with effort. Leaving
 *   them silently absent would look like an oversight.
 *
 * Thumbnails only, loaded lazily. A grid of full-resolution images is tens of
 * megabytes and would make the window stutter for no gain.
 */
export function ImageSearchWorkspace() {
  const { images, imageResults, runner } = useHelix();
  const config = useSettings(['imageSearchEnabled', 'imageProvider']);

  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const outcome = useSyncExternalStore(
    (listener) => imageResults.subscribe(listener),
    () => imageResults.outcome,
    () => null,
  );
  const searching = useSyncExternalStore(
    (listener) => imageResults.subscribe(listener),
    () => imageResults.searching,
    () => false,
  );

  // A new search replaces an old one rather than queueing behind it.
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async () => {
    if (query.trim() === '') return;
    abort.current?.abort();
    abort.current = new AbortController();
    setProblem(null);

    const result = await runner.run('images.search', {
      query: query.trim(),
      ...(provider !== '' ? { provider } : {}),
    });
    if (result.status !== 'ok') setProblem(result.message);
  }, [query, provider, runner]);

  const blocker = images.blocker();

  return (
    <div className="hx-page">
      {!config.imageSearchEnabled && (
        <div className="hx-notice hx-notice--warn" role="alert">
          Image search is switched off in Settings.
        </div>
      )}
      {blocker !== null && (
        <div className="hx-notice hx-notice--warn" role="alert">
          {blocker}
        </div>
      )}

      <section className="hx-panel">
        <div className="hx-imgsearch__bar">
          <input
            className="hx-input"
            value={query}
            placeholder="a black sports car"
            aria-label="What to find pictures of"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run();
            }}
          />
          <select
            className="hx-select hx-select--inline"
            value={provider}
            aria-label="Source"
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="">
              {`Preferred (${images.provider(config.imageProvider)?.name ?? config.imageProvider})`}
            </option>
            {images.providers.map((entry) => {
              const ready = entry.ready();
              return (
                <option key={entry.id} value={entry.id} disabled={!ready.ready}>
                  {entry.name}
                  {ready.ready ? '' : ' — not configured'}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            className="hx-btn"
            disabled={searching || query.trim() === '' || !config.imageSearchEnabled}
            onClick={() => void run()}
          >
            <Icon name="globe" size={15} />
            {searching ? 'Looking…' : 'Search'}
          </button>
        </div>

        {problem && (
          <p className="hx-imgsearch__problem" role="alert">
            {problem}
          </p>
        )}

        {outcome && outcome.failures.length > 0 && (
          <ul className="hx-imgsearch__failures">
            {outcome.failures.map((failure) => (
              <li key={failure.provider}>
                <span className="hx-dot hx-dot--bad" /> {failure.provider}: {failure.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      {outcome && outcome.results.length > 0 && (
        <section className="hx-panel">
          <div className="hx-imgsearch__grid">
            {outcome.results.map((result) => (
              <ImageCard key={result.id} result={result} />
            ))}
          </div>
        </section>
      )}

      {outcome && outcome.results.length === 0 && !searching && (
        <section className="hx-panel">
          <p className="hx-muted">
            Nothing came back for &ldquo;{outcome.query}&rdquo;
            {outcome.answered.length > 0 ? ` from ${outcome.answered.join(', ')}.` : '.'}
          </p>
        </section>
      )}

      <section className="hx-panel">
        <h2 className="hx-panel__title">Sources</h2>
        <ul className="hx-list">
          {images.providers.map((entry) => {
            const ready = entry.ready();
            return (
              <li key={entry.id}>
                <span className={`hx-dot hx-dot--${ready.ready ? "ok" : "off"}`} />{' '}
                <strong>{entry.name}</strong>
                {entry.keyless ? ' — no account needed' : ''}
                <br />
                <span className="hx-muted">{ready.ready ? entry.covers : ready.reason}</span>
              </li>
            );
          })}
        </ul>

        <h2 className="hx-panel__title">Not available, and why</h2>
        <ul className="hx-list">
          {UNAVAILABLE_PROVIDERS.map((entry) => (
            <li key={entry.name}>
              <strong>{entry.name}</strong>
              <br />
              <span className="hx-muted">{entry.because}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ImageCard({ result }: { result: ImageResult }) {
  return (
    <figure className="hx-imgcard">
      <a
        className="hx-imgcard__link"
        href={result.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        title={`Open ${result.sourceName}`}
      >
        <img
          className="hx-imgcard__image"
          src={result.thumbnailUrl}
          alt={result.title}
          loading="lazy"
          decoding="async"
        />
      </a>
      <figcaption className="hx-imgcard__meta">
        <span className="hx-imgcard__title">{result.title}</span>
        <span className="hx-imgcard__source">
          {result.sourceName} · via {result.provider}
        </span>
        <span
          className={`hx-imgcard__license hx-imgcard__license--${result.licenseKnowledge}`}
        >
          {result.licenseKnowledge === 'stated'
            ? result.license
            : 'Licence unknown — assume all rights reserved'}
        </span>
        {result.attribution !== undefined && (
          <span className="hx-imgcard__credit">{result.attribution}</span>
        )}
      </figcaption>
    </figure>
  );
}
