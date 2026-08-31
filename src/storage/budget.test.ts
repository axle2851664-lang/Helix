import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  admit,
  fillRatio,
  formatBytes,
  gigabytesToBytes,
  headroom,
  pressure,
  pressureNotice,
  type BudgetState,
} from './budget.js';
import type { VolumeStats } from '../platform/PlatformAdapter.js';

const GB = BYTES_PER_GB;

const quota = (free: number, total: number): VolumeStats => ({
  freeBytes: free,
  totalBytes: total,
  usedByHelixBytes: total - free,
  source: 'origin-quota',
});

const disk = (free: number, total: number): VolumeStats => ({
  freeBytes: free,
  totalBytes: total,
  usedByHelixBytes: 0,
  source: 'volume',
});

const state = (over: Partial<BudgetState> = {}): BudgetState => ({
  usedBytes: 1 * GB,
  ceilingBytes: 10 * GB,
  volume: null,
  ...over,
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * GB)).toBe('3.0 GB');
  });

  it('drops the decimal once the number is large enough not to need it', () => {
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB');
  });

  it('does not invent a figure for a bad input', () => {
    expect(formatBytes(Number.NaN)).toBe('unknown');
    expect(formatBytes(-1)).toBe('unknown');
  });
});

describe('gigabytesToBytes', () => {
  it('converts', () => {
    expect(gigabytesToBytes(2)).toBe(2 * GB);
  });

  it('never returns a negative budget', () => {
    expect(gigabytesToBytes(-5)).toBe(0);
  });
});

describe('headroom', () => {
  /**
   * The rule this module exists for. A browser reports an origin quota, and
   * calling it free disk space would be a lie made entirely of true numbers.
   */
  it('never calls an origin quota disk space', () => {
    const room = headroom(state({ volume: quota(2 * GB, 20 * GB) }));

    expect(room.basis).toBe('origin-quota');
    expect(room.description).toContain("browser's allowance");
    // It may only mention disk space to deny that this is any.
    expect(room.description).toContain('not free disk space');
  });

  it('does say disk when a disk was actually measured', () => {
    const room = headroom(state({ volume: disk(2 * GB, 500 * GB) }));

    expect(room.basis).toBe('volume');
    expect(room.description).toContain('volume');
  });

  it('reports the tighter of the ceiling and the host', () => {
    // Ceiling leaves 9 GB, host offers 2 GB: the host wins.
    expect(headroom(state({ volume: disk(2 * GB, 500 * GB) })).bytes).toBe(2 * GB);

    // Ceiling leaves 1 GB, host offers 400 GB: the ceiling wins.
    expect(
      headroom(state({ usedBytes: 9 * GB, volume: disk(400 * GB, 500 * GB) })).basis,
    ).toBe('ceiling');
  });

  it('says so when the host cannot report anything', () => {
    const room = headroom(state({ volume: null }));

    expect(room.basis).toBe('ceiling');
    expect(room.description).toContain('cannot report free space');
  });

  it('never reports negative headroom', () => {
    expect(headroom(state({ usedBytes: 40 * GB })).bytes).toBe(0);
  });
});

describe('admit', () => {
  it('allows a write that fits', () => {
    expect(admit(100, state()).allowed).toBe(true);
  });

  it('refuses a write past the ceiling, and names it', () => {
    const verdict = admit(20 * GB, state());
    if (verdict.allowed) throw new Error('should have been refused');

    expect(verdict.bound).toBe('ceiling');
    expect(verdict.reason).toContain('ceiling you set');
    expect(verdict.reason).toContain('Settings');
  });

  /**
   * Someone told they are out of space will go and clear their disk. When the
   * constraint is the browser's allowance, that does nothing at all, so the
   * refusal has to say which it is.
   */
  it('refuses against a quota without sending the user to clear their disk', () => {
    const verdict = admit(5 * GB, state({ volume: quota(1 * GB, 6 * GB) }));
    if (verdict.allowed) throw new Error('should have been refused');

    expect(verdict.bound).toBe('host');
    expect(verdict.reason).toContain('will not help');
  });

  it('refuses against real free space in the plainer terms it deserves', () => {
    const verdict = admit(5 * GB, state({ volume: disk(1 * GB, 500 * GB) }));
    if (verdict.allowed) throw new Error('should have been refused');

    expect(verdict.reason).toContain('free on the volume');
  });

  it('checks the ceiling before the host, so the fixable limit is reported first', () => {
    const verdict = admit(30 * GB, state({ volume: quota(1 * GB, 6 * GB) }));
    if (verdict.allowed) throw new Error('should have been refused');

    expect(verdict.bound).toBe('ceiling');
  });

  it('allows a zero-byte write', () => {
    expect(admit(0, state({ usedBytes: 10 * GB })).allowed).toBe(true);
  });
});

describe('fillRatio and pressure', () => {
  it('is comfortable when there is room', () => {
    expect(pressure(state()).level).toBe('comfortable');
  });

  it('steps through the promised thresholds', () => {
    expect(pressure(state({ usedBytes: 7.6 * GB })).level).toBe('notable');
    expect(pressure(state({ usedBytes: 8.6 * GB })).level).toBe('high');
    expect(pressure(state({ usedBytes: 9.6 * GB })).level).toBe('critical');
    expect(pressure(state({ usedBytes: 9.95 * GB })).level).toBe('full');
  });

  it('carries the basis with the level', () => {
    expect(pressure(state({ usedBytes: 9 * GB, volume: quota(0.1 * GB, 9.1 * GB) })).basis).toBe(
      'origin-quota',
    );
  });

  it('never exceeds one', () => {
    expect(fillRatio(state({ usedBytes: 900 * GB })).ratio).toBeLessThanOrEqual(1);
  });

  it('handles a ceiling of nothing without dividing by zero', () => {
    const ratio = fillRatio(state({ usedBytes: 0, ceilingBytes: 0 })).ratio;
    expect(Number.isFinite(ratio)).toBe(true);
  });
});

describe('pressureNotice', () => {
  // A banner that is always there is furniture, and furniture is not read on
  // the day it matters.
  it('says nothing while there is room', () => {
    expect(pressureNotice(state())).toBeNull();
  });

  it('names the ceiling as something the user can change', () => {
    expect(pressureNotice(state({ usedBytes: 9.6 * GB }))).toContain('Settings');
  });

  it('does not blame the disk for a browser allowance', () => {
    const notice = pressureNotice(
      state({ usedBytes: 9 * GB, volume: quota(0.05 * GB, 9.05 * GB) }),
    );

    expect(notice).toContain('not your disk');
  });
});
