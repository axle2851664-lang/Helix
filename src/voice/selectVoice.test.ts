import { describe, expect, it } from 'vitest';
import { describeSelection, rankVoices, scoreVoice, selectVoice } from './selectVoice.js';
import type { SpeechVoice } from './types.js';

const voice = (name: string, lang: string): SpeechVoice => ({ id: name, name, lang });

describe('scoreVoice', () => {
  it('prefers British English over other English', () => {
    expect(scoreVoice(voice('A', 'en-GB'))).toBeGreaterThan(scoreVoice(voice('A', 'en-US')));
  });

  it('prefers any English over a non-English voice', () => {
    expect(scoreVoice(voice('A', 'en-US'))).toBeGreaterThan(scoreVoice(voice('A', 'de-DE')));
  });

  it('prefers a male-indicating name', () => {
    expect(scoreVoice(voice('George', 'en-GB'))).toBeGreaterThan(
      scoreVoice(voice('Hazel', 'en-GB')),
    );
  });

  it('rewards higher-quality engines', () => {
    expect(scoreVoice(voice('Ryan Natural', 'en-GB'))).toBeGreaterThan(
      scoreVoice(voice('Ryan', 'en-GB')),
    );
  });
});

describe('selectVoice', () => {
  it('picks a British male voice from a typical Windows set', () => {
    const installed = [
      voice('Microsoft Zira - English (United States)', 'en-US'),
      voice('Microsoft Hazel - English (United Kingdom)', 'en-GB'),
      voice('Microsoft George - English (United Kingdom)', 'en-GB'),
      voice('Microsoft Hans - German (Germany)', 'de-DE'),
    ];
    expect(selectVoice(installed)?.name).toContain('George');
  });

  // Language matters more than the name hint: an American "David" should not
  // beat a British voice just because the name reads as male.
  it('prefers a British voice over an American one with a male name', () => {
    const installed = [
      voice('Microsoft David - English (United States)', 'en-US'),
      voice('Microsoft Sonia - English (United Kingdom)', 'en-GB'),
    ];
    expect(selectVoice(installed)?.lang).toBe('en-GB');
  });

  it('falls back to another English voice when no British one exists', () => {
    const installed = [voice('Microsoft Zira', 'en-US'), voice('Anna', 'de-DE')];
    expect(selectVoice(installed)?.lang).toBe('en-US');
  });

  it('returns null when nothing is installed', () => {
    expect(selectVoice([])).toBeNull();
  });

  it('handles an underscore language tag', () => {
    expect(selectVoice([voice('Arthur', 'en_GB'), voice('Zira', 'en-US')])?.name).toBe('Arthur');
  });
});

describe('rankVoices', () => {
  it('returns every voice, best first', () => {
    const installed = [voice('Zira', 'en-US'), voice('George', 'en-GB'), voice('Hans', 'de-DE')];
    const ranked = rankVoices(installed);

    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.voice.name).toBe('George');
    expect(ranked[2]?.voice.name).toBe('Hans');
  });
});

describe('describeSelection', () => {
  // The UI must not imply a British voice is in use when none is installed.
  it('confirms a genuine British voice', () => {
    expect(describeSelection(voice('George', 'en-GB'))).toContain('British English');
  });

  it('says plainly when falling back to another English voice', () => {
    const text = describeSelection(voice('Zira', 'en-US'));
    expect(text).toContain('No British English voice is installed');
    expect(text).toContain('Zira');
  });

  it('warns when only a non-English voice exists', () => {
    expect(describeSelection(voice('Hans', 'de-DE'))).toContain('may sound wrong');
  });

  it('says when nothing is installed', () => {
    expect(describeSelection(null)).toContain('No speech voices are installed');
  });
});

describe('real Windows voice sets', () => {
  // The default Windows en-US set, which is what many machines actually have.
  const windowsUs = [
    voice('Microsoft David - English (United States)', 'en-US'),
    voice('Microsoft Mark - English (United States)', 'en-US'),
    voice('Microsoft Zira - English (United States)', 'en-US'),
  ];

  it('picks a male voice from the default Windows set, not alphabetical luck', () => {
    const chosen = selectVoice(windowsUs);
    expect(['Microsoft David - English (United States)', 'Microsoft Mark - English (United States)'])
      .toContain(chosen?.name);
  });

  it('ranks Zira below the male voices', () => {
    const ranked = rankVoices(windowsUs);
    expect(ranked[ranked.length - 1]?.voice.name).toContain('Zira');
  });

  // A machine with no en-GB voice must be told so, not left believing
  // it has a British voice.
  it('states plainly that no British voice is installed', () => {
    const text = describeSelection(selectVoice(windowsUs));
    expect(text).toContain('No British English voice is installed');
  });
});
