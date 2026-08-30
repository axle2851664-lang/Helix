import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import type { CameraSnapshot } from '../../camera/CameraManager.js';

interface TopBarProps {
  online: boolean;
  statusOpen: boolean;
  onToggleStatus: () => void;
  onOpenHistory: () => void;
  onToggleSidebar: () => void;
}

/**
 * Main workspace header: identity, live connectivity, and the History / Voice /
 * status-panel controls from the reference layout.
 */
export function TopBar({
  online,
  statusOpen,
  onToggleStatus,
  onOpenHistory,
  onToggleSidebar,
}: TopBarProps) {
  const settings = useSettings(['speechToTextProvider']);
  const voiceLocked = settings.speechToTextProvider === 'none';

  // The active-camera indicator lives in the top bar, not on the camera screen,
  // so it stays visible wherever the user navigates while the device is live
  // (spec 10: a visible camera-active indicator is mandatory).
  const { camera } = useHelix();
  const [cameraState, setCameraState] = useState<CameraSnapshot>(() => camera.snapshot);
  useEffect(() => camera.subscribe(setCameraState), [camera]);

  return (
    <header className="hx-topbar">
      <div className="hx-topbar__left">
        <button
          type="button"
          className="hx-iconbtn hx-topbar__menu"
          onClick={onToggleSidebar}
          aria-label="Toggle navigation"
        >
          <Icon name="menu" size={18} />
        </button>
        <span className="hx-topbar__brand">HELIX</span>
        {cameraState.live && (
          <button
            type="button"
            className="hx-camlive hx-camlive--button"
            onClick={() => camera.stop('indicator')}
            title="The camera is on. Click to turn it off."
          >
            <span className="hx-camlive__dot" aria-hidden="true" />
            CAMERA ON
          </button>
        )}
        <span className={`hx-conn hx-conn--${online ? 'online' : 'offline'}`}>
          <span className={`hx-dot hx-dot--${online ? 'ok' : 'warn'}`} aria-hidden="true" />
          {online ? 'ONLINE' : 'OFFLINE'}
        </span>
      </div>

      <div className="hx-topbar__right">
        <button type="button" className="hx-topbtn" onClick={onOpenHistory}>
          <Icon name="clock" size={16} />
          <span>History</span>
        </button>

        <button
          type="button"
          className={`hx-topbtn${voiceLocked ? ' hx-topbtn--locked' : ''}`}
          onClick={onToggleStatus}
          title={
            voiceLocked
              ? 'Voice is locked: no speech provider is configured. Choose one in Settings under Voice.'
              : 'Voice pipeline arrives in phase 5.'
          }
          aria-label="Voice"
        >
          <Icon name="microphone" size={16} />
          <span>Voice</span>
        </button>

        <button
          type="button"
          className="hx-iconbtn"
          onClick={onToggleStatus}
          aria-pressed={statusOpen}
          aria-label={statusOpen ? 'Hide status panel' : 'Show status panel'}
        >
          <Icon name="panel" size={18} />
        </button>
      </div>
    </header>
  );
}
