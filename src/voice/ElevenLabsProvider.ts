import type {
  ProviderAvailability,
  SpeechRecognitionError,
  SpeechRecognitionResult,
  SpeechToTextProvider,
  SpeechVoice,
  TextToSpeechProvider,
} from './types.js';
import { rmsFromBytes, SilenceDetector } from './silence.js';
import { messageFrom } from '../ai/transport.js';

/**
 * Speech through ElevenLabs.
 *
 * Two providers, one file, because they share a credential and a boundary.
 * The key lives in the Rust shell and is read from `ELEVENLABS_API_KEY` at the
 * moment a request goes out; the web view holds a command name and nothing
 * else. See `src-tauri/src/voice.rs`.
 *
 * **This moves the user's voice off the machine, and says so.** `processing`
 * is 'remote' on the recognition side and the setting that selects it is
 * labelled accordingly. Whisper remains the default for exactly this reason -
 * nothing here is presented as private, and nothing falls back to it silently.
 *
 * Synthesis is a different risk and is not treated as the same one: the text
 * it sends is already on screen, and no microphone is involved.
 *
 * The capture loop deliberately mirrors LocalWhisperProvider rather than
 * sharing a recorder with it. Both are batch models fed by `MediaRecorder` on
 * a `SilenceDetector`, so the shape is the same - but the working local
 * provider has no test coverage, and extracting a recorder out from under it
 * would risk the voice path that already works in order to save forty lines in
 * the one that does not exist yet. The shared part that matters, the decision
 * about when a turn has ended, is already shared: it is `silence.ts`.
 */

/** How often the microphone level is sampled. Matches the local provider. */
const LEVEL_INTERVAL_MS = 50;

/** Too short to contain a word. Sending it would spend a request on noise. */
const MIN_AUDIO_BYTES = 2048;

/** The shape of the shell bridge this file needs, and nothing wider. */
export interface ShellInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface ElevenLabsOptions {
  /** The shell bridge. Without one, neither provider is available. */
  invoke?: ShellInvoke | null;
  /** Injectable for tests. */
  mediaDevices?: MediaDevices;
}

/** base64 for the IPC hop. A byte array costs four JSON bytes per byte. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In chunks: spreading a megabyte of audio into String.fromCharCode as
  // arguments overflows the call stack, which presents as a crash part-way
  // through a long turn and never on a short one.
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  // The buffer rather than the view: `BlobPart` requires a view backed by an
  // ArrayBuffer specifically, and Uint8Array's buffer type is wider than that.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function shellMissing(): ProviderAvailability {
  return {
    available: false,
    reason: 'ElevenLabs needs the Helix desktop app, which is where the key is held.',
  };
}

// ------------------------------------------------------------- recognition

export class ElevenLabsSpeechToText implements SpeechToTextProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs (sends audio to ElevenLabs)';
  // Not 'unknown', and emphatically not 'on-device'. The audio leaves.
  readonly processing = 'remote' as const;
  readonly requiresNetwork = true;

  readonly #invoke: ShellInvoke | null;
  readonly #mediaDevices: MediaDevices | undefined;

  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #context: AudioContext | null = null;
  #levelTimer: ReturnType<typeof setInterval> | null = null;
  #chunks: Blob[] = [];
  #listening = false;
  #level = 0;
  #onLevel: ((level: number) => void) | null = null;

  constructor(options: ElevenLabsOptions = {}) {
    this.#invoke = options.invoke ?? null;
    this.#mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  }

  get listening(): boolean {
    return this.#listening;
  }

  get level(): number {
    return this.#level;
  }

  /** Subscribe to the live microphone level, for the on-screen meter. */
  onLevel(handler: (level: number) => void): () => void {
    this.#onLevel = handler;
    return () => {
      this.#onLevel = null;
    };
  }

  isAvailable(): ProviderAvailability {
    if (!this.#invoke) return shellMissing();
    if (typeof MediaRecorder === 'undefined') {
      return { available: false, reason: 'This browser has no MediaRecorder support.' };
    }
    if (!this.#mediaDevices?.getUserMedia) {
      return { available: false, reason: 'This browser exposes no microphone API.' };
    }
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return {
        available: false,
        reason: 'Microphone access requires a secure context (HTTPS or localhost).',
      };
    }
    return { available: true };
  }

  async start(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: SpeechRecognitionError) => void;
    onEnd: () => void;
  }): Promise<void> {
    const availability = this.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Speech recognition is unavailable.');
    }
    if (this.#listening) return;

    let stream: MediaStream;
    try {
      stream = await (this.#mediaDevices as MediaDevices).getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
        video: false,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'AbortError';
      throw new Error(
        name === 'NotAllowedError'
          ? 'Microphone access was declined. Allow it from the icon in your browser address bar.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this system.'
            : 'The microphone could not be started.',
      );
    }

    this.#stream = stream;
    this.#chunks = [];

    const context = new AudioContext();
    this.#context = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    const detector = new SilenceDetector();

    const recorder = new MediaRecorder(stream);
    this.#recorder = recorder;

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.#chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => {
      void this.#finish(handlers);
    });

    // setInterval, not requestAnimationFrame: RAF is throttled to a standstill
    // in a background tab, which would leave the microphone open and the turn
    // never ending.
    this.#levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      const level = rmsFromBytes(buffer);
      this.#level = level;
      this.#onLevel?.(level);

      const verdict = detector.push(level, performance.now());
      if (!verdict.end) return;

      if (verdict.reason === 'no-speech') {
        handlers.onError({ code: 'no-speech', message: 'I did not hear anything.' });
      }
      this.stop();
    }, LEVEL_INTERVAL_MS);

    recorder.start();
    this.#listening = true;
  }

  async #finish(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: SpeechRecognitionError) => void;
    onEnd: () => void;
  }): Promise<void> {
    const chunks = this.#chunks;
    this.#chunks = [];

    try {
      const invoke = this.#invoke;
      if (chunks.length === 0 || !invoke) {
        handlers.onEnd();
        return;
      }

      const type = chunks[0]?.type ?? 'audio/webm';
      const blob = new Blob(chunks, { type });

      // Nothing is sent for a turn that cannot contain a word. A remote
      // request costs money as well as time, so this check matters more here
      // than it does for the local model.
      if (blob.size < MIN_AUDIO_BYTES) {
        handlers.onEnd();
        return;
      }

      const response = await invoke<{ text?: unknown }>('elevenlabs_transcribe', {
        audio: await toBase64(blob),
        // The recorder's own type, not an assumption: what MediaRecorder
        // produces differs by browser, and labelling Ogg as WebM is a 400.
        mime: type.split(';')[0] ?? 'audio/webm',
      });

      const text = typeof response.text === 'string' ? response.text.trim() : '';
      if (text !== '') {
        handlers.onResult({
          transcript: text,
          isFinal: true,
          // ElevenLabs reports per-word probabilities, not one figure for the
          // utterance. Averaging them would invent a number, so: none.
          confidence: null,
        });
      }
    } catch (error) {
      /**
       * `messageFrom`, not `String(error)`.
       *
       * Tauri rejects with a plain `{ message }` object rather than an Error,
       * so `String(error)` is the literal text "[object Object]" - and the
       * cause is the only thing that says whether this was a rejected key, a
       * malformed request or an exhausted quota. The identical mistake was
       * already found and fixed on the inference side; this is the same
       * helper, not a second copy of it.
       */
      const cause = messageFrom(error);
      handlers.onError({
        code: 'transcription-failed',
        // Named, because two providers emitted the same sentence and there
        // was no way to tell from the screen which one had failed.
        message: `ElevenLabs could not transcribe the recording. ${cause}`,
        cause,
      });
    } finally {
      handlers.onEnd();
    }
  }

  stop(): void {
    if (this.#levelTimer !== null) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }

    if (this.#recorder && this.#recorder.state !== 'inactive') {
      try {
        this.#recorder.stop();
      } catch {
        // Already stopped.
      }
    }
    this.#recorder = null;

    for (const track of this.#stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
    this.#stream = null;

    void this.#context?.close().catch(() => undefined);
    this.#context = null;

    this.#level = 0;
    this.#onLevel?.(0);
    this.#listening = false;
  }
}

// -------------------------------------------------------------- synthesis

export class ElevenLabsTextToSpeech implements TextToSpeechProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs';
  readonly processing = 'remote' as const;

  readonly #invoke: ShellInvoke | null;

  #audio: HTMLAudioElement | null = null;
  #url: string | null = null;
  #speaking = false;
  /** Incremented by every cancel, so a reply in flight knows it is stale. */
  #generation = 0;

  constructor(options: ElevenLabsOptions = {}) {
    this.#invoke = options.invoke ?? null;
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  isAvailable(): ProviderAvailability {
    if (!this.#invoke) return shellMissing();
    if (typeof Audio === 'undefined') {
      return { available: false, reason: 'This browser cannot play audio.' };
    }
    return { available: true };
  }

  async listVoices(): Promise<SpeechVoice[]> {
    const invoke = this.#invoke;
    if (!invoke) return [];

    try {
      const response = await invoke<{ voices?: unknown }>('elevenlabs_voices');
      const voices = Array.isArray(response.voices) ? response.voices : [];

      return voices.flatMap((entry): SpeechVoice[] => {
        const voice = entry as { voice_id?: unknown; name?: unknown; labels?: unknown };
        if (typeof voice.voice_id !== 'string') return [];
        const labels = (voice.labels ?? {}) as { language?: unknown };
        return [
          {
            id: voice.voice_id,
            name: typeof voice.name === 'string' ? voice.name : voice.voice_id,
            // Reported where the account reports it. Not guessed at 'en-US',
            // which is what `selectVoice` would then rank on.
            lang: typeof labels.language === 'string' ? labels.language : '',
          },
        ];
      });
    } catch {
      // A list that cannot be fetched is an empty list, not a failure: the
      // caller falls back to the configured voice id.
      return [];
    }
  }

  async speak(text: string, options?: { voiceId?: string; rate?: number }): Promise<void> {
    const invoke = this.#invoke;
    if (!invoke) throw new Error(shellMissing().reason);

    const voiceId = options?.voiceId?.trim();
    if (!voiceId) {
      // Named rather than defaulted to one of ElevenLabs' stock voices: a
      // voice silently chosen for the user is a voice they did not pick, and
      // the ids are account-specific anyway.
      throw new Error('No ElevenLabs voice is chosen. Pick one in settings.');
    }

    const spoken = text.trim();
    if (spoken === '') return;

    this.cancel();
    const generation = this.#generation;

    const encoded = await invoke<string>('elevenlabs_speak', { text: spoken, voiceId });
    // Cancelled while the audio was being synthesised. Playing it now would
    // mean Helix talking over the thing that interrupted it.
    if (generation !== this.#generation) return;

    // A blob URL, not a data: URL. The content policy allows `media-src
    // 'self' blob:` and nothing else, so a data URL here is silently blocked
    // and presents as synthesis that succeeds and never makes a sound.
    const blob = new Blob([fromBase64(encoded)], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    if (options?.rate !== undefined) audio.playbackRate = options.rate;

    this.#url = url;
    this.#audio = audio;
    this.#speaking = true;

    try {
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener('ended', () => resolve());
        audio.addEventListener('error', () =>
          reject(new Error('The synthesised audio could not be played.')),
        );
        void audio.play().catch(reject);
      });
    } finally {
      // Only tear down what is still ours: a cancel part-way through has
      // already replaced these and revoked the URL.
      if (generation === this.#generation) this.#release();
    }
  }

  cancel(): void {
    this.#generation += 1;
    try {
      this.#audio?.pause();
    } catch {
      // Not playing.
    }
    this.#release();
  }

  #release(): void {
    if (this.#url !== null) {
      URL.revokeObjectURL(this.#url);
      this.#url = null;
    }
    this.#audio = null;
    this.#speaking = false;
  }
}
