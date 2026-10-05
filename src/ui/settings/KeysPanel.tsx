import { useCallback, useEffect, useState } from 'react';
import { tauriInvoke } from '../../platform/TauriPlatform.js';

/**
 * Where keys are put.
 *
 * WHY THIS IS A SCREEN AND NOT A FILE. Keys were documented as lines in a
 * `.env`, which asks for a terminal, or an editor that silently appends `.txt`
 * and writes a byte-order mark - and every one of those failures looks
 * identical from inside Helix: a key that does nothing. That is a bad way to
 * ask anyone to hold a credential.
 *
 * WHAT HAS NOT CHANGED. The page still never holds a key. It sends one, at the
 * moment it is typed, to a shell command that writes it where the shell reads
 * it - and there is no command that gives one back. The field below is write
 * only, which is why it empties on save and why a stored key reads as the word
 * "saved" rather than as dots standing in for a value this page cannot see. A
 * page that can read a secret is a page a secret can be read from.
 *
 * So: no reveal button, no placeholder of the right length, and nothing left
 * in this component's state after a save.
 */

interface KeyStatus {
  name: string;
  label: string;
  set: boolean;
  /** 'saved' here, 'environment' set outside Helix, 'none' absent. */
  source: 'saved' | 'environment' | 'none';
}

export function KeysPanel() {
  const [statuses, setStatuses] = useState<readonly KeyStatus[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      setStatuses(await invoke<KeyStatus[]>('key_status'));
    } catch {
      // An older shell has no such command. The panel then says what it says
      // in a browser, which is true of it too.
      setStatuses(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (name: string) => {
    const invoke = tauriInvoke();
    const value = drafts[name]?.trim() ?? '';
    if (!invoke || value === '') return;

    setBusy(name);
    setNote(null);
    try {
      const where = await invoke<string>('save_key', { name, value });
      // Cleared immediately. The value has done its job and this component
      // has no business still holding it.
      setDrafts((current) => ({ ...current, [name]: '' }));
      setNote(`Saved to ${where}. It is in use now - no restart needed.`);
      await refresh();
    } catch (error) {
      setNote(messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  const forget = async (name: string) => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    setBusy(name);
    setNote(null);
    try {
      await invoke<void>('forget_key', { name });
      setNote('Forgotten.');
    } catch (error) {
      // Not swallowed: `forget_key` reports when the key is also set in the
      // machine's own environment, where Helix cannot remove it - and a
      // "forgotten" that left the key in use would be a false report.
      setNote(messageOf(error));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (statuses === null) {
    return (
      <section className="helix-panel helix-settings__section">
        <h2 className="helix-panel__title">Keys</h2>
        <p className="helix-settings__note">
          Only the desktop app can hold a key. In a browser there is nowhere to put one that
          the page itself could not read.
        </p>
      </section>
    );
  }

  return (
    <section className="helix-panel helix-settings__section">
      <h2 className="helix-panel__title">Keys</h2>
      <p className="helix-settings__note">
        Held by the desktop shell, not by this page, and never shown again once saved. Nothing
        here is required - ordinary conversation runs on a local model that needs no key.
      </p>

      {note !== null && <p className="helix-keys__note">{note}</p>}

      {statuses.map((status) => (
        <div className="helix-keys__row" key={status.name}>
          <div className="helix-keys__head">
            <span className="helix-keys__label">{status.label}</span>
            <span className={`helix-keys__state helix-keys__state--${status.source}`}>
              {status.source === 'saved'
                ? 'saved'
                : status.source === 'environment'
                  ? 'set outside Helix'
                  : 'not set'}
            </span>
          </div>

          <div className="helix-keys__controls">
            <input
              className="hx-input helix-keys__input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={status.set ? 'Replace it' : `Paste your ${status.label} key`}
              value={drafts[status.name] ?? ''}
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [status.name]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save(status.name);
              }}
              aria-label={`${status.label} key`}
            />
            <button
              type="button"
              className="hx-btn"
              disabled={busy !== null || (drafts[status.name]?.trim() ?? '') === ''}
              onClick={() => void save(status.name)}
            >
              Save
            </button>
            {status.source === 'saved' && (
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                disabled={busy !== null}
                onClick={() => void forget(status.name)}
              >
                Forget
              </button>
            )}
          </div>

          <div className="helix-keys__var">{status.name}</div>
        </div>
      ))}
    </section>
  );
}

/** Tauri rejects with a plain object, so the message needs unwrapping. */
function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return error instanceof Error ? error.message : 'That did not work.';
}
