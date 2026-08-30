import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryRecord,
} from '../../memory/types.js';

/**
 * Inspect, add and delete long-term memory (spec 6, 10).
 *
 * The specification requires a way to see and remove everything Helix has
 * retained, so this screen is the full surface: every stored memory is listed,
 * each can be deleted individually, and the whole store can be cleared behind a
 * confirmation.
 */
export function MemoryWorkspace() {
  const { memory, settings } = useHelix();
  const privacy = useSettings(['allowLongTermMemory']);

  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('fact');
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const refresh = useCallback(() => {
    void memory.list().then(setRecords);
  }, [memory]);

  useEffect(() => {
    refresh();
    return memory.subscribe(refresh);
  }, [refresh, memory]);

  const add = async () => {
    setError(null);
    try {
      await memory.save({ content: draft, category });
      setDraft('');
    } catch (saveError) {
      // Refusals (credentials, memory disabled) are the answer, shown verbatim.
      setError(toUserMessage(saveError));
    }
  };

  const visible = query.trim()
    ? records.filter((record) =>
        record.content.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : records;

  return (
    <div className="hx-page">
      {!privacy.allowLongTermMemory && (
        <div className="hx-notice hx-notice--warn" role="alert">
          <strong>Long-term memory is off.</strong> I shall not store anything new, sir. What
          is already recorded remains below and may still be deleted.{' '}
          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            onClick={() => void settings.set('allowLongTermMemory', true)}
          >
            Turn on
          </button>
        </div>
      )}

      <section className="hx-panel">
        <h2 className="hx-panel__title">Remember something</h2>
        <p className="hx-settings__note">
          I retain only what you explicitly ask me to keep, sir. Nothing from a conversation is
          recorded here of its own accord, and credentials are declined.
        </p>

        <div className="hx-field">
          <label className="hx-field__label" htmlFor="memory-content">
            Memory
          </label>
          <input
            id="memory-content"
            className="hx-input"
            value={draft}
            maxLength={2000}
            placeholder="I prefer dark interfaces"
            disabled={!privacy.allowLongTermMemory}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draft.trim()) void add();
            }}
          />
        </div>

        <div className="hx-field__actions">
          <select
            className="hx-select hx-select--inline"
            value={category}
            disabled={!privacy.allowLongTermMemory}
            aria-label="Category"
            onChange={(event) => setCategory(event.target.value as MemoryCategory)}
          >
            {MEMORY_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="hx-btn"
            disabled={draft.trim() === '' || !privacy.allowLongTermMemory}
            onClick={() => void add()}
          >
            <Icon name="plus" size={15} /> Remember
          </button>
        </div>

        {error && (
          <div className="hx-notice hx-notice--warn hx-field__error" role="alert">
            {error}
          </div>
        )}
      </section>

      {records.length === 0 ? (
        <div className="hx-panel hx-empty">
          <Icon name="brain" size={26} />
          <p>Nothing on record as yet, sir.</p>
          <p className="hx-muted">
            Add one above, or say &ldquo;remember that ...&rdquo; on the home screen.
          </p>
        </div>
      ) : (
        <section className="hx-panel">
          <div className="hx-settings__head">
            <h2 className="hx-panel__title">
              {records.length} {records.length === 1 ? 'memory' : 'memories'}
            </h2>
            <input
              className="hx-input hx-input--search"
              value={query}
              placeholder="Filter"
              aria-label="Filter memories"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {visible.length === 0 ? (
            <p className="hx-muted">Nothing matches &ldquo;{query}&rdquo;.</p>
          ) : (
            <ul className="hx-memlist">
              {visible.map((record) => (
                <li className="hx-memlist__row" key={record.id}>
                  <div className="hx-memlist__body">
                    <div className="hx-memlist__content">{record.content}</div>
                    <div className="hx-memlist__meta">
                      <span className="hx-tag">{record.category}</span>
                      {record.projectId && <span className="hx-tag">project</span>}
                      <span>saved {new Date(record.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="hx-iconbtn"
                    aria-label={`Forget: ${record.content}`}
                    onClick={() => void memory.delete(record.id)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {records.length > 0 && (
        <section className="hx-panel">
          <h2 className="hx-panel__title">Clear everything</h2>
          {confirmingClear ? (
            <div className="hx-notice hx-notice--warn">
              <strong>Delete all {records.length} memories?</strong> This cannot be undone.
              <div className="hx-field__actions">
                <button
                  type="button"
                  className="hx-btn hx-btn--danger"
                  onClick={() => {
                    void memory.clear().then(() => setConfirmingClear(false));
                  }}
                >
                  Delete all
                </button>
                <button
                  type="button"
                  className="hx-btn hx-btn--quiet"
                  onClick={() => setConfirmingClear(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="hx-btn" onClick={() => setConfirmingClear(true)}>
              Forget everything
            </button>
          )}
        </section>
      )}
    </div>
  );
}
