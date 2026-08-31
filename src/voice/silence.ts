/**
 * Turn-taking: deciding when the speaker has stopped.
 *
 * Press the microphone once and talk - there is no wake word between turns.
 * The turn ends when the measured audio level stays below the speech floor for
 * long enough, which means the decision rests on real microphone level, not a
 * timer that fires whether or not anyone spoke.
 *
 * This module is pure: levels and timestamps in, a verdict out. That makes the
 * behaviour testable without a microphone, and it keeps the tuning constants
 * below in one place rather than scattered through the audio code.
 */

/**
 * How long the level must stay below the floor before the turn ends.
 * Tune this first if turns are cut off mid-sentence (raise it) or drag on
 * after you stop (lower it).
 */
export const SILENCE_HOLD_MS = 900;

/**
 * RMS level, 0..1, below which audio counts as silence.
 *
 * Deliberately low. A room has a noise floor, and a threshold set too high
 * treats quiet speech as silence and clips the end of every sentence.
 */
export const SPEECH_FLOOR = 0.012;

/**
 * The turn will not end before this much speech has been heard, so a cough or
 * a click cannot produce an empty one-frame turn.
 */
export const MIN_SPEECH_MS = 250;

/**
 * Give up on a turn that never contains speech at all, rather than listening
 * forever with an open microphone.
 */
export const MAX_SILENT_WAIT_MS = 8000;

/** Longest single turn, so a stuck level cannot hold the microphone open. */
export const MAX_TURN_MS = 60_000;

export type TurnVerdict =
  | { end: false }
  | { end: true; reason: 'silence' | 'no-speech' | 'too-long' };

export interface SilenceDetectorOptions {
  holdMs?: number;
  floor?: number;
  minSpeechMs?: number;
  maxSilentWaitMs?: number;
  maxTurnMs?: number;
}

export class SilenceDetector {
  readonly #holdMs: number;
  readonly #floor: number;
  readonly #minSpeechMs: number;
  readonly #maxSilentWaitMs: number;
  readonly #maxTurnMs: number;

  #startedAt: number | null = null;
  /** When the current run of below-floor audio began. */
  #quietSince: number | null = null;
  /** Total time above the floor, so a turn is known to contain speech. */
  #speechMs = 0;
  #lastAt: number | null = null;
  #peak = 0;

  constructor(options: SilenceDetectorOptions = {}) {
    this.#holdMs = options.holdMs ?? SILENCE_HOLD_MS;
    this.#floor = options.floor ?? SPEECH_FLOOR;
    this.#minSpeechMs = options.minSpeechMs ?? MIN_SPEECH_MS;
    this.#maxSilentWaitMs = options.maxSilentWaitMs ?? MAX_SILENT_WAIT_MS;
    this.#maxTurnMs = options.maxTurnMs ?? MAX_TURN_MS;
  }

  /** True once any speech has been detected in this turn. */
  get heardSpeech(): boolean {
    return this.#speechMs >= this.#minSpeechMs;
  }

  /** Loudest level seen, for the UI to show the microphone is alive. */
  get peak(): number {
    return this.#peak;
  }

  reset(): void {
    this.#startedAt = null;
    this.#quietSince = null;
    this.#speechMs = 0;
    this.#lastAt = null;
    this.#peak = 0;
  }

  /**
   * Feed one measured level.
   *
   * @param level RMS amplitude, 0..1.
   * @param at    Timestamp in milliseconds.
   */
  push(level: number, at: number): TurnVerdict {
    if (this.#startedAt === null) this.#startedAt = at;

    const elapsedSinceLast = this.#lastAt === null ? 0 : Math.max(0, at - this.#lastAt);
    this.#lastAt = at;
    this.#peak = Math.max(this.#peak, level);

    if (level >= this.#floor) {
      this.#speechMs += elapsedSinceLast;
      // Any speech restarts the quiet run: a pause mid-sentence is not the end
      // of a turn unless it lasts.
      this.#quietSince = null;
    } else if (this.#quietSince === null) {
      this.#quietSince = at;
    }

    const turnMs = at - this.#startedAt;

    if (turnMs >= this.#maxTurnMs) return { end: true, reason: 'too-long' };

    // Nothing has been said at all, and the microphone has been open a while.
    if (!this.heardSpeech && turnMs >= this.#maxSilentWaitMs) {
      return { end: true, reason: 'no-speech' };
    }

    // The ordinary path: speech happened, then quiet held long enough.
    if (
      this.heardSpeech &&
      this.#quietSince !== null &&
      at - this.#quietSince >= this.#holdMs
    ) {
      return { end: true, reason: 'silence' };
    }

    return { end: false };
  }
}

/**
 * RMS of a time-domain buffer from an AnalyserNode, normalised to 0..1.
 *
 * RMS rather than peak: peak jumps on a single click and makes the level meter
 * flicker, while RMS tracks perceived loudness, which is what both the meter
 * and the silence decision want.
 */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/**
 * Convert a byte-domain AnalyserNode buffer (0..255, centred on 128) to RMS.
 * `getByteTimeDomainData` is cheaper than the float version and is enough
 * precision for a level meter and a threshold.
 */
export function rmsFromBytes(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (const byte of bytes) {
    const centred = (byte - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / bytes.length);
}
