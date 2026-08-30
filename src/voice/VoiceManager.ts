import type { ActivityManager, ActivityToken } from '../core/ActivityManager.js';
import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceState,
} from './types.js';

/**
 * The voice pipeline (spec 9).
 *
 *   microphone -> recognition -> orchestrator -> response -> synthesis -> speaker
 *
 * Rules enforced here rather than left to the UI:
 *
 * - **The microphone indicator cannot lie.** `MICROPHONE_STARTED` is emitted
 *   only after the provider confirms the device is live, and `MICROPHONE_STOPPED`
 *   is emitted from the provider's own end callback. The indicator follows real
 *   device state, never an optimistic UI flag.
 * - **Nothing is recorded.** Helix keeps the transcript text only; no audio is
 *   captured, buffered or stored (spec 9).
 * - **Helix can always be interrupted.** `stopSpeaking()` cancels synthesis
 *   immediately, and starting to listen cancels any speech in progress.
 * - **Refuses rather than fails obscurely.** A provider that cannot run, a
 *   network-dependent provider while offline, or a missing microphone each
 *   produce a readable reason.
 */

export interface VoiceManagerOptions {
  settings: SettingsManager;
  logger: Logger;
  activity: ActivityManager;
  bus?: EventBus;
  stt?: SpeechToTextProvider;
  tts?: TextToSpeechProvider;
  /** Reports connectivity, so a remote provider is refused while offline. */
  isOnline?: () => boolean;
}

export interface VoiceSnapshot {
  state: VoiceState;
  /** Live transcript while listening, including interim text. */
  transcript: string;
  /** Last error, cleared when listening starts again. */
  error: string | null;
  micLive: boolean;
}

export type VoiceListener = (snapshot: VoiceSnapshot) => void;

export class VoiceManager {
  readonly #settings: SettingsManager;
  readonly #logger: Logger;
  readonly #activity: ActivityManager;
  readonly #bus: EventBus | undefined;
  readonly #stt: SpeechToTextProvider | undefined;
  readonly #tts: TextToSpeechProvider | undefined;
  readonly #isOnline: () => boolean;
  readonly #listeners = new Set<VoiceListener>();

  #state: VoiceState = 'idle';
  #transcript = '';
  #error: string | null = null;
  #activityToken: ActivityToken | null = null;
  /** Resolves with the final transcript when listening ends. */
  #pending: ((transcript: string) => void) | null = null;

  constructor(options: VoiceManagerOptions) {
    this.#settings = options.settings;
    this.#logger = options.logger.child('voice');
    this.#activity = options.activity;
    this.#bus = options.bus;
    this.#stt = options.stt;
    this.#tts = options.tts;
    this.#isOnline = options.isOnline ?? (() => true);
  }

  get snapshot(): VoiceSnapshot {
    return {
      state: this.#state,
      transcript: this.#transcript,
      error: this.#error,
      micLive: this.#stt?.listening ?? false,
    };
  }

  get state(): VoiceState {
    return this.#state;
  }

  subscribe(listener: VoiceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#logger.error('A voice listener threw.', error);
      }
    }
  }

  #setState(state: VoiceState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit();
  }

  /**
   * Why voice input cannot be used right now, or null when it can.
   * Checked before any attempt, so the UI explains rather than failing.
   */
  inputBlocker(): string | null {
    if (this.#settings.get('speechToTextProvider') === 'none') {
      return 'No speech provider is configured. Choose one in Settings under Voice.';
    }
    if (!this.#stt) {
      return 'The selected speech provider is not available in this build.';
    }

    const availability = this.#stt.isAvailable();
    if (!availability.available) {
      return availability.reason ?? 'Speech recognition is unavailable.';
    }

    // A provider that streams audio to a service cannot work offline, and
    // must not be started only to fail mid-utterance.
    if (this.#stt.requiresNetwork) {
      if (this.#settings.get('offlineMode') === 'offline') {
        return `${this.#stt.name} sends audio to an online service, and Helix is in offline mode.`;
      }
      if (!this.#isOnline()) {
        return `${this.#stt.name} needs a network connection, and you appear to be offline.`;
      }
    }

    return null;
  }

  /** Why speech output cannot be used, or null when it can. */
  outputBlocker(): string | null {
    if (this.#settings.get('textToSpeechProvider') === 'none') {
      return 'No text-to-speech provider is configured.';
    }
    if (!this.#tts) return 'The selected voice provider is not available in this build.';
    const availability = this.#tts.isAvailable();
    return availability.available ? null : (availability.reason ?? 'Speech output is unavailable.');
  }

  /**
   * Where recognised audio is processed, for the privacy notice.
   * Null when there is no usable provider.
   */
  get inputProcessing(): { location: string; providerName: string } | null {
    if (!this.#stt) return null;
    return { location: this.#stt.processing, providerName: this.#stt.name };
  }

  /**
   * Start listening. Resolves with the final transcript, or an empty string if
   * nothing was heard. Rejects with a readable HelixError when it cannot start.
   */
  async listen(): Promise<string> {
    const blocker = this.inputBlocker();
    if (blocker !== null) {
      throw new HelixError('CAPABILITY_UNAVAILABLE', blocker, {
        technical: 'listen() called while input is blocked.',
      });
    }
    if (this.#state === 'listening') return '';

    // Interrupting Helix by starting to speak is the natural gesture (spec 9).
    this.stopSpeaking();

    const stt = this.#stt as SpeechToTextProvider;
    this.#transcript = '';
    this.#error = null;

    let finalTranscript = '';

    try {
      await stt.start({
        onResult: (result) => {
          if (result.isFinal) finalTranscript += result.transcript;
          // Interim text is shown live but never accumulated.
          this.#transcript = (finalTranscript + (result.isFinal ? '' : result.transcript)).trim();
          this.#emit();
        },
        onError: (error) => {
          // "no-speech" is an ordinary outcome, not a failure to report loudly.
          if (error.code !== 'no-speech' && error.code !== 'aborted') {
            this.#error = error.message;
            this.#logger.warn('Speech recognition error.', { code: error.code });
          }
          this.#setState('error');
        },
        onEnd: () => {
          this.#endActivity();
          this.#bus?.emit('MICROPHONE_STOPPED', { reason: 'recognition-ended' });
          if (this.#state !== 'error') this.#setState('idle');
          this.#emit();
          const resolve = this.#pending;
          this.#pending = null;
          resolve?.(finalTranscript.trim());
        },
      });
    } catch (error) {
      this.#endActivity();
      // Providers contract to throw user-readable messages (see types.ts), and
      // theirs are more actionable than a generic fallback - "Microphone access
      // was denied. Allow it in your browser settings" beats "could not start".
      const specific =
        error instanceof Error && error.message.trim() !== '' ? error.message : null;
      const helix =
        error instanceof HelixError
          ? error
          : new HelixError(
              'CAPABILITY_UNAVAILABLE',
              specific ?? 'Helix could not start listening.',
              { technical: `listen() failed: ${String(error)}` },
            );

      this.#error = helix.userMessage;
      this.#setState('error');
      throw helix;
    }

    // Only now is the device genuinely live.
    this.#bus?.emit('MICROPHONE_STARTED', { deviceId: null });
    this.#activityToken = this.#activity.begin('listening');
    this.#setState('listening');

    return new Promise<string>((resolve) => {
      this.#pending = resolve;
    });
  }

  /** Stop listening. The pending listen() resolves with what was heard. */
  stopListening(): void {
    this.#stt?.stop();
  }

  /** Speak a response. Resolves when finished or interrupted. */
  async speak(text: string): Promise<void> {
    const blocker = this.outputBlocker();
    if (blocker !== null) {
      // Not an error: the user simply has no voice output configured, and the
      // reply is already visible as text.
      this.#logger.debug('Speech output skipped.', { reason: blocker });
      return;
    }

    const tts = this.#tts as TextToSpeechProvider;
    this.#setState('speaking');
    const token = this.#activity.begin('speaking');

    try {
      await tts.speak(text, { rate: this.#settings.get('speechRate') });
    } catch (error) {
      this.#logger.warn('Speech synthesis failed.', error);
      this.#error = 'Helix could not speak the response, but it is shown above.';
    } finally {
      token.end('completed');
      if (this.#state === 'speaking') this.#setState('idle');
    }
  }

  /** Interrupt Helix mid-sentence (spec 9). */
  stopSpeaking(): void {
    this.#tts?.cancel();
    if (this.#state === 'speaking') this.#setState('idle');
  }

  /** Mark the thinking phase between recognition and a response. */
  beginProcessing(): void {
    this.#setState('processing');
  }

  endProcessing(): void {
    if (this.#state === 'processing') this.#setState('idle');
  }

  #endActivity(): void {
    this.#activityToken?.end('completed');
    this.#activityToken = null;
  }

  /** Release the microphone and stop any speech. Used on shutdown (spec 28). */
  shutdown(): void {
    this.stopListening();
    this.stopSpeaking();
    this.#endActivity();
    this.#setState('idle');
  }
}
