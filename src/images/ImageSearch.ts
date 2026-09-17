import type { Logger } from '../core/Logger.js';
import type {
  ImageProviderFailure,
  ImageResult,
  ImageSearchOutcome,
  ImageSearchProvider,
  ImageSearchRequest,
} from './types.js';

/**
 * Running an image search across providers.
 *
 * The behaviour worth arguing about is the fallback. A provider that fails is
 * replaced by the next one that is ready - but the results are labelled with
 * the provider that actually produced them, and the outcome lists every
 * provider that was asked and could not answer, with its reason. Presenting a
 * fallback's results under the first provider's name is a small lie that makes
 * every later judgement about quality worthless: "Google gave me rubbish" when
 * Google was never reached.
 *
 * Duplicates are removed by image URL. Two providers indexing the same Flickr
 * photograph is common, and showing it twice wastes a slot in a grid where
 * slots are the scarce thing.
 */

export interface ImageSearchOptions {
  providers: readonly ImageSearchProvider[];
  logger: Logger;
  /** Preferred provider id, from settings. */
  defaultProvider?: () => string;
}

export class ImageSearch {
  readonly #providers: readonly ImageSearchProvider[];
  readonly #logger: Logger;
  readonly #defaultProvider: () => string;

  constructor(options: ImageSearchOptions) {
    this.#providers = options.providers;
    this.#logger = options.logger.child('images');
    this.#defaultProvider = options.defaultProvider ?? (() => '');
  }

  get providers(): readonly ImageSearchProvider[] {
    return this.#providers;
  }

  provider(id: string): ImageSearchProvider | undefined {
    return this.#providers.find((entry) => entry.id === id);
  }

  /** Providers that could run right now, in the order they would be tried. */
  usable(preferred?: string): ImageSearchProvider[] {
    const wanted = (preferred ?? this.#defaultProvider()).trim();
    const ready = this.#providers.filter((entry) => entry.ready().ready);

    return [...ready].sort((a, b) => rank(a, wanted) - rank(b, wanted));
  }

  /**
   * Why nothing can search, or null when something can.
   *
   * Separated from searching so a screen can say "no provider is configured"
   * before the user types, rather than after.
   */
  blocker(): string | null {
    if (this.usable().length > 0) return null;

    const credentialOnly = this.#providers.filter((entry) => entry.ready().needsCredential);
    if (credentialOnly.length === this.#providers.length && this.#providers.length > 0) {
      return 'Every image provider here needs a key. Wikimedia and Openverse need none - if they are missing, the desktop app is not running.';
    }

    const first = this.#providers[0]?.ready().reason;
    return first ?? 'No image provider is configured.';
  }

  async search(
    request: ImageSearchRequest & { provider?: string },
  ): Promise<ImageSearchOutcome> {
    const query = request.query.trim();
    if (query === '') {
      return { results: [], failures: [], answered: [], query };
    }

    const order = this.usable(request.provider);
    const failures: ImageProviderFailure[] = [];
    const answered: string[] = [];

    if (order.length === 0) {
      const named = request.provider?.trim();
      const known = named ? this.provider(named) : undefined;
      if (named && known) {
        failures.push({ provider: known.name, reason: known.ready().reason ?? 'Not available.' });
      } else if (named) {
        failures.push({ provider: named, reason: `Helix has no image provider called "${named}".` });
      }
      return { results: [], failures, answered, query };
    }

    for (const provider of order) {
      if (request.signal?.aborted) break;

      try {
        const results = await provider.search({ ...request, query });
        answered.push(provider.id);

        if (results.length > 0) {
          return { results: dedupe(results), failures, answered, query };
        }
        // An empty answer is an answer. Try the next provider, but the fact
        // that this one looked and found nothing is kept.
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // The message is the provider's own, already stripped of credentials
        // at the provider. Logged with the id only, never the URL, which
        // carries the key for the keyed providers.
        this.#logger.warn('An image provider could not answer.', { provider: provider.id });
        failures.push({ provider: provider.name, reason });
      }
    }

    return { results: [], failures, answered, query };
  }
}

/** Preferred first, then keyless, then the rest. Stable within each group. */
function rank(provider: ImageSearchProvider, preferred: string): number {
  if (preferred !== '' && provider.id === preferred) return 0;
  return provider.keyless ? 1 : 2;
}

export function dedupe(results: readonly ImageResult[]): ImageResult[] {
  const seen = new Set<string>();
  const kept: ImageResult[] = [];
  for (const result of results) {
    if (seen.has(result.imageUrl)) continue;
    seen.add(result.imageUrl);
    kept.push(result);
  }
  return kept;
}

/**
 * One sentence describing what happened, for Helix to say out loud.
 *
 * Names the provider that actually answered. "I found twelve" is useless if
 * the user asked for Google and got Openverse.
 */
export function describeOutcome(outcome: ImageSearchOutcome, providers: readonly ImageSearchProvider[]): string {
  const nameOf = (id: string) => providers.find((entry) => entry.id === id)?.name ?? id;

  if (outcome.results.length > 0) {
    const from = [...new Set(outcome.results.map((result) => result.provider))].map(nameOf);
    const count = outcome.results.length;
    return `${count} ${count === 1 ? 'image' : 'images'} for "${outcome.query}", from ${from.join(' and ')}.`;
  }

  if (outcome.failures.length > 0) {
    return `Nothing came back for "${outcome.query}". ${outcome.failures[0]?.reason ?? ''}`.trim();
  }

  if (outcome.answered.length > 0) {
    return `Nothing matching "${outcome.query}" in ${outcome.answered.map(nameOf).join(' or ')}.`;
  }

  return `Nothing could search for "${outcome.query}".`;
}
