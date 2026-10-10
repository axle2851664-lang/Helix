import type { EventBus } from '../core/EventBus.js';
import { HavocError } from '../core/HavocError.js';
import type { Logger } from '../core/Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import type { ToolCard } from '../tools/cards.js';

/**
 * Conversation storage (spec 10: short-term conversation memory).
 *
 * Privacy is structural here, not advisory. Conversations always exist in
 * memory for the current session, but they are only written to disk when the
 * user has switched on "Keep conversation history" (off by default). The check
 * happens inside every write path, so no caller can bypass it by accident.
 *
 * This is short-term memory, deliberately separate from long-term memory: it is
 * never promoted into anything permanent without an explicit user action.
 */

export type MessageRole = 'user' | 'havoc' | 'system';

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  /**
   * Set when Havoc could not do what was asked. Kept so the transcript records
   * the failure rather than showing an answer that never happened.
   */
  failure?: string;
  /**
   * The structured half of a two-part reply, kept with the message so a
   * reloaded transcript still shows the detail. Plain data, so it survives the
   * round trip through storage unchanged.
   */
  card?: ToolCard;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const NAMESPACE = 'conversations';

function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

export interface ConversationStoreOptions {
  store: KeyValueStore;
  settings: SettingsManager;
  logger: Logger;
  bus?: EventBus;
}

export class ConversationStore {
  readonly #store: KeyValueStore;
  readonly #settings: SettingsManager;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;

  /** Session-scoped copies. Always populated, persisted only when permitted. */
  readonly #session = new Map<string, Conversation>();
  #listeners = new Set<() => void>();

  constructor(options: ConversationStoreOptions) {
    this.#store = options.store;
    this.#settings = options.settings;
    this.#logger = options.logger.child('conversations');
    this.#bus = options.bus;
  }

  /** True when conversations are being written to durable storage. */
  get persisting(): boolean {
    return this.#settings.get('saveConversationHistory');
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
        this.#logger.error('A conversation listener threw.', error);
      }
    }
  }

  async create(title = 'New conversation'): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      id: newId('conv'),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    this.#session.set(conversation.id, conversation);
    await this.#persist(conversation);

    this.#bus?.emit('CONVERSATION_CREATED', { conversationId: conversation.id });
    this.#notify();
    return conversation;
  }

  async get(id: string): Promise<Conversation | undefined> {
    const cached = this.#session.get(id);
    if (cached) return cached;

    try {
      const stored = await this.#store.get<Conversation>(NAMESPACE, id);
      const conversation = stored === undefined ? undefined : migrateRoles(stored);
      if (conversation) this.#session.set(id, conversation);
      return conversation;
    } catch (error) {
      this.#logger.error('Could not read a conversation.', error);
      return undefined;
    }
  }

  async appendMessage(
    conversationId: string,
    message: Omit<ConversationMessage, 'id' | 'createdAt'>,
  ): Promise<ConversationMessage> {
    const conversation = await this.get(conversationId);
    if (!conversation) {
      throw new HavocError('NOT_FOUND', 'That conversation no longer exists.', {
        technical: `appendMessage: unknown conversation ${conversationId}`,
      });
    }

    const full: ConversationMessage = {
      id: newId('msg'),
      createdAt: Date.now(),
      ...message,
    };

    conversation.messages.push(full);
    conversation.updatedAt = full.createdAt;

    // Title the conversation from its first user message, so the list is
    // readable without asking a model to summarise anything.
    if (conversation.title === 'New conversation' && message.role === 'user') {
      conversation.title = message.text.slice(0, 60).trim() || 'New conversation';
    }

    await this.#persist(conversation);
    this.#bus?.emit('MESSAGE_APPENDED', { conversationId, role: message.role });
    this.#notify();
    return full;
  }

  async list(): Promise<ConversationSummary[]> {
    const summaries = new Map<string, ConversationSummary>();

    if (this.persisting) {
      try {
        const stored = await this.#store.entries<Conversation>(NAMESPACE);
        for (const [, conversation] of stored) {
          summaries.set(conversation.id, ConversationStore.#summarise(conversation));
        }
      } catch (error) {
        this.#logger.error('Could not list stored conversations.', error);
      }
    }

    // Session copies win: they are the most recent view of a conversation.
    for (const conversation of this.#session.values()) {
      summaries.set(conversation.id, ConversationStore.#summarise(conversation));
    }

    return [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static #summarise(conversation: Conversation): ConversationSummary {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    };
  }

  async delete(id: string): Promise<void> {
    this.#session.delete(id);
    try {
      await this.#store.delete(NAMESPACE, id);
    } catch (error) {
      this.#logger.error('Could not delete a stored conversation.', error);
    }
    this.#bus?.emit('CONVERSATION_DELETED', { conversationId: id });
    this.#notify();
  }

  /** Remove every conversation, from this session and from disk. */
  async clearAll(): Promise<void> {
    this.#session.clear();
    try {
      await this.#store.clearNamespace(NAMESPACE);
    } catch (error) {
      this.#logger.error('Could not clear stored conversations.', error);
    }
    this.#notify();
  }

  /**
   * Write through only when the user has allowed history. A failure is logged
   * and reported, never silently ignored - but it does not lose the in-session
   * copy, so the UI stays usable.
   */
  async #persist(conversation: Conversation): Promise<void> {
    if (!this.persisting) return;
    try {
      await this.#store.set(NAMESPACE, conversation.id, conversation);
    } catch (error) {
      this.#logger.error('Could not save a conversation.', error);
    }
  }
}

/**
 * Messages stored before the rename said `role: 'helix'`.
 *
 * Normalised here, at the one place conversations are read, because the role
 * is compared by value all over the orchestrator - which decides what the
 * model is shown, and what counts as the last thing Havoc said. Renaming the
 * union and nothing else silently dropped every message of an existing
 * conversation out of the context sent to the model: Havoc would have been
 * answering with no memory of anything it had ever said, which is far worse
 * than an error, because it looks like forgetfulness rather than a bug.
 *
 * A read-time normalisation rather than a stored migration. It costs a pass
 * over a conversation that was being loaded anyway, it cannot half-finish, and
 * a conversation that is never opened never needs it. The value is written
 * back the next time a message is appended.
 */
function migrateRoles(conversation: Conversation): Conversation {
  const stale = conversation.messages.some(
    (message) => (message.role as string) === 'helix',
  );
  if (!stale) return conversation;

  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      (message.role as string) === 'helix' ? { ...message, role: 'havoc' as const } : message,
    ),
  };
}
