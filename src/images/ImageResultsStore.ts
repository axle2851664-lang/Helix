import type { ImageSearchOutcome } from './types.js';

/**
 * The most recent image search, held where several screens can see it.
 *
 * The search panel shows a grid of it and the spatial stage places cards from
 * it, and neither owns it: a result found in the panel has to be reachable
 * from the stage without searching again, because searching again spends
 * somebody's quota to fetch what is already in hand.
 *
 * Only the latest search is kept. A history of every search Helix ever ran is
 * a record of what the user was looking at, which is not a thing to accumulate
 * without being asked.
 */
export class ImageResultsStore {
  #outcome: ImageSearchOutcome | null = null;
  #searching = false;
  readonly #listeners = new Set<() => void>();

  get outcome(): ImageSearchOutcome | null {
    return this.#outcome;
  }

  get searching(): boolean {
    return this.#searching;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setSearching(searching: boolean): void {
    if (this.#searching === searching) return;
    this.#searching = searching;
    this.#notify();
  }

  set(outcome: ImageSearchOutcome | null): void {
    this.#outcome = outcome;
    this.#searching = false;
    this.#notify();
  }

  clear(): void {
    this.set(null);
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not break searching.
      }
    }
  }
}
