import { describe, expect, it } from 'vitest';
import { NEVER_COPIED, formatBytes, planPortable, portableItems } from './plan.js';
import { ARCHIVABLE } from '../backup/archive.js';

describe('what is offered', () => {
  it('offers the program and every archivable namespace, and nothing else', () => {
    const ids = portableItems().map((item) => item.id);
    expect(ids).toContain('app');
    for (const namespace of Object.keys(ARCHIVABLE)) {
      expect(ids, namespace).toContain(namespace);
    }
    expect(ids).toHaveLength(Object.keys(ARCHIVABLE).length + 1);
  });

  /**
   * The rule that is not the user's to change. There is no checkbox for a
   * credential, so no sequence of clicks can produce a plan containing one.
   */
  it('offers no credential, by any name', () => {
    const text = JSON.stringify(portableItems()).toLowerCase();
    for (const word of ['token', 'secret', 'credential', 'api key', 'password']) {
      expect(text, word).not.toContain(word);
    }
  });

  it('says what is never copied, and why', () => {
    expect(NEVER_COPIED.length).toBeGreaterThan(0);
    for (const entry of NEVER_COPIED) {
      expect(entry.because.length).toBeGreaterThan(20);
    }
  });

  /**
   * Everything that would be readable by a stranger carries that sentence.
   * The program does not, because it says nothing about anybody.
   */
  it('attaches the consequence to every personal item', () => {
    for (const item of portableItems()) {
      if (item.id === 'app') expect(item.ifLost).toBeNull();
      else expect(item.ifLost, item.id).not.toBeNull();
    }
  });
});

describe('planning a copy', () => {
  it('includes exactly what was ticked', () => {
    const plan = planPortable({ selected: ['app', 'settings'] });
    expect(plan.include.map((item) => item.id)).toEqual(['app', 'settings']);
    expect(plan.carriesApp).toBe(true);
  });

  it('ignores an id that is not on offer rather than guessing at it', () => {
    const plan = planPortable({ selected: ['app', 'google-tokens', 'nonsense'] });
    expect(plan.include.map((item) => item.id)).toEqual(['app']);
  });

  it('refuses an empty selection', () => {
    expect(planPortable({ selected: [] }).problem).toMatch(/nothing/i);
  });

  it('names which chosen items a stranger could read', () => {
    const plan = planPortable({ selected: ['app', 'conversations', 'memory'] });
    expect(plan.personal.map((item) => item.id)).toEqual(['memory', 'conversations']);
  });

  it('counts only what has been measured, and says how much was not', () => {
    const plan = planPortable({
      selected: ['app', 'settings', 'memory'],
      sizes: { app: 1000, settings: 500 },
    });
    expect(plan.bytes).toBe(1500);
    expect(plan.unmeasured).toBe(1);
  });

  /**
   * Refused before anything is written. A copy that fills the disk and stops
   * halfway leaves a portable Helix that looks complete and is not.
   */
  it('refuses a copy that would not fit, before writing anything', () => {
    const plan = planPortable({
      selected: ['app'],
      sizes: { app: 900 * 1024 * 1024 },
      freeBytes: 100 * 1024 * 1024,
    });
    expect(plan.problem).toMatch(/free/i);
  });

  it('does not invent a size problem when the disk was never measured', () => {
    const plan = planPortable({
      selected: ['app'],
      sizes: { app: 900 * 1024 * 1024 },
      freeBytes: null,
    });
    expect(plan.problem).toBeNull();
  });
});

describe('sizes people can read', () => {
  it('uses the unit that fits', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  it('says so rather than printing nonsense for a number it cannot use', () => {
    expect(formatBytes(Number.NaN)).toBe('an unknown amount');
    expect(formatBytes(-1)).toBe('an unknown amount');
  });
});
