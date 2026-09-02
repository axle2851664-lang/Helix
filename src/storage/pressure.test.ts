import { describe, expect, it } from 'vitest';
import { assessDiskPressure, thresholdWarning, TOO_LATE_TO_HELP_BYTES } from './pressure.js';
import type { VolumeStats } from '../platform/PlatformAdapter.js';

const GB = 1024 ** 3;

const volume = (freeGb: number): VolumeStats => ({
  freeBytes: freeGb * GB,
  totalBytes: 237 * GB,
  usedByHelixBytes: 1.2 * GB,
  source: 'volume',
});

const threshold = 5 * GB;

describe('assessDiskPressure', () => {
  // The measured state of the machine this was written for: 54.3 GB free.
  it('is quiet when there is plenty of room', () => {
    const verdict = assessDiskPressure(volume(54.3), threshold);
    expect(verdict.level).toBe('ample');
    expect(verdict.shouldReclaim).toBe(false);
  });

  /**
   * A warning before an action. Crossing straight from "fine" to "I have just
   * deleted something" leaves the user no moment to intervene, which is why
   * `low` sits at twice the threshold rather than just above it.
   */
  it('warns before it acts', () => {
    const verdict = assessDiskPressure(volume(7), threshold);
    expect(verdict.level).toBe('low');
    expect(verdict.shouldReclaim).toBe(false);
    expect(verdict.message).toContain('not cleared anything');
  });

  it('acts below the threshold', () => {
    const verdict = assessDiskPressure(volume(3), threshold);
    expect(verdict.level).toBe('critical');
    expect(verdict.shouldReclaim).toBe(true);
  });

  /**
   * The sentence that has to be right every single time this fires.
   *
   * The permission covers rebuildable caches and nothing else. If this message
   * ever stops saying so, the user has no way to know what an automatic action
   * took, and an automatic action nobody can audit is the thing the storage
   * report refused to build in the first place.
   */
  it('says what it is not touching, every time it acts', () => {
    const message = assessDiskPressure(volume(3), threshold).message;
    expect(message).toContain('files, notes and conversations are untouched');
  });

  /**
   * The measurement trap. A browser reports its origin quota, which has
   * nothing to do with free disk space - acting on it would fire at
   * meaningless moments and clear caches for no reason.
   */
  it('refuses to read an origin quota as free disk space', () => {
    const verdict = assessDiskPressure(
      { freeBytes: 0.2 * GB, totalBytes: 1 * GB, usedByHelixBytes: 0.8 * GB, source: 'origin-quota' },
      threshold,
    );

    expect(verdict.level).toBe('unmeasurable');
    expect(verdict.shouldReclaim).toBe(false);
    expect(verdict.message).toContain('desktop shell');
  });

  it('does nothing when the host cannot measure at all', () => {
    const verdict = assessDiskPressure(null, threshold);
    expect(verdict.level).toBe('unmeasurable');
    expect(verdict.shouldReclaim).toBe(false);
  });

  it('always explains itself', () => {
    for (const free of [54.3, 7, 3]) {
      expect(assessDiskPressure(volume(free), threshold).message.length).toBeGreaterThan(10);
    }
  });
});

describe('thresholdWarning', () => {
  /**
   * The number originally asked for, and why it is reported back rather than
   * silently accepted. On a 237 GB drive, 0.33 GB free means Windows is
   * already failing to save; the caches Helix can clear are megabytes. The
   * setting is still allowed - it is the user's machine - but pretending it
   * would rescue anything would be the flattering answer, not the true one.
   */
  it('says when a threshold is too late to be useful', () => {
    const warning = thresholdWarning(0.33 * GB);
    expect(warning).toContain('later than I can usefully act on');
  });

  it('is quiet about a sensible one', () => {
    expect(thresholdWarning(5 * GB)).toBeNull();
    expect(thresholdWarning(TOO_LATE_TO_HELP_BYTES)).toBeNull();
  });
});
