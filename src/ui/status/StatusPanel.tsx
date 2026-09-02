import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import type { Activity } from '../../core/ActivityManager.js';
import { formatContext, getModelOrDefault } from '../../models/catalog.js';
import { ModelRegistry } from '../../ai/registry.js';

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
  const { platform, store, activity, conversations, projects, memory, ai, bus, voice } =
    useHelix();
  const settings = useSettings([
    'languageProvider',
    'languageModel',
    'inferenceProvider',
    'preferLocalInference',
    'speechToTextProvider',
    'visionProvider',
    'offlineMode',
    'allowLongTermMemory',
    'saveConversationHistory',
  ]);

  const [online, setOnline] = useState(() => platform.isOnline());
  const [current, setCurrent] = useState<Activity>(() => activity.current);
  const [conversationCount, setConversationCount] = useState(0);
  const [assetCount, setAssetCount] = useState(0);
  const [projectCount, setProjectCount] = useState(0);
  const [memoryCount, setMemoryCount] = useState(0);

  useEffect(() => platform.onConnectivityChange(setOnline), [platform]);
  useEffect(() => activity.subscribe(setCurrent), [activity]);

  /**
   * What would actually answer, asked of the router rather than of settings.
   *
   * The two rows below used to be derived from `settings.languageModel` and
   * `settings.inferenceProvider`, and the result was a panel reading
   * "AI MODEL: Opus 5 / INFERENCE: Not configured" while qwen2.5:3b was
   * answering a question three inches to its left. Settings record a
   * preference; the router knows what is installed, what fits, and what is
   * reachable from this host. Only the second of those is a status.
   *
   * Recomputed when the local probe finishes, because at first paint the
   * registry holds nothing but a placeholder marked unavailable.
   */
  const [selection, setSelection] = useState(() => ai.describeSelection());
  useEffect(() => {
    setSelection(ai.describeSelection());
    return bus.on('AI_MODELS_REGISTERED', () => setSelection(ai.describeSelection()));
  }, [ai, bus]);

  /**
   * Which voice will actually speak, named rather than assumed.
   *
   * Resolved asynchronously because listing voices waits on a browser event,
   * and null until it lands - at which point the row says "Ready" and names
   * the voice, including when that voice is not the British one the persona
   * asks for and this machine does not have.
   */
  const [voiceDescription, setVoiceDescription] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void voice.describeVoice().then((description) => {
      if (live) setVoiceDescription(description);
    });
    return () => {
      live = false;
    };
  }, [voice]);

  useEffect(() => {
    const refresh = () => {
      void conversations.list().then((list) => setConversationCount(list.length));
    };
    refresh();
    return conversations.subscribe(refresh);
  }, [conversations]);

  useEffect(() => {
    // Resolved together and set in one update. Separately, listProjects takes
    // several more IndexedDB round-trips than countAssets, so the panel briefly
    // rendered the contradictory pair "1 file" / "No projects yet".
    const refresh = () => {
      void Promise.all([projects.countAssets(), projects.listProjects()]).then(
        ([assets, list]) => {
          setAssetCount(assets);
          setProjectCount(list.length);
        },
      );
    };
    refresh();
    return projects.subscribe(refresh);
  }, [projects]);

  useEffect(() => {
    const refresh = () => {
      void memory.count().then(setMemoryCount);
    };
    refresh();
    return memory.subscribe(refresh);
  }, [memory]);

  const voiceBlocker = voice.outputBlocker();
  const forcedOffline = settings.offlineMode === 'offline';
  const effectivelyOnline = online && !forcedOffline;
  const durable = (store as { durable?: boolean }).durable ?? false;
  const model = getModelOrDefault(settings.languageModel);

  const registry = new ModelRegistry();
  // The router's actual choice where there is one; the stated preference
  // otherwise, which is the right thing to show when nothing can run.
  const selectedModel = selection.model ?? registry.get(settings.languageModel);

  const inferenceLabel = selection.provider
    ? selection.provider.location === 'local'
      ? 'Local'
      : selection.provider.name
    : 'Not configured';

  // "Not configured" is still the honest answer wherever nothing can run, and
  // the reason now comes from the router, which names the specific missing
  // thing per provider rather than one generic failure for all of them.
  const inferenceDetail = selection.provider
    ? selection.provider.location === 'local'
      ? 'Running on this machine. Nothing leaves it.'
      : `${selection.provider.name} is answering.`
    : selection.reason;

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
      // The model, and only the model. Cerebras is not a model and must never
      // appear on this row - it runs models other people trained.
      value: selectedModel?.name ?? model.name,
      // Lit only when this is the model that would genuinely answer, not when
      // it is merely the one selected in Settings.
      tone: selection.model ? 'ok' : 'off',
      detail: selectedModel
        ? `${selectedModel.family} by ${selectedModel.author} - ${formatContext(selectedModel.contextLength)} context`
        : `${formatContext(model.contextTokens)} context`,
    },
    {
      key: 'inference',
      icon: 'activity',
      label: 'INFERENCE',
      // The infrastructure that would run it. A separate fact with a separate
      // failure: a configured model with no provider is not a working setup.
      value: inferenceLabel,
      tone: selection.provider ? 'ok' : 'off',
      detail: inferenceDetail,
    },
    {
      key: 'memory',
      icon: 'brain',
      label: 'MEMORY',
      value: !durable
        ? 'Not saving'
        : memoryCount === 0
          ? 'Nothing stored'
          : `${memoryCount} remembered`,
      tone: !durable ? 'warn' : memoryCount > 0 ? 'ok' : 'off',
      detail: settings.allowLongTermMemory
        ? 'Only stores what you ask it to'
        : 'Long-term memory turned off',
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
      // Asked of the voice manager, which knows what this build can load,
      // rather than hard-coded. This row read "Not connected - voice pipeline
      // arrives in phase 5" for a long time after speech in and out both
      // worked, which is the same stale-note fault the settings screen had:
      // it fails in the direction nobody thinks to check.
      ...(settings.speechToTextProvider === 'none'
        ? { value: 'Locked', tone: 'off' as Tone, detail: 'No speech provider configured' }
        : voiceBlocker !== null
          ? { value: 'Unavailable', tone: 'warn' as Tone, detail: voiceBlocker }
          : {
              value: 'Ready',
              tone: 'ok' as Tone,
              detail: voiceDescription ?? 'Speech in and out are available.',
            }),
    },
    {
      key: 'files',
      icon: 'folder',
      label: 'FILES',
      value: assetCount === 0 ? 'None yet' : `${assetCount} ${assetCount === 1 ? 'file' : 'files'}`,
      tone: assetCount > 0 ? 'ok' : 'off',
      detail:
        projectCount === 0
          ? 'No projects yet'
          : `across ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}`,
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
