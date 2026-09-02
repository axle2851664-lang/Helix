import type { WebTransport } from './types.js';

/**
 * How a web request leaves the machine, or does not.
 *
 * The same two-host arrangement as inference and Google, and the reason is the
 * content policy rather than a credential this time: the page ships with
 * `connect-src 'self' blob: http://127.0.0.1:11434`, so the browser refuses
 * every request to an outside origin whether or not Helix wants to make one.
 * That is deliberate and it is why no key can leak from the web build.
 *
 * The shell has no such restriction, which is exactly why `web.rs` spends most
 * of its length deciding where a request may go.
 */

/** Refuses, and says why. Nothing about this is a missing feature. */
export class BrowserWebTransport implements WebTransport {
  unavailableReason(): string {
    return "This build is a web page with a content policy of connect-src 'self', so the browser refuses every request to an outside origin. Searching the web needs the desktop shell.";
  }

  async fetch(): Promise<{ url: string; status: number; body: string }> {
    throw new Error(this.unavailableReason());
  }
}

interface TauriInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/**
 * Goes through Rust, where the address checks live.
 *
 * Deliberately thin: it adds no validation of its own, because a check written
 * here would run in the web view and could be walked around by anything that
 * could call the command directly. The guards belong on the far side of the
 * boundary, and duplicating them here would suggest otherwise.
 */
export class TauriWebTransport implements WebTransport {
  readonly #invoke: TauriInvoke;
  /** Hosts the shell holds a key for. Host names only, never the keys. */
  #keyed = new Set<string>();

  constructor(options: { invoke: TauriInvoke }) {
    this.#invoke = options.invoke;
  }

  /**
   * Ask the shell which keyed providers are configured.
   *
   * The answer is a list of host names. The keys themselves stay in the
   * shell's environment and are attached to the request there, so the page can
   * know that Brave is usable without ever holding the means to use it
   * elsewhere.
   */
  async refreshKeys(): Promise<string[]> {
    try {
      const hosts = await this.#invoke<string[]>('configured_web_providers');
      this.#keyed = new Set(Array.isArray(hosts) ? hosts : []);
    } catch {
      this.#keyed = new Set();
    }
    return [...this.#keyed];
  }

  hasKeyFor(host: string): boolean {
    return this.#keyed.has(host);
  }

  unavailableReason(): null {
    return null;
  }

  async fetch(url: string): Promise<{ url: string; status: number; body: string }> {
    const response = await this.#invoke<{
      url: string;
      status: number;
      body: string;
      truncated: boolean;
    }>('web_fetch', { url });

    return { url: response.url, status: response.status, body: response.body };
  }
}
