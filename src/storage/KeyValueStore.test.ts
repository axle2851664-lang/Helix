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
  /**
   * IndexedDB genuinely persists between store instances, so each test starts
   * from a freshly deleted database.
   *
   * Both names. 'havoc' is the database now; 'helix' is the one the migration
   * reads, and leaving it behind means the next test's brand-new database
   * imports whatever a previous test seeded - which is exactly how this
   * started failing with three keys where one was expected.
   */
  async () => {
    const drop = (name: string) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onblocked = () => resolve();
        request.onerror = () => resolve();
      });
    await drop('havoc');
    await drop('helix');
  },
);

describe('store durability flags', () => {
  it('MemoryKeyValueStore advertises that it is not durable', () => {
    expect(new MemoryKeyValueStore().durable).toBe(false);
  });

  it('IndexedDbStore advertises durability', () => {
    expect(new IndexedDbStore().durable).toBe(true);
  });
});

/**
 * The rename of the database itself, and the copy that makes it true.
 *
 * Renaming the constant alone would have opened a different, empty database
 * with everything still on disk and none of it reachable - no error, no
 * warning, just an assistant that had forgotten everything. These tests are
 * the difference between that and a migration.
 */
describe('migrating from the pre-rename database', () => {
  const OLD = 'helix';
  const NEW = 'havoc';

  const wipe = (name: string) =>
    new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

  /** Write records the way the old build wrote them: compound [ns, key]. */
  const seedLegacy = (entries: Array<[string, string, unknown]>) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(OLD, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => {
        const db = request.result;
        const write = db.transaction('records', 'readwrite');
        for (const [namespace, key, value] of entries) {
          write.objectStore('records').put(value, [namespace, key]);
        }
        write.oncomplete = () => {
          db.close();
          resolve();
        };
        write.onerror = () => reject(write.error);
      };
      request.onerror = () => reject(request.error);
    });

  beforeEach(async () => {
    await wipe(OLD);
    await wipe(NEW);
  });

  it('brings every namespace across on first open', async () => {
    await seedLegacy([
      ['settings', 'theme', 'dark'],
      ['notes', 'n1', { title: 'Supplier', body: 'late again' }],
      ['memory', 'm1', { text: 'the project is called AXUM' }],
    ]);

    const store = new IndexedDbStore();
    expect(await store.get('settings', 'theme')).toBe('dark');
    expect(await store.get<{ title: string }>('notes', 'n1')).toMatchObject({
      title: 'Supplier',
    });
    expect(await store.get<{ text: string }>('memory', 'm1')).toMatchObject({
      text: 'the project is called AXUM',
    });
    await store.close();
  });

  /** Range queries depend on the compound key surviving the copy intact. */
  it('keeps the keys usable, not just the values', async () => {
    await seedLegacy([
      ['notes', 'a', { title: 'one' }],
      ['notes', 'b', { title: 'two' }],
      ['settings', 'theme', 'dark'],
    ]);

    const store = new IndexedDbStore();
    expect((await store.keys('notes')).sort()).toEqual(['a', 'b']);
    expect(await store.entries('notes')).toHaveLength(2);
    // And a namespace query does not bleed into its neighbour.
    expect(await store.keys('settings')).toEqual(['theme']);
    await store.close();
  });

  /**
   * The old database is never deleted. A copy that went wrong and a copy that
   * went right look identical from here, and only one of them is recoverable.
   */
  it('leaves the old database where it was', async () => {
    await seedLegacy([['settings', 'theme', 'dark']]);
    const store = new IndexedDbStore();
    await store.get('settings', 'theme');
    await store.close();

    const still = await new Promise<boolean>((resolve) => {
      const request = indexedDB.open(OLD);
      request.onsuccess = () => {
        const has = request.result.objectStoreNames.contains('records');
        request.result.close();
        resolve(has);
      };
      request.onerror = () => resolve(false);
    });
    expect(still).toBe(true);
  });

  /**
   * A second launch must not copy again. By then the user may have changed
   * something, and re-importing would quietly replace it with the older value.
   */
  it('does not copy a second time over newer records', async () => {
    await seedLegacy([['settings', 'theme', 'dark']]);

    const first = new IndexedDbStore();
    await first.get('settings', 'theme');
    await first.set('settings', 'theme', 'light');
    await first.close();

    const second = new IndexedDbStore();
    expect(await second.get('settings', 'theme')).toBe('light');
    await second.close();
  });

  it('starts empty and invents nothing when there is no old database', async () => {
    const store = new IndexedDbStore();
    expect(await store.get('settings', 'theme')).toBeUndefined();
    expect(await store.keys('settings')).toEqual([]);
    await store.close();
  });
});
