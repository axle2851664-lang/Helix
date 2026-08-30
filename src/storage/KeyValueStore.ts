/**
 * Persistence boundary.
 *
 * Settings, projects, memory and the knowledge index all persist through this
 * interface, so the storage medium can change without touching them. Today the
 * browser host backs it with IndexedDB; the Tauri shell will back it with real
 * files under the paths from PathManager.
 *
 * Namespaces keep subsystems isolated: a project record can never collide with
 * a settings key, and clearing memory cannot clear preferences.
 */
export interface KeyValueStore {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  keys(namespace: string): Promise<string[]>;
  /** Every entry in a namespace, for index rebuilds and export. */
  entries<T>(namespace: string): Promise<Array<[string, T]>>;
  /** Remove every entry in one namespace. Never touches other namespaces. */
  clearNamespace(namespace: string): Promise<void>;
  /** Approximate bytes held, when the backend can report it; null otherwise. */
  estimateSize(): Promise<number | null>;
  close(): Promise<void>;
}

/**
 * In-memory store. Used by tests and as the explicit fallback when no durable
 * backend is available, so callers can detect that persistence is not real.
 */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly #data = new Map<string, Map<string, unknown>>();
  /** False advertises that nothing here survives a reload. */
  readonly durable = false;

  #ns(namespace: string): Map<string, unknown> {
    let bucket = this.#data.get(namespace);
    if (!bucket) {
      bucket = new Map();
      this.#data.set(namespace, bucket);
    }
    return bucket;
  }

  async get<T>(namespace: string, key: string): Promise<T | undefined> {
    return this.#ns(namespace).get(key) as T | undefined;
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    // Structured-clone so callers cannot mutate stored state by reference,
    // matching the copy semantics a real backend gives for free.
    this.#ns(namespace).set(key, structuredClone(value));
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.#ns(namespace).delete(key);
  }

  async keys(namespace: string): Promise<string[]> {
    return [...this.#ns(namespace).keys()];
  }

  async entries<T>(namespace: string): Promise<Array<[string, T]>> {
    return [...this.#ns(namespace).entries()] as Array<[string, T]>;
  }

  async clearNamespace(namespace: string): Promise<void> {
    this.#data.delete(namespace);
  }

  async estimateSize(): Promise<number | null> {
    return null;
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
