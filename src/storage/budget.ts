import type { VolumeStats } from '../platform/PlatformAdapter.js';

/**
 * Storage arithmetic, kept pure.
 *
 * The whole difficulty here is one number: "space left". There are three
 * different quantities competing to be it, and they are not interchangeable.
 *
 *   - The ceiling the user set. A Helix policy, and nothing more.
 *   - The origin quota, which is what a browser reports. It is not disk space.
 *     It is a per-origin allowance the browser may revise, and it can sit on a
 *     volume with far less free space than the quota suggests.
 *   - Actual free space on the volume, which only the desktop shell can see.
 *
 * Reporting a quota as free disk space would be a lie made entirely of true
 * numbers - exactly the failure the standing rules name. So headroom is never
 * returned as a bare number: every figure comes back with the basis it was
 * derived from and a sentence carrying that qualifier.
 *
 * The smallest constraint always wins, and whichever one bound the answer is
 * named, so a refusal is never mysterious.
 */

export type HeadroomBasis = 'ceiling' | 'origin-quota' | 'volume' | 'unknown';

export interface Headroom {
  /** Null when nothing can be measured. Never guessed. */
  bytes: number | null;
  /** What the figure above actually describes. */
  basis: HeadroomBasis;
  /** The figure in words, always carrying its qualifier. */
  description: string;
}

export interface BudgetState {
  /** Bytes Helix currently holds, as measured. */
  usedBytes: number;
  /** The user's configured ceiling, in bytes. */
  ceilingBytes: number;
  /** What the host can see. Null when it cannot see anything. */
  volume: VolumeStats | null;
}

export type Admission =
  | { allowed: true; headroom: Headroom }
  | { allowed: false; reason: string; bound: 'ceiling' | 'host' };

export const BYTES_PER_GB = 1024 ** 3;

export function gigabytesToBytes(gigabytes: number): number {
  return Math.max(0, Math.round(gigabytes * BYTES_PER_GB));
}

/** Short, readable, and never more precise than the measurement deserves. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * How much room is left, and what that number means.
 *
 * The ceiling and the host constraint are compared, and the tighter one is
 * reported - along with which it was, because "you have 2 GB" reads very
 * differently depending on whether the next 2 GB are limited by a setting the
 * user can change or by a disk they cannot.
 */
export function headroom(state: BudgetState): Headroom {
  const underCeiling = Math.max(0, state.ceilingBytes - state.usedBytes);
  const volume = state.volume;

  if (!volume) {
    return {
      bytes: underCeiling,
      basis: 'ceiling',
      description: `${formatBytes(underCeiling)} before Helix reaches the ceiling you set. This host cannot report free space, so nothing here describes your disk.`,
    };
  }

  const quota = volume.source === 'origin-quota';

  if (volume.freeBytes <= underCeiling) {
    return {
      bytes: volume.freeBytes,
      basis: quota ? 'origin-quota' : 'volume',
      description: quota
        ? `${formatBytes(volume.freeBytes)} left in the browser's allowance for this origin. That is not free disk space, and the browser may revise it.`
        : `${formatBytes(volume.freeBytes)} free on the volume holding Helix data.`,
    };
  }

  return {
    bytes: underCeiling,
    basis: 'ceiling',
    description: `${formatBytes(underCeiling)} before Helix reaches the ceiling you set, which is tighter than what the host reports.`,
  };
}

/**
 * May this many bytes be written?
 *
 * Refusals name the constraint that bound them and, when it is the browser's
 * quota, say so plainly - a user told they are "out of space" will go and
 * clear their disk, which would not help at all.
 */
export function admit(bytes: number, state: BudgetState): Admission {
  if (bytes <= 0) return { allowed: true, headroom: headroom(state) };

  const underCeiling = state.ceilingBytes - state.usedBytes;
  if (bytes > underCeiling) {
    return {
      allowed: false,
      bound: 'ceiling',
      reason: `That would put Helix over the ${formatBytes(state.ceilingBytes)} ceiling you set. It holds ${formatBytes(state.usedBytes)}, and this needs ${formatBytes(bytes)}. You may raise the ceiling in Settings, or free something up.`,
    };
  }

  const volume = state.volume;
  if (volume && bytes > volume.freeBytes) {
    return {
      allowed: false,
      bound: 'host',
      reason:
        volume.source === 'origin-quota'
          ? `The browser allows this origin ${formatBytes(volume.totalBytes)} and ${formatBytes(volume.freeBytes)} of it remains, which is less than the ${formatBytes(bytes)} this needs. That is the browser's allowance rather than your disk, so clearing disk space elsewhere will not help.`
          : `Only ${formatBytes(volume.freeBytes)} is free on the volume holding Helix data, and this needs ${formatBytes(bytes)}.`,
    };
  }

  return { allowed: true, headroom: headroom(state) };
}

/**
 * How full Helix is, 0..1, against whichever constraint is tighter.
 *
 * Returned alongside its basis for the same reason as everything else here: a
 * bar at 90% means something quite different when the 90% is of a setting.
 */
export function fillRatio(state: BudgetState): { ratio: number; basis: HeadroomBasis } {
  const room = headroom(state);
  if (room.bytes === null) return { ratio: 0, basis: 'unknown' };

  const total = state.usedBytes + room.bytes;
  return {
    ratio: total <= 0 ? 0 : Math.min(1, state.usedBytes / total),
    basis: room.basis,
  };
}

/**
 * Pressure thresholds, as promised on the placeholder this replaces.
 *
 * The level carries its basis for the same reason every other figure here
 * does: "critical, 96% full" is alarming, and it should not be alarming when
 * the 96% is of a ceiling the user picked and can raise in a second.
 */
export type Pressure = 'comfortable' | 'notable' | 'high' | 'critical' | 'full';

export const PRESSURE_THRESHOLDS = {
  notable: 0.75,
  high: 0.85,
  critical: 0.95,
  full: 0.99,
} as const;

export function pressure(state: BudgetState): { level: Pressure; basis: HeadroomBasis } {
  const { ratio, basis } = fillRatio(state);

  const level: Pressure =
    ratio >= PRESSURE_THRESHOLDS.full
      ? 'full'
      : ratio >= PRESSURE_THRESHOLDS.critical
        ? 'critical'
        : ratio >= PRESSURE_THRESHOLDS.high
          ? 'high'
          : ratio >= PRESSURE_THRESHOLDS.notable
            ? 'notable'
            : 'comfortable';

  return { level, basis };
}

/**
 * The warning sentence, or null when there is nothing worth saying.
 *
 * Silence below the first threshold is deliberate. A banner that is always
 * there is furniture, and furniture is not read on the day it matters.
 */
export function pressureNotice(state: BudgetState): string | null {
  const { level, basis } = pressure(state);
  if (level === 'comfortable') return null;

  const what =
    basis === 'ceiling'
      ? 'the ceiling you set, which you may raise in Settings'
      : basis === 'origin-quota'
        ? "the browser's allowance for this origin, which is not your disk"
        : 'free space on the volume holding Helix data';

  const opener =
    level === 'full'
      ? 'Helix is out of room against'
      : level === 'critical'
        ? 'Helix is nearly out of room against'
        : level === 'high'
          ? 'Helix is running short against'
          : 'Helix is filling up against';

  return `${opener} ${what}.`;
}
