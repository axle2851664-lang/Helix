import { HelixError } from '../core/HelixError.js';
import type { AssetKind } from './types.js';

/**
 * Upload validation (spec 12, 18, 24).
 *
 * Helix accepts a deliberately narrow set of file types. The list is an
 * allowlist, not a blocklist: an unrecognised extension is refused rather than
 * accepted by default, so a new dangerous type cannot slip through by not being
 * on a ban list.
 *
 * Nothing imported is ever executed. That is enforced by the fact that Helix
 * has no code path that executes an asset at all - this module additionally
 * refuses to store executable and script types so they cannot sit in the
 * workspace waiting for one to appear.
 */

interface TypeRule {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  kind: AssetKind;
}

const ALLOWED: readonly TypeRule[] = [
  {
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
    mimeTypes: [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/bmp',
      'image/svg+xml',
    ],
    kind: 'image',
  },
  {
    extensions: ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'],
    mimeTypes: ['model/gltf-binary', 'model/gltf+json', 'model/obj', 'model/stl'],
    kind: 'model3d',
  },
  {
    extensions: ['txt', 'md', 'pdf', 'rtf'],
    mimeTypes: ['text/plain', 'text/markdown', 'application/pdf', 'application/rtf'],
    kind: 'document',
  },
  {
    extensions: ['json', 'csv', 'tsv', 'yaml', 'yml', 'xml'],
    mimeTypes: ['application/json', 'text/csv', 'text/tab-separated-values', 'application/xml'],
    kind: 'data',
  },
];

/**
 * Refused outright, even though the allowlist would already exclude them.
 * Listed explicitly so the user gets a clear reason rather than a generic
 * "unsupported type", and so the intent survives future edits to the allowlist.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'dll', 'com', 'scr', 'msi', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'sh', 'bash', 'zsh', 'app', 'jar',
  'apk', 'deb', 'rpm', 'dmg', 'pkg', 'lnk', 'reg', 'scf', 'hta', 'cpl',
]);

export const DEFAULT_MAX_FILE_BYTES = 250 * 1024 * 1024;

export function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) return '';
  return fileName.slice(index + 1).toLowerCase();
}

export function kindForFile(fileName: string, mimeType: string): AssetKind {
  const extension = fileExtension(fileName);
  for (const rule of ALLOWED) {
    if (rule.extensions.includes(extension)) return rule.kind;
    if (mimeType !== '' && rule.mimeTypes.includes(mimeType.toLowerCase())) return rule.kind;
  }
  return 'other';
}

/**
 * Strip anything that could be used to escape the workspace or confuse a path
 * (spec 18). The stored name is display-only, but it must still be inert.
 */
/** Path separators, matched without relying on a fragile escape sequence. */
const SEPARATORS = new RegExp('[' + String.fromCharCode(92, 92) + '/]');

/** Characters Windows forbids in a filename. */
const WINDOWS_FORBIDDEN = new Set(['<', '>', ':', '"', '|', '?', '*', String.fromCharCode(92), '/']);

export function sanitizeFileName(fileName: string): string {
  // Take the last path segment, so a name carrying directory separators
  // cannot smuggle a path in.
  const base = fileName.split(SEPARATORS).pop() ?? fileName;

  // Filtered by code point rather than by regex literal: control characters
  // are invisible in source and easy to corrupt in an edit, so they are named
  // by their numeric range instead.
  let cleaned = '';
  for (const character of base) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control characters
    if (WINDOWS_FORBIDDEN.has(character)) continue;
    cleaned += character;
  }

  // Leading dots would produce a hidden or relative-looking name.
  while (cleaned.startsWith('.')) cleaned = cleaned.slice(1);
  cleaned = cleaned.trim();

  return cleaned === '' ? 'unnamed' : cleaned.slice(0, 180);
}

export interface FileCandidate {
  name: string;
  size: number;
  type: string;
}

export interface ValidationResult {
  fileName: string;
  kind: AssetKind;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Validate a candidate upload. Throws a HelixError whose userMessage explains
 * the problem in plain language.
 */
export function validateUpload(
  file: FileCandidate,
  options: { maxBytes?: number } = {},
): ValidationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const fileName = sanitizeFileName(file.name);
  const extension = fileExtension(fileName);

  if (extension === '') {
    throw new HelixError(
      'VALIDATION_FAILED',
      `"${fileName}" has no file extension, so Helix cannot tell what it is. Rename it and try again.`,
      { technical: `Rejected upload without extension: ${fileName}` },
    );
  }

  if (EXECUTABLE_EXTENSIONS.has(extension)) {
    throw new HelixError(
      'VALIDATION_FAILED',
      `Helix does not accept .${extension} files. Programs and scripts cannot be added to a project.`,
      { technical: `Rejected executable upload: .${extension}` },
    );
  }

  const kind = kindForFile(fileName, file.type);
  if (kind === 'other') {
    throw new HelixError(
      'VALIDATION_FAILED',
      `Helix does not support .${extension} files yet. Supported types are images, 3D models, documents and data files.`,
      { technical: `Rejected unsupported type: .${extension} (${file.type || 'no mime type'})` },
    );
  }

  if (file.size <= 0) {
    throw new HelixError('VALIDATION_FAILED', `"${fileName}" is empty.`, {
      technical: `Rejected zero-length upload: ${fileName}`,
    });
  }

  if (file.size > maxBytes) {
    throw new HelixError(
      'VALIDATION_FAILED',
      `"${fileName}" is ${formatBytes(file.size)}, which is over the ${formatBytes(maxBytes)} limit for a single file.`,
      { technical: `Rejected oversized upload: ${file.size} > ${maxBytes}` },
    );
  }

  return { fileName, kind, mimeType: file.type, sizeBytes: file.size };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Extensions offered to the file picker, as an accept attribute. */
export const ACCEPT_ATTRIBUTE = ALLOWED.flatMap((rule) =>
  rule.extensions.map((extension) => `.${extension}`),
).join(',');
