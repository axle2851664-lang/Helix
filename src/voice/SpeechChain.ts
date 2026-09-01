import type {
  ProcessingLocation,
  ProviderAvailability,
  SpeechRecognitionError,
  SpeechRecognitionResult,
  SpeechToTextProvider,
} from './types.js';

/**
 * Speech recognition with a fallback.
 *
 * Local first, always. Whisper runs on this machine and no audio leaves it,
 * which is the arrangement worth defending; the fallback exists for when that
 * genuinely cannot run, not as an equal alternative.
 *
 * This is itself a `SpeechToTextProvider`, so VoiceManager and the interface
 * above it need no knowledge of the chain at all - they ask one thing to
 * listen and it answers.
 *
 * Three rules, and the first is the one that matters:
 *
 * 1. **A fallback that moves audio off the device is announced, never
 *    silent.** Falling back from Whisper to browser speech changes where the
 *    user's voice goes - from this machine to Google. Doing that quietly
 *    because the first provider had a bad moment would be the single worst
 *    thing this file could do, so a chain that would cross that line requires
 *    it to have been allowed in advance, and says so when it happens.
 *
 * 2. **Only recoverable failures fall through.** "I did not hear anything" is
 *    a correct answer, not a failure, and retrying it on a second provider
 *    would ship silence to a third party for nothing.
 *
 * 3. **The chain reports which provider actually ran.** A transcript is worth
 *    less if you cannot tell whether it came from the local model or the
 *    remote one.
 */

/**
 * Failure codes worth trying the next provider for.
 *
 * Anything else is either a correct answer or a fault the next provider will
 * hit identically - a denied microphone is denied for everyone.
 */
const RECOVERABLE = new Set(['transcription-failed', 'model-unavailable', 'load-failed']);

export interface SpeechChainOptions {
  /** In order. The first that can run, runs. */
  providers: readonly SpeechToTextProvider[];
  /**
   * Whether a fallback may send audio somewhere the previous provider would
   * not have. Defaults to false: the safe answer when nobody has been asked.
   */
  allowRemoteFallback?: boolean;
  /** Told which provider ran, and why, so the UI can say so. */
  onProviderChange?: (report: ChainReport) => void;
}

export interface ChainReport {
  provider: SpeechToTextProvider;
  /** Null for the first choice; the reason the previous one gave otherwise. */
  fellBackBecause: string | null;
  /** True when this provider sends audio further than the first would have. */
  escalatesPrivacy: boolean;
}

export class SpeechChain implements SpeechToTextProvider {
  readonly id = 'chain';

  readonly #providers: readonly SpeechToTextProvider[];
  readonly #allowRemoteFallback: boolean;
  readonly #onProviderChange: ((report: ChainReport) => void) | undefined;

  #active: SpeechToTextProvider | null = null;

  constructor(options: SpeechChainOptions) {
    this.#providers = options.providers;
    this.#allowRemoteFallback = options.allowRemoteFallback ?? false;
    this.#onProviderChange = options.onProviderChange;
  }

  /** The providers this chain would actually be allowed to use. */
  get usable(): SpeechToTextProvider[] {
    return this.#providers.filter((provider) => {
      if (!provider.isAvailable().available) return false;
      if (provider === this.#providers[0]) return true;
      return this.#allowRemoteFallback || !this.#escalates(provider);
    });
  }

  get name(): string {
    const [first] = this.usable;
    if (!first) return 'No speech provider';

    const rest = this.usable.length - 1;
    return rest > 0 ? `${first.name}, falling back to ${this.usable[1]?.name}` : first.name;
  }

  /**
   * Where audio is processed.
   *
   * Reports the *worst* case among providers that might actually be used, not
   * the first one. Saying "on-device" while a remote fallback is armed would
   * be true only until the moment it stopped being true.
   */
  get processing(): ProcessingLocation {
    const usable = this.usable;
    if (usable.length === 0) return 'unknown';
    return usable.some((provider) => provider.processing !== 'on-device')
      ? 'unknown'
      : 'on-device';
  }

  /** True only if every usable provider needs the network. */
  get requiresNetwork(): boolean {
    const usable = this.usable;
    return usable.length > 0 && usable.every((provider) => provider.requiresNetwork);
  }

  get listening(): boolean {
    return this.#active?.listening ?? false;
  }

  isAvailable(): ProviderAvailability {
    const usable = this.usable;
    if (usable.length > 0) return { available: true };

    // Report the first provider's own reason rather than a generic one: it is
    // the specific thing the user would have to fix.
    const first = this.#providers[0];
    const reason = first?.isAvailable().reason;

    return {
      available: false,
      reason: reason ?? 'No speech provider is configured.',
    };
  }

  /** Does this provider send audio further than the first one would? */
  #escalates(provider: SpeechToTextProvider): boolean {
    const first = this.#providers[0];
    if (!first) return provider.processing !== 'on-device';
    return first.processing === 'on-device' && provider.processing !== 'on-device';
  }

  async start(handlers: {
    onResult: (result: SpeechRecognitionResult) => void;
    onError: (error: SpeechRecognitionError) => void;
    onEnd: () => void;
  }): Promise<void> {
    const usable = this.usable;
    if (usable.length === 0) {
      throw new Error(this.isAvailable().reason ?? 'Speech recognition is unavailable.');
    }

    await this.#attempt(usable, 0, null, handlers);
  }

  /**
   * Try one provider, and move on only if it fails in a way the next one could
   * plausibly do better with.
   *
   * `onEnd` is withheld while a fallback is still to come, because the caller
   * treats it as the end of the turn - firing it between providers would end
   * the turn twice and leave the second transcript arriving after the UI had
   * already given up.
   */
  async #attempt(
    usable: readonly SpeechToTextProvider[],
    index: number,
    because: string | null,
    handlers: {
      onResult: (result: SpeechRecognitionResult) => void;
      onError: (error: SpeechRecognitionError) => void;
      onEnd: () => void;
    },
  ): Promise<void> {
    const provider = usable[index];
    if (!provider) return;

    const hasFallback = index + 1 < usable.length;
    this.#active = provider;

    this.#onProviderChange?.({
      provider,
      fellBackBecause: because,
      escalatesPrivacy: this.#escalates(provider),
    });

    let failed: SpeechRecognitionError | null = null;
    let gotResult = false;

    try {
      await provider.start({
        onResult: (result) => {
          gotResult = true;
          handlers.onResult(result);
        },
        onError: (error) => {
          // Held rather than forwarded: if a fallback succeeds, the user does
          // not need to be told the first attempt failed.
          if (hasFallback && RECOVERABLE.has(error.code)) failed = error;
          else handlers.onError(error);
        },
        onEnd: () => {
          if (!(failed && !gotResult)) handlers.onEnd();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!hasFallback) throw error;
      failed = { code: 'start-failed', message, cause: message };
    }

    if (failed && !gotResult && hasFallback) {
      const reason: SpeechRecognitionError = failed;
      await this.#attempt(usable, index + 1, reason.message, handlers);
    }
  }

  stop(): void {
    this.#active?.stop();
  }

  /** Forwarded from whichever provider is live, so the meter keeps working. */
  onLevel(handler: (level: number) => void): () => void {
    const unsubscribes = this.#providers
      .map((provider) => provider as { onLevel?: (h: (level: number) => void) => () => void })
      .filter((provider) => typeof provider.onLevel === 'function')
      .map((provider) => provider.onLevel?.(handler))
      .filter((off): off is () => void => typeof off === 'function');

    return () => unsubscribes.forEach((off) => off());
  }
}
