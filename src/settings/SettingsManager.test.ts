import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus.js';
import { Logger } from '../core/Logger.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/KeyValueStore.js';
import { SettingsManager } from './SettingsManager.js';
import { getDefaultSettings, validateSettings } from './schema.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

function makeManager(store: KeyValueStore = new MemoryKeyValueStore(), bus?: EventBus) {
  return new SettingsManager({ store, logger: silentLogger(), ...(bus ? { bus } : {}) });
}

describe('schema validation', () => {
  it('produces a complete default record', () => {
    const defaults = getDefaultSettings();
    expect(defaults.theme).toBe('dark');
    expect(defaults.portableMode).toBe(true);
    expect(defaults.storageLimitGb).toBe(500);
    // Providers default to none: Helix must never imply a working provider.
    expect(defaults.languageProvider).toBe('none');
    expect(defaults.visionProvider).toBe('none');
    expect(defaults.allowComputerControl).toBe(false);
  });

  it('fills in keys missing from stored data', () => {
    const report = validateSettings({ theme: 'midnight' });
    expect(report.settings.theme).toBe('midnight');
    expect(report.settings.storageLimitGb).toBe(500);
    expect(report.repaired).toEqual([]);
  });

  it('repairs a value of the wrong type', () => {
    const report = validateSettings({ portableMode: 'yes-please' });
    expect(report.settings.portableMode).toBe(true);
    expect(report.repaired).toContain('portableMode');
  });

  it('rejects an enum value outside its options', () => {
    const report = validateSettings({ theme: 'neon' });
    expect(report.settings.theme).toBe('dark');
    expect(report.repaired).toContain('theme');
  });

  it('clamps an out-of-range number instead of resetting it', () => {
    const high = validateSettings({ storageLimitGb: 9000 });
    expect(high.settings.storageLimitGb).toBe(500);
    expect(high.repaired).toContain('storageLimitGb');

    const low = validateSettings({ backupCount: -5 });
    expect(low.settings.backupCount).toBe(0);
  });

  it('rejects NaN and Infinity', () => {
    expect(validateSettings({ speechRate: Number.NaN }).settings.speechRate).toBe(100);
    expect(validateSettings({ speechRate: Number.POSITIVE_INFINITY }).settings.speechRate).toBe(100);
  });

  it('truncates an over-long string', () => {
    const report = validateSettings({ wakeWord: 'x'.repeat(500) });
    expect(report.settings.wakeWord).toHaveLength(32);
    expect(report.repaired).toContain('wakeWord');
  });

  it('reports keys the schema no longer defines', () => {
    const report = validateSettings({ theme: 'dark', legacyOption: 42 });
    expect(report.unknown).toEqual(['legacyOption']);
  });

  it('survives non-object input', () => {
    expect(validateSettings(null).settings).toEqual(getDefaultSettings());
    expect(validateSettings('garbage').settings).toEqual(getDefaultSettings());
    expect(validateSettings(42).settings).toEqual(getDefaultSettings());
  });
});

describe('SettingsManager', () => {
  let store: MemoryKeyValueStore;

  beforeEach(() => {
    store = new MemoryKeyValueStore();
  });

  it('loads defaults when nothing is stored', async () => {
    const settings = await makeManager(store).load();
    expect(settings).toEqual(getDefaultSettings());
  });

  it('reads synchronously after load', async () => {
    const manager = makeManager(store);
    await manager.load();
    expect(manager.get('theme')).toBe('dark');
    expect(manager.loaded).toBe(true);
  });

  // The claim the whole milestone rests on: a change survives a restart.
  it('persists a change across a fresh manager on the same store', async () => {
    const first = makeManager(store);
    await first.load();
    await first.set('theme', 'midnight');
    await first.set('storageLimitGb', 250);
    await first.flush();

    const second = makeManager(store);
    await second.load();
    expect(second.get('theme')).toBe('midnight');
    expect(second.get('storageLimitGb')).toBe(250);
  });

  it('coerces on set and returns what was actually applied', async () => {
    const manager = makeManager(store);
    await manager.load();
    expect(await manager.set('storageLimitGb', 9000)).toBe(500);
    expect(manager.get('storageLimitGb')).toBe(500);
  });

  it('setMany applies several keys in one write', async () => {
    const manager = makeManager(store);
    await manager.load();
    const spy = vi.spyOn(store, 'set');

    await manager.setMany({ theme: 'midnight', backupCount: 5, reduceMotion: true });
    await manager.flush();

    expect(manager.get('theme')).toBe('midnight');
    expect(manager.get('backupCount')).toBe(5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('setting a value to what it already is does not notify or write', async () => {
    const manager = makeManager(store);
    await manager.load();
    const listener = vi.fn();
    manager.subscribe(listener);
    const spy = vi.spyOn(store, 'set');

    await manager.set('theme', 'dark');

    expect(listener).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('notifies subscribers with the changed keys', async () => {
    const manager = makeManager(store);
    await manager.load();
    const listener = vi.fn();
    manager.subscribe(listener);

    await manager.set('theme', 'midnight');

    expect(listener).toHaveBeenCalledOnce();
    const [settings, changed] = listener.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(settings['theme']).toBe('midnight');
    expect(changed).toEqual(['theme']);
  });

  it('unsubscribe stops notifications', async () => {
    const manager = makeManager(store);
    await manager.load();
    const listener = vi.fn();
    manager.subscribe(listener)();

    await manager.set('theme', 'midnight');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener cannot break the update', async () => {
    const manager = makeManager(store);
    await manager.load();
    const good = vi.fn();
    manager.subscribe(() => {
      throw new Error('listener exploded');
    });
    manager.subscribe(good);

    await expect(manager.set('theme', 'midnight')).resolves.toBe('midnight');
    expect(good).toHaveBeenCalledOnce();
  });

  it('emits SETTINGS_CHANGED on the bus', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('SETTINGS_CHANGED', handler);

    const manager = makeManager(store, bus);
    await manager.load();
    await manager.set('reduceMotion', true);

    expect(handler).toHaveBeenCalledWith({ keys: ['reduceMotion'] });
  });

  it('getAll returns a snapshot that cannot mutate internal state', async () => {
    const manager = makeManager(store);
    await manager.load();
    const snapshot = manager.getAll();
    snapshot.theme = 'midnight';
    expect(manager.get('theme')).toBe('dark');
  });

  describe('reset', () => {
    it('restores every default', async () => {
      const manager = makeManager(store);
      await manager.load();
      await manager.setMany({ theme: 'midnight', backupCount: 7 });

      await manager.reset();

      expect(manager.getAll()).toEqual(getDefaultSettings());
    });

    it('restores only one section', async () => {
      const manager = makeManager(store);
      await manager.load();
      await manager.setMany({ theme: 'midnight', backupCount: 7 });

      await manager.reset('appearance');

      expect(manager.get('theme')).toBe('dark');
      expect(manager.get('backupCount')).toBe(7);
    });
  });

  describe('failure handling', () => {
    it('falls back to defaults when the store cannot be read', async () => {
      const broken: KeyValueStore = {
        ...new MemoryKeyValueStore(),
        get: () => Promise.reject(new Error('disk gone')),
      } as unknown as KeyValueStore;

      const manager = makeManager(broken);
      const settings = await manager.load();

      expect(settings).toEqual(getDefaultSettings());
      expect(manager.loaded).toBe(true);
      expect(manager.persistent).toBe(false);
    });

    it('repairs corrupt stored values rather than failing to start', async () => {
      await store.set('settings', 'current', {
        version: 1,
        values: { theme: 'neon', storageLimitGb: 'lots', backupCount: 3 },
      });

      const manager = makeManager(store);
      await manager.load();

      expect(manager.get('theme')).toBe('dark');
      expect(manager.get('storageLimitGb')).toBe(500);
      expect(manager.get('backupCount')).toBe(3);
    });

    it('handles a record written by a newer Helix', async () => {
      await store.set('settings', 'current', {
        version: 99,
        values: { theme: 'midnight', futureOption: true },
      });

      const manager = makeManager(store);
      await manager.load();
      expect(manager.get('theme')).toBe('midnight');
    });

    // A silent write failure would let a user believe their settings saved.
    it('reports lost persistence instead of failing silently', async () => {
      const manager = makeManager(store);
      await manager.load();
      vi.spyOn(store, 'set').mockRejectedValue(new Error('quota exceeded'));

      await manager.set('theme', 'midnight');
      await manager.flush();

      expect(manager.persistent).toBe(false);
      // The in-memory value still applies so the UI stays responsive.
      expect(manager.get('theme')).toBe('midnight');
    });

    it('recovers the persistent flag once writes succeed again', async () => {
      const manager = makeManager(store);
      await manager.load();
      const spy = vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('transient'));

      await manager.set('theme', 'midnight');
      await manager.flush();
      expect(manager.persistent).toBe(false);

      spy.mockRestore();
      await manager.set('backupCount', 3);
      await manager.flush();
      expect(manager.persistent).toBe(true);
    });

    it('serialises concurrent writes without losing the last value', async () => {
      const manager = makeManager(store);
      await manager.load();

      await Promise.all([
        manager.set('backupCount', 1),
        manager.set('backupCount', 2),
        manager.set('backupCount', 3),
      ]);
      await manager.flush();

      const reloaded = makeManager(store);
      await reloaded.load();
      expect(reloaded.get('backupCount')).toBe(manager.get('backupCount'));
    });
  });
});
