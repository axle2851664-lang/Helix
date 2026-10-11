import { HavocError } from '../core/HavocError.js';
import type { KeyValueStore } from './KeyValueStore.js';

const DB_NAME = 'havoc';

/**
 * The database this profile used before the rename.
 *
 * Renaming the constant alone would not have renamed the database - it would
 * have opened a different, empty one, with settings, notes, memory, projects
 * and timers all still on disk and none of them reachable. So the rename comes
 * with the copy that makes it true, in `#importLegacy` below.
 *
 * The old database is never deleted. A copy that went wrong and a copy that
 * went right look identical from here, and only one of them is recoverable.
 */
const LEGACY_DB_NAME = 'helix';
const DB_VERSION = 1;
const OBJECT_STORE = 'records';

/**
 * IndexedDB-backed persistence for the browser host.
 *
 * Records are keyed by the compound array key `[namespace, key]`. Array keys
 * are native to IndexedDB and avoid string-separator escaping entirely: a key
 * containing spaces, slashes or colons cannot collide with a namespace
 * boundary. Listing one namespace is then a bounded range query rather than a
 * full-store walk, using the standard idiom that an array sorts after every
 * primitive key, so `[ns, []]` is an exclusive upper bound for `[ns, <string>]`.
 *
 * This is genuinely durable storage, not a session cache: values survive a
 * reload and a browser restart. It is *not* the disk, and what it can report is
 * an origin quota rather than free space - see docs/STORAGE.md.
 */
export class IndexedDbStore implements KeyValueStore {
  readonly durable = true;
  #db: IDBDatabase | null = null;
  #opening: Promise<IDBDatabase> | null = null;

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  #open(): Promise<IDBDatabase> {
    if (this.#db) return Promise.resolve(this.#db);
    if (this.#opening) return this.#opening;

    if (!IndexedDbStore.isSupported()) {
      return Promise.reject(
        new HavocError(
          'STORAGE_UNAVAILABLE',
          'Havoc cannot save data because this browser has storage disabled. Settings and projects will not persist.',
          { technical: 'indexedDB is undefined.' },
        ),
      );
    }

    this.#opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      /**
       * Whether this call brought the database into existence.
       *
       * The signal the migration turns on. A database that already existed is
       * one this profile has been using, and copying into it could overwrite
       * newer records with older ones.
       */
      let created = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OBJECT_STORE)) {
          db.createObjectStore(OBJECT_STORE);
          created = true;
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        // Another tab opening a newer version must not be blocked by this
        // connection holding the old one open.
        db.onversionchange = () => {
          db.close();
          this.#db = null;
        };
        this.#db = db;

        if (!created) {
          resolve(db);
          return;
        }

        // Brand new, so there may be a database from before the rename to
        // bring across. A failure here must not stop Havoc starting: an empty
        // Havoc is bad, an unopenable one is worse, and the old database is
        // still on disk either way.
        void this.#importLegacy(db)
          .catch(() => undefined)
          .then(() => resolve(db));
      };

      request.onerror = () =>
        reject(
          new HavocError(
            'STORAGE_UNAVAILABLE',
            'Havoc could not open its local database, so changes will not be saved.',
            { technical: 'indexedDB.open failed: ' + String(request.error?.message ?? 'unknown') },
          ),
        );

      // Fires when another tab holds an older version open and blocks the upgrade.
      request.onblocked = () =>
        reject(
          new HavocError(
            'STORAGE_UNAVAILABLE',
            'Havoc is open in another window using an older version of its database. Close it and try again.',
            { technical: 'indexedDB.open blocked by an existing connection.' },
          ),
        );
    });

    // Drop the in-flight promise on failure so a later call can retry.
    this.#opening.catch(() => {
      this.#opening = null;
    });

    return this.#opening;
  }

  /**
   * Copy everything out of the pre-rename database, once.
   *
   * Only ever called for a database this code just created, so there is
   * nothing here to overwrite. The old one is left exactly as it was.
   *
   * The awkward part is finding out whether the old database exists at all:
   * `indexedDB.open` creates what it cannot find, so asking the question the
   * obvious way invents the thing being asked about. `databases()` answers it
   * properly and exists in every engine Havoc actually runs in; where it does
   * not, the fallback opens the name and treats "it had no records store" as
   * "it did not exist", then deletes the empty database it just made rather
   * than leaving litter behind.
   */
  async #importLegacy(target: IDBDatabase): Promise<number> {
    const legacy = await IndexedDbStore.#openLegacy();
    if (!legacy) return 0;

    try {
      const entries = await new Promise<Array<[IDBValidKey, unknown]>>((resolve, reject) => {
        const read = legacy.transaction(OBJECT_STORE, 'readonly').objectStore(OBJECT_STORE);
        const keys = read.getAllKeys();
        const values = read.getAll();
        let gotKeys: IDBValidKey[] | null = null;
        let gotValues: unknown[] | null = null;

        const settle = () => {
          if (gotKeys === null || gotValues === null) return;
          resolve(gotKeys.map((key, index) => [key, (gotValues as unknown[])[index]]));
        };
        keys.onsuccess = () => {
          gotKeys = keys.result;
          settle();
        };
        values.onsuccess = () => {
          gotValues = values.result;
          settle();
        };
        keys.onerror = () => reject(keys.error);
        values.onerror = () => reject(values.error);
      });

      if (entries.length === 0) return 0;

      await new Promise<void>((resolve, reject) => {
        const write = target.transaction(OBJECT_STORE, 'readwrite');
        const store = write.objectStore(OBJECT_STORE);
        // The key is written back as it was read: a compound [namespace, key]
        // array, which is what every range query in this file depends on.
        for (const [key, value] of entries) store.put(value, key);
        write.oncomplete = () => resolve();
        write.onerror = () => reject(write.error);
        write.onabort = () => reject(write.error);
      });

      return entries.length;
    } finally {
      legacy.close();
    }
  }

  /** The old database, or null when there is none. Never creates one. */
  static async #openLegacy(): Promise<IDBDatabase | null> {
    const lister = (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> })
      .databases;
    if (typeof lister === 'function') {
      try {
        const known = await lister.call(indexedDB);
        if (!known.some((entry) => entry.name === LEGACY_DB_NAME)) return null;
      } catch {
        // Fall through to the probe below.
      }
    }

    return new Promise<IDBDatabase | null>((resolve) => {
      // No version: opens whatever is there without upgrading it, and creates
      // version 1 when there is nothing.
      const request = indexedDB.open(LEGACY_DB_NAME);
      let invented = false;
      request.onupgradeneeded = () => {
        invented = true;
      };
      request.onsuccess = () => {
        const db = request.result;
        if (invented || !db.objectStoreNames.contains(OBJECT_STORE)) {
          db.close();
          // Clean up the empty database this probe just made.
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
          resolve(null);
          return;
        }
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  /** Half-open range covering exactly one namespace. */
  static #range(namespace: string): IDBKeyRange {
    return IDBKeyRange.bound([namespace], [namespace, []], false, true);
  }

  async #tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.#open();
    return new Promise<T>((resolve, reject) => {
      let request: IDBRequest<T>;
      try {
        const tx = db.transaction(OBJECT_STORE, mode);
        request = run(tx.objectStore(OBJECT_STORE));
      } catch (error) {
        reject(
          HavocError.from(
            error,
            'Havoc could not read or write its local data.',
            'STORAGE_UNAVAILABLE',
          ),
        );
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new HavocError('STORAGE_UNAVAILABLE', 'Havoc could not read or write its local data.', {
            technical: 'IndexedDB request failed: ' + String(request.error?.message ?? 'unknown'),
          }),
        );
    });
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.#tx<T | undefined>(
      'readonly',
      (store) => store.get([namespace, key]) as IDBRequest<T | undefined>,
    );
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    await this.#tx('readwrite', (store) => store.put(value, [namespace, key]));
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.#tx('readwrite', (store) => store.delete([namespace, key]));
  }

  async keys(namespace: string): Promise<string[]> {
    const raw = await this.#tx<IDBValidKey[]>('readonly', (store) =>
      store.getAllKeys(IndexedDbStore.#range(namespace)),
    );
    // Each stored key is the tuple [namespace, key]; take the second element.
    return raw.map((entry) => String((entry as IDBValidKey[])[1]));
  }

  async entries<T>(namespace: string): Promise<Array<[string, T]>> {
    // getAllKeys and getAll over the same range return matching orders.
    const keys = await this.keys(namespace);
    const values = await this.#tx<T[]>('readonly', (store) =>
      store.getAll(IndexedDbStore.#range(namespace)),
    );
    return keys.map((key, index) => [key, values[index] as T]);
  }

  async clearNamespace(namespace: string): Promise<void> {
    await this.#tx('readwrite', (store) => store.delete(IndexedDbStore.#range(namespace)));
  }

  /**
   * Origin usage, when the browser reports it. This is NOT disk free space and
   * must never be presented as such - see docs/STORAGE.md.
   */
  async estimateSize(): Promise<number | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const estimate = await navigator.storage.estimate();
      return estimate.usage ?? null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.#db?.close();
    this.#db = null;
    this.#opening = null;
  }
}
