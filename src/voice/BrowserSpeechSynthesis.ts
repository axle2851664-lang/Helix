import type {
  ProviderAvailability,
  SpeechVoice,
  TextToSpeechProvider,
} from './types.js';

/**
 * Text to speech via the browser's SpeechSynthesis API.
 *
 * Unlike recognition, synthesis voices are generally installed with the
 * operating system and run on-device, so no audio leaves the machine. Some
 * browsers additionally offer remote voices; `processing` is reported as
 * 'unknown' rather than claiming on-device for every voice, because the API
 * does not reliably say which is which.
 */
export class BrowserSpeechSynthesis implements TextToSpeechProvider {
  readonly id = 'browser';
  readonly name = 'Browser speech synthesis';
  // Most voices are local, but the API does not distinguish reliably, and
  // guessing 'on-device' would be a privacy claim Helix cannot support.
  readonly processing = 'unknown' as const;

  get speaking(): boolean {
    return typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking;
  }

  static isSupported(): boolean {
    return typeof speechSynthesis !== 'undefined';
  }

  isAvailable(): ProviderAvailability {
    if (!BrowserSpeechSynthesis.isSupported()) {
      return { available: false, reason: 'This browser has no speech synthesis support.' };
    }
    return { available: true };
  }

  /**
   * Voices load asynchronously in some browsers, returning an empty list on the
   * first call. Wait for the voiceschanged event rather than reporting "no
   * voices" for what is really a timing artefact.
   */
  async listVoices(): Promise<SpeechVoice[]> {
    if (!BrowserSpeechSynthesis.isSupported()) return [];

    const toSpeechVoice = (voice: SpeechSynthesisVoice): SpeechVoice => ({
      id: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
    });

    const immediate = speechSynthesis.getVoices();
    if (immediate.length > 0) return immediate.map(toSpeechVoice);

    return new Promise<SpeechVoice[]>((resolve) => {
      const timer = setTimeout(() => {
        speechSynthesis.removeEventListener('voiceschanged', onChange);
        resolve(speechSynthesis.getVoices().map(toSpeechVoice));
      }, 1000);

      const onChange = () => {
        clearTimeout(timer);
        speechSynthesis.removeEventListener('voiceschanged', onChange);
        resolve(speechSynthesis.getVoices().map(toSpeechVoice));
      };

      speechSynthesis.addEventListener('voiceschanged', onChange);
    });
  }

  async speak(text: string, options: { voiceId?: string; rate?: number } = {}): Promise<void> {
    const availability = this.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Speech synthesis is unavailable.');
    }

    const trimmed = text.trim();
    if (trimmed === '') return;

    // Anything already speaking is replaced, so replies cannot pile up.
    this.cancel();

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(trimmed);

      if (options.voiceId) {
        const match = speechSynthesis.getVoices().find((v) => v.voiceURI === options.voiceId);
        if (match) utterance.voice = match;
      }
      if (options.rate !== undefined) {
        // The API accepts 0.1-10; the setting is a percentage.
        utterance.rate = Math.min(10, Math.max(0.1, options.rate / 100));
      }

      utterance.onend = () => {
        resolve();
      };

      utterance.onerror = (event) => {
        // A deliberate interrupt is not a failure - the user asked for it.
        if (event.error === 'canceled' || event.error === 'interrupted') {
          resolve();
          return;
        }
        reject(new Error(`Speech synthesis failed: ${event.error}`));
      };

      speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    if (!BrowserSpeechSynthesis.isSupported()) return;
    try {
      speechSynthesis.cancel();
    } catch {
      // Nothing was speaking.
    }
  }
}
