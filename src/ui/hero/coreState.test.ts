import { describe, expect, it } from 'vitest';
import { coreStateFor, coreStateLabel, type CoreInputs } from './coreState.js';
import type { CoreState } from './Core.js';

const at = (over: Partial<CoreInputs> = {}): CoreInputs => ({
  activity: 'standing-by',
  voice: 'idle',
  awaitingConsent: false,
  ...over,
});

describe('what the core shows', () => {
  it('shows nothing happening when nothing is happening', () => {
    expect(coreStateFor(at())).toBe('idle');
  });

  /**
   * "Completed" is a finished thing. A core still lit for it reads as one
   * still running, which is the same lie as a progress bar that never ends.
   */
  it('treats a finished activity as finished', () => {
    expect(coreStateFor(at({ activity: 'completed' }))).toBe('idle');
  });

  it('follows the audio path while it is live', () => {
    expect(coreStateFor(at({ voice: 'listening', activity: 'listening' }))).toBe('listening');
    expect(coreStateFor(at({ voice: 'speaking', activity: 'speaking' }))).toBe('speaking');
  });

  /**
   * The distinction that matters most on this screen. One of these has
   * already started changing things and the other has not, and a screen that
   * shows the same glow for both is telling the user they are the same.
   */
  it('never blurs thinking into executing', () => {
    expect(coreStateFor(at({ activity: 'thinking' }))).toBe('thinking');

    for (const doing of ['searching', 'opening-project', 'loading-model', 'analyzing-image', 'generating'] as const) {
      expect(coreStateFor(at({ activity: doing })), doing).toBe('executing');
    }
  });

  it('counts the voice pipeline thinking as thinking', () => {
    expect(coreStateFor(at({ voice: 'processing' }))).toBe('thinking');
  });

  it('shows a failure from either side', () => {
    expect(coreStateFor(at({ voice: 'error' }))).toBe('error');
    expect(coreStateFor(at({ activity: 'failed' }))).toBe('error');
  });

  /**
   * A failure must not be painted over by whatever happened to be running
   * when it landed. It is the state the user most needs to see.
   */
  it('does not let a running activity hide a voice failure', () => {
    expect(coreStateFor(at({ voice: 'error', activity: 'generating' }))).toBe('error');
  });

  /**
   * Havoc has stopped and will not continue by itself. Showing "thinking"
   * here would tell the user to wait for something that is waiting for them.
   */
  it('puts a pending question above everything else', () => {
    expect(coreStateFor(at({ awaitingConsent: true }))).toBe('awaiting');
    expect(coreStateFor(at({ awaitingConsent: true, activity: 'generating' }))).toBe('awaiting');
    expect(coreStateFor(at({ awaitingConsent: true, voice: 'error' }))).toBe('awaiting');
  });
});

describe('the word under the core', () => {
  it('says nothing when there is nothing to say', () => {
    expect(coreStateLabel('idle')).toBeNull();
  });

  /**
   * Brightness and rhythm must never be the only signal. Every state that is
   * not "nothing is happening" carries a word, for the same reason the old
   * capability ring carried its reasons in text.
   */
  it('gives every other state a word', () => {
    const states: CoreState[] = ['listening', 'thinking', 'executing', 'speaking', 'awaiting', 'error'];
    for (const state of states) {
      const label = coreStateLabel(state);
      expect(label, state).not.toBeNull();
      expect((label ?? '').length, state).toBeGreaterThan(2);
    }
  });

  it('gives thinking and executing different words', () => {
    expect(coreStateLabel('thinking')).not.toBe(coreStateLabel('executing'));
  });

  // The failure word must not read as an invitation to wait.
  it('does not describe a failure as work in progress', () => {
    expect((coreStateLabel('error') ?? '').toLowerCase()).not.toMatch(/ing\b/);
  });
});
