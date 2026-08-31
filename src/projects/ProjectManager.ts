import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import type { PathManager } from '../storage/PathManager.js';
import { DEFAULT_MAX_FILE_BYTES, validateUpload, type FileCandidate } from './validation.js';
import type {
  AssetOrigin,
  Project,
  ProjectAsset,
  ProjectMatch,
  ProjectSummary,
} from './types.js';

/**
 * Project and asset management (spec 7, 9, 12).
 *
 * Storage layout - three namespaces, kept separate on purpose:
 *
 *   projects        project records (metadata only)
 *   project-assets  asset records (metadata only)
 *   asset-blobs     the file bytes, keyed by asset id
 *
 * Metadata is split from bytes so listing projects never loads a single byte of
 * file content. Blobs are fetched only when something actually needs the file.
 *
 * Two guarantees that shape the API:
 *
 * - **A project must be named.** `createProject` refuses an empty name, and
 *   importing a file requires a project, so a file can never land in an unnamed
 *   or implicit bucket (spec 7, 19).
 * - **Originals are never touched by generated output.** Assets carry an
 *   `origin`, deletions of generated assets cannot cascade to their source, and
 *   `deleteGeneratedAssets` exists precisely so a failed generation can be
 *   cleared without risking the import.
 */

const PROJECTS = 'projects';
const ASSETS = 'project-assets';
const BLOBS = 'asset-blobs';

function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

export interface ProjectManagerOptions {
  store: KeyValueStore;
  logger: Logger;
  paths: PathManager;
  bus?: EventBus;
  /** Overrides the per-file size ceiling. Defaults to 250 MB. */
  maxFileBytes?: number;
}

/**
 * The storage budget, as this module needs to see it.
 *
 * A narrow callback rather than the StorageManager itself, because the manager
 * has to read projects to work out what is being held - taking the whole thing
 * would be a cycle. This is the one question the import path needs answered.
 */
export interface StorageBudget {
  requireRoom(bytes: number): Promise<void>;
}

export interface ImportRequest {
  projectId: string;
  file: FileCandidate;
  /** File contents. Blobs and ArrayBuffers are both structured-cloneable. */
  data: Blob | ArrayBuffer;
  origin?: AssetOrigin;
  derivedFrom?: string;
  metadata?: Record<string, unknown>;
}

export class ProjectManager {
  readonly #store: KeyValueStore;
  readonly #logger: Logger;
  readonly #paths: PathManager;
  readonly #bus: EventBus | undefined;
  readonly #maxFileBytes: number;
  readonly #listeners = new Set<() => void>();
  /** Set by the kernel once StorageManager exists. Null until then. */
  #budget: StorageBudget | null = null;

  constructor(options: ProjectManagerOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child('projects');
    this.#paths = options.paths;
    this.#bus = options.bus;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Attach the storage budget.
   *
   * Wired after construction because the budget has to read projects to know
   * what is held, and the two cannot each be built from the other. Until it is
   * attached, imports are limited only by the per-file ceiling - which is why
   * the kernel attaches it before anything can be imported.
   */
  setBudget(budget: StorageBudget): void {
    this.#budget = budget;
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
        this.#logger.error('A project listener threw.', error);
      }
    }
  }

  // ------------------------------------------------------------- projects

  async createProject(name: string, description = ''): Promise<Project> {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new HelixError('VALIDATION_FAILED', 'A project needs a name.', {
        technical: 'createProject called with an empty name.',
      });
    }
    if (trimmed.length > 120) {
      throw new HelixError(
        'VALIDATION_FAILED',
        'That project name is too long. Keep it under 120 characters.',
        { technical: `Project name length ${trimmed.length}` },
      );
    }

    const now = Date.now();
    const project: Project = {
      id: newId('proj'),
      name: trimmed,
      description: description.trim(),
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    await this.#store.set(PROJECTS, project.id, project);
    this.#logger.info('Project created.', { projectId: project.id });
    this.#bus?.emit('PROJECT_CREATED', { projectId: project.id, name: project.name });
    this.#notify();
    return project;
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    return this.#store.get<Project>(PROJECTS, projectId);
  }

  /** Load a project and announce it, for "open my Iron Man project". */
  async openProject(projectId: string): Promise<ProjectSummary> {
    const summary = await this.getSummary(projectId);
    if (!summary) {
      throw new HelixError('NOT_FOUND', 'That project no longer exists.', {
        technical: `openProject: unknown project ${projectId}`,
      });
    }
    this.#bus?.emit('PROJECT_OPENED', { projectId });
    return summary;
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new HelixError('VALIDATION_FAILED', 'A project needs a name.', {
        technical: 'renameProject called with an empty name.',
      });
    }

    const project = await this.#requireProject(projectId);
    const updated: Project = { ...project, name: trimmed, updatedAt: Date.now() };
    await this.#store.set(PROJECTS, projectId, updated);
    this.#notify();
    return updated;
  }

  async updateProject(
    projectId: string,
    patch: Partial<Pick<Project, 'description' | 'thumbnailAssetId' | 'metadata'>>,
  ): Promise<Project> {
    const project = await this.#requireProject(projectId);
    const updated: Project = { ...project, ...patch, updatedAt: Date.now() };
    await this.#store.set(PROJECTS, projectId, updated);
    this.#notify();
    return updated;
  }

  /**
   * Delete a project and everything belonging to it. This is destructive and
   * irreversible, so callers must confirm with the user first (spec 24) - the
   * manager deliberately does not prompt on their behalf.
   */
  async deleteProject(projectId: string): Promise<void> {
    const assets = await this.listAssets(projectId);
    for (const asset of assets) {
      await this.#store.delete(BLOBS, asset.id);
      await this.#store.delete(ASSETS, asset.id);
    }
    await this.#store.delete(PROJECTS, projectId);

    this.#logger.info('Project deleted.', { projectId, assets: assets.length });
    this.#bus?.emit('PROJECT_DELETED', { projectId });
    this.#notify();
  }

  /** Copy a project and its assets under a new id and name. */
  async duplicateProject(projectId: string, newName?: string): Promise<Project> {
    const source = await this.#requireProject(projectId);
    const copy = await this.createProject(newName ?? `${source.name} copy`, source.description);

    for (const asset of await this.listAssets(projectId)) {
      const blob = await this.#store.get<Blob | ArrayBuffer>(BLOBS, asset.id);
      if (!blob) {
        // The record exists but its bytes do not. Skip it and say so rather
        // than silently creating an asset that cannot be opened.
        this.#logger.warn('Skipped an asset with no stored data while duplicating.', {
          assetId: asset.id,
        });
        continue;
      }
      const duplicated: ProjectAsset = {
        ...asset,
        id: newId('asset'),
        projectId: copy.id,
        createdAt: Date.now(),
      };
      await this.#store.set(BLOBS, duplicated.id, blob);
      await this.#store.set(ASSETS, duplicated.id, duplicated);
    }

    this.#notify();
    return copy;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const entries = await this.#store.entries<Project>(PROJECTS);
    const allAssets = await this.#store.entries<ProjectAsset>(ASSETS);

    const byProject = new Map<string, ProjectAsset[]>();
    for (const [, asset] of allAssets) {
      const list = byProject.get(asset.projectId);
      if (list) list.push(asset);
      else byProject.set(asset.projectId, [asset]);
    }

    return entries
      .map(([, project]) => ProjectManager.#summarise(project, byProject.get(project.id) ?? []))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSummary(projectId: string): Promise<ProjectSummary | undefined> {
    const project = await this.getProject(projectId);
    if (!project) return undefined;
    return ProjectManager.#summarise(project, await this.listAssets(projectId));
  }

  static #summarise(project: Project, assets: ProjectAsset[]): ProjectSummary {
    return {
      ...project,
      assetCount: assets.length,
      originalCount: assets.filter((a) => a.origin === 'original').length,
      generatedCount: assets.filter((a) => a.origin === 'generated').length,
      totalBytes: assets.reduce((sum, a) => sum + a.sizeBytes, 0),
    };
  }

  // --------------------------------------------------------------- search

  /**
   * Find projects by name, then description.
   *
   * Literal scoring, not semantic search: this needs no model and works offline.
   * Filler words are stripped so "bring up my Iron Man project" matches a
   * project called "Iron Man".
   */
  async searchProjects(query: string): Promise<ProjectMatch[]> {
    const cleaned = ProjectManager.normalizeQuery(query);
    if (cleaned === '') return [];

    const projects = await this.listProjects();
    const matches: ProjectMatch[] = [];

    for (const project of projects) {
      const name = project.name.toLowerCase();

      if (name === cleaned) {
        matches.push({ project, score: 1, reason: 'exact' });
        continue;
      }
      if (name.startsWith(cleaned) || cleaned.startsWith(name)) {
        matches.push({ project, score: 0.85, reason: 'prefix' });
        continue;
      }
      if (name.includes(cleaned) || cleaned.includes(name)) {
        matches.push({ project, score: 0.7, reason: 'contains' });
        continue;
      }

      // Token overlap, so "ironman" still finds "Iron Man Project".
      const nameTokens = new Set(name.split(/\s+/).filter(Boolean));
      const queryTokens = cleaned.split(/\s+/).filter(Boolean);
      const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
      if (overlap > 0) {
        matches.push({
          project,
          score: 0.4 + 0.3 * (overlap / Math.max(nameTokens.size, queryTokens.length)),
          reason: 'token',
        });
        continue;
      }

      // Compare with whitespace removed, so "ironman" matches "Iron Man".
      const squashedName = name.replace(/\s+/g, '');
      const squashedQuery = cleaned.replace(/\s+/g, '');
      if (squashedName.includes(squashedQuery) || squashedQuery.includes(squashedName)) {
        matches.push({ project, score: 0.6, reason: 'contains' });
        continue;
      }

      if (project.description.toLowerCase().includes(cleaned)) {
        matches.push({ project, score: 0.25, reason: 'description' });
      }
    }

    return matches.sort((a, b) => b.score - a.score || b.project.updatedAt - a.project.updatedAt);
  }

  /** Words stripped before matching a project name. */
  static readonly #FILLER = new Set([
    'open', 'show', 'bring', 'up', 'me', 'my', 'the', 'a', 'an', 'please',
    'go', 'to', 'take', 'load', 'launch', 'display', 'switch', 'project',
    'projects', 'helix', 'can', 'you', 'i', 'want', 'see', 'get',
  ]);

  static normalizeQuery(query: string): string {
    const words = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const kept = words.filter((word) => !ProjectManager.#FILLER.has(word));
    // If filtering removed everything the query was all filler, so fall back to
    // the original words rather than returning nothing.
    return (kept.length > 0 ? kept : words).join(' ').trim();
  }

  // --------------------------------------------------------------- assets

  /**
   * Import a file into a project. The file is validated first, so an
   * unsupported or oversized file is refused before any bytes are stored.
   */
  async addFileToProject(request: ImportRequest): Promise<ProjectAsset> {
    await this.#requireProject(request.projectId);

    const validated = validateUpload(request.file, { maxBytes: this.#maxFileBytes });

    // Before anything is written. A refusal here carries the reason and the
    // constraint that bound it, so the user is never told a bare "no".
    await this.#budget?.requireRoom(validated.sizeBytes);

    const asset: ProjectAsset = {
      id: newId('asset'),
      projectId: request.projectId,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      kind: validated.kind,
      origin: request.origin ?? 'original',
      createdAt: Date.now(),
      ...(request.derivedFrom !== undefined ? { derivedFrom: request.derivedFrom } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    };

    await this.#store.set(BLOBS, asset.id, request.data);
    await this.#store.set(ASSETS, asset.id, asset);
    await this.#touch(request.projectId);

    // The first image imported becomes the thumbnail unless one is already set.
    const project = await this.getProject(request.projectId);
    if (project && project.thumbnailAssetId === undefined && asset.kind === 'image') {
      await this.updateProject(request.projectId, { thumbnailAssetId: asset.id });
    }

    this.#logger.info('Asset added.', {
      projectId: request.projectId,
      kind: asset.kind,
      origin: asset.origin,
      sizeBytes: asset.sizeBytes,
    });
    this.#notify();
    return asset;
  }

  async listAssets(projectId: string): Promise<ProjectAsset[]> {
    const entries = await this.#store.entries<ProjectAsset>(ASSETS);
    return entries
      .map(([, asset]) => asset)
      .filter((asset) => asset.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getAsset(assetId: string): Promise<ProjectAsset | undefined> {
    return this.#store.get<ProjectAsset>(ASSETS, assetId);
  }

  /** Fetch an asset's bytes. Returns undefined when the data is missing. */
  async getAssetData(assetId: string): Promise<Blob | ArrayBuffer | undefined> {
    return this.#store.get<Blob | ArrayBuffer>(BLOBS, assetId);
  }

  async removeFileFromProject(assetId: string): Promise<void> {
    const asset = await this.getAsset(assetId);
    if (!asset) return;

    await this.#store.delete(BLOBS, assetId);
    await this.#store.delete(ASSETS, assetId);

    // Clear the thumbnail reference if it pointed at this asset.
    const project = await this.getProject(asset.projectId);
    if (project?.thumbnailAssetId === assetId) {
      const remaining = await this.listAssets(asset.projectId);
      const nextImage = remaining.find((candidate) => candidate.kind === 'image');
      await this.#store.set(PROJECTS, project.id, {
        ...project,
        thumbnailAssetId: nextImage?.id,
        updatedAt: Date.now(),
      });
    } else {
      await this.#touch(asset.projectId);
    }

    this.#notify();
  }

  /**
   * Remove generated assets while leaving every original untouched. This is the
   * path used when a generation fails or is rejected (spec 7, 23).
   */
  async deleteGeneratedAssets(projectId: string, derivedFrom?: string): Promise<number> {
    const assets = await this.listAssets(projectId);
    let removed = 0;

    for (const asset of assets) {
      if (asset.origin !== 'generated') continue;
      if (derivedFrom !== undefined && asset.derivedFrom !== derivedFrom) continue;
      await this.#store.delete(BLOBS, asset.id);
      await this.#store.delete(ASSETS, asset.id);
      removed += 1;
    }

    if (removed > 0) {
      await this.#touch(projectId);
      this.#notify();
    }
    return removed;
  }

  /** Total bytes held by all project assets, for the storage breakdown. */
  async getTotalBytes(): Promise<number> {
    const entries = await this.#store.entries<ProjectAsset>(ASSETS);
    return entries.reduce((sum, [, asset]) => sum + asset.sizeBytes, 0);
  }

  async countAssets(): Promise<number> {
    return (await this.#store.keys(ASSETS)).length;
  }

  /** Portable location a project's files would occupy (spec 13). */
  projectPath(projectId: string): string {
    return this.#paths.getProjectPath(projectId);
  }

  async #requireProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new HelixError('NOT_FOUND', 'That project no longer exists.', {
        technical: `Unknown project ${projectId}`,
      });
    }
    return project;
  }

  async #touch(projectId: string): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) return;
    await this.#store.set(PROJECTS, projectId, { ...project, updatedAt: Date.now() });
  }
}
