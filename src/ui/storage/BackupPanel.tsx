import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { toUserMessage } from '../../core/HelixError.js';
import { formatBytes } from '../../storage/budget.js';
import type { Archive, RestorePlan } from '../../backup/archive.js';
import type { SnapshotSummary } from '../../backup/BackupManager.js';

/**
 * Backup, export and restore.
 *
 * The important part of this screen is the thing it refuses to do quickly.
 * Restore replaces what Helix holds, so the file is read, the consequences
 * are counted, and the user is shown exactly what disappears before anything
 * is written. There is no one-click restore and there is deliberately no
 * "restore latest" button.
 *
 * The distinction between a snapshot and an export is stated rather than left
 * to be inferred, because they protect against different things and only one
 * of them survives losing the machine.
 */

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function BackupPanel() {
  const { backup } = useHelix();
  const config = useSettings(['backupCount']);

  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [pending, setPending] = useState<{ archive: Archive; plan: RestorePlan[]; source: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setSnapshots(await backup.list());
  }, [backup]);

  useEffect(() => {
    void refresh();
    return backup.subscribe(() => void refresh());
  }, [refresh, backup]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(toUserMessage(error));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Hand the file to the browser's own save dialogue.
   *
   * Helix never writes to the user's folders; this is the browser doing it, at
   * the user's request, to a location the user chooses.
   */
  const download = (fileName: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportArchive = (scope: 'full' | 'records-only') =>
    run(scope, async () => {
      const result = await backup.export(scope);
      download(result.fileName, result.text);
      // What Helix actually knows. Whether the file reached disk is between
      // the browser and the user - it can be blocked or cancelled, and
      // claiming it was saved would be asserting something unobserved.
      setNotice(
        `${result.fileName}, ${formatBytes(result.bytes)}, handed to your browser to save.`,
      );
    });

  const openFile = async (file: File) => {
    await run('reading', async () => {
      const archive = await backup.readFile(file);
      setPending({ archive, plan: await backup.plan(archive), source: file.name });
      setNotice(null);
    });
  };

  const confirmRestore = () =>
    run('restoring', async () => {
      if (!pending) return;
      const result = await backup.restore(pending.archive);
      setPending(null);
      setNotice(
        `${result.restored} records restored. ` +
          (result.safetySnapshot
            ? 'A snapshot of what was here was taken first, so this can be undone.'
            : 'No snapshot was taken beforehand, because snapshots are switched off.'),
      );
    });

  const restoreSnapshot = (id: string) =>
    run(id, async () => {
      const archive = await backup.read(id);
      setPending({ archive, plan: await backup.plan(archive), source: 'a snapshot' });
    });

  const totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.bytes, 0);

  return (
    <>
      <section className="hx-panel">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">Backup</h2>
          <div className="hx-field__actions">
            <button
              type="button"
              className="hx-btn"
              disabled={busy !== null}
              onClick={() => void exportArchive('full')}
            >
              {busy === 'full' ? 'Preparing...' : 'Export everything'}
            </button>
            <button
              type="button"
              className="hx-btn hx-btn--quiet"
              disabled={busy !== null}
              onClick={() => void exportArchive('records-only')}
            >
              Without file contents
            </button>
          </div>
        </div>

        <p className="hx-settings__note">
          An export is a single file you save where you like, sir. It is the only one of these two
          that survives losing this machine - a snapshot lives in the same browser profile as
          everything it is protecting. The file is not encrypted and holds everything Helix knows
          about you, so it wants keeping somewhere you would keep the originals.
        </p>

        {notice && (
          <div className="hx-notice" role="status">
            {notice}
          </div>
        )}
        {problem && (
          <div className="hx-notice hx-notice--warn" role="alert">
            {problem}
          </div>
        )}
      </section>

      {/* ------------------------------ restore ------------------------------ */}
      <section className={`hx-panel${pending ? ' hx-panel--flagged' : ''}`}>
        <h2 className="hx-panel__title">Restore</h2>

        {!pending ? (
          <>
            <div className="hx-field__actions">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hx-visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void openFile(file);
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="hx-btn"
                disabled={busy !== null}
                onClick={() => fileRef.current?.click()}
              >
                Choose a backup file
              </button>
            </div>
            <p className="hx-settings__note">
              Nothing is restored on choosing a file. Helix reads it, works out what it would
              replace, and shows you before anything is written.
            </p>
          </>
        ) : (
          <>
            <p className="hx-restore__source">
              From <strong>{pending.source}</strong>, written {when(pending.archive.createdAt)}.
            </p>

            <ul className="hx-restore__plan">
              {pending.plan.map((entry) => (
                <li
                  className={`hx-restore__row${entry.lost > 0 ? ' hx-restore__row--loss' : ''}`}
                  key={entry.namespace}
                >
                  <div className="hx-restore__head">
                    <span className="hx-restore__label">{entry.label}</span>
                    <span className="hx-restore__counts">
                      {entry.existing} now &rarr; {entry.incoming} after
                    </span>
                  </div>
                  {entry.lost > 0 && (
                    <p className="hx-restore__loss">
                      <Icon name="alert" size={12} /> {entry.lost}{' '}
                      {entry.lost === 1 ? 'record' : 'records'} here now would be gone.
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {pending.archive.omitted.map((entry) => (
              <p className="hx-restore__loss" key={entry.namespace}>
                <Icon name="alert" size={12} /> {entry.reason}
              </p>
            ))}

            <p className="hx-settings__note">
              A restore replaces rather than merges: anything in Helix that is not in this backup
              goes.{' '}
              {config.backupCount > 0
                ? 'A snapshot will be taken first, so this can be undone.'
                : 'No snapshot will be taken, because "Backups kept" is set to zero.'}
            </p>

            <div className="hx-field__actions">
              <button
                type="button"
                className="hx-btn"
                disabled={busy !== null}
                onClick={() => void confirmRestore()}
              >
                {busy === 'restoring' ? 'Restoring...' : 'Restore, replacing what is here'}
              </button>
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                disabled={busy !== null}
                onClick={() => setPending(null)}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </section>

      {/* ----------------------------- snapshots ----------------------------- */}
      <section className="hx-panel">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">
            Snapshots {snapshots.length > 0 && <>&middot; {formatBytes(totalBytes)}</>}
          </h2>
          <button
            type="button"
            className="hx-btn"
            disabled={busy !== null || config.backupCount === 0}
            onClick={() => void run('snapshot', async () => void (await backup.snapshot()))}
          >
            {busy === 'snapshot' ? 'Taking...' : 'Take one now'}
          </button>
        </div>

        {config.backupCount === 0 ? (
          <p className="hx-muted">
            Snapshots are switched off. Set &ldquo;Backups kept&rdquo; above zero in Settings to
            use them.
          </p>
        ) : snapshots.length === 0 ? (
          <p className="hx-muted">
            None yet. Helix keeps the {config.backupCount} most recent, and takes one
            automatically before any restore.
          </p>
        ) : (
          <ul className="hx-snapshots">
            {snapshots.map((snapshot) => (
              <li className="hx-snapshots__row" key={snapshot.id}>
                <div className="hx-snapshots__body">
                  <div className="hx-snapshots__when">{when(snapshot.createdAt)}</div>
                  <div className="hx-snapshots__meta">
                    {snapshot.items} records &middot; {formatBytes(snapshot.bytes)}
                    {snapshot.note ? ` · ${snapshot.note}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="hx-btn hx-btn--quiet"
                  disabled={busy !== null}
                  onClick={() => void restoreSnapshot(snapshot.id)}
                >
                  Review
                </button>
                <button
                  type="button"
                  className="hx-btn hx-btn--quiet"
                  disabled={busy !== null}
                  onClick={() => void run(snapshot.id, () => backup.delete(snapshot.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="hx-settings__note">
          A snapshot guards against a mistake inside Helix, sir - a restore gone wrong, a project
          deleted in error. It is on this disk, in this browser profile, and it goes when they do.
        </p>
      </section>
    </>
  );
}
