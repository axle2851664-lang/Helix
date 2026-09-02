import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceManager } from './VoiceManager.js';
import { ActivityManager } from '../core/ActivityManager.js';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import type {
  SpeechToTextProvider,
  SpeechVoice,
  TextToSpeechProvider,
} from './types.js';

/** A controllable recogniser, so the pipeline can be driven deterministically. */
class FakeRecognition implements SpeechToTextProvider {
  readonly id = 'fake';
  readonly name = 'Fake recogniser';
  processing = 'remote' as const;
  requiresNetwork = true;

  available = true;
  unavailableReason = 'not available in test';
  failOnStart: string | null = null;
  listening = false;

  #handlers: Parameters<SpeechToTextProvider['start']>[0] | null = null;

  isAvailable() {
    return this.available ? { available: true } : { available: false, reason: this.unavailableReason };
  }

  async start(handlers: Parameters<SpeechToTextProvider['start']>[0]): Promise<void> {
    if (this.failOnStart) throw new Error(this.failOnStart);
    this.#handlers = handlers;
    this.listening = true;
  }

  stop(): void {
    this.listening = false;
    this.#handlers?.onEnd();
    this.#handlers = null;
  }

  /** Test helper: emit a recognition result. */
  emit(transcript: string, isFinal = true): void {
    this.#handlers?.onResult({ transcript, isFinal, confidence: isFinal ? 0.9 : null });
  }

  /** Test helper: emit an error. */
  emitError(code: string, message = 'failed'): void {
    this.#handlers?.onError({ code, message });
  }
}

class FakeSynthesis implements TextToSpeechProvider {
  readonly id = 'fake';
  readonly name = 'Fake voice';
  processing = 'on-device' as const;

  available = true;
  speaking = false;
  spoken: string[] = [];
  cancelled = 0;
  shouldFail = false;

  isAvailable() {
    return this.available ? { available: true } : { available: false, reason: 'no synthesis' };
  }

  /** Overridable, so a machine with no British voice can be simulated. */
  voices: SpeechVoice[] = [{ id: 'v1', name: 'Test', lang: 'en-US' }];
  /** Every options object `speak` was called with, in order. */
  options: Array<{ voiceId?: string; rate?: number }> = [];
  listVoicesCalls = 0;

  async listVoices(): Promise<SpeechVoice[]> {
    this.listVoicesCalls += 1;
    return this.voices;
  }

  async speak(text: string, options: { voiceId?: string; rate?: number } = {}): Promise<void> {
    if (this.shouldFail) throw new Error('synthesis exploded');
    this.speaking = true;
    this.spoken.push(text);
    this.options.push(options);
    this.speaking = false;
  }

  cancel(): void {
    this.cancelled += 1;
    this.speaking = false;
  }
}

async function makeVoice(
  options: {
    stt?: FakeRecognition;
    tts?: FakeSynthesis;
    bus?: EventBus;
    online?: boolean;
    sttSetting?: string;
    ttsSetting?: string;
  } = {},
) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store, logger });
  await settings.load();
  await settings.set('speechToTextProvider', (options.sttSetting ?? 'browser') as never);
  await settings.set('textToSpeechProvider', (options.ttsSetting ?? 'browser') as never);

  const stt = options.stt ?? new FakeRecognition();
  const tts = options.tts ?? new FakeSynthesis();
  const activity = new ActivityManager();

  const voice = new VoiceManager({
    settings,
    logger,
    activity,
    stt,
    tts,
    isOnline: () => options.online ?? true,
    ...(options.bus ? { bus: options.bus } : {}),
  });

  return { voice, stt, tts, settings, activity };
}

describe('VoiceManager: availability', () => {
  it('starts idle', async () => {
    const { voice } = await makeVoice();
    expect(voice.state).toBe('idle');
    expect(voice.snapshot.micLive).toBe(false);
  });

  it('reports no provider configured', async () => {
    const { voice } = await makeVoice({ sttSetting: 'none' });
    expect(voice.inputBlocker()).toContain('No speech provider is configured');
  });

  it('reports an unavailable provider with its reason', async () => {
    const stt = new FakeRecognition();
    stt.available = false;
    stt.unavailableReason = 'This browser has no Web Speech API.';

    const { voice } = await makeVoice({ stt });
    expect(voice.inputBlocker()).toContain('no Web Speech API');
  });

  // A provider that streams audio cannot work offline; starting it only to
  // fail mid-utterance would be worse than refusing up front.
  it('refuses a network provider while offline', async () => {
    const { voice } = await makeVoice({ online: false });
    expect(voice.inputBlocker()).toContain('offline');
  });

  it('refuses a network provider when offline mode is forced', async () => {
    const { voice, settings } = await makeVoice({ online: true });
    await settings.set('offlineMode', 'offline');
    expect(voice.inputBlocker()).toContain('offline mode');
  });

  it('allows an on-device provider while offline', async () => {
    const stt = new FakeRecognition();
    stt.requiresNetwork = false;
    const { voice } = await makeVoice({ stt, online: false });
    expect(voice.inputBlocker()).toBeNull();
  });

  it('reports where audio is processed', async () => {
    const { voice } = await makeVoice();
    expect(voice.inputProcessing?.location).toBe('remote');
  });

  it('reports when no output provider is configured', async () => {
    const { voice } = await makeVoice({ ttsSetting: 'none' });
    expect(voice.outputBlocker()).toContain('No text-to-speech provider');
  });
});

describe('VoiceManager: listening', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('returns the final transcript', async () => {
    const { voice, stt } = await makeVoice();
    const pending = voice.listen();

    await vi.waitFor(() => expect(voice.state).toBe('listening'));
    stt.emit('open my settings');
    stt.stop();

    expect(await pending).toBe('open my settings');
  });

  it('exposes interim text while the user is still speaking', async () => {
    const { voice, stt } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    stt.emit('open my', false);
    expect(voice.snapshot.transcript).toBe('open my');

    stt.emit('open my settings');
    stt.stop();
    await pending;
  });

  // The indicator must follow the device, not an optimistic UI flag.
  it('emits MICROPHONE_STARTED only once the device is live', async () => {
    const started = vi.fn();
    const stopped = vi.fn();
    bus.on('MICROPHONE_STARTED', started);
    bus.on('MICROPHONE_STOPPED', stopped);

    const { voice, stt } = await makeVoice({ bus });
    expect(started).not.toHaveBeenCalled();

    const pending = voice.listen();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(voice.snapshot.micLive).toBe(true);

    stt.stop();
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
    expect(voice.snapshot.micLive).toBe(false);
  });

  it('does not emit MICROPHONE_STARTED when starting fails', async () => {
    const started = vi.fn();
    bus.on('MICROPHONE_STARTED', started);

    const stt = new FakeRecognition();
    stt.failOnStart = 'Microphone access was denied.';
    const { voice } = await makeVoice({ stt, bus });

    await expect(voice.listen()).rejects.toThrow(HelixError);
    expect(started).not.toHaveBeenCalled();
    expect(voice.snapshot.micLive).toBe(false);
  });

  it('refuses to listen when blocked, with a readable reason', async () => {
    const { voice } = await makeVoice({ sttSetting: 'none' });

    await expect(voice.listen()).rejects.toThrow('No speech provider is configured');
    expect(voice.state).toBe('idle');
  });

  it('surfaces a permission error in a readable form', async () => {
    const stt = new FakeRecognition();
    stt.failOnStart = 'Microphone access was denied.';
    const { voice } = await makeVoice({ stt });

    await expect(voice.listen()).rejects.toThrow('Microphone access was denied.');
    expect(voice.state).toBe('error');
    expect(voice.snapshot.error).toContain('denied');
  });

  // Hearing nothing is an ordinary outcome, not an error to alarm the user with.
  it('treats no-speech as an ordinary empty result', async () => {
    const { voice, stt } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    stt.emitError('no-speech');
    stt.stop();

    expect(await pending).toBe('');
    expect(voice.snapshot.error).toBeNull();
  });

  it('reports a genuine recognition error', async () => {
    const { voice, stt } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    stt.emitError('network', 'Speech recognition needs a network connection.');
    stt.stop();
    await pending;

    expect(voice.snapshot.error).toContain('network connection');
  });

  it('ignores a second listen while already listening', async () => {
    const { voice, stt } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    expect(await voice.listen()).toBe('');
    stt.stop();
    await pending;
  });

  it('tracks listening as a real activity', async () => {
    const { voice, stt, activity } = await makeVoice();
    const pending = voice.listen();

    await vi.waitFor(() => expect(activity.current.kind).toBe('listening'));
    stt.stop();
    await pending;

    expect(activity.isBusy).toBe(false);
  });
});

describe('VoiceManager: speaking and interruption', () => {
  it('speaks a response', async () => {
    const { voice, tts } = await makeVoice();
    await voice.speak('Opening settings.');
    expect(tts.spoken).toEqual(['Opening settings.']);
  });

  it('stays silent when no output provider is configured', async () => {
    const { voice, tts } = await makeVoice({ ttsSetting: 'none' });
    await voice.speak('Opening settings.');
    expect(tts.spoken).toEqual([]);
  });

  /**
   * The bug this whole group of tests was missing.
   *
   * `selectVoice.ts` ranked British male voices, had its own test file, and
   * was called by nothing. `speak` passed a rate and no voice, so every reply
   * came out in the browser default - on Windows, an American one. The
   * ranking was correct and wired to nothing, which no test noticed because
   * every test asserted only the words.
   */
  it('speaks with a chosen voice rather than the default', async () => {
    const tts = new FakeSynthesis();
    tts.voices = [
      { id: 'us', name: 'Microsoft David', lang: 'en-US' },
      { id: 'gb', name: 'Microsoft Ryan', lang: 'en-GB' },
    ];
    const { voice } = await makeVoice({ tts });

    await voice.speak('Good evening.');

    expect(tts.options[0]?.voiceId).toBe('gb');
  });

  it('lets an explicit choice override the ranking', async () => {
    const tts = new FakeSynthesis();
    tts.voices = [
      { id: 'us', name: 'Microsoft David', lang: 'en-US' },
      { id: 'gb', name: 'Microsoft Ryan', lang: 'en-GB' },
    ];
    const { voice, settings } = await makeVoice({ tts });
    await settings.set('voiceId', 'us');

    await voice.speak('Good evening.');

    expect(tts.options[0]?.voiceId).toBe('us');
  });

  // A voice can be uninstalled between sessions. Falling back to the ranking
  // is better than asking for an id that is no longer there.
  it('falls back when the chosen voice is no longer installed', async () => {
    const tts = new FakeSynthesis();
    tts.voices = [{ id: 'gb', name: 'Microsoft Ryan', lang: 'en-GB' }];
    const { voice, settings } = await makeVoice({ tts });
    await settings.set('voiceId', 'a-voice-that-was-removed');

    await voice.speak('Good evening.');

    expect(tts.options[0]?.voiceId).toBe('gb');
  });

  // `listVoices` waits on an event that can take a second; paying that per
  // sentence would put a pause in the middle of a conversation.
  it('resolves the voice once rather than on every sentence', async () => {
    const { voice, tts } = await makeVoice();

    await voice.speak('One.');
    await voice.speak('Two.');
    await voice.speak('Three.');

    expect(tts.listVoicesCalls).toBe(1);
  });

  /**
   * The machine this was written on has three voices installed, all American.
   * Saying "Using Microsoft David (British English)" there would be a claim
   * about something the user can hear is untrue.
   */
  it('does not claim a British voice on a machine that has none', async () => {
    const tts = new FakeSynthesis();
    tts.voices = [{ id: 'us', name: 'Microsoft David', lang: 'en-US' }];
    const { voice } = await makeVoice({ tts });

    const description = await voice.describeVoice();

    expect(description).toContain('No British English voice is installed');
    expect(description).toContain('Microsoft David');
  });

  // Spec 9: the user must be able to interrupt Helix.
  it('stopSpeaking cancels synthesis', async () => {
    const { voice, tts } = await makeVoice();
    voice.stopSpeaking();
    expect(tts.cancelled).toBeGreaterThan(0);
  });

  it('starting to listen interrupts speech in progress', async () => {
    const { voice, stt, tts } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    expect(tts.cancelled).toBeGreaterThan(0);
    stt.stop();
    await pending;
  });

  it('a synthesis failure does not throw at the caller', async () => {
    const tts = new FakeSynthesis();
    tts.shouldFail = true;
    const { voice } = await makeVoice({ tts });

    await expect(voice.speak('hello')).resolves.toBeUndefined();
    expect(voice.snapshot.error).toContain('shown above');
  });

  it('returns to idle after speaking', async () => {
    const { voice } = await makeVoice();
    await voice.speak('done');
    expect(voice.state).toBe('idle');
  });
});

describe('VoiceManager: state and shutdown', () => {
  it('notifies subscribers of state changes', async () => {
    const { voice, stt } = await makeVoice();
    const listener = vi.fn();
    voice.subscribe(listener);

    const pending = voice.listen();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    stt.stop();
    await pending;
  });

  it('a throwing listener cannot disturb the pipeline', async () => {
    const { voice, stt } = await makeVoice();
    voice.subscribe(() => {
      throw new Error('listener exploded');
    });

    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));
    stt.stop();
    expect(await pending).toBe('');
  });

  it('tracks the processing phase', async () => {
    const { voice } = await makeVoice();
    voice.beginProcessing();
    expect(voice.state).toBe('processing');
    voice.endProcessing();
    expect(voice.state).toBe('idle');
  });

  it('shutdown releases the microphone and stops speech', async () => {
    const { voice, stt, tts } = await makeVoice();
    const pending = voice.listen();
    await vi.waitFor(() => expect(voice.state).toBe('listening'));

    voice.shutdown();
    await pending;

    expect(stt.listening).toBe(false);
    expect(tts.cancelled).toBeGreaterThan(0);
    expect(voice.state).toBe('idle');
  });
});
