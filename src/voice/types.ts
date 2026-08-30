/**
 * Voice provider interfaces (spec 9).
 *
 * Speech recognition and synthesis sit behind replaceable interfaces so the
 * browser implementations here can be swapped for a local model or a cloud
 * provider without touching VoiceManager or the UI.
 *
 * Every provider must be able to say whether it can actually run, and why not,
 * before anything asks it to listen or speak.
 */

export interface ProviderAvailability {
  available: boolean;
  /** Present when unavailable: what is missing, in plain language. */
  reason?: string;
}

/**
 * Where audio is processed. This is a privacy fact, not a technical detail, and
 * the UI is required to surface it: a provider that ships microphone audio to a
 * third party must never be presented as if it were local.
 */
export type ProcessingLocation = 'on-device' | 'remote' | 'unknown';

export interface SpeechRecognitionResult {
  transcript: string;
  /** False while the user is still speaking; true for the settled result. */
  isFinal: boolean;
  /** 0..1 where the provider reports it, null otherwise. Never invented. */
  confidence: number | null;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly name: string;
  /** Where audio is processed, for the privacy notice. */
  readonly processing: ProcessingLocation;
  /** Requires a network connection to work at all. */
  readonly requiresNetwork: boolean;

  isAvailable(): ProviderAvailability;

  /**
   * Begin listening. Resolves once recognition has actually started, so the
   * caller can show a listening indicator only when the microphone is truly
   * live rather than optimistically.
   *
   * On failure, throw an Error whose message is safe to show the user - the
   * provider knows what went wrong and can say something actionable, which
   * VoiceManager surfaces verbatim.
   */
  start(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: { code: string; message: string }) => void;
    onEnd: () => void;
  }): Promise<void>;

  stop(): void;
  /** True while the microphone is genuinely open. */
  readonly listening: boolean;
}

export interface SpeechVoice {
  id: string;
  name: string;
  lang: string;
}

export interface TextToSpeechProvider {
  readonly id: string;
  readonly name: string;
  readonly processing: ProcessingLocation;

  isAvailable(): ProviderAvailability;
  listVoices(): Promise<SpeechVoice[]>;

  /**
   * Speak text. Resolves when speech finishes, rejects if it fails.
   * Must be interruptible - see `cancel`.
   */
  speak(
    text: string,
    options?: { voiceId?: string; rate?: number },
  ): Promise<void>;

  /** Stop immediately. Required so the user can interrupt Helix (spec 9). */
  cancel(): void;
  readonly speaking: boolean;
}

/** Voice pipeline state, mirrored by the Helix status indicator. */
export type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';
