import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import { findSecrets, looksLikeLabelledCredential } from '../core/secrets.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import {
  NOTE_CATEGORIES,
  type Note,
  type NoteCategory,
  type NoteMatch,
  type NoteSaveRequest,
} from './types.js';

/**
 * Helix's notes.
 *
 * Built on the same three rules as `MemoryManager`, deliberately, because a
 * second store of the user's own words with looser rules would be the obvious
 * way round the first one:
 *
 * 1. **Nothing is written unless the user asks.** There is no code path from a
 *    conversation to a note. `save()` is reached from an explicit instruction
 *    or from the Notepad screen, and from nowhere else.
 *
 * 2. **Credentials are refused, not stored.** Content that looks like a key, a
 *    token or a labelled password is rejected with an explanation, before any
 *    write, and the rejected content is never logged. A user pasting a key
 *    into "write this down" gets a refusal.
 *
 * 3. **Deleting is deleting.** There is no archive, no bin and no soft flag. A
 *    note the user removed is gone from storage, because a note that looks
 *    deleted and is not is worse than one that was never deleted at all.
 *
 * It differs from memory in one way that matters: there is no setting that
 * turns the Notepad off. Memory is consulted on every turn, so a user who
 * wants Helix to stop building a picture of them needs a switch. A note is
 * only ever read when it is asked for, so the switch would only be a way to
 * lose access to your own writing.
 *
 * Search is literal scoring: no model, works offline. Semantic search needs an
 * embedding provider and is not pretended at.
 */

const NAMESPACE = 'notepad';

/**
 * A note is a document rather than a fact, so the ceiling is much higher than
 * memory's 2,000 characters - but it is still a ceiling. Content longer than
 * this is refused rather than silently truncated, because a note that saved
 * and quietly lost its last page is the worst outcome available.
 */
const MAX_CONTENT_LENGTH = 100_000;

const MAX_TITLE_LENGTH = 120;

function newId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `note_${random}`;
}

/** Words ignored when scoring a search. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'i', 'me', 'my', 'you', 'your', 'it', 'its', 'that', 'this', 'of',
  'to', 'in', 'on', 'for', 'and', 'or', 'do', 'does', 'did', 'what',
  'about', 'note', 'notes', 'find', 'search', 'wrote', 'write',
]);

/**
 * The first line, or the first sentence of it, as a title.
 *
 * Derived rather than invented: every character comes from what the user
 * wrote. A note with no title gets its own opening words, which is what
 * someone scanning a list expects to see.
 */
export function deriveTitle(content: string): string {
  const firstLine = content.trim().split('\n').find((line) => line.trim() !== '') ?? '';
  const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
  if (cleaned === '') return 'Untitled note';
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;

  // Cut at a word boundary. A title ending mid-word reads as a bug.
  const cut = cleaned.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '...';
}

export interface NotepadManagerOptions {
  store: KeyValueStore;
  logger: Logger;
  bus?: EventBus;
}

export class NotepadManager {
  readonly #store: KeyValueStore;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: NotepadManagerOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child('notepad');
    this.#bus = options.bus;
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
        this.#logger.error('A notepad listener threw.', error);
      }
    }
  }

  /**
   * Refuse content that looks like a credential.
   *
   * Shared by `save` and `update`, because an edit is a write: a note that
   * refused a key on creation and accepted one on its second save would have
   * no rule at all.
   */
  #refuseSecrets(content: string): void {
    const secrets = findSecrets(content);
    if (secrets.length > 0) {
      const kinds = [...new Set(secrets.map((finding) => finding.label))].join(', ');
      // The content itself is never logged, only the kind of thing it was.
      this.#logger.warn('Refused to write a note containing what looks like a credential.', { kinds });
      throw new HelixError(
        'VALIDATION_FAILED',
        `That looks like a credential (${kinds}), so I won't write it down. Helix keeps no keys, tokens or passwords in the Notepad.`,
        { technical: `Rejected note containing: ${kinds}` },
      );
    }

    if (looksLikeLabelledCredential(content)) {
      this.#logger.warn('Refused to write a note matching the labelled-credential pattern.');
      throw new HelixError(
        'VALIDATION_FAILED',
        "That reads like a password or key, so I won't write it down. Helix keeps no credentials in the Notepad.",
        { technical: 'Rejected note matching the labelled-credential pattern.' },
      );
    }
  }

  #validate(content: string): string {
    const trimmed = content.trim();

    if (trimmed === '') {
      throw new HelixError('VALIDATION_FAILED', 'There is nothing to write down.', {
        technical: 'Notepad write called with empty content.',
      });
    }

    if (trimmed.length > MAX_CONTENT_LENGTH) {
      throw new HelixError(
        'VALIDATION_FAILED',
        `That is too long for one note (${trimmed.length} characters, limit ${MAX_CONTENT_LENGTH}). Split it and I'll keep both.`,
        { technical: `Note content length ${trimmed.length}` },
      );
    }

    this.#refuseSecrets(trimmed);
    return trimmed;
  }

  /** Write a note. Only ever called in response to an explicit request. */
  async save(request: NoteSaveRequest): Promise<Note> {
    const content = this.#validate(request.content);
    const now = Date.now();

    const note: Note = {
      id: newId(),
      title: NotepadManager.#title(request.title, content),
      content,
      category: NotepadManager.#validCategory(request.category),
      source: request.source ?? 'user-explicit',
      createdAt: now,
      updatedAt: now,
      tags: NotepadManager.#tags(request.tags),
    };

    await this.#store.set(NAMESPACE, note.id, note);
    // Only that a note exists, never a word of what is in it.
    this.#logger.info('Note written.', { noteId: note.id, category: note.category });
    this.#bus?.emit('NOTE_SAVED', { noteId: note.id, category: note.category });
    this.#notify();
    return note;
  }

  /**
   * Change a note that already exists.
   *
   * `createdAt` is never touched, and neither is `source`: a note that was
   * imported stays imported however many times it is edited, because that is a
   * fact about where it came from rather than about its current text.
   */
  async update(
    id: string,
    changes: { title?: string; content?: string; category?: NoteCategory; tags?: string[] },
  ): Promise<Note> {
    const existing = await this.get(id);
    if (!existing) {
      throw new HelixError('NOT_FOUND', "That note doesn't exist.", {
        technical: `update() on missing note ${id}`,
      });
    }

    const content = changes.content === undefined ? existing.content : this.#validate(changes.content);

    // A title the user set stays until the user changes it. Only a title that
    // was derived follows the content, and only when the content moved.
    const derivedBefore = existing.title === deriveTitle(existing.content);
    const title =
      changes.title !== undefined
        ? NotepadManager.#title(changes.title, content)
        : derivedBefore
          ? deriveTitle(content)
          : existing.title;

    const note: Note = {
      ...existing,
      title,
      content,
      category: changes.category === undefined
        ? existing.category
        : NotepadManager.#validCategory(changes.category),
      tags: changes.tags === undefined ? existing.tags : NotepadManager.#tags(changes.tags),
      updatedAt: Date.now(),
    };

    await this.#store.set(NAMESPACE, note.id, note);
    this.#logger.info('Note updated.', { noteId: note.id });
    this.#bus?.emit('NOTE_SAVED', { noteId: note.id, category: note.category });
    this.#notify();
    return note;
  }

  /**
   * Add to the end of a note.
   *
   * Its own verb rather than a read-modify-write at the call site, because
   * "add this to my notes about X" is one of the two things anyone asks the
   * Notepad to do, and two callers doing it by hand would eventually disagree
   * about what a blank line means.
   */
  async append(id: string, text: string): Promise<Note> {
    const existing = await this.get(id);
    if (!existing) {
      throw new HelixError('NOT_FOUND', "That note doesn't exist.", {
        technical: `append() on missing note ${id}`,
      });
    }

    const addition = text.trim();
    if (addition === '') {
      throw new HelixError('VALIDATION_FAILED', 'There is nothing to add.', {
        technical: 'append() called with empty text.',
      });
    }

    return this.update(id, { content: `${existing.content}\n\n${addition}` });
  }

  async get(id: string): Promise<Note | undefined> {
    return this.#store.get<Note>(NAMESPACE, id);
  }

  /** Every note, most recently changed first. */
  async list(): Promise<Note[]> {
    const entries = await this.#store.entries<Note>(NAMESPACE);
    return entries.map(([, note]) => note).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async count(): Promise<number> {
    return (await this.#store.keys(NAMESPACE)).length;
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.#store.delete(NAMESPACE, id);
    this.#logger.info('Note deleted.', { noteId: id });
    this.#bus?.emit('NOTE_DELETED', { noteId: id });
    this.#notify();
    return true;
  }

  /**
   * Literal keyword search, best first.
   *
   * A title hit outranks a body hit: someone searching for "suppliers" who
   * has a note called Suppliers means that one, and burying it under three
   * notes that mention the word in passing is the difference between a search
   * that works and one that technically works.
   */
  async search(query: string, options: { limit?: number } = {}): Promise<NoteMatch[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return [];

    const all = await this.list();
    const queryTokens = NotepadManager.#tokenize(normalized);
    const matches: NoteMatch[] = [];

    for (const note of all) {
      const title = note.title.toLowerCase();
      const content = note.content.toLowerCase();

      if (title === normalized || title.includes(normalized)) {
        matches.push({ note, score: 1, reason: 'title', excerpt: NotepadManager.#excerpt(note, normalized) });
        continue;
      }
      if (content === normalized) {
        matches.push({ note, score: 0.9, reason: 'exact', excerpt: NotepadManager.#excerpt(note, normalized) });
        continue;
      }
      if (content.includes(normalized)) {
        matches.push({ note, score: 0.8, reason: 'phrase', excerpt: NotepadManager.#excerpt(note, normalized) });
        continue;
      }
      if (note.tags.some((tag) => queryTokens.includes(tag))) {
        matches.push({ note, score: 0.7, reason: 'tag', excerpt: NotepadManager.#excerpt(note, normalized) });
        continue;
      }

      if (queryTokens.length > 0) {
        const haystack = new Set(NotepadManager.#tokenize(`${title} ${content}`));
        const hits = queryTokens.filter((token) => haystack.has(token));
        if (hits.length > 0) {
          matches.push({
            note,
            score: 0.3 + 0.4 * (hits.length / queryTokens.length),
            reason: 'token',
            excerpt: NotepadManager.#excerpt(note, hits[0] ?? normalized),
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
    return options.limit === undefined ? matches : matches.slice(0, options.limit);
  }

  /**
   * The line the match was on.
   *
   * A substring of the note and never anything else - the point of showing it
   * is to let the user see why this note came back, and a summary would be
   * Helix's words presented as theirs.
   */
  static #excerpt(note: Note, needle: string): string {
    const lines = note.content.split('\n').filter((line) => line.trim() !== '');
    const hit = lines.find((line) => line.toLowerCase().includes(needle)) ?? lines[0] ?? note.title;
    const trimmed = hit.trim();
    return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157)}...`;
  }

  static #title(given: string | undefined, content: string): string {
    const trimmed = (given ?? '').trim();
    if (trimmed === '') return deriveTitle(content);
    return trimmed.length <= MAX_TITLE_LENGTH ? trimmed : `${trimmed.slice(0, MAX_TITLE_LENGTH)}...`;
  }

  static #validCategory(category: NoteCategory | undefined): NoteCategory {
    if (category && (NOTE_CATEGORIES as readonly string[]).includes(category)) return category;
    return 'note';
  }

  static #tags(tags: string[] | undefined): string[] {
    if (!tags) return [];
    return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  }

  static #tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  }
}
