import { HelixError } from '../core/HelixError.js';
import type { KeyValueStore } from './KeyValueStore.js';

const DB_NAME = 'helix';
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
        new HelixError(
          'STORAGE_UNAVAILABLE',
          'Helix cannot save data because this browser has storage disabled. Settings and projects will not persist.',
          { technical: 'indexedDB is undefined.' },
        ),
      );
    }

    this.#opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OBJECT_STORE)) {
          db.createObjectStore(OBJECT_STORE);
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
        resolve(db);
      };

      request.onerror = () =>
        reject(
          new HelixError(
            'STORAGE_UNAVAILABLE',
            'Helix could not open its local database, so changes will not be saved.',
            { technical: 'indexedDB.open failed: ' + String(request.error?.message ?? 'unknown') },
          ),
        );

      // Fires when another tab holds an older version open and blocks the upgrade.
      request.onblocked = () =>
        reject(
          new HelixError(
            'STORAGE_UNAVAILABLE',
            'Helix is open in another window using an older version of its database. Close it and try again.',
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
          HelixError.from(
            error,
            'Helix could not read or write its local data.',
            'STORAGE_UNAVAILABLE',
          ),
        );
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          new HelixError('STORAGE_UNAVAILABLE', 'Helix could not read or write its local data.', {
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
