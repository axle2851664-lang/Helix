import { useState } from 'react';
import { useHelix, useSettings } from '../HelixProvider.js';
import { AddDevicePanel } from '../relay/AddDevicePanel.js';
import { RelayPanel } from '../relay/RelayPanel.js';
import {
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
  type SettingsField,
  type SettingsKey,
  type SettingsSection,
} from '../../settings/schema.js';

/**
 * Settings, rendered directly from the schema (spec 15).
 *
 * Every control here is wired to real persisted state: changing one writes
 * through SettingsManager and survives a reload. Nothing on this screen is
 * decorative.
 */

const SECTION_ORDER: readonly SettingsSection[] = [
  'appearance',
  'voice',
  'camera',
  'vision',
  'gestures',
  'providers',
  'relay',
  'storage',
  'privacy',
  'advanced',
];

const SECTION_LABELS: Record<SettingsSection, string> = {
  appearance: 'Appearance',
  voice: 'Voice',
  camera: 'Camera',
  vision: 'Vision',
  gestures: 'Hand tracking',
  providers: 'AI providers',
  relay: 'Phone relay',
  storage: 'Storage',
  privacy: 'Privacy',
  advanced: 'Advanced',
};

/**
 * Notes shown against sections whose settings describe capabilities that are
 * not built yet. Being explicit is the point: a user must not conclude from a
 * populated dropdown that the feature works.
 *
 * Which cuts both ways, and did. Voice and local inference were both still
 * described here as arriving in a later phase long after they started working,
 * so the screen was telling the user that a thing they could hear and read was
 * not built. A stale note is the same fault as an optimistic one - it just
 * fails in the direction nobody checks.
 */
const SECTION_NOTES: Partial<Record<SettingsSection, string>> = {
  voice:
    'Speech in and out both work. Which voice Helix speaks with depends on what is installed on this machine, and it will tell you which one it chose.',
  camera: 'The camera workspace arrives in phase 6.',
  vision: 'Vision providers arrive in phase 6. No provider is implemented yet.',
  gestures: 'Hand tracking arrives in phase 9.',
  providers:
    'Local inference works. Cloud providers need the desktop shell, because a key held in a web page is a leaked key.',
  relay:
    'Needs the desktop shell and a connected Google account. Nothing is polled until you switch it on, and an address without a shared key is ignored.',
  storage: 'Reported usage arrives with StorageManager. The ceiling is stored now.',
};

export function SettingsWorkspace() {
  const { settings } = useHelix();
  const values = useSettings();
  const [busyKey, setBusyKey] = useState<SettingsKey | null>(null);

  const update = async (key: SettingsKey, value: unknown) => {
    setBusyKey(key);
    try {
      await settings.set(key, value as never);
    } finally {
      setBusyKey(null);
    }
  };

  const grouped = SECTION_ORDER.map((section) => ({
    section,
    keys: SETTINGS_KEYS.filter((key) => SETTINGS_SCHEMA[key].section === section),
  })).filter((group) => group.keys.length > 0);

  return (
    <div className="helix-settings">
      {!settings.persistent && (
        <div className="helix-notice helix-notice--warn" role="alert">
          Helix cannot save settings right now. Changes will apply for this session only and will be
          lost when Helix closes.
        </div>
      )}

      {grouped.map(({ section, keys }) => (
        <section className="helix-panel helix-settings__section" key={section}>
          <div className="helix-settings__head">
            <h2 className="helix-panel__title">{SECTION_LABELS[section]}</h2>
            <button
              type="button"
              className="helix-btn helix-btn--quiet"
              onClick={() => void settings.reset(section)}
            >
              Reset
            </button>
          </div>

          {SECTION_NOTES[section] && (
            <p className="helix-settings__note">{SECTION_NOTES[section]}</p>
          )}

          {keys.map((key) => (
            <SettingRow
              key={key}
              settingKey={key}
              field={SETTINGS_SCHEMA[key] as SettingsField}
              value={values[key]}
              busy={busyKey === key}
              onChange={(next) => void update(key, next)}
            />
          ))}

          {/*
            The relay needs an action, not just fields. Storing a client id
            does nothing on its own, and for a while nothing called the connect
            command at all - so a fully configured relay dead-ended in silence.
          */}
          {section === 'relay' && (
            <>
              <AddDevicePanel />
              <RelayPanel />
            </>
          )}
        </section>
      ))}
    </div>
  );
}

interface SettingRowProps {
  settingKey: SettingsKey;
  field: SettingsField;
  value: unknown;
  busy: boolean;
  onChange: (value: unknown) => void;
}

function SettingRow({ settingKey, field, value, busy, onChange }: SettingRowProps) {
  const id = `setting-${settingKey}`;
  // The camera indicator is a safety guarantee, not a preference (spec 18).
  const locked = settingKey === 'cameraIndicatorAlwaysVisible';

  return (
    <div className="helix-setting">
      <div className="helix-setting__text">
        <label className="helix-setting__label" htmlFor={id}>
          {field.label}
        </label>
        {field.description && <p className="helix-setting__desc">{field.description}</p>}
      </div>

      <div className="helix-setting__control">
        {field.kind === 'boolean' && (
          <label className="helix-switch">
            <input
              id={id}
              type="checkbox"
              checked={value as boolean}
              disabled={busy || locked}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span className="helix-switch__track" aria-hidden="true" />
          </label>
        )}

        {field.kind === 'enum' && (
          <select
            id={id}
            className="helix-select"
            value={value as string}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option} value={option}>
                {field.optionLabels?.[option] ?? option}
              </option>
            ))}
          </select>
        )}

        {field.kind === 'number' && (
          <div className="helix-number">
            <input
              id={id}
              type="range"
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              value={value as number}
              disabled={busy}
              onChange={(event) => onChange(Number(event.target.value))}
            />
            <span className="helix-number__value">
              {String(value)}
              {field.unit ?? ''}
            </span>
          </div>
        )}

        {field.kind === 'string' && (
          <input
            id={id}
            type="text"
            className="helix-input"
            value={value as string}
            maxLength={field.maxLength}
            placeholder={field.placeholder ?? ''}
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
    </div>
  );
}
