import type { KeyValueStore } from './KeyValueStore.js';
import type { Logger } from '../core/Logger.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import type { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import type { ConversationStore } from '../conversations/ConversationStore.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import { HelixError } from '../core/HelixError.js';
import {
  admit,
  fillRatio,
  gigabytesToBytes,
  headroom,
  type Admission,
  type BudgetState,
  type Headroom,
} from './budget.js';

/**
 * Storage accounting and the enforced ceiling (spec 11).
 *
 * Two jobs, and the second is the one that matters. Accounting tells the user
 * what Helix is holding. Admission decides whether the next write happens at
 * all, and it runs at the choke point - inside the import path - rather than in
 * the screen that calls it, so no caller can forget to ask.
 *
 * Everything reported here is measured or explicitly marked as not. Asset sizes
 * are known exactly because they were recorded on import. Record sizes are
 * estimated by serialising them, which is honest about being an estimate: JSON
 * length is not what IndexedDB writes to disk, and the difference is not worth
 * pretending away.
 */

export type StorageCategory =
  | 'assets'
  | 'knowledge'
  | 'conversations'
  | 'memory'
  | 'settings';

export interface CategoryUsage {
  category: StorageCategory;
  label: string;
  bytes: number;
  items: number;
  /**
   * How the figure was arrived at. `measured` means a recorded byte count;
   * `estimated` means a serialised length, which is close but not what the
   * backend actually writes.
   */
  basis: 'measured' | 'estimated';
  /** What the category holds, for the user rather than for the developer. */
  description: string;
}

/**
 * Something that can be deleted to free space.
 *
 * Never acted on automatically. Helix reports what could go and what it would
 * recover; deleting is a decision, and a storage figure is not consent.
 */
export interface Reclaimable {
  id: 'orphan-index' | 'generated-assets' | 'stored-conversations';
  label: string;
  /** Why this is safe to remove, and what is lost if it goes. */
  detail: string;
  bytes: number;
  items: number;
}

export interface StorageReport {
  categories: CategoryUsage[];
  totalBytes: number;
  ceilingBytes: number;
  headroom: Headroom;
  fill: { ratio: number; basis: string };
  reclaimable: Reclaimable[];
  /**
   * Whether the backend can report its own size. When false, the total is the
   * sum of the categories, which misses backend overhead.
   */
  backendReportedBytes: number | null;
}

export interface StorageManagerOptions {
  store: KeyValueStore;
  platform: PlatformAdapter;
  settings: SettingsManager;
  projects: ProjectManager;
  knowledge: KnowledgeIndex;
  conversations: ConversationStore;
  memory: MemoryManager;
  logger: Logger;
}

/** Serialised length, used where nothing exact is recorded. */
function estimateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

export class StorageManager {
  readonly #store: KeyValueStore;
  readonly #platform: PlatformAdapter;
  readonly #settings: SettingsManager;
  readonly #projects: ProjectManager;
  readonly #knowledge: KnowledgeIndex;
  readonly #conversations: ConversationStore;
  readonly #memory: MemoryManager;
  readonly #logger: Logger;

  constructor(options: StorageManagerOptions) {
    this.#store = options.store;
    this.#platform = options.platform;
    this.#settings = options.settings;
    this.#projects = options.projects;
    this.#knowledge = options.knowledge;
    this.#conversations = options.conversations;
    this.#memory = options.memory;
    this.#logger = options.logger.child('storage');
  }

  get ceilingBytes(): number {
    return gigabytesToBytes(this.#settings.get('storageLimitGb'));
  }

  /** The state both the budget functions and the UI work from. */
  async budgetState(): Promise<BudgetState> {
    const [usedBytes, volume] = await Promise.all([
      this.usedBytes(),
      this.#platform.getVolumeStats(),
    ]);
    return { usedBytes, ceilingBytes: this.ceilingBytes, volume };
  }

  /**
   * Bytes Helix holds.
   *
   * Prefers the backend's own figure when it has one, because that includes
   * index and record overhead the category sums cannot see. Falls back to the
   * sum, which is an undercount - and the report says which was used.
   */
  async usedBytes(): Promise<number> {
    const reported = await this.#store.estimateSize();
    if (reported !== null) return reported;

    const categories = await this.#categories();
    return categories.reduce((total, category) => total + category.bytes, 0);
  }

  async headroom(): Promise<Headroom> {
    return headroom(await this.budgetState());
  }

  /**
   * May this write proceed?
   *
   * Called from inside the import path, so it cannot be skipped by a caller
   * that forgets. Returns a verdict rather than throwing, because "no" with a
   * reason is information the user needs.
   */
  async admit(bytes: number): Promise<Admission> {
    return admit(bytes, await this.budgetState());
  }

  /** Admission as an assertion, for call sites that treat refusal as an error. */
  async requireRoom(bytes: number): Promise<void> {
    const verdict = await this.admit(bytes);
    if (verdict.allowed) return;

    throw new HelixError('STORAGE_LIMIT', verdict.reason, {
      technical: `refused ${bytes} bytes, bound by ${verdict.bound}`,
    });
  }

  async report(): Promise<StorageReport> {
    const [categories, state, backendReportedBytes, reclaimable] = await Promise.all([
      this.#categories(),
      this.budgetState(),
      this.#store.estimateSize(),
      this.#reclaimable(),
    ]);

    return {
      categories,
      totalBytes: state.usedBytes,
      ceilingBytes: state.ceilingBytes,
      headroom: headroom(state),
      fill: fillRatio(state),
      reclaimable,
      backendReportedBytes,
    };
  }

  async #categories(): Promise<CategoryUsage[]> {
    const [projects, documents, conversations, memories, settingsEntries] = await Promise.all([
      this.#projects.listProjects(),
      this.#knowledge.list(),
      this.#conversations.list(),
      this.#memory.list(),
      this.#store.entries<unknown>('settings'),
    ]);

    const assetBytes = projects.reduce((total, project) => total + project.totalBytes, 0);
    const assetCount = projects.reduce((total, project) => total + project.assetCount, 0);

    return [
      {
        category: 'assets',
        label: 'Imported files',
        bytes: assetBytes,
        items: assetCount,
        // Exact: the byte count was recorded when the file was imported.
        basis: 'measured',
        description: 'Your originals and anything generated from them.',
      },
      {
        category: 'knowledge',
        label: 'Search index',
        bytes: documents.reduce((total, document) => total + estimateBytes(document), 0),
        items: documents.length,
        basis: 'estimated',
        description: 'Extracted text, so files can be searched without reopening them.',
      },
      {
        category: 'conversations',
        label: 'Conversations',
        bytes: conversations.reduce((total, entry) => total + estimateBytes(entry), 0),
        items: conversations.length,
        basis: 'estimated',
        description: this.#conversations.persisting
          ? 'Written to storage, because history is switched on.'
          : 'Held for this session only, and not written to storage.',
      },
      {
        category: 'memory',
        label: 'Long-term memory',
        bytes: memories.reduce((total, record) => total + estimateBytes(record), 0),
        items: memories.length,
        basis: 'estimated',
        description: 'Only what you asked Helix to keep.',
      },
      {
        category: 'settings',
        label: 'Settings',
        bytes: settingsEntries.reduce((total, [, value]) => total + estimateBytes(value), 0),
        items: settingsEntries.length,
        basis: 'estimated',
        description: 'Your preferences. No credentials are ever stored here.',
      },
    ];
  }

  /**
   * What could be freed.
   *
   * Each entry says what is lost, because "reclaim 40 MB" is not a decision
   * anyone can make without knowing what goes with it.
   */
  async #reclaimable(): Promise<Reclaimable[]> {
    const items: Reclaimable[] = [];

    const [documents, projects] = await Promise.all([
      this.#knowledge.list(),
      this.#projects.listProjects(),
    ]);

    // Index records whose asset has been deleted. Pure waste: they can never
    // be searched to anything the user still has.
    const orphans: typeof documents = [];
    for (const document of documents) {
      if (!(await this.#projects.getAsset(document.assetId))) orphans.push(document);
    }
    if (orphans.length > 0) {
      items.push({
        id: 'orphan-index',
        label: 'Index records for deleted files',
        detail: 'The files they describe are gone, so these can never match a search. Nothing is lost.',
        bytes: orphans.reduce((total, document) => total + estimateBytes(document), 0),
        items: orphans.length,
      });
    }

    const generatedBytes = projects.reduce((total, project) => total + project.generatedCount, 0);
    if (generatedBytes > 0) {
      const bytes = await this.#generatedBytes();
      items.push({
        id: 'generated-assets',
        label: 'Generated files',
        detail:
          'Anything Helix produced from your originals. Your originals are untouched, but whatever was generated would have to be made again.',
        bytes,
        items: generatedBytes,
      });
    }

    if (!this.#conversations.persisting) {
      const stored = await this.#store.entries<unknown>('conversations');
      if (stored.length > 0) {
        items.push({
          id: 'stored-conversations',
          label: 'Conversations left on disk',
          detail:
            'History is switched off, but these were written while it was on. Removing them cannot affect this session.',
          bytes: stored.reduce((total, [, value]) => total + estimateBytes(value), 0),
          items: stored.length,
        });
      }
    }

    return items;
  }

  async #generatedBytes(): Promise<number> {
    const projects = await this.#projects.listProjects();
    let bytes = 0;

    for (const project of projects) {
      for (const asset of await this.#projects.listAssets(project.id)) {
        if (asset.origin === 'generated') bytes += asset.sizeBytes;
      }
    }
    return bytes;
  }

  /**
   * Free one of the reclaimable entries.
   *
   * Deliberately one at a time, by id, on an explicit request. There is no
   * "clean up everything" here: the user chooses each thing that goes.
   */
  async reclaim(id: Reclaimable['id']): Promise<{ items: number }> {
    switch (id) {
      case 'orphan-index': {
        const removed = await this.#knowledge.prune();
        this.#logger.info('Pruned orphaned index records.', { removed });
        return { items: removed };
      }
      case 'generated-assets': {
        let removed = 0;
        for (const project of await this.#projects.listProjects()) {
          removed += await this.#projects.deleteGeneratedAssets(project.id);
        }
        this.#logger.info('Removed generated assets.', { removed });
        return { items: removed };
      }
      case 'stored-conversations': {
        const stored = await this.#store.entries<unknown>('conversations');
        await this.#store.clearNamespace('conversations');
        this.#logger.info('Cleared stored conversations.', { removed: stored.length });
        return { items: stored.length };
      }
    }
  }
}
