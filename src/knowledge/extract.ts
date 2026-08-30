import type { AssetKind } from '../projects/types.js';

/**
 * Text extraction from stored assets (spec 12: indexing, search, previews).
 *
 * Helix indexes what it can genuinely read, and says so for the rest. A PDF or
 * a photograph is stored perfectly well but cannot be turned into text without
 * a dependency Helix does not have - reporting that is the whole point of
 * `ExtractionResult.reason`, rather than indexing an empty string and leaving
 * the user to wonder why search never finds their document.
 */

export type ExtractionStatus = 'extracted' | 'unsupported' | 'empty' | 'not-text';

export interface ExtractionResult {
  status: ExtractionStatus;
  /** Extracted text, empty unless status is 'extracted'. */
  text: string;
  /** Why nothing was extracted. Present unless status is 'extracted'. */
  reason?: string;
}

/** Extensions Helix can read as plain text with no additional dependency. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'rtf',
]);

/**
 * Formats that are stored but cannot be read yet, with the specific dependency
 * each would need. Being concrete here is what makes the limitation actionable.
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  pdf: 'PDF text extraction needs a PDF parser, which Helix does not bundle yet.',
  glb: '3D models contain geometry, not text.',
  gltf: '3D models contain geometry, not text.',
  obj: '3D models contain geometry, not text.',
  stl: '3D models contain geometry, not text.',
  ply: '3D models contain geometry, not text.',
  fbx: '3D models contain geometry, not text.',
};

const IMAGE_REASON =
  'Reading text from an image needs OCR or a vision provider, and none is configured.';

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index <= 0 ? '' : fileName.slice(index + 1).toLowerCase();
}

/** Can this asset be indexed at all? Cheap check, no data required. */
export function canExtract(fileName: string, kind: AssetKind): boolean {
  if (kind === 'image') return false;
  return TEXT_EXTENSIONS.has(extensionOf(fileName));
}

/** Why an asset cannot be indexed, or null when it can. */
export function extractionBlocker(fileName: string, kind: AssetKind): string | null {
  if (canExtract(fileName, kind)) return null;
  if (kind === 'image') return IMAGE_REASON;

  const extension = extensionOf(fileName);
  return (
    KNOWN_UNSUPPORTED[extension] ??
    `Helix cannot read .${extension || 'unknown'} files as text yet.`
  );
}

function decode(data: ArrayBuffer): string {
  // fatal:true so mis-decoded binary throws rather than yielding replacement
  // characters that would then be indexed as if they were words.
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

/**
 * Heuristic binary check. A file with the right extension can still hold
 * binary; indexing that produces junk search terms.
 */
function looksBinary(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data.slice(0, Math.min(data.byteLength, 2048)));
  let suspicious = 0;
  for (const byte of bytes) {
    // NUL is decisive; other C0 controls beyond tab/newline/CR are suspicious.
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return bytes.length > 0 && suspicious / bytes.length > 0.1;
}

export async function extractText(
  fileName: string,
  kind: AssetKind,
  data: Blob | ArrayBuffer,
): Promise<ExtractionResult> {
  const blocker = extractionBlocker(fileName, kind);
  if (blocker !== null) {
    return { status: 'unsupported', text: '', reason: blocker };
  }

  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;

  if (buffer.byteLength === 0) {
    return { status: 'empty', text: '', reason: 'The file is empty.' };
  }

  if (looksBinary(buffer)) {
    return {
      status: 'not-text',
      text: '',
      reason: 'This file has a text extension but contains binary data, so it was not indexed.',
    };
  }

  let text: string;
  try {
    text = decode(buffer);
  } catch {
    return {
      status: 'not-text',
      text: '',
      reason: 'The file is not valid UTF-8 text, so it was not indexed.',
    };
  }

  const trimmed = text.trim();
  if (trimmed === '') {
    return { status: 'empty', text: '', reason: 'The file contains no text.' };
  }

  return { status: 'extracted', text: trimmed };
}

/**
 * Split text into overlapping chunks.
 *
 * Chunks are what search returns, so they must be small enough to be a useful
 * snippet. The overlap keeps a phrase that straddles a boundary findable
 * instead of falling into the gap between two chunks.
 */
export function chunkText(
  text: string,
  options: { size?: number; overlap?: number } = {},
): string[] {
  const size = options.size ?? 900;
  const overlap = Math.min(options.overlap ?? 120, size - 1);
  const normalized = text.replace(/\r\n/g, '\n').trim();

  if (normalized.length <= size) return normalized === '' ? [] : [normalized];

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);

    // Prefer a paragraph, then a sentence, then a word boundary, so a chunk
    // does not end mid-word in the snippet the user reads.
    if (end < normalized.length) {
      const window = normalized.slice(start, end);
      const paragraph = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
      const space = window.lastIndexOf(' ');
      const cut = paragraph > size * 0.5 ? paragraph : sentence > size * 0.5 ? sentence + 1 : space;
      if (cut > 0) end = start + cut;
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk !== '') chunks.push(chunk);

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}
