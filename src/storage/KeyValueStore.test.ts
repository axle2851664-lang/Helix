import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryKeyValueStore, type KeyValueStore } from './KeyValueStore.js';
import { IndexedDbStore } from './IndexedDbStore.js';

/**
 * One contract, run against every backend. Persistence bugs that only appear in
 * one implementation are exactly the kind that corrupt user projects, so the
 * in-memory store and the real IndexedDB store are held to identical behaviour.
 */
function describeStoreContract(
  name: string,
  create: () => KeyValueStore,
  /** Wipe any state shared between store instances, e.g. a real database. */
  reset: () => Promise<void> = async () => {},
) {
  describe(name, () => {
    let store: KeyValueStore;

    beforeEach(async () => {
      await reset();
      store = create();
    });

    afterEach(async () => {
      await store.close();
    });

    it('returns undefined for a key that was never set', async () => {
      expect(await store.get('settings', 'missing')).toBeUndefined();
    });

    it('round-trips a value', async () => {
      await store.set('settings', 'theme', 'dark');
      expect(await store.get<string>('settings', 'theme')).toBe('dark');
    });

    it('round-trips a structured object', async () => {
      const project = { id: 'p1', name: 'Iron Man', assets: ['a.png'], meta: { starred: true } };
      await store.set('projects', 'p1', project);
      expect(await store.get('projects', 'p1')).toEqual(project);
    });

    it('overwrites an existing key', async () => {
      await store.set('settings', 'theme', 'dark');
      await store.set('settings', 'theme', 'light');
      expect(await store.get<string>('settings', 'theme')).toBe('light');
      expect(await store.keys('settings')).toEqual(['theme']);
    });

    it('deletes a key', async () => {
      await store.set('settings', 'theme', 'dark');
      await store.delete('settings', 'theme');
      expect(await store.get('settings', 'theme')).toBeUndefined();
    });

    it('deleting a missing key is harmless', async () => {
      await expect(store.delete('settings', 'nope')).resolves.toBeUndefined();
    });

    it('lists keys within a namespace only', async () => {
      await store.set('settings', 'theme', 1);
      await store.set('settings', 'voice', 2);
      await store.set('projects', 'p1', 3);

      expect((await store.keys('settings')).sort()).toEqual(['theme', 'voice']);
      expect(await store.keys('projects')).toEqual(['p1']);
    });

    it('returns an empty list for an unknown namespace', async () => {
      expect(await store.keys('nothing-here')).toEqual([]);
    });

    it('returns entries as key/value pairs', async () => {
      await store.set('projects', 'p1', { name: 'Iron Man' });
      await store.set('projects', 'p2', { name: 'Helmet' });

      const entries = await store.entries<{ name: string }>('projects');
      expect(entries).toHaveLength(2);
      expect(Object.fromEntries(entries)).toEqual({
        p1: { name: 'Iron Man' },
        p2: { name: 'Helmet' },
      });
    });

    // Namespace isolation is what stops "clear my memory" from wiping settings.
    it('isolates namespaces that share key names', async () => {
      await store.set('settings', 'id', 'from-settings');
      await store.set('memory', 'id', 'from-memory');

      expect(await store.get<string>('settings', 'id')).toBe('from-settings');
      expect(await store.get<string>('memory', 'id')).toBe('from-memory');
    });

    it('clearNamespace removes only that namespace', async () => {
      await store.set('memory', 'm1', 1);
      await store.set('memory', 'm2', 2);
      await store.set('settings', 'theme', 'dark');

      await store.clearNamespace('memory');

      expect(await store.keys('memory')).toEqual([]);
      expect(await store.get<string>('settings', 'theme')).toBe('dark');
    });

    // A namespace must not match one that merely shares its prefix.
    it('does not let a namespace bleed into a prefix-sharing sibling', async () => {
      await store.set('memory', 'a', 'short');
      await store.set('memory-longterm', 'b', 'long');

      expect(await store.keys('memory')).toEqual(['a']);
      expect(await store.keys('memory-longterm')).toEqual(['b']);

      await store.clearNamespace('memory');
      expect(await store.get<string>('memory-longterm', 'b')).toBe('long');
    });

    // Keys are user-influenced (project names, memory ids), so separators and
    // punctuation inside a key must not corrupt namespace boundaries.
    it('handles keys containing separators and punctuation', async () => {
      const awkward = 'iron man/reference:v2 final.png';
      await store.set('projects', awkward, 'ok');

      expect(await store.get<string>('projects', awkward)).toBe('ok');
      expect(await store.keys('projects')).toEqual([awkward]);
    });

    it('stores falsy values distinguishably from absence', async () => {
      await store.set('settings', 'zero', 0);
      await store.set('settings', 'false', false);
      await store.set('settings', 'empty', '');

      expect(await store.get<number>('settings', 'zero')).toBe(0);
      expect(await store.get<boolean>('settings', 'false')).toBe(false);
      expect(await store.get<string>('settings', 'empty')).toBe('');
      expect(await store.get('settings', 'absent')).toBeUndefined();
    });

    it('does not alias stored state to the caller object', async () => {
      const value = { nested: { count: 1 } };
      await store.set('projects', 'p1', value);
      value.nested.count = 99;

      const loaded = await store.get<typeof value>('projects', 'p1');
      expect(loaded?.nested.count).toBe(1);
    });
  });
}

describeStoreContract('MemoryKeyValueStore', () => new MemoryKeyValueStore());

describeStoreContract(
  'IndexedDbStore',
  () => new IndexedDbStore(),
  // IndexedDB genuinely persists between store instances, so each test starts
  // from a freshly deleted database.
  () =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('helix');
      request.onsuccess = () => resolve();
      request.onblocked = () => resolve();
      request.onerror = () => reject(request.error);
    }),
);

describe('store durability flags', () => {
  it('MemoryKeyValueStore advertises that it is not durable', () => {
    expect(new MemoryKeyValueStore().durable).toBe(false);
  });

  it('IndexedDbStore advertises durability', () => {
    expect(new IndexedDbStore().durable).toBe(true);
  });
});
