import type { KeyValueStore } from '../storage/KeyValueStore.js';
import type { Logger } from '../core/Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import { HelixError } from '../core/HelixError.js';
import {
  ARCHIVABLE,
  ArchiveError,
  archiveFileName,
  buildArchive,
  decodeBinary,
  encodeBinary,
  isEncodedBlob,
  parseArchive,
  planRestore,
  serialiseArchive,
  summariseArchive,
  type Archive,
  type ArchivableNamespace,
  type ArchiveScope,
  type RestorePlan,
} from './archive.js';

/**
 * Backup, restore and snapshots (spec 11: `backupCount`).
 *
 * The setting for how many backups to keep has existed since the settings
 * schema was written and has never done anything. This makes it real.
 *
 * A snapshot lives inside Helix's own storage, which is the only place a
 * browser can put one. That is worth being plain about: a snapshot protects
 * against a mistake inside Helix - a restore gone wrong, a project deleted in
 * error - and against nothing else. It is on the same disk, in the same
 * browser profile, and it goes when that goes. Protection against losing the
 * machine means exporting a file and putting it somewhere else, which is why
 * export is not buried behind snapshots.
 *
 * Two things are never done automatically. Nothing is ever restored without
 * the user seeing exactly what it replaces, and nothing is ever downloaded
 * without being asked for. A backup file is everything Helix knows about
 * someone, and it leaves unencrypted.
 */

const SNAPSHOT_NAMESPACE = 'backups';

/** Namespaces carried in a full archive, in restore order. */
const NAMESPACES = Object.keys(ARCHIVABLE) as ArchivableNamespace[];

/** File contents, which are the only large thing and the only binary one. */
const BLOB_NAMESPACE: ArchivableNamespace = 'asset-blobs';

export interface SnapshotRecord {
  id: string;
  createdAt: number;
  scope: ArchiveScope;
  /** Serialised archive. Kept as text so it round-trips through any backend. */
  payload: string;
  /** Length of that text, so a list does not have to measure every one. */
  bytes: number;
  /** Item counts per namespace, for the list. */
  counts: Record<string, number>;
  /** Why it was taken. Set when Helix took it before a risky operation. */
  note?: string;
}

export interface SnapshotSummary {
  id: string;
  createdAt: number;
  scope: ArchiveScope;
  bytes: number;
  items: number;
  note?: string;
}

export interface BackupManagerOptions {
  store: KeyValueStore;
  settings: SettingsManager;
  logger: Logger;
  /** Checked before a snapshot is written, so one cannot blow the ceiling. */
  budget?: { requireRoom(bytes: number): Promise<void> };
}

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `snap_${Date.now().toString(36)}_${random}`;
}

export class BackupManager {
  readonly #store: KeyValueStore;
  readonly #settings: SettingsManager;
  readonly #logger: Logger;
  readonly #budget: BackupManagerOptions['budget'];
  #listeners = new Set<() => void>();

  constructor(options: BackupManagerOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#logger = options.logger.child('backup');
    this.#budget = options.budget;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#logger.error('A backup listener threw.', error);
      }
    }
  }

  /** How many snapshots the user has asked Helix to keep. */
  get keepCount(): number {
    return this.#settings.get('backupCount');
  }

  /* ---------------------------------------------------------------- */
  /* Building                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Read everything out of storage into an archive.
   *
   * The snapshot namespace is deliberately excluded. A backup containing every
   * previous backup doubles on each round and is worthless besides - restoring
   * one would bring back a stale list of the others.
   */
  async build(scope: ArchiveScope = 'full'): Promise<Archive> {
    const sections = [];
    const omitted: Archive['omitted'] = [];

    for (const namespace of NAMESPACES) {
      if (namespace === BLOB_NAMESPACE && scope === 'records-only') {
        const count = (await this.#store.keys(namespace)).length;
        omitted.push({
          namespace,
          reason: `The contents of ${count} ${count === 1 ? 'file' : 'files'} were left out to keep this small. Their records are here, so a restore can tell you exactly which files are missing.`,
        });
        continue;
      }

      const entries = await this.#store.entries<unknown>(namespace);
      const encoded: Array<[string, unknown]> = [];

      for (const [key, value] of entries) {
        encoded.push([
          key,
          namespace === BLOB_NAMESPACE
            ? await encodeBinary(value as Blob | ArrayBuffer)
            : value,
        ]);
      }
      sections.push({ namespace, entries: encoded });
    }

    return buildArchive(sections, { scope, omitted });
  }

  /**
   * The archive as a file, with its real size.
   *
   * Size is measured rather than estimated, because base64 inflates binary by
   * a third and a user deciding whether to keep file contents needs the actual
   * number, not a guess at it.
   */
  async export(scope: ArchiveScope = 'full'): Promise<{
    fileName: string;
    text: string;
    bytes: number;
  }> {
    const archive = await this.build(scope);
    const text = serialiseArchive(archive);

    return {
      fileName: archiveFileName(archive.createdAt, scope),
      text,
      bytes: new TextEncoder().encode(text).length,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Snapshots                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Take a snapshot and prune to the configured count.
   *
   * A snapshot costs real storage, so it goes through the same budget as an
   * imported file. Refusing here is better than a snapshot that succeeds and
   * pushes something else over the ceiling.
   */
  async snapshot(note?: string): Promise<SnapshotSummary> {
    if (this.keepCount === 0) {
      throw new HelixError(
        'VALIDATION_FAILED',
        'Snapshots are switched off. Set "Backups kept" above zero in Settings to take one.',
      );
    }

    const archive = await this.build('full');
    const payload = serialiseArchive(archive);
    const bytes = new TextEncoder().encode(payload).length;

    await this.#budget?.requireRoom(bytes);

    const counts: Record<string, number> = {};
    for (const section of archive.sections) counts[section.namespace] = section.entries.length;

    const record: SnapshotRecord = {
      id: newId(),
      createdAt: archive.createdAt,
      scope: 'full',
      payload,
      bytes,
      counts,
      ...(note !== undefined ? { note } : {}),
    };

    await this.#store.set(SNAPSHOT_NAMESPACE, record.id, record);
    await this.prune();

    this.#logger.info('Snapshot taken.', { id: record.id, bytes });
    this.#notify();

    return this.#summarise(record);
  }

  #summarise(record: SnapshotRecord): SnapshotSummary {
    return {
      id: record.id,
      createdAt: record.createdAt,
      scope: record.scope,
      bytes: record.bytes,
      items: Object.values(record.counts).reduce((total, count) => total + count, 0),
      ...(record.note !== undefined ? { note: record.note } : {}),
    };
  }

  async list(): Promise<SnapshotSummary[]> {
    const entries = await this.#store.entries<SnapshotRecord>(SNAPSHOT_NAMESPACE);
    return entries
      .map(([, record]) => this.#summarise(record))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((total, snapshot) => total + snapshot.bytes, 0);
  }

  /** Drop the oldest until only `backupCount` remain. Returns how many went. */
  async prune(): Promise<number> {
    const entries = await this.#store.entries<SnapshotRecord>(SNAPSHOT_NAMESPACE);
    const ordered = entries
      .map(([, record]) => record)
      .sort((a, b) => b.createdAt - a.createdAt);

    const excess = ordered.slice(this.keepCount);
    for (const record of excess) {
      await this.#store.delete(SNAPSHOT_NAMESPACE, record.id);
    }

    if (excess.length > 0) {
      this.#logger.info('Pruned old snapshots.', { removed: excess.length });
      this.#notify();
    }
    return excess.length;
  }

  async delete(id: string): Promise<void> {
    await this.#store.delete(SNAPSHOT_NAMESPACE, id);
    this.#notify();
  }

  async read(id: string): Promise<Archive> {
    const record = await this.#store.get<SnapshotRecord>(SNAPSHOT_NAMESPACE, id);
    if (!record) {
      throw new HelixError('NOT_FOUND', 'That snapshot no longer exists.');
    }
    return parseArchive(record.payload);
  }

  /* ---------------------------------------------------------------- */
  /* Restoring                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * What restoring this archive would do, before anything is written.
   *
   * Restore replaces a namespace rather than merging into it, which is what a
   * backup should do and exactly the wrong thing to learn afterwards. The plan
   * exists so the user is told first.
   */
  async plan(archive: Archive): Promise<RestorePlan[]> {
    const existing: Record<string, number> = {};
    for (const namespace of NAMESPACES) {
      existing[namespace] = (await this.#store.keys(namespace)).length;
    }
    return planRestore(archive, existing);
  }

  /**
   * Restore an archive.
   *
   * Takes a snapshot first when snapshots are switched on, so an unwanted
   * restore is itself recoverable. That is the single most useful thing this
   * class does: the moment a user restores the wrong file is the moment they
   * most need the state they just replaced.
   */
  async restore(archive: Archive): Promise<{ restored: number; safetySnapshot: string | null }> {
    let safetySnapshot: string | null = null;

    if (this.keepCount > 0) {
      try {
        const taken = await this.snapshot('Taken automatically before a restore.');
        safetySnapshot = taken.id;
      } catch (error) {
        // Not fatal, but the user must be told the net is missing.
        this.#logger.warn('Could not snapshot before restoring.', error);
      }
    }

    let restored = 0;
    for (const section of archive.sections) {
      // Replace, not merge. Anything present and absent from the archive goes,
      // which is what the plan warned about.
      await this.#store.clearNamespace(section.namespace);

      for (const [key, value] of section.entries) {
        const restoredValue =
          section.namespace === BLOB_NAMESPACE && isEncodedBlob(value)
            ? decodeBinary(value)
            : value;
        await this.#store.set(section.namespace, key, restoredValue);
        restored += 1;
      }
    }

    // Settings live in memory as well as in storage, so they have to be read
    // back or the interface keeps running on the values it was started with.
    await this.#settings.load();

    this.#logger.info('Archive restored.', { restored, sections: archive.sections.length });
    this.#notify();

    return { restored, safetySnapshot };
  }

  /** Read a file the user chose, and refuse it clearly when it is not ours. */
  async readFile(file: Blob): Promise<Archive> {
    const text = await file.text();
    try {
      return parseArchive(text);
    } catch (error) {
      throw new HelixError(
        'VALIDATION_FAILED',
        error instanceof ArchiveError ? error.message : 'That file could not be read as a backup.',
      );
    }
  }

  /** Section labels and counts, for showing what an archive holds. */
  summarise(archive: Archive) {
    return summariseArchive(archive);
  }
}
