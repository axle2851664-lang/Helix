import { describe, expect, it } from 'vitest';
import { manifestText } from './manifest.js';
import { planPortable } from './plan.js';

const when = new Date('2026-09-25T10:00:00Z');

describe('the note left on the disk', () => {
  it('lists what was actually copied', () => {
    const text = manifestText(
      planPortable({ selected: ['app', 'settings'], sizes: { app: 1024 * 1024 } }),
      when,
    );

    expect(text).toContain('Helix itself');
    expect(text).toContain('1.0 MB');
    expect(text).toContain('Your settings');
    expect(text).not.toContain('Your conversations');
  });

  /**
   * The reader who matters most is somebody finding this in a drawer with no
   * Helix to open it, so the warning has to be in the file itself.
   */
  it('warns that the disk is unencrypted when anything personal is on it', () => {
    const text = manifestText(planPortable({ selected: ['conversations'] }), when);
    expect(text).toContain('NOT ENCRYPTED');
    expect(text).toContain('Your conversations');
  });

  it('does not cry wolf when only the program was copied', () => {
    const text = manifestText(planPortable({ selected: ['app'] }), when);
    expect(text).not.toContain('NOT ENCRYPTED');
  });

  /**
   * Somebody restoring this needs to know the Google connection did not come
   * with it, before they wonder why the mail will not load.
   */
  it('always says what was deliberately left out', () => {
    for (const selected of [['app'], ['conversations'], ['app', 'memory']]) {
      const text = manifestText(planPortable({ selected }), when);
      expect(text, selected.join()).toContain('DELIBERATELY NOT HERE');
      expect(text, selected.join()).toContain('Google');
    }
  });

  it('tells the reader what to do with it, differently for app and data', () => {
    expect(manifestText(planPortable({ selected: ['app'] }), when)).toContain('run Helix from there');
    expect(manifestText(planPortable({ selected: ['memory'] }), when)).toContain(
      'Install Helix on the other machine first',
    );
    expect(manifestText(planPortable({ selected: ['memory'] }), when)).toContain('Restore');
  });

  it('is plain text a stranger can read with nothing installed', () => {
    const text = manifestText(planPortable({ selected: ['app', 'memory'] }), when);
    expect(text).not.toContain('{');
    expect(text).not.toContain('<');
    expect(text.split('\n').length).toBeGreaterThan(5);
  });
});
