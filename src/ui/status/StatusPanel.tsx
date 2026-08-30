import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import type { Activity } from '../../core/ActivityManager.js';

/**
 * The Helix status panel.
 *
 * Every row is derived from real application state. The reference design shows
 * "Connected" against most rows; that is not reproduced here, because nothing
 * is connected yet and displaying otherwise would be a fabricated status. Rows
 * read "Not configured", "Disabled" and so on until the subsystem behind them
 * genuinely exists.
 */

type Tone = 'ok' | 'warn' | 'off' | 'busy';

interface StatusRow {
  key: string;
  icon: IconName;
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}

interface StatusPanelProps {
  onClose: () => void;
  onOpenSystem: () => void;
}

export function StatusPanel({ onClose, onOpenSystem }: StatusPanelProps) {
  const { platform, store, activity, conversations } = useHelix();
  const settings = useSettings([
    'languageProvider',
    'speechToTextProvider',
    'visionProvider',
    'offlineMode',
    'allowLongTermMemory',
    'saveConversationHistory',
  ]);

  const [online, setOnline] = useState(() => platform.isOnline());
  const [current, setCurrent] = useState<Activity>(() => activity.current);
  const [conversationCount, setConversationCount] = useState(0);

  useEffect(() => platform.onConnectivityChange(setOnline), [platform]);
  useEffect(() => activity.subscribe(setCurrent), [activity]);

  useEffect(() => {
    const refresh = () => {
      void conversations.list().then((list) => setConversationCount(list.length));
    };
    refresh();
    return conversations.subscribe(refresh);
  }, [conversations]);

  const forcedOffline = settings.offlineMode === 'offline';
  const effectivelyOnline = online && !forcedOffline;
  const durable = (store as { durable?: boolean }).durable ?? false;

  const rows: StatusRow[] = [
    {
      key: 'system',
      icon: 'activity',
      label: 'SYSTEM',
      value: effectivelyOnline ? 'Online' : 'Offline',
      tone: effectivelyOnline ? 'ok' : 'warn',
      ...(forcedOffline ? { detail: 'Forced offline in Settings' } : {}),
    },
    {
      key: 'model',
      icon: 'chip',
      label: 'AI MODEL',
      // Selecting a provider is not the same as connecting to one. Provider
      // connections arrive in phase 5, so a selection reports honestly.
      ...(settings.languageProvider === 'none'
        ? { value: 'Not configured', tone: 'off' as Tone }
        : {
            value: 'Not connected',
            tone: 'warn' as Tone,
            detail: `${settings.languageProvider} selected, connection not built yet`,
          }),
    },
    {
      key: 'memory',
      icon: 'brain',
      label: 'MEMORY',
      value: durable ? 'Local store ready' : 'Not saving',
      tone: durable ? 'ok' : 'warn',
      detail: settings.allowLongTermMemory
        ? 'Long-term memory allowed'
        : 'Long-term memory disabled',
    },
    {
      key: 'web',
      icon: 'globe',
      label: 'WEB',
      value: 'Disabled',
      tone: 'off',
      detail: 'No web provider configured',
    },
    {
      key: 'voice',
      icon: 'microphone',
      label: 'VOICE',
      ...(settings.speechToTextProvider === 'none'
        ? { value: 'Locked', tone: 'off' as Tone, detail: 'No speech provider configured' }
        : {
            value: 'Not connected',
            tone: 'warn' as Tone,
            detail: 'Voice pipeline arrives in phase 5',
          }),
    },
    {
      key: 'files',
      icon: 'folder',
      label: 'FILES',
      value: '0 indexed',
      tone: 'off',
      detail: 'File indexing arrives in phase 4',
    },
    {
      key: 'conversations',
      icon: 'conversation',
      label: 'CONVERSATIONS',
      value:
        conversationCount === 0
          ? 'None yet'
          : `${conversationCount} ${conversationCount === 1 ? 'session' : 'sessions'}`,
      tone: conversationCount > 0 ? 'ok' : 'off',
      detail: settings.saveConversationHistory ? 'Saved to disk' : 'This session only',
    },
  ];

  return (
    <aside className="hx-status">
      <header className="hx-status__head">
        <h2 className="hx-status__title">HELIX STATUS</h2>
        <button type="button" className="hx-iconbtn" onClick={onClose} aria-label="Close status panel">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="hx-status__rows">
        {rows.map((row) => (
          <div className="hx-statusrow" key={row.key}>
            <span className="hx-statusrow__icon">
              <Icon name={row.icon} size={17} />
            </span>
            <div className="hx-statusrow__body">
              <div className="hx-statusrow__label">{row.label}</div>
              <div className="hx-statusrow__value">
                {row.value}
                <span className={`hx-dot hx-dot--${row.tone}`} aria-hidden="true" />
              </div>
              {row.detail && <div className="hx-statusrow__detail">{row.detail}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="hx-status__foot">
        <h3 className="hx-status__title">ACTIVE OPERATION</h3>
        <div className={`hx-operation hx-operation--${current.kind}`}>
          <span className="hx-operation__ring" aria-hidden="true" />
          <div>
            <div className="hx-operation__label">{current.label}</div>
            {current.detail && <div className="hx-operation__detail">{current.detail}</div>}
          </div>
        </div>

        <button type="button" className="hx-btn hx-btn--quiet hx-status__link" onClick={onOpenSystem}>
          Open system diagnostics
        </button>
      </div>
    </aside>
  );
}
