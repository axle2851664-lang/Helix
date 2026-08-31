import { describe, expect, it } from 'vitest';
import {
  MAX_SILENT_WAIT_MS,
  MIN_SPEECH_MS,
  rmsFromBytes,
  rmsLevel,
  SILENCE_HOLD_MS,
  SilenceDetector,
  SPEECH_FLOOR,
} from './silence.js';

/** Feed a run of levels at a fixed cadence, returning the first end verdict. */
function feed(
  detector: SilenceDetector,
  steps: Array<{ level: number; ms: number }>,
  stepMs = 50,
) {
  let at = 0;
  for (const step of steps) {
    const frames = Math.max(1, Math.round(step.ms / stepMs));
    for (let i = 0; i < frames; i += 1) {
      at += stepMs;
      const verdict = detector.push(step.level, at);
      if (verdict.end) return { verdict, at };
    }
  }
  return { verdict: { end: false } as const, at };
}

const LOUD = 0.2;
const QUIET = 0.001;

describe('SilenceDetector', () => {
  it('does not end a turn while speech continues', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(detector, [{ level: LOUD, ms: 5000 }]);
    expect(verdict.end).toBe(false);
  });

  it('ends the turn after speech followed by held silence', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(detector, [
      { level: LOUD, ms: 1000 },
      { level: QUIET, ms: 2000 },
    ]);

    expect(verdict.end).toBe(true);
    if (verdict.end) expect(verdict.reason).toBe('silence');
  });

  // A pause mid-sentence must not be read as the end of a turn.
  it('does not end on a pause shorter than the hold', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(detector, [
      { level: LOUD, ms: 600 },
      { level: QUIET, ms: SILENCE_HOLD_MS - 300 },
      { level: LOUD, ms: 600 },
    ]);
    expect(verdict.end).toBe(false);
  });

  it('restarts the silence hold when speech resumes', () => {
    const detector = new SilenceDetector();
    const { verdict, at } = feed(detector, [
      { level: LOUD, ms: 500 },
      { level: QUIET, ms: 700 },
      { level: LOUD, ms: 200 },
      { level: QUIET, ms: 2000 },
    ]);

    expect(verdict.end).toBe(true);
    // Ends well after the first quiet run would have, proving it restarted.
    expect(at).toBeGreaterThan(500 + 700 + 200 + SILENCE_HOLD_MS - 100);
  });

  // A cough or a click must not produce an empty turn.
  it('ignores a burst too short to count as speech', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(
      detector,
      [
        { level: LOUD, ms: MIN_SPEECH_MS / 2 },
        { level: QUIET, ms: 1500 },
      ],
      50,
    );

    // Not a 'silence' end - there was never enough speech to end.
    if (verdict.end) expect(verdict.reason).not.toBe('silence');
  });

  it('gives up when nothing is ever said', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(detector, [{ level: QUIET, ms: MAX_SILENT_WAIT_MS + 1000 }], 100);

    expect(verdict.end).toBe(true);
    if (verdict.end) expect(verdict.reason).toBe('no-speech');
  });

  // A stuck level must not hold the microphone open indefinitely.
  it('caps an unending turn', () => {
    const detector = new SilenceDetector({ maxTurnMs: 2000 });
    const { verdict } = feed(detector, [{ level: LOUD, ms: 4000 }], 100);

    expect(verdict.end).toBe(true);
    if (verdict.end) expect(verdict.reason).toBe('too-long');
  });

  it('tracks whether speech was heard', () => {
    const detector = new SilenceDetector();
    expect(detector.heardSpeech).toBe(false);

    feed(detector, [{ level: LOUD, ms: 500 }]);
    expect(detector.heardSpeech).toBe(true);
  });

  it('records the peak level for the meter', () => {
    const detector = new SilenceDetector();
    detector.push(0.05, 50);
    detector.push(0.4, 100);
    detector.push(0.1, 150);
    expect(detector.peak).toBeCloseTo(0.4, 5);
  });

  it('reset clears the turn', () => {
    const detector = new SilenceDetector();
    feed(detector, [{ level: LOUD, ms: 500 }]);
    detector.reset();

    expect(detector.heardSpeech).toBe(false);
    expect(detector.peak).toBe(0);
  });

  it('treats a level exactly at the floor as speech', () => {
    const detector = new SilenceDetector();
    const { verdict } = feed(detector, [
      { level: SPEECH_FLOOR, ms: 600 },
      { level: QUIET, ms: 2000 },
    ]);
    expect(verdict.end).toBe(true);
  });

  it('honours custom tuning', () => {
    const detector = new SilenceDetector({ holdMs: 200, minSpeechMs: 50 });
    const { verdict, at } = feed(detector, [
      { level: LOUD, ms: 200 },
      { level: QUIET, ms: 1000 },
    ]);

    expect(verdict.end).toBe(true);
    // Ends much sooner than the default hold would allow.
    expect(at).toBeLessThan(200 + SILENCE_HOLD_MS);
  });
});

describe('level measurement', () => {
  it('rmsLevel is zero for silence', () => {
    expect(rmsLevel(new Float32Array(64))).toBe(0);
  });

  it('rmsLevel rises with amplitude', () => {
    const quiet = rmsLevel(Float32Array.from({ length: 64 }, () => 0.1));
    const loud = rmsLevel(Float32Array.from({ length: 64 }, () => 0.8));
    expect(loud).toBeGreaterThan(quiet);
  });

  it('rmsLevel handles an empty buffer', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  // Byte buffers from getByteTimeDomainData centre on 128, not 0.
  it('rmsFromBytes treats 128 as silence', () => {
    expect(rmsFromBytes(new Uint8Array(64).fill(128))).toBe(0);
  });

  it('rmsFromBytes rises with deviation from centre', () => {
    const quiet = rmsFromBytes(new Uint8Array(64).fill(136));
    const loud = rmsFromBytes(new Uint8Array(64).fill(200));
    expect(loud).toBeGreaterThan(quiet);
  });

  // RMS rather than peak: a single click should not swamp the reading.
  it('rmsFromBytes is not dominated by one spike', () => {
    const mostlyQuiet = new Uint8Array(64).fill(128);
    mostlyQuiet[0] = 255;
    expect(rmsFromBytes(mostlyQuiet)).toBeLessThan(0.2);
  });
});
