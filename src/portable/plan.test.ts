import { describe, expect, it } from 'vitest';
import { NEVER_COPIED, PORTABLE_PRESETS, formatBytes, matchesPreset, planPortable, portableItems } from './plan.js';
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
   * halfway leaves a portable Havoc that looks complete and is not.
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

describe('presets', () => {
  /**
   * A preset is a shortcut through the same machinery, never around it. Every
   * id it names has to be a real item, or a preset would select something the
   * screen cannot show and the plan cannot cost.
   */
  it('only names items that exist', () => {
    const real = new Set(portableItems().map((item) => item.id));
    for (const preset of PORTABLE_PRESETS) {
      for (const id of preset.items) {
        expect(real.has(id), `${preset.id} names ${id}`).toBe(true);
      }
    }
  });

  it('offers the two that were asked for', () => {
    const notepadOnly = PORTABLE_PRESETS.find((preset) => preset.id === 'notepad-only');
    expect(notepadOnly?.items).toEqual(['notepad']);

    const both = PORTABLE_PRESETS.find((preset) => preset.id === 'helix-and-notepad');
    expect(new Set(both?.items)).toEqual(new Set(['app', 'notepad']));
  });

  /**
   * The point of "Notepad only" is that it is only the notepad. A preset that
   * quietly carried a conversation history would be worse than no preset,
   * because the name is the whole reassurance.
   */
  it('keeps Notepad only to the notepad', () => {
    const plan = planPortable({ selected: ['notepad'] });
    expect(plan.include.map((item) => item.id)).toEqual(['notepad']);
    expect(plan.carriesApp).toBe(false);
  });

  /** There is no checkbox for a credential, so there is no preset with one. */
  it('never names anything that is never copied', () => {
    const forbidden = ['tokens', 'relay', 'keys', 'secrets', 'credentials'];
    for (const preset of PORTABLE_PRESETS) {
      for (const id of preset.items) {
        expect(forbidden, `${preset.id} names ${id}`).not.toContain(id);
      }
    }
  });

  /**
   * "Everything" has to mean everything, or the name is a lie in the other
   * direction: someone choosing it to move machines would arrive missing a
   * subsystem added after the preset was written.
   */
  it('makes "everything" actually everything', () => {
    const everything = PORTABLE_PRESETS.find((preset) => preset.id === 'everything');
    expect(new Set(everything?.items)).toEqual(new Set(portableItems().map((item) => item.id)));
  });

  it('recognises the ticks that make up a preset', () => {
    const notepadOnly = PORTABLE_PRESETS[0];
    expect(notepadOnly).toBeDefined();
    if (!notepadOnly) return;

    expect(matchesPreset(notepadOnly, ['notepad'])).toBe(true);
    expect(matchesPreset(notepadOnly, ['notepad', 'memory'])).toBe(false);
    expect(matchesPreset(notepadOnly, [])).toBe(false);
  });
});
