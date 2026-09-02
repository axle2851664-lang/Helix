import type { VolumeStats } from '../platform/PlatformAdapter.js';

/**
 * Deciding when Helix should clear up after itself, and when it must not.
 *
 * `StorageManager` reports what could be reclaimed and refuses to act, on the
 * grounds that a storage figure is not consent. That rule was right and it has
 * been changed deliberately: the user asked for one specific tier - Helix's own
 * rebuildable caches - to be cleared automatically when the disk gets tight.
 *
 * What that permission does and does not cover is the whole substance of this
 * file. It covers the file-search index, which rebuilds itself from files that
 * are still there. It does not cover projects, imported files, notes, memories,
 * generated images or stored conversations. Those are the user's, some cannot
 * be recreated, and an automatic threshold is not a good enough reason to
 * destroy any of them - the standing instruction that Helix must never write to
 * the user's own data unasked is untouched by this.
 *
 * Two measurement traps, both real:
 *
 *   - A browser reports its **origin quota**, not free disk space, and the two
 *     have nothing to do with each other. Acting on a quota figure as though it
 *     were a disk would fire at meaningless moments. `VolumeStats.source` says
 *     which is which and this file refuses to guess.
 *
 *   - Free space is a reading, not a property. It moves constantly, so the
 *     assessment is separated from the acting: something has to decide the
 *     reading is stable enough to be worth acting on, and that is not this
 *     function's job.
 */

export type PressureLevel = 'ample' | 'low' | 'critical' | 'unmeasurable';

export interface PressureAssessment {
  level: PressureLevel;
  /** Free bytes on the volume, or null where that cannot be measured. */
  freeBytes: number | null;
  /** True only when Helix should clear its own rebuildable caches now. */
  shouldReclaim: boolean;
  /** One sentence, in Helix's voice, always present. */
  message: string;
}

/**
 * A threshold low enough that the machine is already in trouble.
 *
 * Below roughly a gigabyte Windows cannot page reliably, updates fail and
 * applications start refusing to save. Clearing a search index at that point
 * recovers megabytes against a problem measured in gigabytes - it is not a
 * rescue, it is a gesture. Flagged so the interface can say so rather than
 * quietly accepting a setting that will not help.
 */
export const TOO_LATE_TO_HELP_BYTES = 1 * 1024 ** 3;

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * How much trouble the disk is in.
 *
 * `low` deliberately sits at twice the threshold, so there is a warning before
 * there is an action. Crossing straight from "fine" to "I have just deleted
 * something" gives the user no moment to intervene.
 */
export function assessDiskPressure(
  stats: VolumeStats | null,
  thresholdBytes: number,
): PressureAssessment {
  if (stats === null) {
    return {
      level: 'unmeasurable',
      freeBytes: null,
      shouldReclaim: false,
      message: 'I cannot measure free disk space on this host, so I am not watching it.',
    };
  }

  // The trap worth failing loudly on. An origin quota is not a disk, and a
  // browser only ever knows the former.
  if (stats.source !== 'volume') {
    return {
      level: 'unmeasurable',
      freeBytes: null,
      shouldReclaim: false,
      message:
        'This is a web build, so I can only see my own storage quota rather than the disk. Watching free space needs the desktop shell.',
    };
  }

  const free = stats.freeBytes;

  if (free < thresholdBytes) {
    return {
      level: 'critical',
      freeBytes: free,
      shouldReclaim: true,
      message: `Only ${gigabytes(free)} is free, below the ${gigabytes(thresholdBytes)} you set. I am clearing my own rebuildable caches; your files, notes and conversations are untouched.`,
    };
  }

  if (free < thresholdBytes * 2) {
    return {
      level: 'low',
      freeBytes: free,
      shouldReclaim: false,
      message: `${gigabytes(free)} free, which is getting close to the ${gigabytes(thresholdBytes)} mark. I have not cleared anything yet.`,
    };
  }

  return {
    level: 'ample',
    freeBytes: free,
    shouldReclaim: false,
    message: `${gigabytes(free)} free.`,
  };
}

/**
 * Whether the configured threshold is late enough to be useless, and why.
 * Null when the threshold is sensible.
 */
export function thresholdWarning(thresholdBytes: number): string | null {
  if (thresholdBytes >= TOO_LATE_TO_HELP_BYTES) return null;

  return `A threshold of ${gigabytes(thresholdBytes)} is later than I can usefully act on. Below about a gigabyte Windows itself starts failing to save, and the caches I am able to clear are measured in megabytes. I would raise it.`;
}
