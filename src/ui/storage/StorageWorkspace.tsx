import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { BackupPanel } from './BackupPanel.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { formatBytes, pressure, pressureNotice } from '../../storage/budget.js';
import type { Reclaimable, StorageReport } from '../../storage/StorageManager.js';

/**
 * What Helix is holding, and what bounds it.
 *
 * The screen this replaces promised four things: a breakdown by category,
 * warnings at 75, 85, 95 and 99 per cent, cleanup that never touches user
 * data, and a write refused before it starts. All four are here.
 *
 * The care in this file is about one number. A browser reports an origin
 * quota, not free disk space, and presenting one as the other would be a lie
 * made entirely of true numbers. So the bar and every figure beside it say
 * what they are measured against, and the word "disk" appears only where a
 * disk was actually measured.
 */

const PRESSURE_TONE = {
  comfortable: 'ok',
  notable: 'ok',
  high: 'warn',
  critical: 'warn',
  full: 'warn',
} as const;

export function StorageWorkspace() {
  const { storage, paths, store, backup, projects, knowledge, memory } = useHelix();
  // The ceiling is a setting, so the report has to follow it changing.
  const config = useSettings(['storageLimitGb']);

  const [report, setReport] = useState<StorageReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [next, state] = await Promise.all([storage.report(), storage.budgetState()]);
    setReport(next);
    setNotice(pressureNotice(state));
  }, [storage]);

  /**
   * Re-measure whenever anything it counts changes.
   *
   * Without this the figures are whatever they were when the screen opened:
   * taking a snapshot showed it in the snapshot list and left the storage
   * breakdown reading zero, which is worse than showing nothing at all.
   */
  useEffect(() => {
    void refresh();

    const stops = [
      backup.subscribe(() => void refresh()),
      projects.subscribe(() => void refresh()),
      knowledge.subscribe(() => void refresh()),
      memory.subscribe(() => void refresh()),
    ];
    return () => stops.forEach((stop) => stop());
  }, [refresh, config.storageLimitGb, backup, projects, knowledge, memory]);

  const reclaim = async (item: Reclaimable) => {
    setBusy(item.id);
    try {
      await storage.reclaim(item.id);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!report) {
    return (
      <div className="hx-page">
        <div className="hx-panel hx-empty">
          <p className="hx-muted">Measuring, sir.</p>
        </div>
      </div>
    );
  }

  const durable = (store as { durable?: boolean }).durable ?? false;
  const level = pressure({
    usedBytes: report.totalBytes,
    ceilingBytes: report.ceilingBytes,
    volume: null,
  }).level;
  const largest = Math.max(1, ...report.categories.map((category) => category.bytes));

  return (
    <div className="hx-page">
      {notice && (
        <div className="hx-notice" role="status">
          {notice}
        </div>
      )}

      <section className="hx-panel">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">In use</h2>
          <span className="hx-storage__total">{formatBytes(report.totalBytes)}</span>
        </div>

        <div className="hx-storage__bar" aria-hidden="true">
          <div
            className={`hx-storage__fill hx-storage__fill--${PRESSURE_TONE[level]}`}
            style={{ width: `${Math.max(0.5, report.fill.ratio * 100)}%` }}
          />
        </div>

        {/* The bar without this sentence would be meaningless, so they are
            never separated. */}
        <p className="hx-storage__basis">{report.headroom.description}</p>

        <div className="hx-row">
          <span className="hx-row__label">Counted how</span>
          <span className="hx-row__value">
            {report.backendReportedBytes === null
              ? 'summed from records - backend overhead not included'
              : 'reported by the storage backend'}
          </span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Ceiling</span>
          <span className="hx-row__value">
            {formatBytes(report.ceilingBytes)} &middot; set in Settings
          </span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Data root</span>
          <span className="hx-row__value hx-row__value--mono">{paths.dataRoot}</span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Durable</span>
          <span className="hx-row__value">
            {durable ? 'Yes, IndexedDB' : 'No - this session only'}
          </span>
        </div>
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">Where it goes</h2>
        <ul className="hx-usage">
          {report.categories.map((category) => (
            <li className="hx-usage__row" key={category.category}>
              <div className="hx-usage__head">
                <span className="hx-usage__label">{category.label}</span>
                <span className="hx-usage__bytes">
                  {formatBytes(category.bytes)}
                  {category.basis === 'estimated' && (
                    <span className="hx-usage__basis"> approx.</span>
                  )}
                </span>
              </div>
              <div className="hx-usage__track" aria-hidden="true">
                <div
                  className="hx-usage__fill"
                  style={{ width: `${(category.bytes / largest) * 100}%` }}
                />
              </div>
              <p className="hx-usage__detail">
                {category.items} {category.items === 1 ? 'item' : 'items'} &middot;{' '}
                {category.description}
              </p>
            </li>
          ))}
        </ul>
        <p className="hx-settings__note">
          Imported file sizes are exact, sir - they were recorded on import. The rest are the
          serialised length of each record, which is close to what is written but not identical
          to it, so they are marked as approximate rather than presented as measurements.
        </p>
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">What could be freed</h2>
        {report.reclaimable.length === 0 ? (
          <p className="hx-muted">
            Nothing is going spare. Everything Helix holds is either yours or in use.
          </p>
        ) : (
          <ul className="hx-reclaim">
            {report.reclaimable.map((item) => (
              <li className="hx-reclaim__row" key={item.id}>
                <div className="hx-reclaim__body">
                  <div className="hx-reclaim__label">
                    {item.label}
                    <span className="hx-reclaim__bytes">{formatBytes(item.bytes)}</span>
                  </div>
                  <p className="hx-reclaim__detail">{item.detail}</p>
                </div>
                <button
                  type="button"
                  className="hx-btn"
                  disabled={busy !== null}
                  onClick={() => void reclaim(item)}
                >
                  {busy === item.id ? 'Removing...' : `Remove ${item.items}`}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hx-settings__note">
          Nothing here is ever removed on its own, and nothing that is yours appears on this
          list. Each entry says what goes with it.
        </p>
      </section>

      <BackupPanel />

      <section className="hx-panel">
        <h2 className="hx-panel__title">What this build cannot see</h2>
        <ul className="hx-list">
          <li>
            <Icon name="alert" size={13} /> Real free space on your disk. A browser reports only
            the allowance it gives this origin, which is not the same thing and may be revised.
          </li>
          <li>
            <Icon name="alert" size={13} /> Space used outside Helix - model weights served from
            the application folder are not counted here.
          </li>
        </ul>
        <p className="hx-settings__note">
          Both need the desktop shell. Until then Helix reports what it can measure and names
          what it cannot, rather than filling the gap with a plausible figure.
        </p>
      </section>
    </div>
  );
}
