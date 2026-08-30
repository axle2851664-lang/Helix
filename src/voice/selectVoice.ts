import type { SpeechVoice } from './types.js';

/**
 * Choosing a voice that matches the Helix character.
 *
 * The target is a composed, articulate British voice - not a theatrical one,
 * and deliberately not an imitation of any particular person. The browser only
 * exposes a name and a language tag, so selection is a ranking over those:
 * British English first, then names that conventionally indicate a male voice
 * on Windows and Chrome, then general quality markers.
 *
 * This is a preference, not a guarantee. Installed voices vary by machine, and
 * `describeSelection` exists so the UI can say what was actually chosen rather
 * than implying the intended voice was available.
 */

/** Language tags for British English, most specific first. */
const BRITISH_TAGS = ['en-gb', 'en_gb'];

/**
 * Name fragments that indicate a male voice in the common Windows, Chrome and
 * macOS voice sets. Matching by name is crude, but it is the only signal the
 * Web Speech API exposes.
 */
const MALE_NAME_HINTS = [
  'male',
  // Windows en-GB
  'george', 'ryan', 'oliver', 'thomas', 'arthur',
  // Windows en-US - the default set on most machines, so worth naming
  'david', 'mark', 'guy', 'christopher', 'eric', 'roger', 'steffan',
  // macOS and other common sets
  'daniel', 'james', 'brian', 'alex', 'fred', 'oliver',
];

/** Names that indicate a female voice, used to rank down rather than exclude. */
const FEMALE_NAME_HINTS = [
  'female',
  // Windows en-GB
  'hazel', 'susan', 'sonia', 'libby', 'maisie', 'abbi', 'bella', 'olivia',
  // Windows en-US
  'zira', 'aria', 'jenny', 'michelle', 'ana', 'jessa',
  // macOS and other common sets
  'serena', 'kate', 'emily', 'fiona', 'samantha', 'victoria', 'moira',
];

/** Higher-quality synthesis engines, where the name advertises it. */
const QUALITY_HINTS = ['natural', 'neural', 'premium', 'enhanced', 'online'];

export interface VoiceScore {
  voice: SpeechVoice;
  score: number;
}

export function scoreVoice(voice: SpeechVoice): number {
  const lang = voice.lang.toLowerCase().replace('_', '-');
  const name = voice.name.toLowerCase();
  let score = 0;

  if (BRITISH_TAGS.some((tag) => lang.startsWith(tag.replace('_', '-')))) score += 100;
  else if (lang.startsWith('en-')) score += 30;
  else if (lang.startsWith('en')) score += 20;
  // A non-English voice reading English is worse than no preference at all.
  else score -= 50;

  if (MALE_NAME_HINTS.some((hint) => name.includes(hint))) score += 40;
  if (FEMALE_NAME_HINTS.some((hint) => name.includes(hint))) score -= 25;
  if (QUALITY_HINTS.some((hint) => name.includes(hint))) score += 15;

  return score;
}

/**
 * Rank the available voices. Returns them best-first so a UI can offer the
 * whole list with the recommended one at the top.
 */
export function rankVoices(voices: readonly SpeechVoice[]): VoiceScore[] {
  return voices
    .map((voice) => ({ voice, score: scoreVoice(voice) }))
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name));
}

/** The best available match, or null when no voices are installed. */
export function selectVoice(voices: readonly SpeechVoice[]): SpeechVoice | null {
  const ranked = rankVoices(voices);
  return ranked[0]?.voice ?? null;
}

/**
 * Describe what was actually selected, so the UI never implies a British voice
 * is in use when the machine has none installed.
 */
export function describeSelection(voice: SpeechVoice | null): string {
  if (!voice) return 'No speech voices are installed on this system.';

  const lang = voice.lang.toLowerCase().replace('_', '-');
  if (BRITISH_TAGS.some((tag) => lang.startsWith(tag.replace('_', '-')))) {
    return `Using ${voice.name} (British English).`;
  }
  if (lang.startsWith('en')) {
    return `No British English voice is installed. Using ${voice.name} (${voice.lang}) instead.`;
  }
  return `No English voice is installed. Using ${voice.name} (${voice.lang}), which may sound wrong.`;
}
