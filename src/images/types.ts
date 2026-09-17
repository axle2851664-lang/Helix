import type { WebTransport } from '../web/types.js';

/**
 * Searching the web for pictures.
 *
 * The rules are the ones the rest of `web/` already holds, with one addition
 * that matters more here than anywhere else in Helix.
 *
 * **Nothing is invented.** A field is either something a provider actually
 * returned or it is absent. That applies hardest to `license`: an image whose
 * terms are unknown is marked unknown, never guessed at and never quietly
 * described as free. Getting that wrong does not produce a bad search result,
 * it produces a copyright problem wearing the appearance of permission.
 *
 * **Every result carries where it came from.** `sourceUrl` is the page, not
 * the file - a picture without its page is a picture nobody can check, credit,
 * or read the terms of.
 *
 * **The provider named is the provider that answered.** When one fails and
 * another is tried, the result says which one produced it. Reporting a
 * fallback's results under the first provider's name is a small lie that makes
 * every subsequent judgement about quality worthless.
 */

/** What a licence permits, as far as the provider actually said. */
export type LicenseKnowledge =
  /** The provider stated terms. `license` holds them verbatim. */
  | 'stated'
  /** The provider said nothing. Assume all rights reserved. */
  | 'unknown';

export interface ImageResult {
  /** Stable within a search, for keys and for selection. */
  id: string;
  /** Small image for display. Falls back to imageUrl when none was given. */
  thumbnailUrl: string;
  /** The full-size file. */
  imageUrl: string;
  /** The page the image lives on. Required: an unattributed image is a rumour. */
  sourceUrl: string;
  /** The site, as the provider named it. */
  sourceName: string;
  title: string;
  description?: string;
  width?: number;
  height?: number;
  /** Who to credit, verbatim from the provider. Absent when none was given. */
  attribution?: string;
  /** The licence as stated. Absent when the provider did not say. */
  license?: string;
  licenseUrl?: string;
  licenseKnowledge: LicenseKnowledge;
  /** Which provider actually produced this. Never the one that was asked for. */
  provider: string;
}

export interface ImageSearchRequest {
  query: string;
  /** How many to ask for. Providers cap this themselves. */
  count?: number;
  /** Ask the provider to filter adult content where it supports it. */
  safeSearch?: boolean;
  /** Abort in flight, so a new search does not wait behind an old one. */
  signal?: AbortSignal;
}

export interface ImageProviderFailure {
  provider: string;
  reason: string;
}

export interface ImageSearchOutcome {
  results: readonly ImageResult[];
  /** Providers asked that could not answer, with reasons. Never blended in. */
  failures: readonly ImageProviderFailure[];
  /** Providers that answered, whether or not they found anything. */
  answered: readonly string[];
  /** What was actually searched for, after any parsing. */
  query: string;
}

/** Why a provider cannot be used right now. */
export interface ProviderReadiness {
  ready: boolean;
  /** What the user would have to do. Null when ready. */
  reason: string | null;
  /** True when the only thing missing is a credential. */
  needsCredential: boolean;
}

export interface ImageSearchProvider {
  readonly id: string;
  readonly name: string;
  /** What this provider is honestly good for, shown in settings. */
  readonly covers: string;
  /**
   * The host its requests go to. The shell decides per host whether it holds a
   * credential, so this is how readiness is established without the page ever
   * seeing a key.
   */
  readonly host: string;
  /** True when the provider works with no account at all. */
  readonly keyless: boolean;

  ready(): ProviderReadiness;
  search(request: ImageSearchRequest): Promise<readonly ImageResult[]>;
}

export interface ProviderOptions {
  transport: WebTransport;
  /** Asks the shell whether a key for `host` is configured. */
  hasKeyFor?: (host: string) => boolean;
}
