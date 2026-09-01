import { useEffect, useState } from 'react';
import { GuardrailPanel } from '../system/GuardrailPanel.js';
import { useHelix, useHelixState } from '../HelixProvider.js';
import type { HardwareProfile, VolumeStats } from '../../platform/PlatformAdapter.js';
import type { LogRecord } from '../../core/Logger.js';
import { HelixMark } from '../components/HelixMark.js';
import { HELIX_STATES, type HelixStatus } from '../../types/status.js';

/**
 * System status (spec 3, 16, 17).
 *
 * Everything shown here is measured at runtime. Where a value cannot be
 * determined on this host it says "unknown" rather than displaying a plausible
 * number, and storage figures are labelled with what they actually describe.
 */

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function SystemWorkspace() {
  const { platform, paths, store, logBuffer } = useHelix();
  const { warnings } = useHelixState();

  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [volume, setVolume] = useState<VolumeStats | null>(null);
  const [helixUsage, setHelixUsage] = useState<number | null>(null);
  const [logs, setLogs] = useState<readonly LogRecord[]>([]);
  const [previewStatus, setPreviewStatus] = useState<HelixStatus>('IDLE');
  const [shellVersion, setShellVersion] = useState<string | null>(null);

  useEffect(() => {
    void platform.getHardwareProfile().then(setHardware);
    void platform.getVolumeStats().then(setVolume);
    void store.estimateSize().then(setHelixUsage);

    // Asked of the shell rather than inferred from a global. Detection is a
    // probe and a probe can be wrong; this is the shell stating its own
    // version, so a window that merely looks like one cannot claim to be it.
    const asShell = platform as { shellVersion?: () => Promise<string | null> };
    if (typeof asShell.shellVersion === 'function') {
      void asShell.shellVersion().then(setShellVersion);
    } else {
      setShellVersion(null);
    }
  }, [platform, store]);

  // The log buffer is mutated in place, so poll a snapshot rather than
  // pretending it is reactive state.
  useEffect(() => {
    const tick = () => setLogs([...logBuffer.records].reverse().slice(0, 60));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [logBuffer]);

  const durable = (store as { durable?: boolean }).durable ?? false;

  return (
    <div className="helix-system">
      {warnings.length > 0 && (
        <div className="helix-notice helix-notice--warn" role="alert">
          <strong>Startup warnings</strong>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="helix-panel">
        <h2 className="helix-panel__title">Host</h2>
        <Row
          label="Shell"
          value={
            platform.kind === 'browser'
              ? 'Browser (Tauri shell pending)'
              : shellVersion
                ? `Tauri desktop shell ${shellVersion}`
                : 'Tauri window, but its command bridge did not answer'
          }
        />
        <Row label="Portable mode" value={paths.isPortable ? 'On' : 'Off'} />
        <Row label="Data root" value={paths.dataRoot} mono />
        <Row
          label="Durable storage"
          value={durable ? 'IndexedDB' : 'In-memory only (nothing is saved)'}
        />
      </section>

      <section className="helix-panel">
        <h2 className="helix-panel__title">Hardware</h2>
        {hardware === null ? (
          <p className="helix-muted">Reading hardware…</p>
        ) : (
          <>
            <Row label="Logical cores" value={hardware.logicalCores?.toString() ?? 'unknown'} />
            <Row
              label="System memory"
              value={
                hardware.totalMemoryBytes === null
                  ? 'unknown (not exposed to web pages)'
                  : `${formatBytes(hardware.totalMemoryBytes)}${hardware.memoryIsApproximate ? ' (approximate)' : ''}`
              }
            />
            <Row label="GPU" value={hardware.gpuRenderer ?? 'unknown'} />
            <Row
              label="VRAM"
              value={
                hardware.vramBytes === null
                  ? 'unknown (not measurable from a browser)'
                  : formatBytes(hardware.vramBytes)
              }
            />
          </>
        )}
      </section>

      <section className="helix-panel">
        <h2 className="helix-panel__title">Storage</h2>
        <Row label="Used by Helix" value={formatBytes(helixUsage)} />
        {volume === null ? (
          <p className="helix-muted">
            This host cannot report storage figures.
          </p>
        ) : (
          <>
            <Row label="Reported free" value={formatBytes(volume.freeBytes)} />
            <Row label="Reported total" value={formatBytes(volume.totalBytes)} />
            <p className="helix-settings__note">
              {volume.source === 'origin-quota'
                ? 'These are browser origin-quota figures, not disk free space. Real volume statistics need the Tauri shell.'
                : 'Figures describe the volume holding Helix data.'}
            </p>
          </>
        )}
        <p className="helix-settings__note">
          Storage accounting and the enforced ceiling arrive with StorageManager.
        </p>
      </section>

      <section className="helix-panel">
        <h2 className="helix-panel__title">Capabilities</h2>
        {Object.entries(platform.capabilities).map(([key, capability]) => (
          <div className="helix-cap" key={key}>
            <span
              className={`helix-cap__dot helix-cap__dot--${capability.available ? 'yes' : 'no'}`}
            />
            <div className="helix-cap__body">
              <div className="helix-cap__name">
                {key} &mdash; {capability.available ? 'available' : 'unavailable'}
              </div>
              {capability.reason && <div className="helix-cap__reason">{capability.reason}</div>}
            </div>
          </div>
        ))}
      </section>

      <section className="helix-panel">
        <h2 className="helix-panel__title">Status indicator</h2>
        <p className="helix-settings__note">
          Preview of the six Helix states. These are driven by real subsystem state once voice and
          vision land; this control exists to check the indicator itself.
        </p>
        <div className="helix-state-preview">
          <HelixMark status={previewStatus} size={84} />
          <div className="helix-state-row">
            {HELIX_STATES.map((state) => (
              <button
                key={state}
                type="button"
                className="helix-state-btn"
                aria-pressed={previewStatus === state}
                onClick={() => setPreviewStatus(state)}
              >
                {state}
              </button>
            ))}
          </div>
        </div>
      </section>

      <GuardrailPanel />

      <section className="helix-panel">
        <h2 className="helix-panel__title">Activity log</h2>
        {logs.length === 0 ? (
          <p className="helix-muted">No records yet.</p>
        ) : (
          <div className="helix-log">
            {logs.map((record, index) => (
              <div className={`helix-log__row helix-log__row--${record.level.toLowerCase()}`} key={index}>
                <span className="helix-log__time">
                  {new Date(record.timestamp).toISOString().slice(11, 19)}
                </span>
                <span className="helix-log__level">{record.level}</span>
                <span className="helix-log__scope">{record.scope}</span>
                <span className="helix-log__msg">{record.message}</span>
              </div>
            ))}
          </div>
        )}
        <p className="helix-settings__note">
          Secrets are redacted before a record is written, not when it is displayed.
        </p>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="helix-row">
      <span className="helix-row__label">{label}</span>
      <span className={`helix-row__value${mono ? ' helix-row__value--mono' : ''}`}>{value}</span>
    </div>
  );
}
