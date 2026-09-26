import { describe, expect, it } from 'vitest';
import { OllamaProvider } from './OllamaProvider.js';
import type { InferenceTransport, StreamEvent } from './types.js';

/**
 * Words arriving as they are generated.
 *
 * The reply takes exactly as long either way. What changes is that the first
 * words appear in about a second instead of after the whole thing, which on a
 * CPU is the difference between a machine that is visibly working and one
 * that appears to have hung.
 */

function streamingTransport(events: StreamEvent[]) {
  const sent: unknown[] = [];
  const transport = {
    id: 'tauri',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async () => ({ message: { content: 'whole reply' } }),
    streamChat: async (options: { body: unknown; onEvent: (event: StreamEvent) => void }) => {
      sent.push(options.body);
      for (const event of events) options.onEvent(event);
    },
  } as unknown as InferenceTransport;

  return { sent, provider: new OllamaProvider({ transport }) };
}

describe('streaming a reply', () => {
  it('hands over each piece as it arrives, in order', async () => {
    const { provider } = streamingTransport([
      { kind: 'chunk', text: 'Good ' },
      { kind: 'chunk', text: 'evening, ' },
      { kind: 'chunk', text: 'sir.' },
      { kind: 'done', model: 'qwen2.5:3b' },
    ]);

    const pieces: string[] = [];
    const result = await provider.stream({ model: 'qwen2.5:3b', messages: [] }, (text) =>
      pieces.push(text),
    );

    expect(pieces).toEqual(['Good ', 'evening, ', 'sir.']);
    expect(result.text).toBe('Good evening, sir.');
    expect(result.model).toBe('qwen2.5:3b');
  });

  it('asks the runtime to stream, and to stay loaded', async () => {
    const { sent, provider } = streamingTransport([{ kind: 'done', model: 'x' }]);
    await provider.stream({ model: 'qwen2.5:3b', messages: [] }, () => {});

    expect((sent[0] as { stream: boolean }).stream).toBe(true);
    expect((sent[0] as { keep_alive: string }).keep_alive).toMatch(/^\d+m$/);
  });

  /**
   * A stream that dies with nothing written is a failure. One that dies
   * part-way has already put real words on screen, so it completes - what
   * must never happen is a truncated answer presented as a finished one.
   */
  it('fails when it dies before any text arrived', async () => {
    const { provider } = streamingTransport([{ kind: 'failed', message: 'the runtime stopped' }]);

    await expect(
      provider.stream({ model: 'qwen2.5:3b', messages: [] }, () => {}),
    ).rejects.toThrow(/runtime stopped/);
  });

  it('keeps the words that did arrive when it dies part-way', async () => {
    const { provider } = streamingTransport([
      { kind: 'chunk', text: 'Good ev' },
      { kind: 'failed', message: 'the runtime stopped' },
    ]);

    const result = await provider.stream({ model: 'qwen2.5:3b', messages: [] }, () => {});
    expect(result.text).toBe('Good ev');
  });
});

describe('a transport that cannot stream', () => {
  /**
   * The browser has no channel to stream over. It must not be made to
   * pretend: one piece, delivered when it actually arrived.
   */
  it('gets the whole reply in one piece rather than a fake stream', async () => {
    const transport = {
      id: 'browser',
      unavailableReason: () => null,
      hasCredential: () => false,
      request: async () => ({ message: { content: 'All at once.' } }),
    } as unknown as InferenceTransport;

    const pieces: string[] = [];
    const result = await new OllamaProvider({ transport }).stream(
      { model: 'qwen2.5:3b', messages: [] },
      (text) => pieces.push(text),
    );

    expect(pieces).toEqual(['All at once.']);
    expect(result.text).toBe('All at once.');
  });
});
