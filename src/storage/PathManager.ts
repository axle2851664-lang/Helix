import { HelixError } from '../core/HelixError.js';

/**
 * Portable path resolution (spec 13).
 *
 * Every Helix path derives from one runtime-resolved root. Nothing in the
 * codebase may construct an absolute path by hand, and nothing persisted to
 * disk may contain one: relocating a Helix folder from one drive letter to
 * another must be invisible to projects, models and memory records.
 *
 * This module is deliberately host-agnostic. It performs pure string algebra on
 * POSIX-style separators and never touches a filesystem, which is what lets it
 * be fully unit-tested under the browser host where no filesystem exists. The
 * Tauri shell supplies a real root later; the arithmetic does not change.
 */

export const HELIX_DIRECTORIES = [
  'app',
  'config',
  'data',
  'projects',
  'models',
  'cache',
  'logs',
  'providers',
  'runtime',
  'temp',
  'backups',
  'generated',
  'knowledge',
  'memory',
] as const;

export type HelixDirectory = (typeof HELIX_DIRECTORIES)[number];

/** Normalise separators and collapse `.` / `..` without touching the disk. */
export function normalizePath(input: string): string {
  const withForwardSlashes = input.replace(/\\/g, '/');

  // Preserve a leading drive designator or UNC prefix while normalising the rest.
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(withForwardSlashes);
  const uncMatch = /^\/\/([^/]+\/[^/]+)(\/.*)?$/.exec(withForwardSlashes);

  let prefix = '';
  let body = withForwardSlashes;
  if (driveMatch) {
    prefix = driveMatch[1] ?? '';
    body = driveMatch[2] ?? '/';
  } else if (uncMatch) {
    prefix = '//' + (uncMatch[1] ?? '');
    body = uncMatch[2] ?? '/';
  }

  const isAbsolute = body.startsWith('/');
  const segments: string[] = [];

  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (segments.length > 0 && last !== '..') segments.pop();
      else if (!isAbsolute && prefix === '') segments.push('..');
      // Traversal above an absolute root is clamped, never allowed to escape.
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join('/');
  if (prefix !== '') return prefix + '/' + joined;
  if (isAbsolute) return '/' + joined;
  return joined;
}

/** Join segments with normalisation. Empty segments are ignored. */
export function joinPath(...segments: string[]): string {
  const filtered = segments.filter((s) => s !== '');
  if (filtered.length === 0) return '';
  return normalizePath(filtered.join('/'));
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('/');
}

export interface PathManagerOptions {
  /** Absolute root of the Helix installation, resolved by the host at runtime. */
  root: string;
  /** When true, data lives beside the application (spec 13). */
  portable?: boolean;
  /**
   * Data root used when `portable` is false, e.g. an OS app-data directory.
   * Required in that case; there is deliberately no hard-coded fallback.
   */
  dataRoot?: string;
}

export class PathManager {
  readonly #root: string;
  readonly #dataRoot: string;
  readonly #portable: boolean;

  constructor(options: PathManagerOptions) {
    if (!options.root || options.root.trim() === '') {
      throw new HelixError(
        'VALIDATION_FAILED',
        'Helix could not determine where it is installed, so it cannot resolve its data folders.',
        { technical: 'PathManager constructed with an empty root.' },
      );
    }

    this.#root = normalizePath(options.root);
    this.#portable = options.portable ?? true;

    if (this.#portable) {
      this.#dataRoot = this.#root;
    } else {
      if (!options.dataRoot || options.dataRoot.trim() === '') {
        throw new HelixError(
          'VALIDATION_FAILED',
          'Helix is set to non-portable mode but no data location was provided.',
          { technical: 'PathManager: portable=false requires an explicit dataRoot.' },
        );
      }
      this.#dataRoot = normalizePath(options.dataRoot);
    }
  }

  get isPortable(): boolean {
    return this.#portable;
  }

  /** Root of the Helix installation. */
  get root(): string {
    return this.#root;
  }

  /** Root under which all mutable data lives. */
  get dataRoot(): string {
    return this.#dataRoot;
  }

  getAppPath(...s: string[]): string { return joinPath(this.#root, 'app', ...s); }
  getDataPath(...s: string[]): string { return joinPath(this.#dataRoot, 'data', ...s); }
  getConfigPath(...s: string[]): string { return joinPath(this.#dataRoot, 'config', ...s); }
  getProjectPath(...s: string[]): string { return joinPath(this.#dataRoot, 'projects', ...s); }
  getModelPath(...s: string[]): string { return joinPath(this.#dataRoot, 'models', ...s); }
  getMemoryPath(...s: string[]): string { return joinPath(this.#dataRoot, 'memory', ...s); }
  getKnowledgePath(...s: string[]): string { return joinPath(this.#dataRoot, 'knowledge', ...s); }
  getGeneratedPath(...s: string[]): string { return joinPath(this.#dataRoot, 'generated', ...s); }
  getCachePath(...s: string[]): string { return joinPath(this.#dataRoot, 'cache', ...s); }
  getTempPath(...s: string[]): string { return joinPath(this.#dataRoot, 'temp', ...s); }
  getLogPath(...s: string[]): string { return joinPath(this.#dataRoot, 'logs', ...s); }
  getBackupPath(...s: string[]): string { return joinPath(this.#dataRoot, 'backups', ...s); }
  getProviderPath(...s: string[]): string { return joinPath(this.#dataRoot, 'providers', ...s); }
  getRuntimePath(...s: string[]): string { return joinPath(this.#dataRoot, 'runtime', ...s); }

  /**
   * Convert an absolute path into one relative to the data root, for
   * persistence. Storing absolute paths is exactly what breaks a drive-letter
   * change, so records must always be written through this.
   */
  toPortable(absolutePath: string): string {
    const normalized = normalizePath(absolutePath);
    const base = this.#dataRoot;
    if (normalized === base) return '';

    const prefix = base.endsWith('/') ? base : base + '/';
    // Windows paths are case-insensitive, so compare case-folded.
    if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new HelixError(
        'VALIDATION_FAILED',
        'That location is outside the Helix workspace, so it cannot be stored in a project.',
        { technical: 'toPortable: "' + normalized + '" is not under data root "' + base + '".' },
      );
    }
    return normalized.slice(prefix.length);
  }

  /** Resolve a stored portable path back to an absolute one for the current root. */
  fromPortable(relativePath: string): string {
    const normalized = normalizePath(relativePath);
    if (isAbsolutePath(normalized)) {
      throw new HelixError(
        'VALIDATION_FAILED',
        'Helix found an absolute path where a portable one was expected.',
        { technical: 'fromPortable received absolute path "' + normalized + '".' },
      );
    }
    return joinPath(this.#dataRoot, normalized);
  }

  /**
   * Guard against path traversal (spec 18). True only when the resolved path
   * stays inside the Helix data root.
   */
  isWithinWorkspace(candidate: string): boolean {
    const normalized = normalizePath(candidate);
    const resolved = isAbsolutePath(normalized)
      ? normalized
      : joinPath(this.#dataRoot, normalized);
    const base = this.#dataRoot.toLowerCase();
    const target = resolved.toLowerCase();
    return target === base || target.startsWith(base.endsWith('/') ? base : base + '/');
  }

  /** Throw unless the candidate resolves inside the workspace; returns the resolved path. */
  assertWithinWorkspace(candidate: string): string {
    if (!this.isWithinWorkspace(candidate)) {
      throw new HelixError(
        'PERMISSION_DENIED',
        'Helix can only work with files inside its own workspace.',
        { technical: 'Path escapes workspace: "' + candidate + '"' },
      );
    }
    const normalized = normalizePath(candidate);
    return isAbsolutePath(normalized) ? normalized : joinPath(this.#dataRoot, normalized);
  }
}
