import { useEffect, useMemo, useState } from 'react';
import { HelixMark } from './components/HelixMark.js';
import { HELIX_STATES, type HelixStatus } from '../types/status.js';
import { BrowserPlatform } from '../platform/BrowserPlatform.js';
import type { CapabilityStatus, PlatformAdapter } from '../platform/PlatformAdapter.js';
import { EventBus } from '../core/EventBus.js';

const CAPABILITY_LABELS: Record<string, string> = {
  filesystem: 'Filesystem access',
  diskStats: 'Real disk statistics',
  camera: 'Camera',
  microphone: 'Microphone',
  webgl2: 'WebGL2 (3D / Spatial / Earth)',
  processSpawn: 'Local process spawn',
  removableMedia: 'Removable media control',
};

interface AppProps {
  platform?: PlatformAdapter;
  bus?: EventBus;
}

export function App({ platform, bus }: AppProps) {
  const adapter = useMemo(() => platform ?? new BrowserPlatform(), [platform]);
  const eventBus = useMemo(() => bus ?? new EventBus(), [bus]);

  const [status, setStatus] = useState<HelixStatus>('IDLE');
  const [online, setOnline] = useState(() => adapter.isOnline());

  useEffect(() => {
    const unsubscribe = adapter.onConnectivityChange((next) => {
      setOnline(next);
      eventBus.emit('CONNECTIVITY_CHANGED', { mode: next ? 'online' : 'offline' });
    });
    eventBus.emit('helix:ready', { startedAt: Date.now() });
    return unsubscribe;
  }, [adapter, eventBus]);

  const capabilities = Object.entries(adapter.capabilities) as Array<
    [string, CapabilityStatus]
  >;

  return (
    <div className="helix-app">
      <header className="helix-header">
        <div className="helix-header__id">
          <span className="helix-wordmark">Helix</span>
          <span className="helix-version">v0.1.0 &middot; phase 1</span>
        </div>
        <div className="helix-badges">
          <span className={`helix-badge helix-badge--${online ? 'online' : 'offline'}`}>
            {online ? 'ONLINE' : 'OFFLINE'}
          </span>
          <span className="helix-badge">{adapter.kind.toUpperCase()} HOST</span>
        </div>
      </header>

      <main className="helix-stage">
        <HelixMark status={status} size={116} />
        <div className="helix-status-label">{status}</div>
        <p className="helix-phase-note">
          Phase 1 scaffold. Core primitives and the platform boundary are in place;
          orchestration, memory and the sensor subsystems arrive in later phases.
        </p>

        <div className="helix-state-row">
          {HELIX_STATES.map((state) => (
            <button
              key={state}
              type="button"
              className="helix-state-btn"
              aria-pressed={status === state}
              onClick={() => setStatus(state)}
            >
              {state}
            </button>
          ))}
        </div>
      </main>

      <section className="helix-stage" style={{ paddingTop: 0, flex: 'none' }}>
        <div className="helix-panel">
          <h2 className="helix-panel__title">Host capabilities &mdash; detected, not assumed</h2>
          {capabilities.map(([key, cap]) => (
            <div className="helix-cap" key={key}>
              <span className={`helix-cap__dot helix-cap__dot--${cap.available ? 'yes' : 'no'}`} />
              <div className="helix-cap__body">
                <div className="helix-cap__name">
                  {CAPABILITY_LABELS[key] ?? key} &mdash; {cap.available ? 'available' : 'unavailable'}
                </div>
                {cap.reason ? <div className="helix-cap__reason">{cap.reason}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="helix-footer">
        Unavailable capabilities are reported, never simulated.
      </footer>
    </div>
  );
}
