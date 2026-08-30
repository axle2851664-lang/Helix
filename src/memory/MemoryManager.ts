import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import { findSecrets, looksLikeLabelledCredential } from '../core/secrets.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryMatch,
  type MemoryRecord,
  type MemorySaveRequest,
} from './types.js';

/**
 * Long-term memory (spec 6, 10).
 *
 * Three rules are enforced here rather than left to callers:
 *
 * 1. **Nothing is remembered unless the user asks.** There is no code path that
 *    turns a conversation into a memory. `save()` is called from an explicit
 *    "remember this" command or the Memory workspace, and from nowhere else.
 *
 * 2. **Credentials are refused, not stored.** Content that looks like an API
 *    key, token, private key, or a labelled password is rejected with an
 *    explanation. A user who pastes a key into "remember this" gets a refusal,
 *    not a credential written to disk (spec 8).
 *
 * 3. **The user can turn it off.** When `allowLongTermMemory` is false, saving
 *    is refused outright - existing memories remain readable and deletable, so
 *    disabling the feature never destroys data silently.
 *
 * Search is literal scoring: no model, works offline. Semantic search needs an
 * embedding provider and is not pretended at.
 */

const NAMESPACE = 'memory';

/** Content longer than this is refused rather than silently truncated. */
const MAX_CONTENT_LENGTH = 2000;

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `mem_${random}`;
}

/** Words ignored when scoring a search. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'i', 'me', 'my', 'you', 'your', 'it', 'its', 'that', 'this', 'of',
  'to', 'in', 'on', 'for', 'and', 'or', 'do', 'does', 'did', 'what',
  'about', 'know', 'remember', 'tell', 'me', 'anything',
]);

export interface MemoryManagerOptions {
  store: KeyValueStore;
  settings: SettingsManager;
  logger: Logger;
  bus?: EventBus;
}

export class MemoryManager {
  readonly #store: KeyValueStore;
  readonly #settings: SettingsManager;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: MemoryManagerOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#logger = options.logger.child('memory');
    this.#bus = options.bus;
  }

  /** False when the user has disabled long-term memory in Settings. */
  get enabled(): boolean {
    return this.#settings.get('allowLongTermMemory');
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
        this.#logger.error('A memory listener threw.', error);
      }
    }
  }

  /**
   * Store a memory. Only ever called in response to an explicit user request.
   * Throws a HelixError with a readable message when the content is refused.
   */
  async save(request: MemorySaveRequest): Promise<MemoryRecord> {
    if (!this.enabled) {
      throw new HelixError(
        'PERMISSION_DENIED',
        'Long-term memory is turned off. Enable it in Settings under Privacy if you want me to remember things.',
        { technical: 'save() called while allowLongTermMemory is false.' },
      );
    }

    const content = request.content.trim();

    if (content === '') {
      throw new HelixError('VALIDATION_FAILED', 'There is nothing to remember.', {
        technical: 'save() called with empty content.',
      });
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      throw new HelixError(
        'VALIDATION_FAILED',
        `That is too long to store as a single memory (${content.length} characters, limit ${MAX_CONTENT_LENGTH}).`,
        { technical: `Memory content length ${content.length}` },
      );
    }

    // Refuse credentials. Deliberately before any write, and the rejected
    // content is never logged.
    const secrets = findSecrets(content);
    if (secrets.length > 0) {
      const kinds = [...new Set(secrets.map((finding) => finding.label))].join(', ');
      this.#logger.warn('Refused to store content that looks like a credential.', { kinds });
      throw new HelixError(
        'VALIDATION_FAILED',
        `That looks like a credential (${kinds}), so I will not store it. Helix never keeps keys, tokens or passwords in memory.`,
        { technical: `Rejected memory containing: ${kinds}` },
      );
    }

    if (looksLikeLabelledCredential(content)) {
      this.#logger.warn('Refused to store a labelled credential.');
      throw new HelixError(
        'VALIDATION_FAILED',
        'That reads like a password or key, so I will not store it. Helix never keeps credentials in memory.',
        { technical: 'Rejected memory matching the labelled-credential pattern.' },
      );
    }

    const category = MemoryManager.#validCategory(request.category);
    const now = Date.now();

    const record: MemoryRecord = {
      id: newId(),
      content,
      category,
      source: request.source ?? 'user-explicit',
      // Only user-stated memories exist today, so confidence is certain.
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.tags && request.tags.length > 0
        ? { tags: request.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean) }
        : {}),
    };

    await this.#store.set(NAMESPACE, record.id, record);
    // The content itself is not logged - only that a memory was created.
    this.#logger.info('Memory saved.', { memoryId: record.id, category });
    this.#bus?.emit('MEMORY_SAVED', { memoryId: record.id, category });
    this.#notify();
    return record;
  }

  static #validCategory(category: MemoryCategory | undefined): MemoryCategory {
    if (category && (MEMORY_CATEGORIES as readonly string[]).includes(category)) return category;
    return 'fact';
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    return this.#store.get<MemoryRecord>(NAMESPACE, id);
  }

  /** Every memory, newest first. Optionally scoped to one project. */
  async list(options: { projectId?: string } = {}): Promise<MemoryRecord[]> {
    const entries = await this.#store.entries<MemoryRecord>(NAMESPACE);
    return entries
      .map(([, record]) => record)
      .filter((record) =>
        options.projectId === undefined ? true : record.projectId === options.projectId,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async count(): Promise<number> {
    return (await this.#store.keys(NAMESPACE)).length;
  }

  /**
   * Literal keyword search. Returns matches ordered best first, and touches
   * `lastAccessedAt` on what it returns so the UI can show what is actually
   * being used.
   */
  async search(query: string, options: { projectId?: string; limit?: number } = {}): Promise<
    MemoryMatch[]
  > {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return [];

    const all = await this.list(
      options.projectId !== undefined ? { projectId: options.projectId } : {},
    );
    const queryTokens = MemoryManager.#tokenize(normalized);
    const matches: MemoryMatch[] = [];

    for (const memory of all) {
      const content = memory.content.toLowerCase();

      if (content === normalized) {
        matches.push({ memory, score: 1, reason: 'exact' });
        continue;
      }
      if (content.includes(normalized)) {
        matches.push({ memory, score: 0.8, reason: 'phrase' });
        continue;
      }
      if (memory.tags?.some((tag) => queryTokens.includes(tag))) {
        matches.push({ memory, score: 0.7, reason: 'tag' });
        continue;
      }

      if (queryTokens.length > 0) {
        const contentTokens = new Set(MemoryManager.#tokenize(content));
        const hits = queryTokens.filter((token) => contentTokens.has(token)).length;
        if (hits > 0) {
          matches.push({ memory, score: 0.3 + 0.4 * (hits / queryTokens.length), reason: 'token' });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
    const limited = options.limit === undefined ? matches : matches.slice(0, options.limit);

    await this.#touch(limited.map((match) => match.memory));
    return limited;
  }

  static #tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }

  /** Record that memories were read, without changing `updatedAt`. */
  async #touch(records: MemoryRecord[]): Promise<void> {
    const now = Date.now();
    for (const record of records) {
      try {
        await this.#store.set(NAMESPACE, record.id, { ...record, lastAccessedAt: now });
      } catch (error) {
        // A failed access-time update must not break the search result.
        this.#logger.debug('Could not update lastAccessedAt.', error);
      }
    }
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'category' | 'tags' | 'projectId'>>,
  ): Promise<MemoryRecord> {
    const existing = await this.get(id);
    if (!existing) {
      throw new HelixError('NOT_FOUND', 'That memory no longer exists.', {
        technical: `update: unknown memory ${id}`,
      });
    }

    if (patch.content !== undefined) {
      const content = patch.content.trim();
      if (content === '') {
        throw new HelixError('VALIDATION_FAILED', 'A memory cannot be empty.', {
          technical: 'update called with empty content.',
        });
      }
      // Editing must be held to the same credential rule as creating.
      if (findSecrets(content).length > 0 || looksLikeLabelledCredential(content)) {
        throw new HelixError(
          'VALIDATION_FAILED',
          'That looks like a credential, so I will not store it.',
          { technical: 'Rejected memory edit containing credential-shaped content.' },
        );
      }
    }

    const updated: MemoryRecord = {
      ...existing,
      ...patch,
      ...(patch.content !== undefined ? { content: patch.content.trim() } : {}),
      updatedAt: Date.now(),
    };

    await this.#store.set(NAMESPACE, id, updated);
    this.#notify();
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.#store.delete(NAMESPACE, id);
    this.#logger.info('Memory deleted.', { memoryId: id });
    this.#bus?.emit('MEMORY_DELETED', { memoryId: id });
    this.#notify();
  }

  /**
   * Delete every memory, or every memory for one project.
   * Destructive and irreversible - callers must confirm with the user first.
   */
  async clear(options: { projectId?: string } = {}): Promise<number> {
    if (options.projectId === undefined) {
      const total = await this.count();
      await this.#store.clearNamespace(NAMESPACE);
      this.#logger.info('All memories cleared.', { removed: total });
      this.#notify();
      return total;
    }

    const scoped = await this.list({ projectId: options.projectId });
    for (const record of scoped) {
      await this.#store.delete(NAMESPACE, record.id);
    }
    if (scoped.length > 0) this.#notify();
    return scoped.length;
  }
}
