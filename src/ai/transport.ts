import type { InferenceTransport } from './types.js';

/**
 * How an inference request leaves the machine, and why it usually cannot.
 *
 * This is the file where "the API key never reaches the browser" stops being a
 * promise and becomes a fact about the code. A provider cannot call `fetch`;
 * it can only ask a transport, and the browser transport has no key to give it
 * and no permission to reach anything.
 *
 * Two hosts, three honest answers:
 *
 * - **Browser, cloud provider.** Refused, permanently. Anything the page holds
 *   as a credential is readable by everything else in the page, so a key
 *   pasted into a web build is a leaked key. No arrangement fixes that, and it
 *   is not a missing feature to be added later.
 *
 * - **Browser, local provider.** Allowed. This was refused too until it was
 *   looked at properly, and the refusal was wrong: it applied a rule about
 *   credentials to a server that has none. Ollama listens on loopback, wants
 *   no key, and is not an outside origin - it is the same machine, reached
 *   over a socket instead of a function call. The reason to keep a key out of
 *   the page does not arise where there is no key, and the reason to keep the
 *   page off the network does not arise where the request never leaves the
 *   machine.
 *
 *   The permission is deliberately narrow: one fixed origin, and only for a
 *   provider named local below. It is not a general opening of the page to the
 *   network, and the content policy still forbids everything else.
 *
 * - **Desktop shell.** The request is made in Rust. The key is read from the
 *   environment there and never crosses into the web view, so the page can
 *   trigger a request without ever being able to see what authorised it. This
 *   remains the only way a cloud provider is reachable at all.
 */

/**
 * Where a local model server listens.
 *
 * Loopback, and fixed rather than configurable. A configurable origin here
 * would be a setting whose wrong value turns the browser build into something
 * that posts the user's conversation to an arbitrary host, which is the exact
 * outcome the rest of this file exists to prevent.
 *
 * The content policy in `index.html` names the same origin and must agree with
 * this. Changing one without the other produces a blocked request and a
 * confusing error rather than a working feature, so a test asserts they match.
 */
export const LOCAL_INFERENCE_ORIGIN = 'http://127.0.0.1:11434';

/** Providers that run on this machine and need no credential. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

export interface BrowserInferenceTransportOptions {
  /** Injected in tests. Production always uses the real thing. */
  fetch?: typeof globalThis.fetch;
}

/** The browser build's transport: local inference, and nothing else. */
export class BrowserInferenceTransport implements InferenceTransport {
  readonly id = 'browser';
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: BrowserInferenceTransportOptions = {}) {
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  unavailableReason(providerId?: string): string | null {
    if (providerId !== undefined && LOCAL_PROVIDERS.has(providerId)) return null;

    return 'This is a web build. A key held in the page would be readable by everything in the page, so cloud inference needs the desktop shell. Local models on this machine work here.';
  }

  /**
   * Always false, and deliberately not "not yet".
   *
   * Unchanged by the loopback permission above, and the two must not be
   * confused: the browser may reach a local server precisely because that
   * server needs no credential. It still holds none, for anyone.
   */
  hasCredential(): boolean {
    return false;
  }

  async request(options: {
    providerId: string;
    path: string;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const refusal = this.unavailableReason(options.providerId);
    if (refusal !== null) throw new Error(refusal);

    let response: Response;
    try {
      response = await this.#fetch(`${LOCAL_INFERENCE_ORIGIN}${options.path}`, {
        method: options.body === null ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(options.body === null ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // A refused connection and a blocked request are indistinguishable from
      // here, and they have different fixes, so both are named rather than one
      // being guessed at.
      throw new Error(
        `I could not reach the local AI service at ${LOCAL_INFERENCE_ORIGIN}. Either it is not running, or this page is not permitted to reach it.`,
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new Error(
        `The local AI service answered with ${response.status} ${response.statusText}.`,
      );
    }

    return response.json();
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
