import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TauriInferenceTransport } from './transport.js';

/**
 * The shape of the arguments crossing into Rust.
 *
 * This is where local inference was broken in the desktop shell, and it cost
 * days. The Rust command is `inference_request(request: InferenceRequest)` -
 * one parameter, named `request` - and Tauri matches arguments by parameter
 * name. The front end sent `{ provider, path, body }` flat, so every call
 * failed at the argument boundary without reaching Ollama, and the provider
 * reported it as "I'm unable to reach the local AI service".
 *
 * Every symptom pointed at Ollama. Ollama was running the whole time.
 *
 * The browser build was unaffected, because it calls fetch directly and never
 * crosses this boundary - so the bug was invisible to every test and every
 * browser check, which is precisely why it needs one here.
 */

const rustSource = () =>
  readFileSync(
    new URL('../../src-tauri/src/inference.rs', import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      '$1',
    ),
    'utf8',
  );

function capturing() {
  const calls: Array<{ command: string; args: unknown }> = [];
  const invoke = (async (command: string, args: unknown) => {
    calls.push({ command, args });
    return { models: [] };
  }) as never;

  return {
    calls,
    transport: new TauriInferenceTransport({ invoke, configuredProviders: ['ollama'] }),
  };
}

describe('arguments handed to the shell', () => {
  it('nests them under the parameter name the Rust command declares', async () => {
    const { calls, transport } = capturing();
    await transport.request({ providerId: 'ollama', path: '/api/tags', body: null });

    expect(calls[0]?.command).toBe('inference_request');
    expect(calls[0]?.args).toEqual({
      request: { provider: 'ollama', path: '/api/tags', body: null },
    });
  });

  it('does not send them flat, which is what silently broke it', async () => {
    const { calls, transport } = capturing();
    await transport.request({ providerId: 'ollama', path: '/api/tags', body: null });

    expect(Object.keys(calls[0]?.args as object)).toEqual(['request']);
  });

  /**
   * Read from the Rust source, so a rename on that side fails here rather
   * than at runtime in front of somebody.
   */
  it('matches the parameter name in inference.rs', () => {
    const signature = /pub async fn inference_request\(\s*([a-z_]+)\s*:/.exec(rustSource());

    expect(signature?.[1]).toBe('request');
  });

  it('carries a body through unchanged when there is one', async () => {
    const { calls, transport } = capturing();
    const body = { model: 'qwen2.5:7b', messages: [] };
    await transport.request({ providerId: 'ollama', path: '/api/chat', body });

    expect((calls[0]?.args as { request: { body: unknown } }).request.body).toEqual(body);
  });
});

describe('failures coming back from the shell', () => {
  /**
   * Tauri rejects with a plain value. An unwrapped rejection loses its
   * message to every `instanceof Error` check between here and the screen,
   * which is how the real reason stayed hidden.
   */
  it('turns a string rejection into an Error that keeps its message', async () => {
    const invoke = (async () => {
      throw 'ollama inference is not configured.';
    }) as never;
    const transport = new TauriInferenceTransport({ invoke, configuredProviders: ['ollama'] });

    await expect(
      transport.request({ providerId: 'ollama', path: '/api/tags', body: null }),
    ).rejects.toThrow(/not configured/);
  });

  it('keeps the message from an object rejection too', async () => {
    const invoke = (async () => {
      throw { message: 'Refused an unexpected inference path: /nope' };
    }) as never;
    const transport = new TauriInferenceTransport({ invoke, configuredProviders: ['ollama'] });

    await expect(
      transport.request({ providerId: 'ollama', path: '/api/tags', body: null }),
    ).rejects.toThrow(/unexpected inference path/);
  });

  it('never throws a non-Error, whatever came back', async () => {
    const invoke = (async () => {
      throw undefined;
    }) as never;
    const transport = new TauriInferenceTransport({ invoke, configuredProviders: ['ollama'] });

    await expect(
      transport.request({ providerId: 'ollama', path: '/api/tags', body: null }),
    ).rejects.toBeInstanceOf(Error);
  });
});
