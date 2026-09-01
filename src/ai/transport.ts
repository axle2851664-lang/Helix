import type { InferenceTransport } from './types.js';

/**
 * How an inference request leaves the machine, and why it usually cannot.
 *
 * This is the file where "the API key never reaches the browser" stops being a
 * promise and becomes a fact about the code. A provider cannot call `fetch`;
 * it can only ask a transport, and the browser transport has no key to give it
 * and no permission to reach anything.
 *
 * Two hosts, two honest answers:
 *
 * - **Browser.** Refuses, for two independent reasons either of which is
 *   sufficient. The content policy forbids reaching an outside origin, and
 *   anything the page could hold as a credential is readable by everything
 *   else in the page. A key pasted into a web build is a leaked key.
 *
 * - **Desktop shell.** The request is made in Rust. The key is read from the
 *   environment there and never crosses into the web view, so the page can
 *   trigger a request without ever being able to see what authorised it.
 */

/** Refuses everything, and says why. The browser build gets this one. */
export class BrowserInferenceTransport implements InferenceTransport {
  readonly id = 'browser';

  unavailableReason(): string {
    return "This is a web build: its content policy forbids reaching any outside origin, and a key held in the page would be readable by everything in the page. Inference needs the desktop shell.";
  }

  /**
   * Always false, and deliberately not "not yet".
   *
   * There is no arrangement in which a browser build should hold an inference
   * credential, so this is not a missing feature to be added later.
   */
  hasCredential(): boolean {
    return false;
  }

  async request(): Promise<unknown> {
    throw new Error(this.unavailableReason());
  }
}

/** The shape the shell exposes. Kept narrow deliberately. */
interface TauriInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface TauriInferenceTransportOptions {
  invoke: TauriInvoke;
  /**
   * Which providers the shell reports a key for. Ids only - the values stay
   * in Rust and are never sent to the web view, not even to be counted.
   */
  configuredProviders?: readonly string[];
}

/**
 * Makes the request in Rust.
 *
 * The web view sends a provider id, a path and a body. It never sends a
 * credential, because it never has one: the shell attaches the key on its side
 * of the boundary, immediately before the request goes out.
 */
export class TauriInferenceTransport implements InferenceTransport {
  readonly id = 'tauri';

  readonly #invoke: TauriInvoke;
  #configured: Set<string>;

  constructor(options: TauriInferenceTransportOptions) {
    this.#invoke = options.invoke;
    this.#configured = new Set(options.configuredProviders ?? []);
  }

  /** Ask the shell which providers it holds a key for. Ids, never values. */
  async refreshCredentials(): Promise<string[]> {
    try {
      const ids = await this.#invoke<string[]>('configured_inference_providers');
      this.#configured = new Set(Array.isArray(ids) ? ids : []);
    } catch {
      this.#configured = new Set();
    }
    return [...this.#configured];
  }

  unavailableReason(): null {
    return null;
  }

  hasCredential(providerId: string): boolean {
    return this.#configured.has(providerId);
  }

  async request(options: {
    providerId: string;
    path: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (!this.hasCredential(options.providerId)) {
      throw new Error(`${options.providerId} inference is not configured.`);
    }

    return this.#invoke<unknown>('inference_request', {
      provider: options.providerId,
      path: options.path,
      body: options.body,
    });
  }
}
