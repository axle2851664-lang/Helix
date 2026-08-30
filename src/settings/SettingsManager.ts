import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import {
  coerceSetting,
  getDefaultSettings,
  SETTINGS_SCHEMA,
  validateSettings,
  type HelixSettings,
  type SettingsKey,
} from './schema.js';

const NAMESPACE = 'settings';
const RECORD_KEY = 'current';
/** Bump when a stored shape needs migrating; see #migrate. */
const SCHEMA_VERSION = 1;

interface StoredSettings {
  version: number;
  values: Record<string, unknown>;
}

export interface SettingsManagerOptions {
  store: KeyValueStore;
  logger: Logger;
  bus?: EventBus;
}

export type SettingsListener = (settings: HelixSettings, changed: SettingsKey[]) => void;

/**
 * Owns the single source of truth for user settings (spec 15).
 *
 * Behaviour that matters:
 *
 * - **Settings are readable synchronously after `load()`.** UI code should never
 *   await on every read, so the validated record is held in memory and writes
 *   are flushed to the store behind it.
 * - **Persisted data is untrusted.** It is validated on load; invalid values are
 *   repaired to defaults (or clamped) and the repair is logged rather than
 *   silently applied.
 * - **A failed write is reported, never swallowed.** If persistence is
 *   unavailable the in-memory value still updates, but `persistent` goes false
 *   so the UI can tell the user their changes will not survive a restart.
 */
export class SettingsManager {
  readonly #store: KeyValueStore;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<SettingsListener>();

  #settings: HelixSettings = getDefaultSettings();
  #loaded = false;
  #persistent = true;
  /** Serialises writes so rapid changes cannot interleave and lose data. */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: SettingsManagerOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child('settings');
    this.#bus = options.bus;
  }

  /** True once load() has completed, successfully or by falling back to defaults. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** False when changes cannot be written to durable storage. */
  get persistent(): boolean {
    return this.#persistent;
  }

  /** A snapshot of all settings. Mutating it does not affect stored state. */
  getAll(): HelixSettings {
    return { ...this.#settings };
  }

  get<K extends SettingsKey>(key: K): HelixSettings[K] {
    return this.#settings[key];
  }

  async load(): Promise<HelixSettings> {
    try {
      const stored = await this.#store.get<StoredSettings>(NAMESPACE, RECORD_KEY);

      if (!stored) {
        this.#settings = getDefaultSettings();
        this.#loaded = true;
        this.#logger.info('No stored settings found; using defaults.');
        return this.getAll();
      }

      const migrated = this.#migrate(stored);
      const report = validateSettings(migrated.values);
      this.#settings = report.settings;

      if (report.repaired.length > 0) {
        this.#logger.warn('Repaired invalid stored settings.', { keys: report.repaired });
      }
      if (report.unknown.length > 0) {
        // Retained in the log rather than deleted outright, so a downgrade
        // followed by an upgrade does not silently lose a user's choice.
        this.#logger.info('Ignoring settings not defined by this version.', {
          keys: report.unknown,
        });
      }

      this.#loaded = true;
      return this.getAll();
    } catch (error) {
      // Settings must never block startup. Fall back to defaults, loudly.
      this.#persistent = false;
      this.#settings = getDefaultSettings();
      this.#loaded = true;
      this.#logger.error('Could not load settings; continuing with defaults.', error);
      return this.getAll();
    }
  }

  /**
   * Update one setting. Returns the coerced value actually applied, which may
   * differ from the requested one when it was out of range.
   */
  async set<K extends SettingsKey>(key: K, value: HelixSettings[K]): Promise<HelixSettings[K]> {
    if (!(key in SETTINGS_SCHEMA)) {
      throw new HelixError('VALIDATION_FAILED', 'That setting does not exist.', {
        technical: 'Unknown settings key: ' + String(key),
      });
    }

    const { value: coerced, valid } = coerceSetting(key, value);
    if (!valid) {
      this.#logger.warn('Setting value adjusted to fit its allowed range.', {
        key,
        requested: value,
        applied: coerced,
      });
    }

    if (Object.is(this.#settings[key], coerced)) return coerced;

    this.#settings = { ...this.#settings, [key]: coerced };
    this.#notify([key]);
    await this.#persist();
    return coerced;
  }

  /** Apply several settings as one atomic change and a single write. */
  async setMany(values: Partial<HelixSettings>): Promise<void> {
    const changed: SettingsKey[] = [];
    const next = { ...this.#settings };

    for (const [rawKey, rawValue] of Object.entries(values)) {
      const key = rawKey as SettingsKey;
      if (!(key in SETTINGS_SCHEMA)) continue;
      const { value: coerced } = coerceSetting(key, rawValue);
      if (!Object.is(next[key], coerced)) {
        (next as Record<string, unknown>)[key] = coerced;
        changed.push(key);
      }
    }

    if (changed.length === 0) return;
    this.#settings = next;
    this.#notify(changed);
    await this.#persist();
  }

  /** Restore defaults. Either the whole schema, or one section's keys. */
  async reset(section?: string): Promise<void> {
    const defaults = getDefaultSettings();
    if (section === undefined) {
      const changed = (Object.keys(defaults) as SettingsKey[]).filter(
        (key) => !Object.is(this.#settings[key], defaults[key]),
      );
      this.#settings = defaults;
      if (changed.length > 0) this.#notify(changed);
      await this.#persist();
      return;
    }

    const patch: Partial<HelixSettings> = {};
    for (const key of Object.keys(defaults) as SettingsKey[]) {
      if (SETTINGS_SCHEMA[key].section === section) {
        (patch as Record<string, unknown>)[key] = defaults[key];
      }
    }
    await this.setMany(patch);
  }

  subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(changed: SettingsKey[]): void {
    const snapshot = this.getAll();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot, changed);
      } catch (error) {
        this.#logger.error('A settings listener threw.', error);
      }
    }
    this.#bus?.emit('SETTINGS_CHANGED', { keys: changed as string[] });
  }

  /** Queue a write so concurrent updates cannot interleave. */
  #persist(): Promise<void> {
    const record: StoredSettings = {
      version: SCHEMA_VERSION,
      values: this.#settings as unknown as Record<string, unknown>,
    };

    this.#writeChain = this.#writeChain
      .then(() => this.#store.set(NAMESPACE, RECORD_KEY, record))
      .then(() => {
        if (!this.#persistent) {
          this.#persistent = true;
          this.#logger.info('Settings storage recovered; changes are being saved again.');
        }
      })
      .catch((error: unknown) => {
        // Surfaced through `persistent` so the UI can warn, not silently lost.
        this.#persistent = false;
        this.#logger.error('Could not save settings; changes will be lost on restart.', error);
      });

    return this.#writeChain;
  }

  /** Wait for any queued write to finish. Used by shutdown and by tests. */
  async flush(): Promise<void> {
    await this.#writeChain;
  }

  /**
   * Bring an older stored record up to the current shape.
   * Version 1 is the initial schema, so there is nothing to migrate yet; the
   * seam exists so that a future change has an obvious home and cannot be
   * bolted onto load().
   */
  #migrate(stored: StoredSettings): StoredSettings {
    if (typeof stored.version !== 'number' || stored.version > SCHEMA_VERSION) {
      // Written by a newer Helix. Validate what we understand and keep going.
      this.#logger.warn('Settings were written by a newer version of Helix.', {
        storedVersion: stored.version,
        supported: SCHEMA_VERSION,
      });
      return { version: SCHEMA_VERSION, values: stored.values ?? {} };
    }
    return { version: SCHEMA_VERSION, values: stored.values ?? {} };
  }
}
