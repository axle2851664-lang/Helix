import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ElevenLabsSpeechToText,
  ElevenLabsTextToSpeech,
  type ShellInvoke,
} from './ElevenLabsProvider.js';

/**
 * These tests cover the boundary and the refusals, which is where this file
 * can be wrong without anyone noticing: a provider that claims to be available
 * in a browser, a voice chosen on the user's behalf, or audio that plays after
 * the user interrupted it.
 *
 * They do not drive a microphone. The capture loop needs MediaRecorder, an
 * AudioContext and an AnalyserNode, and a hand-built triple of those tests the
 * fakes rather than the code.
 */

/** Minimal audio element, enough to resolve or fail a `speak`. */
class FakeAudio {
  playbackRate = 1;
  paused = false;
  readonly #listeners = new Map<string, () => void>();
  static last: FakeAudio | null = null;
  static failOnPlay = false;

  constructor(readonly src: string) {
    FakeAudio.last = this;
  }

  addEventListener(name: string, listener: () => void): void {
    this.#listeners.set(name, listener);
  }

  play(): Promise<void> {
    if (FakeAudio.failOnPlay) return Promise.reject(new Error('blocked'));
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  finish(): void {
    this.#listeners.get('ended')?.();
  }

  fail(): void {
    this.#listeners.get('error')?.();
  }
}

const revoked: string[] = [];

function withAudioGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals['Audio'] = FakeAudio;
  globals['URL'] = {
    createObjectURL: (blob: Blob) => `blob:${blob.size}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  };
}

afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals['Audio'];
  delete globals['URL'];
  revoked.length = 0;
  FakeAudio.last = null;
  FakeAudio.failOnPlay = false;
});

describe('ElevenLabs availability', () => {
  it('is unavailable without the shell, and says where the key lives', () => {
    for (const provider of [new ElevenLabsSpeechToText(), new ElevenLabsTextToSpeech()]) {
      const availability = provider.isAvailable();
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/desktop app/i);
    }
  });

  /**
   * The one fact the interface is required to surface. A provider that ships
   * microphone audio to a third party must never read as local.
   */
  it('reports recognition as remote and network-bound', () => {
    const stt = new ElevenLabsSpeechToText();
    expect(stt.processing).toBe('remote');
    expect(stt.requiresNetwork).toBe(true);
    expect(stt.name).toMatch(/sends audio/i);
  });
});

describe('listVoices', () => {
  it('maps the account voices and never invents a language', async () => {
    const invoke = (async () => ({
      voices: [
        { voice_id: 'abc123', name: 'Havoc', labels: { language: 'en' } },
        { voice_id: 'def456' },
        // No id: unusable, so it is dropped rather than given a blank one.
        { name: 'broken' },
      ],
    })) as unknown as ShellInvoke;

    const voices = await new ElevenLabsTextToSpeech({ invoke }).listVoices();
    expect(voices).toEqual([
      { id: 'abc123', name: 'Havoc', lang: 'en' },
      { id: 'def456', name: 'def456', lang: '' },
    ]);
  });

  it('answers with an empty list when the request fails', async () => {
    const invoke = (async () => {
      throw new Error('401');
    }) as unknown as ShellInvoke;
    expect(await new ElevenLabsTextToSpeech({ invoke }).listVoices()).toEqual([]);
  });

  it('has nothing to list without the shell', async () => {
    expect(await new ElevenLabsTextToSpeech().listVoices()).toEqual([]);
  });
});

describe('speak', () => {
  function provider(invoke: ShellInvoke): ElevenLabsTextToSpeech {
    withAudioGlobals();
    return new ElevenLabsTextToSpeech({ invoke });
  }

  const ok = (async (command: string) =>
    command === 'elevenlabs_speak' ? 'TWFu' : {}) as unknown as ShellInvoke;

  /**
   * A voice silently chosen for the user is a voice they did not pick, and the
   * ids are account-specific, so there is no sensible default to fall back on.
   */
  it('refuses rather than choosing a voice on the user\'s behalf', async () => {
    const invoke = vi.fn();
    await expect(
      provider(invoke as unknown as ShellInvoke).speak('hello'),
    ).rejects.toThrow(/voice is chosen/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('says nothing for empty text, and spends no request on it', async () => {
    const invoke = vi.fn();
    await provider(invoke as unknown as ShellInvoke).speak('   ', { voiceId: 'abc' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('plays the synthesised audio and reports when it is finished', async () => {
    const tts = provider(ok);
    const speaking = tts.speak('hello', { voiceId: 'abc', rate: 1.2 });

    // Let the invoke resolve so the element exists.
    await vi.waitFor(() => expect(FakeAudio.last).not.toBeNull());
    expect(tts.speaking).toBe(true);
    expect(FakeAudio.last?.playbackRate).toBe(1.2);

    FakeAudio.last?.finish();
    await speaking;
    expect(tts.speaking).toBe(false);
    // The blob URL is released rather than leaked for the life of the window.
    expect(revoked).toEqual([FakeAudio.last?.src]);
  });

  it('rejects when the audio cannot be played', async () => {
    const tts = provider(ok);
    const speaking = tts.speak('hello', { voiceId: 'abc' });
    await vi.waitFor(() => expect(FakeAudio.last).not.toBeNull());

    FakeAudio.last?.fail();
    await expect(speaking).rejects.toThrow(/could not be played/i);
    expect(tts.speaking).toBe(false);
  });

  /**
   * Synthesis takes a network round trip, and the user can interrupt during
   * it. Playing the reply afterwards would mean Havoc talking over whatever
   * interrupted it - the one thing `cancel` exists to prevent.
   */
  it('does not play a reply that was cancelled while it was being synthesised', async () => {
    let release = (_: string) => {};
    const invoke = (async () =>
      new Promise<string>((resolve) => {
        release = resolve;
      })) as unknown as ShellInvoke;

    const tts = provider(invoke);
    const speaking = tts.speak('hello', { voiceId: 'abc' });

    tts.cancel();
    release('TWFu');
    await speaking;

    expect(FakeAudio.last).toBeNull();
    expect(tts.speaking).toBe(false);
  });

  it('stops audio that is already playing', async () => {
    const tts = provider(ok);
    void tts.speak('hello', { voiceId: 'abc' }).catch(() => undefined);
    await vi.waitFor(() => expect(FakeAudio.last).not.toBeNull());

    const playing = FakeAudio.last;
    tts.cancel();
    expect(playing?.paused).toBe(true);
    expect(tts.speaking).toBe(false);
  });

  it('refuses without the shell instead of failing silently', async () => {
    withAudioGlobals();
    await expect(
      new ElevenLabsTextToSpeech().speak('hello', { voiceId: 'abc' }),
    ).rejects.toThrow(/desktop app/i);
  });
});
