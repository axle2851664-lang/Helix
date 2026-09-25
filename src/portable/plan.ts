import { ARCHIVABLE, type ArchivableNamespace } from '../backup/archive.js';

/**
 * What to take when Helix goes on a flash drive, decided one part at a time.
 *
 * A removable disk is the easiest thing in computing to lose. It ends up in a
 * drawer, in a coat, in somebody else's laptop; it is not encrypted, it has no
 * screen lock, and finding one tells you nothing about whose it is. So the
 * question this module exists to make the user answer is not "back up Helix?"
 * but "which of these specific things should leave the machine?", asked with
 * the consequence of each one attached.
 *
 * Two rules are not the user's to change, and both are enforced here rather
 * than written in a note beside a checkbox:
 *
 *   - **Credentials never go.** Google refresh tokens, the relay secret, API
 *     keys. A refresh token on a lost stick is a mailbox in somebody's hand,
 *     and nothing about a portable copy is worth that. There is no checkbox
 *     for it; `NEVER_COPIED` says so on the screen and `planPortable` cannot
 *     be made to include it, because no item exists to select.
 *   - **Nothing is chosen for you.** Every item is off by default except the
 *     program itself, which contains nothing about the user at all. A default
 *     that copies a conversation history is a default that copies it the one
 *     time somebody is not paying attention.
 */

/** Things that are never written to a removable disk, and why. */
export const NEVER_COPIED: ReadonlyArray<{ what: string; because: string }> = [
  {
    what: 'Your Google connection',
    because:
      'A refresh token does not expire on its own and opens your mailbox. On a stick that gets lost, it is your mail in somebody else’s hands. Sign in again on the other machine instead - it takes a minute.',
  },
  {
    what: 'The phone relay secret',
    because:
      'It is the one thing standing between your phone pairing and anybody else’s. Copying it copies the ability to speak to Helix as you.',
  },
  {
    what: 'API keys',
    because:
      'They are held by the shell and never leave it, here or anywhere. A key on a lost disk is somebody else spending your money.',
  },
];

export type PortableItemId = 'app' | ArchivableNamespace;

export interface PortableItem {
  id: PortableItemId;
  label: string;
  /** What it is, in plain words. */
  detail: string;
  /**
   * What it would mean for this to be found by somebody else. Null for the
   * things that say nothing about the user.
   */
  ifLost: string | null;
  /** Measured, never estimated. Null when nothing has measured it. */
  bytes: number | null;
}

/**
 * The offer, in the order it is worth thinking about: the program first,
 * because it is the only item with no personal content and the one most
 * people actually want.
 */
export function portableItems(sizes: Partial<Record<PortableItemId, number>> = {}): PortableItem[] {
  const size = (id: PortableItemId): number | null => sizes[id] ?? null;

  return [
    {
      id: 'app',
      label: 'Helix itself',
      detail: 'The program, so it runs on another machine without installing anything.',
      ifLost: null,
      bytes: size('app'),
    },
    {
      id: 'settings',
      label: 'Your settings',
      detail: ARCHIVABLE.settings,
      ifLost: 'It shows how you have Helix set up. No messages, no files.',
      bytes: size('settings'),
    },
    {
      id: 'memory',
      label: 'What Helix remembers',
      detail: ARCHIVABLE.memory,
      ifLost: 'Everything you asked Helix to remember about you, in plain text.',
      bytes: size('memory'),
    },
    {
      id: 'conversations',
      label: 'Your conversations',
      detail: ARCHIVABLE.conversations,
      ifLost: 'Every conversation you have had with Helix, readable by anyone who finds it.',
      bytes: size('conversations'),
    },
    {
      id: 'project-assets',
      label: 'Your file list',
      detail: ARCHIVABLE['project-assets'],
      ifLost: 'The names of your files, which often say as much as the files do.',
      bytes: size('project-assets'),
    },
    {
      id: 'asset-blobs',
      label: 'The files themselves',
      detail: ARCHIVABLE['asset-blobs'],
      ifLost: 'The full contents of every file you have imported.',
      bytes: size('asset-blobs'),
    },
    {
      id: 'knowledge',
      label: 'The search index',
      detail: ARCHIVABLE.knowledge,
      ifLost: 'Extracted text from your files - effectively the files, in prose.',
      bytes: size('knowledge'),
    },
  ];
}

export interface PortablePlan {
  /** Chosen, in the order they are offered. */
  include: PortableItem[];
  /** True when the program is going, which changes what the copy is for. */
  carriesApp: boolean;
  /** Chosen items that would be readable by whoever finds the disk. */
  personal: PortableItem[];
  /** Total of what has been measured. Unmeasured items are counted separately. */
  bytes: number;
  unmeasured: number;
  /** Why this plan cannot run, or null. */
  problem: string | null;
}

export interface PortablePlanOptions {
  /** Ids the user ticked. Anything unknown is ignored rather than guessed at. */
  selected: readonly string[];
  sizes?: Partial<Record<PortableItemId, number>>;
  /** Free space on the disk, when the shell has measured it. */
  freeBytes?: number | null;
}

export function planPortable(options: PortablePlanOptions): PortablePlan {
  const all = portableItems(options.sizes ?? {});
  const chosen = new Set(options.selected);
  const include = all.filter((item) => chosen.has(item.id));

  const bytes = include.reduce((total, item) => total + (item.bytes ?? 0), 0);
  const unmeasured = include.filter((item) => item.bytes === null).length;

  let problem: string | null = null;
  if (include.length === 0) {
    problem = 'Nothing is selected, so there is nothing to copy.';
  } else if (
    options.freeBytes !== null &&
    options.freeBytes !== undefined &&
    bytes > options.freeBytes
  ) {
    // Refused before anything is written. A copy that fills the disk and
    // stops halfway leaves a portable Helix that looks complete and is not.
    problem = `That is ${formatBytes(bytes)}, and the disk has ${formatBytes(
      options.freeBytes,
    )} free. Choose less, or use a larger disk.`;
  }

  return {
    include,
    carriesApp: chosen.has('app'),
    personal: include.filter((item) => item.ifLost !== null),
    bytes,
    unmeasured,
    problem,
  };
}

/** Sizes in the units people think in. Never rounded up into a lie. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown amount';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
