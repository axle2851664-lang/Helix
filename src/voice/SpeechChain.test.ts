import { describe, expect, it, vi } from 'vitest';
import { SpeechChain } from './SpeechChain.js';
import type {
  ProviderAvailability,
  SpeechRecognitionError,
  SpeechToTextProvider,
} from './types.js';

interface FakeOptions {
  id: string;
  processing?: 'on-device' | 'remote';
  available?: ProviderAvailability;
  requiresNetwork?: boolean;
  /** What happens when it is asked to listen. */
  behaviour?: 'transcribe' | 'fail' | 'silence' | 'deny' | 'throw';
  failCode?: string;
}

function fake(options: FakeOptions): SpeechToTextProvider & { started: boolean } {
  const behaviour = options.behaviour ?? 'transcribe';

  return {
    started: false,
    id: options.id,
    name: options.id,
    processing: options.processing ?? 'on-device',
    requiresNetwork: options.requiresNetwork ?? false,
    listening: false,
    isAvailable: () => options.available ?? { available: true },
    stop: () => {},
    async start(handlers) {
      (this as { started: boolean }).started = true;

      if (behaviour === 'throw') throw new Error(`${options.id} would not start`);

      if (behaviour === 'transcribe') {
        handlers.onResult({ transcript: `from ${options.id}`, isFinal: true, confidence: null });
      } else if (behaviour === 'fail') {
        handlers.onError({
          code: options.failCode ?? 'transcription-failed',
          message: `${options.id} could not transcribe`,
        });
      } else if (behaviour === 'silence') {
        handlers.onError({ code: 'no-speech', message: 'I did not hear anything.' });
      } else if (behaviour === 'deny') {
        handlers.onError({ code: 'not-allowed', message: 'The microphone was refused.' });
      }
      handlers.onEnd();
    },
  };
}

const collect = () => {
  const results: string[] = [];
  const errors: SpeechRecognitionError[] = [];
  let ends = 0;

  return {
    results,
    errors,
    get ends() {
      return ends;
    },
    handlers: {
      onResult: (r: { transcript: string }) => results.push(r.transcript),
      onError: (e: SpeechRecognitionError) => errors.push(e),
      onEnd: () => {
        ends += 1;
      },
    },
  };
};

describe('SpeechChain', () => {
  it('uses the first provider when it works', async () => {
    const local = fake({ id: 'local' });
    const remote = fake({ id: 'remote', processing: 'remote' });
    const sink = collect();

    await new SpeechChain({ providers: [local, remote] }).start(sink.handlers);

    expect(sink.results).toEqual(['from local']);
    expect(remote.started).toBe(false);
  });

  it('falls back when the first fails recoverably', async () => {
    const local = fake({ id: 'local', behaviour: 'fail' });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(sink.results).toEqual(['from backup']);
    expect(sink.errors).toEqual([]);
  });

  /**
   * The rule this file exists for. Falling back from Whisper to browser speech
   * moves the user's voice from this machine to Google. Doing that quietly
   * because the first provider had a bad moment is the worst thing the chain
   * could do.
   */
  it('will not fall back to a remote provider unless allowed', async () => {
    const local = fake({ id: 'local', behaviour: 'fail' });
    const google = fake({ id: 'google', processing: 'remote' });
    const sink = collect();

    await new SpeechChain({ providers: [local, google] }).start(sink.handlers);

    expect(google.started).toBe(false);
    expect(sink.errors[0]?.code).toBe('transcription-failed');
  });

  it('does fall back to a remote provider once allowed', async () => {
    const local = fake({ id: 'local', behaviour: 'fail' });
    const google = fake({ id: 'google', processing: 'remote' });
    const sink = collect();

    await new SpeechChain({
      providers: [local, google],
      allowRemoteFallback: true,
    }).start(sink.handlers);

    expect(sink.results).toEqual(['from google']);
  });

  it('announces the fallback rather than making it silently', async () => {
    const onProviderChange = vi.fn();
    const local = fake({ id: 'local', behaviour: 'fail' });
    const google = fake({ id: 'google', processing: 'remote' });

    await new SpeechChain({
      providers: [local, google],
      allowRemoteFallback: true,
      onProviderChange,
    }).start(collect().handlers);

    expect(onProviderChange).toHaveBeenCalledTimes(2);
    expect(onProviderChange.mock.calls[1]?.[0]).toMatchObject({
      escalatesPrivacy: true,
      fellBackBecause: 'local could not transcribe',
    });
  });

  // Silence is a correct answer. Retrying it elsewhere would ship silence to a
  // third party for nothing.
  it('does not fall back when the user simply said nothing', async () => {
    const local = fake({ id: 'local', behaviour: 'silence' });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(backup.started).toBe(false);
    expect(sink.errors[0]?.code).toBe('no-speech');
  });

  // A denied microphone is denied for every provider.
  it('does not fall back when the microphone was refused', async () => {
    const local = fake({ id: 'local', behaviour: 'deny' });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(backup.started).toBe(false);
    expect(sink.errors[0]?.code).toBe('not-allowed');
  });

  it('falls back when the first provider will not start at all', async () => {
    const local = fake({ id: 'local', behaviour: 'throw' });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(sink.results).toEqual(['from backup']);
  });

  it('skips a provider that says it cannot run', async () => {
    const local = fake({
      id: 'local',
      available: { available: false, reason: 'No model installed.' },
    });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(sink.results).toEqual(['from backup']);
    expect(local.started).toBe(false);
  });

  /**
   * The turn must end once. Firing it between providers would end the turn
   * before the second transcript arrived, and the UI would have given up.
   */
  it('ends the turn once, not once per provider', async () => {
    const local = fake({ id: 'local', behaviour: 'fail' });
    const backup = fake({ id: 'backup' });
    const sink = collect();

    await new SpeechChain({ providers: [local, backup] }).start(sink.handlers);

    expect(sink.ends).toBe(1);
  });

  describe('what it reports about itself', () => {
    // Saying "on-device" while a remote fallback is armed would be true only
    // until the moment it stopped being true.
    it('does not claim to be on-device when a remote fallback is armed', () => {
      const chain = new SpeechChain({
        providers: [fake({ id: 'local' }), fake({ id: 'google', processing: 'remote' })],
        allowRemoteFallback: true,
      });

      expect(chain.processing).toBe('unknown');
    });

    it('claims on-device when the remote fallback is not allowed', () => {
      const chain = new SpeechChain({
        providers: [fake({ id: 'local' }), fake({ id: 'google', processing: 'remote' })],
      });

      expect(chain.processing).toBe('on-device');
      expect(chain.usable.map((p) => p.id)).toEqual(['local']);
    });

    it('needs the network only if everything usable does', () => {
      const mixed = new SpeechChain({
        providers: [fake({ id: 'local' }), fake({ id: 'google', processing: 'remote', requiresNetwork: true })],
        allowRemoteFallback: true,
      });
      expect(mixed.requiresNetwork).toBe(false);

      const allRemote = new SpeechChain({
        providers: [fake({ id: 'google', processing: 'remote', requiresNetwork: true })],
      });
      expect(allRemote.requiresNetwork).toBe(true);
    });

    it('names both providers when both may be used', () => {
      const chain = new SpeechChain({
        providers: [fake({ id: 'Whisper' }), fake({ id: 'Browser', processing: 'remote' })],
        allowRemoteFallback: true,
      });

      expect(chain.name).toBe('Whisper, falling back to Browser');
    });

    // The specific thing the user would have to fix, not a generic message.
    it('reports the first provider reason when nothing can run', () => {
      const chain = new SpeechChain({
        providers: [
          fake({ id: 'local', available: { available: false, reason: 'Run npm run fetch:models.' } }),
        ],
      });

      expect(chain.isAvailable()).toEqual({
        available: false,
        reason: 'Run npm run fetch:models.',
      });
    });

    it('handles an empty chain', async () => {
      const chain = new SpeechChain({ providers: [] });

      expect(chain.isAvailable().available).toBe(false);
      await expect(chain.start(collect().handlers)).rejects.toThrow();
    });
  });
});
