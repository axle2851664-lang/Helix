import { useEffect, useState } from 'react';
import { HelixMark } from './components/HelixMark.js';
import { NavRail } from './components/NavRail.js';
import { HelixProvider, useHelix, useHelixState, useSettings } from './HelixProvider.js';
import { WorkspaceView } from './workspaces/index.js';
import { WORKSPACES, type WorkspaceId } from './workspaces/registry.js';
import type { HelixStatus } from '../types/status.js';

/**
 * The Helix application shell.
 *
 * Kept thin on purpose: it owns navigation and the status frame and delegates
 * everything else to workspace components and the kernel's managers (spec 19).
 */
export function App() {
  return (
    <HelixProvider>
      <HelixShell />
    </HelixProvider>
  );
}

function HelixShell() {
  const { state } = useHelixState();

  if (state.phase === 'starting') {
    return (
      <div className="helix-app helix-app--centered">
        <HelixMark status="PROCESSING" size={92} />
        <p className="helix-status-label">Starting</p>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="helix-app helix-app--centered">
        <HelixMark status="ERROR" size={92} />
        <p className="helix-status-label">Failed to start</p>
        <p className="helix-phase-note">{state.message}</p>
      </div>
    );
  }

  return <HelixWorkspaceShell />;
}

function HelixWorkspaceShell() {
  const { bus, platform, settings } = useHelix();
  const { warnings } = useHelixState();
  const appearance = useSettings(['reduceMotion', 'accentIntensity', 'theme', 'offlineMode']);

  const [workspace, setWorkspace] = useState<WorkspaceId>('system');
  const [online, setOnline] = useState(() => platform.isOnline());

  // Helix's own status. Wired to real subsystem state as those phases land;
  // until then it stays IDLE rather than animating to imply activity.
  const [status] = useState<HelixStatus>('IDLE');

  useEffect(() => {
    return platform.onConnectivityChange((next) => {
      setOnline(next);
      bus.emit('CONNECTIVITY_CHANGED', { mode: next ? 'online' : 'offline' });
    });
  }, [platform, bus]);

  const changeWorkspace = (next: WorkspaceId) => {
    setWorkspace((previous) => {
      if (previous !== next) bus.emit('WORKSPACE_CHANGED', { workspace: next, previous });
      return next;
    });
  };

  const descriptor = WORKSPACES[workspace];
  const forcedOffline = appearance.offlineMode === 'offline';
  const connectivity = forcedOffline || !online ? 'OFFLINE' : 'ONLINE';

  return (
    <div
      className="helix-app helix-app--shell"
      data-theme={appearance.theme}
      data-reduce-motion={appearance.reduceMotion ? 'true' : 'false'}
      style={{ ['--helix-accent-strength' as string]: String(appearance.accentIntensity / 100) }}
    >
      <header className="helix-header">
        <div className="helix-header__id">
          <HelixMark status={status} size={24} />
          <span className="helix-wordmark">Helix</span>
          <span className="helix-version">v0.1.0 &middot; milestone 2</span>
        </div>

        <div className="helix-badges">
          {!settings.persistent && (
            <span className="helix-badge helix-badge--offline" title="Changes will not be saved">
              NOT SAVING
            </span>
          )}
          <span className={`helix-badge helix-badge--${connectivity.toLowerCase()}`}>
            {connectivity}
            {forcedOffline ? ' (forced)' : ''}
          </span>
          <span className="helix-badge">{platform.kind.toUpperCase()} HOST</span>
        </div>
      </header>

      <div className="helix-body">
        <NavRail active={workspace} onSelect={changeWorkspace} />

        <main className="helix-main">
          <div className="helix-main__head">
            <div>
              <h1 className="helix-main__title">{descriptor.title}</h1>
              <p className="helix-main__subtitle">{descriptor.subtitle}</p>
            </div>
            {!descriptor.implemented && (
              <span className="helix-badge helix-badge--pending">PHASE {descriptor.phase}</span>
            )}
          </div>

          {warnings.length > 0 && workspace !== 'system' && (
            <div className="helix-notice helix-notice--warn" role="alert">
              {warnings[0]}{' '}
              <button
                type="button"
                className="helix-btn helix-btn--quiet"
                onClick={() => changeWorkspace('system')}
              >
                View system status
              </button>
            </div>
          )}

          <div className="helix-main__content">
            <WorkspaceView workspace={workspace} />
          </div>
        </main>
      </div>
    </div>
  );
}
