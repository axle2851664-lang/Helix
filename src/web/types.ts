/**
 * Looking things up on the live web.
 *
 * The rule that governs everything in this directory: **what comes back is
 * evidence, not instruction, and never Helix's own words.** A search result is
 * text written by a stranger. It gets attributed, it gets scanned, and it
 * never reaches a model as though Helix had said it.
 *
 * The second rule is that nothing here invents. A provider that cannot answer
 * says so; it does not return a plausible summary. This is the same line the
 * whole project has held about inference and mail, and it matters more here
 * than anywhere else, because a fabricated search result looks exactly like a
 * real one and arrives precisely when the user cannot check it themselves.
 */

/** One thing found, always attributed. */
export interface SearchResult {
  title: string;
  /** Where it came from. Required - an unattributed result is a rumour. */
  url: string;
  /** The provider's own words about it, never Helix's. */
  snippet: string;
  /** Which provider produced it, so a summary can say where it looked. */
  provider: string;
}

/** Why a provider could not answer. Never blended into "no results". */
export interface ProviderFailure {
  provider: string;
  reason: string;
}

export interface SearchOutcome {
  results: readonly SearchResult[];
  /** Providers that were asked and could not answer, with reasons. */
  failures: readonly ProviderFailure[];
  /** Providers that answered, whether or not they found anything. */
  answered: readonly string[];
}

/**
 * How a request leaves the machine.
 *
 * The same shape as the inference and Google transports and for the same
 * reason: a provider never calls `fetch` itself, so the browser build cannot
 * quietly acquire network reach through this directory.
 */
export interface WebTransport {
  /** Why the web cannot be reached from this host, or null when it can. */
  unavailableReason(): string | null;
  /** Fetch a URL, returning the body as text. */
  fetch(url: string): Promise<{ url: string; status: number; body: string }>;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly name: string;
  /**
   * What this provider is actually good for.
   *
   * Present because the honest answer differs sharply between them, and a
   * user told only "no results" learns nothing. Wikipedia does not know
   * yesterday's news; a keyless instant-answer endpoint is blank for most
   * queries. Saying so is the difference between a limit and a bug.
   */
  readonly covers: string;
  /** Null when usable, a reason when not - a missing key, for instance. */
  unavailableReason(): string | null;
  search(query: string, limit: number): Promise<readonly SearchResult[]>;
}
