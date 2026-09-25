import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { tauriInvoke } from '../../platform/TauriPlatform.js';
import { NEVER_COPIED, formatBytes, planPortable, portableItems } from '../../portable/plan.js';
import { manifestText } from '../../portable/manifest.js';
import type { PortableItemId } from '../../portable/plan.js';

/**
 * Taking Helix with you.
 *
 * The screen asks one question - what should go on the disk - and asks it one
 * item at a time, with the consequence of each attached. That shape is the
 * whole feature. A single "copy Helix to USB" button would be easier to build
 * and would quietly put a conversation history on a stick that lives in a coat
 * pocket, which is not a thing anybody agreed to.
 *
 * Everything starts unticked except the program itself, which contains nothing
 * about the user. A default that copies personal data is a default that copies
 * it the one time somebody is not paying attention.
 *
 * Credentials have no checkbox. Not a disabled one - none. The list of what is
 * never copied is shown so their absence reads as a decision rather than an
 * oversight, but nothing on this screen can select one, because no such item
 * exists to select.
 */

interface Drive {
  name: string;
  mountPoint: string;
  freeBytes: number;
  totalBytes: number;
  hasHelix: boolean;
}

export function PortableWorkspace() {
  const { backup } = useHelix();

  const [drives, setDrives] = useState<readonly Drive[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<PortableItemId>>(new Set(['app']));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const look = useCallback(async () => {
    setProblem(null);
    const invoke = tauriInvoke();

    // No shell is a different thing from no disks plugged in, and an empty
    // list would read as the second when it is the first.
    if (invoke === null) {
      setSupported(false);
      return;
    }

    try {
      const found = await invoke<Drive[]>('portable_drives');
      setDrives(found);
      setSupported(true);
      if (found.length === 1 && found[0]) setChosen(found[0].mountPoint);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const latest = useRef(look);
  latest.current = look;
  useEffect(() => {
    void latest.current();
  }, []);

  const drive = drives.find((entry) => entry.mountPoint === chosen) ?? null;

  const plan = planPortable({
    selected: [...selected],
    freeBytes: drive?.freeBytes ?? null,
  });

  const write = useCallback(async () => {
    const invoke = tauriInvoke();
    if (!drive || plan.problem !== null || invoke === null) return;

    setBusy(true);
    setProblem(null);
    setOutcome(null);

    try {
      const wantsData = plan.include.some((item) => item.id !== 'app');
      const exported = wantsData ? await backup.export('full') : null;

      const result = await invoke<{ folder: string; bytesWritten: number }>('portable_write', {
        mountPoint: drive.mountPoint,
        data: exported?.text ?? null,
        includeApp: selected.has('app'),
        manifest: manifestText(plan, new Date()),
      });

      setOutcome(
        `Written to ${result.folder} - ${formatBytes(result.bytesWritten)}. There is a note in that folder saying what is there and what is not.`,
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [drive, plan, backup, selected]);

  const toggle = (id: PortableItemId) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!supported) {
    return (
      <div className="hx-page">
        <section className="hx-panel">
          <h2 className="hx-panel__title">This needs the desktop app</h2>
          <p className="hx-muted">
            A web page cannot see your disks or write to them. Open Helix on the machine itself to
            make a portable copy.
          </p>
        </section>
        <NeverCopied />
      </div>
    );
  }

  return (
    <div className="hx-page">
      <section className="hx-panel">
        <div className="hx-portable__bar">
          <h2 className="hx-panel__title">Which disk?</h2>
          <button type="button" className="hx-btn hx-btn--quiet" onClick={() => void look()}>
            <Icon name="activity" size={15} /> Look again
          </button>
        </div>

        {drives.length === 0 ? (
          <p className="hx-muted">
            No removable disk is plugged in. Helix only writes to a disk you can take with you, so
            a portable copy can never land on top of your real installation.
          </p>
        ) : (
          <ul className="hx-portable__drives">
            {drives.map((entry) => (
              <li key={entry.mountPoint}>
                <label className="hx-portable__drive">
                  <input
                    type="radio"
                    name="drive"
                    checked={chosen === entry.mountPoint}
                    onChange={() => setChosen(entry.mountPoint)}
                  />
                  <span>
                    <strong>{entry.name}</strong>{' '}
                    <span className="hx-muted">{entry.mountPoint}</span>
                    <br />
                    <span className="hx-muted">
                      {formatBytes(entry.freeBytes)} free of {formatBytes(entry.totalBytes)}
                      {entry.hasHelix
                        ? ' · already has a Helix folder, which will be replaced'
                        : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">What should go on it?</h2>
        <ul className="hx-portable__items">
          {portableItems().map((item) => (
            <li key={item.id}>
              <label className="hx-portable__item">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span>
                  <strong>{item.label}</strong>
                  <br />
                  <span className="hx-muted">{item.detail}</span>
                  {item.ifLost !== null && (
                    <>
                      <br />
                      <span className="hx-portable__warn">If the disk is lost: {item.ifLost}</span>
                    </>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="hx-panel">
        {plan.problem !== null ? (
          <p className="hx-muted">{plan.problem}</p>
        ) : (
          <p className="hx-muted">
            {plan.include.length} {plan.include.length === 1 ? 'thing' : 'things'} selected
            {plan.bytes > 0 ? `, ${formatBytes(plan.bytes)} measured` : ''}
            {plan.unmeasured > 0 ? ` (${plan.unmeasured} not yet measured)` : ''}.
          </p>
        )}

        {plan.personal.length > 0 && (
          <div className="hx-notice hx-notice--warn" role="alert">
            This disk is not encrypted. Anyone who finds it can read{' '}
            {plan.personal.map((item) => item.label.toLowerCase()).join(', ')} without a password.
          </div>
        )}

        {problem !== null && (
          <div className="hx-notice hx-notice--warn" role="alert">
            {problem}
          </div>
        )}
        {outcome !== null && (
          <p className="hx-portable__done" role="status">
            {outcome}
          </p>
        )}

        <button
          type="button"
          className="hx-btn"
          disabled={busy || drive === null || plan.problem !== null}
          onClick={() => void write()}
        >
          <Icon name="drive" size={15} />
          {busy ? 'Writing...' : drive ? `Write to ${drive.name}` : 'Choose a disk first'}
        </button>
      </section>

      <NeverCopied />
    </div>
  );
}

function NeverCopied() {
  return (
    <section className="hx-panel">
      <h2 className="hx-panel__title">What Helix will never put on a disk</h2>
      <ul className="hx-list">
        {NEVER_COPIED.map((entry) => (
          <li key={entry.what}>
            <strong>{entry.what}</strong>
            <br />
            <span className="hx-muted">{entry.because}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
