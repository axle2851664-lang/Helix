/**
 * The backup archive format.
 *
 * An archive is a file that leaves Helix and later comes back, which makes it
 * two quite different things at once: on the way out it is everything Helix
 * knows about the user, and on the way in it is untrusted input from disk.
 * Both halves are handled here, and the second is where the care goes.
 *
 * Three rules are enforced by the parser rather than left to the caller:
 *
 * 1. **Only namespaces Helix owns may be restored.** A crafted archive naming
 *    some other namespace is refused outright rather than trusted to be
 *    harmless. Restore writes to storage, so the list of places it can write
 *    is fixed here and nowhere else.
 *
 * 2. **An unknown version is refused, never guessed at.** A future archive
 *    read by an older Helix would restore a shape the code does not
 *    understand, and the damage would not show up until much later.
 *
 * 3. **Nothing in an archive is an instruction.** It is data, restored as
 *    data. That is worth stating because an archive is exactly the sort of
 *    file someone might hand you.
 */

export const ARCHIVE_FORMAT = 'helix.backup';
export const ARCHIVE_VERSION = 1;

/**
 * Every namespace an archive may contain, and what each holds.
 *
 * Restore will write to these and to nothing else. Adding a namespace to
 * Helix means adding it here deliberately, which is the point: a subsystem
 * cannot start appearing in backups by accident, and it cannot be written to
 * by a crafted file.
 */
export const ARCHIVABLE = {
  settings: 'Your preferences.',
  memory: 'What you asked Helix to remember.',
  conversations: 'Saved conversation history.',
  'project-assets': 'The record of each imported file: name, size, kind.',
  'asset-blobs': 'The contents of those files.',
  knowledge: 'Extracted text, so files stay searchable without re-indexing.',
} as const;

export type ArchivableNamespace = keyof typeof ARCHIVABLE;

export function isArchivable(namespace: string): namespace is ArchivableNamespace {
  return Object.prototype.hasOwnProperty.call(ARCHIVABLE, namespace);
}

/** File contents are large. Whether to carry them is the user's choice. */
export type ArchiveScope = 'full' | 'records-only';

export interface ArchiveSection {
  namespace: ArchivableNamespace;
  entries: Array<[string, unknown]>;
}

export interface Archive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  createdAt: number;
  scope: ArchiveScope;
  sections: ArchiveSection[];
  /** What was deliberately left out, so a restore can say what is missing. */
  omitted: Array<{ namespace: string; reason: string }>;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/* ------------------------------------------------------------------ */
/* Binary                                                             */
/* ------------------------------------------------------------------ */

/**
 * Base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a whole file overflows the argument
 * limit and throws on anything of a reasonable size, which is a failure that
 * only appears once someone has real data - the worst time to find it.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** How a blob travels: tagged, so a restore knows to turn it back. */
export interface EncodedBlob {
  __helixBinary: true;
  type: string;
  base64: string;
}

export function isEncodedBlob(value: unknown): value is EncodedBlob {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as EncodedBlob).__helixBinary === true &&
    typeof (value as EncodedBlob).base64 === 'string'
  );
}

export async function encodeBinary(value: Blob | ArrayBuffer): Promise<EncodedBlob> {
  const buffer = value instanceof Blob ? await value.arrayBuffer() : value;
  return {
    __helixBinary: true,
    type: value instanceof Blob ? value.type : 'application/octet-stream',
    base64: encodeBase64(new Uint8Array(buffer)),
  };
}

export function decodeBinary(value: EncodedBlob): Blob {
  return new Blob([decodeBase64(value.base64) as BlobPart], { type: value.type });
}

/* ------------------------------------------------------------------ */
/* Building and parsing                                               */
/* ------------------------------------------------------------------ */

export function buildArchive(
  sections: ArchiveSection[],
  options: { scope: ArchiveScope; omitted?: Archive['omitted']; now?: number },
): Archive {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    createdAt: options.now ?? Date.now(),
    scope: options.scope,
    sections,
    omitted: options.omitted ?? [],
  };
}

export function serialiseArchive(archive: Archive): string {
  return JSON.stringify(archive);
}

/**
 * Read an archive from a file.
 *
 * Every failure names what is wrong with the file rather than saying it is
 * invalid, because the commonest cause is picking the wrong file and the user
 * needs to be able to tell that from a corrupt one.
 */
export function parseArchive(text: string): Archive {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArchiveError('That file is not a Helix backup - it is not readable as JSON.');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ArchiveError('That file is not a Helix backup.');
  }

  const candidate = raw as Partial<Archive>;

  if (candidate.format !== ARCHIVE_FORMAT) {
    throw new ArchiveError('That file is not a Helix backup - it has no Helix backup marker.');
  }

  if (typeof candidate.version !== 'number') {
    throw new ArchiveError('That backup does not say which version it is, so it cannot be read.');
  }

  // Newer archives are refused rather than partially understood. Restoring a
  // shape this code does not know would corrupt quietly and surface later.
  if (candidate.version > ARCHIVE_VERSION) {
    throw new ArchiveError(
      `That backup was written by a newer Helix (version ${candidate.version}, this reads ${ARCHIVE_VERSION}). Update Helix before restoring it.`,
    );
  }

  if (!Array.isArray(candidate.sections)) {
    throw new ArchiveError('That backup has no contents.');
  }

  const sections: ArchiveSection[] = [];
  for (const section of candidate.sections) {
    if (typeof section !== 'object' || section === null) {
      throw new ArchiveError('That backup contains a section Helix cannot read.');
    }
    const { namespace, entries } = section as ArchiveSection;

    // The security property. A crafted archive naming anything else is
    // refused, not ignored: silently dropping it would restore a partial
    // state the user believed was complete.
    if (typeof namespace !== 'string' || !isArchivable(namespace)) {
      throw new ArchiveError(
        `That backup contains "${String(namespace)}", which is not part of Helix. It has not been restored.`,
      );
    }

    if (!Array.isArray(entries)) {
      throw new ArchiveError(`The ${namespace} section of that backup is malformed.`);
    }

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
        throw new ArchiveError(`The ${namespace} section of that backup is malformed.`);
      }
    }

    sections.push({ namespace, entries: entries as Array<[string, unknown]> });
  }

  return {
    format: ARCHIVE_FORMAT,
    version: candidate.version,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
    scope: candidate.scope === 'records-only' ? 'records-only' : 'full',
    sections,
    omitted: Array.isArray(candidate.omitted) ? candidate.omitted : [],
  };
}

/* ------------------------------------------------------------------ */
/* Describing                                                         */
/* ------------------------------------------------------------------ */

export interface ArchiveSummary {
  namespace: ArchivableNamespace;
  label: string;
  items: number;
}

export function summariseArchive(archive: Archive): ArchiveSummary[] {
  return archive.sections.map((section) => ({
    namespace: section.namespace,
    label: ARCHIVABLE[section.namespace],
    items: section.entries.length,
  }));
}

/**
 * What restoring would replace.
 *
 * Computed before anything is written and shown to the user, because restore
 * is not a merge: a namespace in the archive replaces the one in Helix. That
 * is the right behaviour for a backup and the wrong thing to discover
 * afterwards.
 */
export interface RestorePlan {
  namespace: ArchivableNamespace;
  label: string;
  incoming: number;
  existing: number;
  /** Records that exist now and are not in the archive. These are lost. */
  lost: number;
}

export function planRestore(
  archive: Archive,
  existing: Record<string, number>,
): RestorePlan[] {
  return archive.sections.map((section) => {
    const have = existing[section.namespace] ?? 0;
    return {
      namespace: section.namespace,
      label: ARCHIVABLE[section.namespace],
      incoming: section.entries.length,
      existing: have,
      lost: Math.max(0, have - section.entries.length),
    };
  });
}

/** A filename that sorts chronologically and says what it is. */
export function archiveFileName(createdAt: number, scope: ArchiveScope): string {
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `helix-backup-${stamp}${scope === 'records-only' ? '-records' : ''}.json`;
}
