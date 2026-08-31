import type {
  ProviderAvailability,
  SpeechRecognitionResult,
  SpeechToTextProvider,
} from './types.js';
import { rmsFromBytes, SilenceDetector } from './silence.js';

/**
 * Speech recognition using Whisper, running on this machine.
 *
 * Unlike the browser's Web Speech API, no audio leaves the device: the model
 * runs in WebAssembly and its weights are served from Helix's own origin. That
 * is why `processing` is 'on-device' and `requiresNetwork` is false - this
 * works offline, and nothing is sent to a third party.
 *
 * How a turn works, and why:
 *
 * - Audio is captured with `MediaRecorder` and transcribed once the turn ends.
 *   Whisper is a batch model, not a streaming one; pretending otherwise would
 *   mean re-running it per frame for no benefit.
 * - The turn ends on measured microphone level, via an `AnalyserNode` and
 *   SilenceDetector, so it responds to the speaker actually stopping rather
 *   than to a fixed timer.
 * - The level loop runs on `setInterval`, deliberately not
 *   `requestAnimationFrame`. RAF is throttled to a standstill in a background
 *   tab, which would leave the microphone open and silently deaf - the single
 *   most confusing failure this design can have.
 */

/** How often the microphone level is sampled. */
const LEVEL_INTERVAL_MS = 50;

/** Whisper expects 16 kHz mono. */
const TARGET_SAMPLE_RATE = 16_000;

export type WhisperModelSize = 'tiny' | 'base';

const MODEL_IDS: Record<WhisperModelSize, string> = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
};

/** Minimal shape of the transformers.js pipeline, to avoid a hard import. */
type TranscribeFn = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string }>;

export interface LocalWhisperOptions {
  size?: WhisperModelSize;
  /** Injectable for tests. */
  mediaDevices?: MediaDevices;
}

export class LocalWhisperProvider implements SpeechToTextProvider {
  readonly id = 'local';
  readonly name = 'Whisper (on this machine)';
  readonly processing = 'on-device' as const;
  // The model is served locally, so a turn can be transcribed with no network.
  readonly requiresNetwork = false;

  readonly #size: WhisperModelSize;
  readonly #mediaDevices: MediaDevices | undefined;

  #transcribe: TranscribeFn | null = null;
  #loading: Promise<void> | null = null;

  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #context: AudioContext | null = null;
  #levelTimer: ReturnType<typeof setInterval> | null = null;
  #chunks: Blob[] = [];
  #listening = false;

  /** Latest measured level, 0..1, for the UI meter. */
  #level = 0;
  #onLevel: ((level: number) => void) | null = null;

  constructor(options: LocalWhisperOptions = {}) {
    this.#size = options.size ?? 'tiny';
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
    if (typeof WebAssembly === 'undefined') {
      return { available: false, reason: 'This browser has no WebAssembly support.' };
    }
    return { available: true };
  }

  /**
   * Load the model. Separated from `start` so the UI can show progress: the
   * first load reads tens of megabytes and takes noticeable time.
   */
  async load(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.#transcribe) return;
    if (this.#loading) return this.#loading;

    this.#loading = (async () => {
      const transformers = await import('@huggingface/transformers');

      // Serve weights from Helix's own origin. The content security policy
      // permits no external origins, and local weights are what make this
      // genuinely on-device.
      transformers.env.allowRemoteModels = false;
      transformers.env.allowLocalModels = true;
      transformers.env.localModelPath = './models/';

      const pipe = await transformers.pipeline(
        'automatic-speech-recognition',
        MODEL_IDS[this.#size],
        {
          dtype: 'q8',
          // ProgressInfo is a union; only the 'progress' variant carries a
          // percentage, so read it defensively rather than asserting a shape.
          progress_callback: (info: unknown) => {
            const value = (info as { progress?: unknown }).progress;
            if (typeof value === 'number') onProgress?.(value / 100);
          },
        },
      );

      this.#transcribe = pipe as unknown as TranscribeFn;
    })();

    try {
      await this.#loading;
    } catch (error) {
      this.#loading = null;
      throw new Error(
        'The speech model could not be loaded. Run "npm run fetch:models" to install it.',
        { cause: error },
      );
    }
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

    await this.load();

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

    // --- level metering, for both the meter and the turn decision ---
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

    // setInterval, not requestAnimationFrame: RAF stops in a background tab
    // and the microphone would stay open with no turn ever ending.
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

  /** Transcribe the captured audio and report the result. */
  async #finish(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: { code: string; message: string }) => void;
    onEnd: () => void;
  }): Promise<void> {
    const chunks = this.#chunks;
    this.#chunks = [];

    try {
      if (chunks.length === 0 || !this.#transcribe) {
        handlers.onEnd();
        return;
      }

      const blob = new Blob(chunks, { type: chunks[0]?.type ?? 'audio/webm' });
      const samples = await this.#decode(blob);

      // Too short to contain a word; transcribing would return noise.
      if (samples.length < TARGET_SAMPLE_RATE / 4) {
        handlers.onEnd();
        return;
      }

      const output = await this.#transcribe(samples);
      const text = output.text.trim();

      if (text !== '') {
        handlers.onResult({
          transcript: text,
          isFinal: true,
          // Whisper does not report a usable per-utterance confidence, and an
          // invented number would be worse than none.
          confidence: null,
        });
      }
    } catch (error) {
      handlers.onError({
        code: 'transcription-failed',
        message: 'The recording could not be transcribed.',
      });
      void error;
    } finally {
      handlers.onEnd();
    }
  }

  /** Decode recorded audio to 16 kHz mono, which is what Whisper expects. */
  async #decode(blob: Blob): Promise<Float32Array> {
    const bytes = await blob.arrayBuffer();
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    try {
      const decoded = await context.decodeAudioData(bytes);
      // Mono: take channel 0. The capture already requests one channel, but a
      // browser may ignore that constraint.
      return decoded.getChannelData(0);
    } finally {
      void context.close();
    }
  }

  stop(): void {
    if (this.#levelTimer !== null) {
      clearInterval(this.#levelTimer);
      this.#levelTimer = null;
    }

    if (this.#recorder && this.#recorder.state !== 'inactive') {
      try {
        // Fires 'stop', which triggers transcription.
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
