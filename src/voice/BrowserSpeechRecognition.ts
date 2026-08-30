import type {
  ProviderAvailability,
  SpeechRecognitionResult,
  SpeechToTextProvider,
} from './types.js';

/**
 * Speech recognition via the Web Speech API.
 *
 * PRIVACY - this matters and is surfaced in the UI, not buried here:
 * Chrome and Edge implement `SpeechRecognition` by streaming microphone audio
 * to a Google speech service. It is NOT on-device, despite being a browser API
 * with no key. `processing` is therefore 'remote' and `requiresNetwork` is
 * true, and VoiceManager refuses to start it while Helix is in offline mode.
 * A user who believes their voice stays on the machine must be told otherwise
 * (spec 9: microphone access must always be clearly indicated).
 *
 * Nothing is recorded or stored. Audio is streamed by the browser and Helix
 * keeps only the resulting text, which the log redactor never sees.
 */

/** Minimal shape of the Web Speech API, which TypeScript does not ship types for. */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }
  >;
}

type RecognitionConstructor = new () => SpeechRecognitionLike;

function getConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate =
    (window as { SpeechRecognition?: RecognitionConstructor }).SpeechRecognition ??
    (window as { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition;
  return candidate ?? null;
}

/** Web Speech error codes mapped to messages a person can act on. */
const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed':
    'Microphone access was denied. Allow it in your browser settings to use voice.',
  'service-not-allowed':
    'The browser refused to start speech recognition. It may be blocked by policy.',
  'no-speech': 'I did not hear anything.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection and could not reach the service.',
  aborted: 'Listening stopped.',
  'language-not-supported': 'That language is not supported by the browser speech service.',
};

export class BrowserSpeechRecognition implements SpeechToTextProvider {
  readonly id = 'browser';
  readonly name = 'Browser speech recognition';
  // See the privacy note above: this is not on-device in Chrome or Edge.
  readonly processing = 'remote' as const;
  readonly requiresNetwork = true;

  #recognition: SpeechRecognitionLike | null = null;
  #listening = false;
  readonly #lang: string;

  constructor(options: { lang?: string } = {}) {
    this.#lang = options.lang ?? 'en-US';
  }

  get listening(): boolean {
    return this.#listening;
  }

  static isSupported(): boolean {
    return getConstructor() !== null;
  }

  isAvailable(): ProviderAvailability {
    if (getConstructor() === null) {
      return {
        available: false,
        reason:
          'This browser has no Web Speech API. Chrome or Edge support it; Firefox does not.',
      };
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return {
        available: false,
        reason: 'Speech recognition requires a secure context (HTTPS or localhost).',
      };
    }
    return { available: true };
  }

  async start(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: { code: string; message: string }) => void;
    onEnd: () => void;
  }): Promise<void> {
    const availability = this.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Speech recognition is unavailable.');
    }
    if (this.#listening) return;

    const Recognition = getConstructor();
    if (!Recognition) throw new Error('Speech recognition is unavailable.');

    const recognition = new Recognition();
    recognition.lang = this.#lang;
    // Single utterance: push-to-talk stops when the user releases.
    recognition.continuous = false;
    // Interim results drive the live transcript so the user sees it working.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        handlers.onResult({
          transcript: alternative.transcript,
          isFinal: result.isFinal,
          // Chrome reports 0 for interim results; that is absence, not certainty.
          confidence: result.isFinal && alternative.confidence > 0 ? alternative.confidence : null,
        });
      }
    };

    recognition.onerror = (event) => {
      this.#listening = false;
      handlers.onError({
        code: event.error,
        message: ERROR_MESSAGES[event.error] ?? 'Speech recognition failed.',
      });
    };

    recognition.onend = () => {
      this.#listening = false;
      handlers.onEnd();
    };

    this.#recognition = recognition;

    // Resolve only once the browser confirms the microphone is live, so the
    // listening indicator cannot appear before recording actually begins.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      recognition.onstart = () => {
        settled = true;
        this.#listening = true;
        resolve();
      };

      const originalError = recognition.onerror;
      recognition.onerror = (event) => {
        if (!settled) {
          settled = true;
          this.#listening = false;
          reject(new Error(ERROR_MESSAGES[event.error] ?? 'Speech recognition failed.'));
          return;
        }
        originalError?.(event);
      };

      try {
        recognition.start();
      } catch (error) {
        settled = true;
        reject(error instanceof Error ? error : new Error('Could not start listening.'));
      }
    });
  }

  stop(): void {
    if (!this.#recognition) return;
    try {
      this.#recognition.stop();
    } catch {
      // Already stopped; nothing to do.
    }
    this.#listening = false;
  }
}
