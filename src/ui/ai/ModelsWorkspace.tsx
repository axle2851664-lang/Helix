import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { formatBytes } from '../../storage/budget.js';
import { assessFit, footprintFromName, largestComfortableModel } from '../../ai/resources.js';
import type { FitVerdict } from '../../ai/resources.js';
import type { LocalAIStatus } from '../../ai/OllamaProvider.js';
import type { OllamaProvider } from '../../ai/OllamaProvider.js';
import type { ModelInfo } from '../../ai/types.js';
import type { HardwareProfile } from '../../platform/PlatformAdapter.js';

/**
 * Local models: what is installed, what is running, and what would fit.
 *
 * The fit assessment is the part that earns its place. On a machine with under
 * eight gigabytes the difference between a 7B and a 13B is the difference
 * between an assistant and one that swaps to disk and looks like it has hung,
 * and the moment to learn that is before a several-gigabyte download rather
 * than after it.
 *
 * Nothing here downloads anything. Pulling a model is a deliberate act at a
 * terminal, and a button that quietly fetched five gigabytes because someone
 * clicked the wrong row is not a button worth having.
 */

/**
 * Every FitVerdict, deliberately exhaustive: a missing member reads as
 * `undefined` in the class name, so the dot silently loses its colour on
 * exactly the models the user most needs warning about.
 */
const VERDICT_TONE: Record<FitVerdict, 'ok' | 'warn' | 'off'> = {
  comfortable: 'ok',
  tight: 'warn',
  // It could fit, just not alongside what is running - a warning, not a no.
  'not-right-now': 'warn',
  'will-not-fit': 'warn',
  unknown: 'off',
};

export function ModelsWorkspace() {
  const { ai, platform } = useHelix();
  const settings = useSettings(['languageModel', 'preferLocalInference']);

  const [status, setStatus] = useState<LocalAIStatus | null>(null);
  const [models, setModels] = useState<readonly ModelInfo[]>([]);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [busy, setBusy] = useState(false);

  // The local provider, found by id rather than by position, so reordering the
  // provider list cannot silently point this screen at the wrong one.
  const local = ai.provider('ollama') as OllamaProvider | undefined;

  const refresh = useCallback(async () => {
    if (!local) return;
    setBusy(true);
    try {
      setStatus(await local.getStatus());
      setModels(await local.refresh());
    } finally {
      setBusy(false);
    }
  }, [local]);

  useEffect(() => {
    void refresh();
    void platform.getHardwareProfile().then(setHardware);
  }, [refresh, platform]);

  const memory = hardware
    ? {
        totalMemoryBytes: hardware.totalMemoryBytes,
        memoryIsApproximate: hardware.memoryIsApproximate,
        availableMemoryBytes: hardware.availableMemoryBytes,
      }
    : { totalMemoryBytes: null, memoryIsApproximate: false, availableMemoryBytes: null };

  const recommended = largestComfortableModel(memory);

  return (
    <div className="hx-page">
      <section className="hx-panel">
        <div className="hx-settings__head">
          <h2 className="hx-panel__title">Local AI</h2>
          <button type="button" className="hx-btn" disabled={busy} onClick={() => void refresh()}>
            {busy ? 'Checking...' : 'Refresh'}
          </button>
        </div>

        {status === null ? (
          <p className="hx-muted">Checking the local AI service.</p>
        ) : (
          <>
            <div className="hx-row">
              <span className="hx-row__label">Service</span>
              <span className="hx-row__value">
                {status.serviceRunning ? 'Running' : 'Not running'}
              </span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">Models installed</span>
              <span className="hx-row__value">{status.installedModels}</span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">Active model</span>
              <span className="hx-row__value">{status.activeModel ?? 'None selected'}</span>
            </div>

            {/* The provider's own sentence, not a paraphrase of it. */}
            <p className={status.serviceRunning ? 'hx-settings__note' : 'hx-notice'}>
              {status.message}
            </p>
          </>
        )}
      </section>

      {/* ------------------------- what this machine can take ------------- */}
      <section className="hx-panel">
        <h2 className="hx-panel__title">What this machine can run</h2>

        <div className="hx-row">
          <span className="hx-row__label">Memory</span>
          <span className="hx-row__value">
            {hardware?.totalMemoryBytes === null || hardware === null
              ? 'Not measurable from here'
              : `${formatBytes(hardware.totalMemoryBytes)}${
                  hardware.memoryIsApproximate ? ' (approximate)' : ''
                }`}
          </span>
        </div>
        <div className="hx-row">
          <span className="hx-row__label">Largest comfortable model</span>
          <span className="hx-row__value">
            {recommended === null ? 'Cannot say' : `about ${recommended}B at 4-bit`}
          </span>
        </div>

        <p className="hx-settings__note">
          Estimated from the weights plus the context and runtime around them, with headroom left
          for everything else you have open. A model that needs more than is free will swap to disk
          and appear to have hung rather than fail outright, which is why this is worth knowing
          before a download rather than after one.
        </p>
      </section>

      {/* ------------------------------ installed ------------------------- */}
      <section className="hx-panel">
        <h2 className="hx-panel__title">Installed models</h2>

        {models.length === 0 ? (
          <>
            <p className="hx-muted">
              {status?.serviceRunning === false
                ? 'The local AI service is not running, so Helix cannot see what is installed.'
                : 'No local AI model is installed.'}
            </p>
            <p className="hx-settings__note">
              Install one from a terminal. Helix does not download models on your behalf - they are
              several gigabytes each, and that should be a deliberate act rather than the result of
              a click.
            </p>
            <pre className="hx-graph__content">
              ollama pull qwen2.5:{recommended === null ? '7' : Math.min(recommended, 7)}b
            </pre>
          </>
        ) : (
          <ul className="hx-filelist">
            {models.map((model) => {
              const fit = assessFit(
                footprintFromName(model.id, model.note?.includes('GB') ? null : null),
                memory,
              );
              const active = model.id === settings.languageModel;

              return (
                <li className="hx-filelist__row" key={model.id}>
                  <span className={`hx-dot hx-dot--${VERDICT_TONE[fit.verdict]}`} />
                  <div className="hx-filelist__body">
                    <div className="hx-filelist__name">
                      {model.name}
                      {active && <span className="hx-tag">active</span>}
                    </div>
                    <div className="hx-filelist__meta">
                      {model.family}
                      {model.note ? ` · ${model.note}` : ''}
                    </div>
                    <div className="hx-filelist__reason">{fit.message}</div>
                  </div>
                  <button
                    type="button"
                    className="hx-btn hx-btn--quiet"
                    disabled={active || fit.verdict === 'will-not-fit'}
                    onClick={() => {
                      local?.setModel(model.id);
                      void refresh();
                    }}
                  >
                    {active ? 'In use' : 'Use'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">Where conversation is processed</h2>
        <div className="hx-row">
          <span className="hx-row__label">Preference</span>
          <span className="hx-row__value">
            {settings.preferLocalInference ? 'Local first' : 'No local preference'}
          </span>
        </div>
        <p className="hx-settings__note">
          <Icon name="lock" size={12} /> With a local model running, ordinary conversation stays on
          this machine: nothing is sent anywhere, and no paid API is involved. A cloud provider is
          used only if you configure one and the local model cannot answer - and Helix says so in
          the reply when that happens rather than letting it pass unmentioned.
        </p>
      </section>
    </div>
  );
}
