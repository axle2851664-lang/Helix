import { useEffect, useState } from 'react';
import { describeBuild } from '../../platform/buildStamp.js';
import { GuardrailPanel } from '../system/GuardrailPanel.js';
import { useHavoc, useHavocState } from '../HavocProvider.js';
import type { HardwareProfile, VolumeStats } from '../../platform/PlatformAdapter.js';
import type { LogRecord } from '../../core/Logger.js';
import { HavocMark } from '../components/HavocMark.js';
import { HAVOC_STATES, type HavocStatus } from '../../types/status.js';
import { tauriInvoke } from '../../platform/TauriPlatform.js';
import { describeReasoning, reactorSegments, type ReactorSegment } from '../hero/capabilities.js';
import { useSettings } from '../HavocProvider.js';

/**
 * What the shell found when it looked for a file of keys.
 *
 * Names only - never values. A variable name is not a secret, and this is the
 * one thing that answers "did my key arrive". The value never crosses the
 * boundary, exactly as it never does for inference.
 */
interface EnvReport {
  searched: string[];
  loaded: string[];
  names: string[];
}

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
  const { platform, paths, store, logBuffer, voice, projects, memory, knowledge, ai } =
    useHavoc();
  const config = useSettings([
    'languageProvider',
    'speechToTextProvider',
    'visionProvider',
    'gestureProvider',
    'allowLongTermMemory',
  ]);
  const { warnings } = useHavocState();

  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [volume, setVolume] = useState<VolumeStats | null>(null);
  const [havocUsage, setHavocUsage] = useState<number | null>(null);
  const [logs, setLogs] = useState<readonly LogRecord[]>([]);
  const [previewStatus, setPreviewStatus] = useState<HavocStatus>('IDLE');

  /**
   * What each subsystem can actually do, and why.
   *
   * This measurement used to light the sphere itself - brighter at the
   * latitudes whose subsystem worked. That made the core a status display,
   * which the main screen is not for, so it moved here: the words were always
   * the useful half, and this is the screen for words about the machine.
   */
  const [segments, setSegments] = useState<readonly ReactorSegment[]>([]);
  useEffect(() => {
    let cancelled = false;
    const measure = () => {
      void Promise.all([
        projects.listProjects(),
        knowledge.list(),
        memory.count(),
      ]).then(([list, documents]) => {
        if (cancelled) return;
        setSegments(
          reactorSegments({
            online: platform.isOnline(),
            reasoning: describeReasoning(ai),
            languageProvider: config.languageProvider,
            hearingBlocker: voice.inputBlocker(),
            hearingProvider: config.speechToTextProvider,
            speechBlocker: voice.outputBlocker(),
            visionProvider: config.visionProvider,
            gestureProvider: config.gestureProvider,
            memoryAllowed: config.allowLongTermMemory,
            durableStorage: (store as { durable?: boolean }).durable ?? false,
            projectCount: list.length,
            searchableFiles: documents.filter((document) => document.indexed).length,
          }),
        );
      });
    };
    measure();
    return () => {
      cancelled = true;
    };
  }, [ai, config, knowledge, memory, platform, projects, store, voice]);
  /** Null until the shell answers, and in a browser for ever. */
  const [env, setEnv] = useState<EnvReport | null>(null);

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    let cancelled = false;
    void invoke<EnvReport>('env_file_report')
      .then((report) => {
        if (!cancelled) setEnv(report);
      })
      // An older shell has no such command. Silence is right: the section
      // then says what a browser says, which is true of it too.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [shellVersion, setShellVersion] = useState<string | null>(null);

  useEffect(() => {
    void platform.getHardwareProfile().then(setHardware);
    void platform.getVolumeStats().then(setVolume);
    void store.estimateSize().then(setHavocUsage);

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
        {/*
          The row that ends "is this even my code".
          An installed Havoc carries the interface from the day it was built
          and pulling source cannot change it; a dev build is whatever is on
          disk now. On screen the two are identical, which is how six rounds
          went into debugging fixes that were never loaded.
        */}
        <Row label="Interface built" value={describeBuild()} />
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
        <Row label="Used by Havoc" value={formatBytes(havocUsage)} />
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
                : 'Figures describe the volume holding Havoc data.'}
            </p>
          </>
        )}
        <p className="helix-settings__note">
          Storage accounting and the enforced ceiling arrive with StorageManager.
        </p>
      </section>

      {/*
        Keys, and where they came from.
        
        This exists because a key that does nothing is indistinguishable from a
        key that was rejected, and the difference is everything: one is a
        wrongly-placed file and the other is a wrong value. An evening went on
        guessing between them. The shell knows which paths it tried and which
        it read, so it says.
      */}
      <section className="helix-panel">
        <h2 className="helix-panel__title">Keys from the environment</h2>
        {env === null ? (
          <p className="helix-settings__note">
            Only the desktop app reads a file of keys. In a browser there is nowhere safe to
            hold one.
          </p>
        ) : (
          <>
            {env.loaded.length === 0 ? (
              <p className="helix-settings__note">
                No <code>.env</code> was found. Put one at the top of the Havoc folder, then
                reopen Havoc. These are the places that were looked at:
              </p>
            ) : (
              <>
                <p className="helix-settings__note">
                  Read {env.loaded.length === 1 ? 'this file' : 'these files'}:
                </p>
                <ul className="helix-settings__paths">
                  {env.loaded.map((path) => (
                    <li key={path}><code>{path}</code></li>
                  ))}
                </ul>
                <p className="helix-settings__note">
                  {env.names.length === 0
                    ? 'It set nothing. Every line was blank, a comment, or had no value after the "=".'
                    : `It set: ${env.names.join(', ')}.`}
                </p>
              </>
            )}
            <details className="helix-settings__detail">
              <summary>Where it looked</summary>
              <ul className="helix-settings__paths">
                {env.searched.map((path) => (
                  <li key={path}><code>{path}</code></li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      {segments.length > 0 && (
        <section className="helix-panel">
          <h2 className="helix-panel__title">Subsystems</h2>
          {segments.map((segment) => (
            <div className="helix-cap" key={segment.id}>
              <span
                className={`helix-cap__dot helix-cap__dot--${
                  segment.state === 'ready' ? 'yes' : segment.state === 'caveat' ? 'partial' : 'no'
                }`}
              />
              <div className="helix-cap__body">
                <div className="helix-cap__name">{segment.label.toLowerCase()}</div>
                <div className="helix-cap__reason">{segment.reason}</div>
              </div>
            </div>
          ))}
        </section>
      )}

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
          Preview of the six Havoc states. These are driven by real subsystem state once voice and
          vision land; this control exists to check the indicator itself.
        </p>
        <div className="helix-state-preview">
          <HavocMark status={previewStatus} size={84} />
          <div className="helix-state-row">
            {HAVOC_STATES.map((state) => (
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
