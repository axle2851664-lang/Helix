import type { EventBus } from '../core/EventBus.js';
import type { Logger } from '../core/Logger.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import type { ProjectManager } from '../projects/ProjectManager.js';
import { chunkText, extractText, extractionBlocker } from './extract.js';

/**
 * File and knowledge memory (spec 6D, 12).
 *
 * Indexes the text of imported files so they can be searched, and keeps that
 * strictly separate from long-term memory: the specification is explicit that
 * file contents must not be converted into personal memories. Nothing here ever
 * writes to the memory namespace.
 *
 * Search is term-frequency scoring over stored chunks - literal, offline, and
 * needing no embedding provider. Semantic search is a later addition and is not
 * pretended at; `searchable` reports what this index can actually do.
 */

const NAMESPACE = 'knowledge';

/** A file that could not be indexed still gets a record, with the reason. */
export interface IndexedDocument {
  /** Same id as the project asset, so the two stay in step. */
  assetId: string;
  projectId: string;
  fileName: string;
  indexedAt: number;
  /** True when text was extracted and chunks exist. */
  indexed: boolean;
  /** Why it was not indexed. Present when `indexed` is false. */
  reason?: string;
  chunks: string[];
  /** Total characters of extracted text. */
  characters: number;
}

export interface KnowledgeHit {
  assetId: string;
  projectId: string;
  fileName: string;
  /** Index of the matching chunk within the document. */
  chunkIndex: number;
  /** The matching chunk, trimmed to a readable snippet. */
  snippet: string;
  score: number;
  /** Query terms that matched, for highlighting and explanation. */
  matched: string[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'it', 'its', 'this', 'that', 'with', 'as', 'at', 'by',
  'from', 'what', 'do', 'does', 'my', 'me', 'i', 'about', 'say', 'says',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export interface KnowledgeIndexOptions {
  store: KeyValueStore;
  projects: ProjectManager;
  logger: Logger;
  bus?: EventBus;
}

export class KnowledgeIndex {
  readonly #store: KeyValueStore;
  readonly #projects: ProjectManager;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options: KnowledgeIndexOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#logger = options.logger.child('knowledge');
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
        this.#logger.error('A knowledge listener threw.', error);
      }
    }
  }

  /**
   * Index one asset. Always writes a record - an unreadable file is recorded
   * with its reason rather than skipped, so the Files view can explain why it
   * is not searchable.
   */
  async indexAsset(assetId: string): Promise<IndexedDocument> {
    const asset = await this.#projects.getAsset(assetId);
    if (!asset) {
      throw new Error(`indexAsset: unknown asset ${assetId}`);
    }

    const blocker = extractionBlocker(asset.fileName, asset.kind);
    if (blocker !== null) {
      return this.#write({
        assetId,
        projectId: asset.projectId,
        fileName: asset.fileName,
        indexedAt: Date.now(),
        indexed: false,
        reason: blocker,
        chunks: [],
        characters: 0,
      });
    }

    const data = await this.#projects.getAssetData(assetId);
    if (!data) {
      return this.#write({
        assetId,
        projectId: asset.projectId,
        fileName: asset.fileName,
        indexedAt: Date.now(),
        indexed: false,
        reason: 'The file data is missing from storage.',
        chunks: [],
        characters: 0,
      });
    }

    const extraction = await extractText(asset.fileName, asset.kind, data);
    if (extraction.status !== 'extracted') {
      return this.#write({
        assetId,
        projectId: asset.projectId,
        fileName: asset.fileName,
        indexedAt: Date.now(),
        indexed: false,
        ...(extraction.reason !== undefined ? { reason: extraction.reason } : {}),
        chunks: [],
        characters: 0,
      });
    }

    const chunks = chunkText(extraction.text);
    this.#logger.info('Indexed a file.', {
      assetId,
      chunks: chunks.length,
      characters: extraction.text.length,
    });

    return this.#write({
      assetId,
      projectId: asset.projectId,
      fileName: asset.fileName,
      indexedAt: Date.now(),
      indexed: true,
      chunks,
      characters: extraction.text.length,
    });
  }

  async #write(document: IndexedDocument): Promise<IndexedDocument> {
    await this.#store.set(NAMESPACE, document.assetId, document);
    this.#bus?.emit('KNOWLEDGE_INDEXED', {
      assetId: document.assetId,
      indexed: document.indexed,
    });
    this.#notify();
    return document;
  }

  /**
   * Index every asset in a project that is not already indexed.
   * Returns how many were newly indexed and how many could not be.
   */
  async indexProject(projectId: string): Promise<{ indexed: number; skipped: number }> {
    const assets = await this.#projects.listAssets(projectId);
    let indexed = 0;
    let skipped = 0;

    for (const asset of assets) {
      try {
        const document = await this.indexAsset(asset.id);
        if (document.indexed) indexed += 1;
        else skipped += 1;
      } catch (error) {
        // One bad file must not abandon the rest of the project.
        skipped += 1;
        this.#logger.warn('Could not index an asset.', { assetId: asset.id, error });
      }
    }

    return { indexed, skipped };
  }

  async get(assetId: string): Promise<IndexedDocument | undefined> {
    return this.#store.get<IndexedDocument>(NAMESPACE, assetId);
  }

  async list(options: { projectId?: string } = {}): Promise<IndexedDocument[]> {
    const entries = await this.#store.entries<IndexedDocument>(NAMESPACE);
    return entries
      .map(([, document]) => document)
      .filter((document) =>
        options.projectId === undefined ? true : document.projectId === options.projectId,
      )
      .sort((a, b) => b.indexedAt - a.indexedAt);
  }

  /** Documents that are actually searchable, i.e. have chunks. */
  async searchable(): Promise<IndexedDocument[]> {
    return (await this.list()).filter((document) => document.indexed);
  }

  async remove(assetId: string): Promise<void> {
    await this.#store.delete(NAMESPACE, assetId);
    this.#notify();
  }

  /** Drop index records whose asset no longer exists. */
  async prune(): Promise<number> {
    const documents = await this.list();
    let removed = 0;
    for (const document of documents) {
      if (!(await this.#projects.getAsset(document.assetId))) {
        await this.#store.delete(NAMESPACE, document.assetId);
        removed += 1;
      }
    }
    if (removed > 0) this.#notify();
    return removed;
  }

  async clear(): Promise<void> {
    await this.#store.clearNamespace(NAMESPACE);
    this.#notify();
  }

  /**
   * Keyword search across indexed chunks.
   *
   * Scoring is term frequency weighted by how rare a term is across documents,
   * so a word appearing in every file contributes little. Deliberately simple:
   * it is honest keyword matching, and the UI does not describe it as anything
   * cleverer.
   */
  async search(
    query: string,
    options: { projectId?: string; limit?: number } = {},
  ): Promise<KnowledgeHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const documents = (
      await this.list(options.projectId !== undefined ? { projectId: options.projectId } : {})
    ).filter((document) => document.indexed);
    if (documents.length === 0) return [];

    // Document frequency per term, for the rarity weighting.
    const documentFrequency = new Map<string, number>();
    for (const document of documents) {
      const present = new Set<string>();
      for (const chunk of document.chunks) {
        for (const token of tokenize(chunk)) {
          if (terms.includes(token)) present.add(token);
        }
      }
      for (const token of present) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }

    const hits: KnowledgeHit[] = [];

    for (const document of documents) {
      document.chunks.forEach((chunk, chunkIndex) => {
        const chunkTokens = tokenize(chunk);
        if (chunkTokens.length === 0) return;

        const counts = new Map<string, number>();
        for (const token of chunkTokens) {
          if (terms.includes(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
        }
        if (counts.size === 0) return;

        let score = 0;
        for (const [term, count] of counts) {
          const df = documentFrequency.get(term) ?? 1;
          const rarity = Math.log(1 + documents.length / df);
          score += (count / chunkTokens.length) * rarity;
        }

        // Reward covering more of the query, so a chunk matching every term
        // outranks one that repeats a single term.
        score *= counts.size / terms.length;

        // An exact phrase match is a much stronger signal than scattered terms.
        if (chunk.toLowerCase().includes(query.trim().toLowerCase())) score *= 3;

        hits.push({
          assetId: document.assetId,
          projectId: document.projectId,
          fileName: document.fileName,
          chunkIndex,
          snippet: KnowledgeIndex.#snippet(chunk, [...counts.keys()]),
          score,
          matched: [...counts.keys()],
        });
      });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.limit ?? 10);
  }

  /** A readable excerpt centred on the first matching term. */
  static #snippet(chunk: string, terms: string[], width = 260): string {
    const collapsed = chunk.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= width) return collapsed;

    const lower = collapsed.toLowerCase();
    let at = -1;
    for (const term of terms) {
      const found = lower.indexOf(term);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    if (at === -1) return `${collapsed.slice(0, width)}...`;

    const start = Math.max(0, at - Math.floor(width / 3));
    const end = Math.min(collapsed.length, start + width);
    return `${start > 0 ? '...' : ''}${collapsed.slice(start, end).trim()}${
      end < collapsed.length ? '...' : ''
    }`;
  }

  async stats(): Promise<{ documents: number; searchable: number; chunks: number }> {
    const documents = await this.list();
    const searchable = documents.filter((document) => document.indexed);
    return {
      documents: documents.length,
      searchable: searchable.length,
      chunks: searchable.reduce((sum, document) => sum + document.chunks.length, 0),
    };
  }
}
