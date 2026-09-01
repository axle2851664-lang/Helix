import { ModelRegistry } from './registry.js';
import type {
  Capability,
  ChatMessage,
  GenerateResult,
  InferenceProvider,
  ModelInfo,
} from './types.js';

/**
 * The Helix AI router.
 *
 * Answers three questions per request, in this order: which model should do
 * this, which inference provider should run it, and what happens when that
 * arrangement fails.
 *
 * The rule the whole file is built to keep: **never claim the requested model
 * handled a request that something else handled.** A fallback is a change in
 * what answered, and sometimes a change in what it is capable of. Both go into
 * the result where the interface can show them, not into a log.
 *
 * Local inference is preferred when it is configured. That is a decision about
 * where the user's words go rather than about speed - cloud inference means
 * sending them to somebody else's machine, and if a local model can do the job
 * it should.
 */

/** What a request needs from a model, inferred from what was asked. */
export interface Requirement {
  capabilities: readonly Capability[];
  /** Why these were chosen, for the interface to explain the routing. */
  reason: string;
}

/**
 * Work out what a request needs.
 *
 * Deliberately conservative: unrecognised requests get `chat` rather than a
 * guess at something more specific, because over-specifying narrows the model
 * choice on no evidence.
 */
export function classify(text: string): Requirement {
  const lower = text.toLowerCase();

  if (/\b(image|photo|picture|screenshot|diagram|what is in this)\b/.test(lower)) {
    return { capabilities: ['vision'], reason: 'This needs to look at an image.' };
  }

  if (/\b(code|function|bug|refactor|compile|stack trace|typescript|rust|python)\b/.test(lower)) {
    return { capabilities: ['coding'], reason: 'This is a coding request.' };
  }

  if (/\b(quick|quickly|briefly|short answer|just tell me|fast)\b/.test(lower)) {
    return { capabilities: ['fast'], reason: 'You asked for something quick.' };
  }

  if (/\b(why|explain|analyse|analyze|compare|reason|prove|design)\b/.test(lower)) {
    return { capabilities: ['reasoning'], reason: 'This needs reasoning rather than recall.' };
  }

  return { capabilities: ['chat'], reason: 'An ordinary request.' };
}

export interface RouteAttempt {
  providerId: string;
  modelId: string;
  /** Why it was not used. Null on the attempt that succeeded. */
  failedBecause: string | null;
}

export interface RoutedResult extends GenerateResult {
  /** What was asked for before any fallback. */
  requestedModel: string;
  requestedProvider: string;
  /** True when something other than the first choice answered. */
  substituted: boolean;
  /**
   * Set when the substitute cannot do something the first choice could. This
   * is the sentence the user must see: a fallback that quietly drops vision
   * has changed the answer, not just the route.
   */
  capabilityLoss: string | null;
  /** Every attempt in order, including the failures. */
  attempts: readonly RouteAttempt[];
}

export interface AIRouterOptions {
  providers: readonly InferenceProvider[];
  registry?: ModelRegistry;
  /** Provider id to try first, when it is configured. */
  preferredProvider?: string;
  /** Provider id to fall back to. */
  fallbackProvider?: string;
  /** Prefer local inference over cloud whenever local is configured. */
  preferLocal?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export class AIRouter {
  readonly #providers: readonly InferenceProvider[];
  readonly #registry: ModelRegistry;
  readonly #options: AIRouterOptions;

  constructor(options: AIRouterOptions) {
    this.#providers = options.providers;
    this.#registry = options.registry ?? new ModelRegistry();
    this.#options = options;
  }

  get registry(): ModelRegistry {
    return this.#registry;
  }

  provider(id: string): InferenceProvider | undefined {
    return this.#providers.find((provider) => provider.id === id);
  }

  /** Providers that could actually run something now. */
  get configured(): InferenceProvider[] {
    return this.#providers.filter((provider) => provider.isConfigured().configured);
  }

  /**
   * Candidate model-and-provider pairs for a requirement, best first.
   *
   * Ordering, in priority order: local before cloud when asked for, then the
   * preferred provider, then the fallback, then anything else. Within a
   * provider, verified models come before unverified ones - an id written from
   * documentation should never be chosen ahead of one the provider confirmed.
   */
  plan(requirement: Requirement): Array<{ model: ModelInfo; provider: InferenceProvider }> {
    const matching = this.#registry.withCapabilities(requirement.capabilities);

    const scored = matching
      .map((model) => ({ model, provider: this.provider(model.inferenceProvider) }))
      .filter(
        (entry): entry is { model: ModelInfo; provider: InferenceProvider } =>
          entry.provider !== undefined && entry.provider.isConfigured().configured,
      )
      .filter((entry) => entry.model.status !== 'unavailable');

    return scored.sort((a, b) => this.#rank(a) - this.#rank(b));
  }

  #rank(entry: { model: ModelInfo; provider: InferenceProvider }): number {
    let score = 0;

    if (this.#options.preferLocal && entry.provider.location === 'local') score -= 1000;
    if (entry.provider.id === this.#options.preferredProvider) score -= 500;
    if (entry.provider.id === this.#options.fallbackProvider) score -= 100;
    // A documented-but-unconfirmed id is a worse bet than a confirmed one.
    if (entry.model.status === 'unverified') score += 50;

    return score;
  }

  /**
   * What the first choice can do that a substitute cannot.
   * Null when nothing is lost.
   */
  #capabilityLoss(first: ModelInfo, used: ModelInfo): string | null {
    const lost = first.capabilities.filter(
      (capability) => !used.capabilities.includes(capability),
    );
    if (lost.length === 0) return null;

    return `${used.name} cannot do what ${first.name} can: ${lost.join(', ')}.`;
  }

  /**
   * Run a request, falling back if it fails.
   *
   * Every attempt is recorded. Nothing is retried on the same provider - a
   * provider that just failed is not more likely to succeed immediately after,
   * and retrying a billable call on a hunch spends money for nothing.
   */
  async generate(
    messages: readonly ChatMessage[],
    requirement: Requirement = { capabilities: ['chat'], reason: 'An ordinary request.' },
  ): Promise<RoutedResult> {
    const candidates = this.plan(requirement);

    if (candidates.length === 0) {
      throw new Error(this.#nothingAvailableReason());
    }

    const first = candidates[0];
    if (!first) throw new Error(this.#nothingAvailableReason());

    const attempts: RouteAttempt[] = [];

    for (const candidate of candidates) {
      try {
        const result = await candidate.provider.generate({
          model: candidate.model.id,
          messages,
          ...(this.#options.temperature !== undefined
            ? { temperature: this.#options.temperature }
            : {}),
          ...(this.#options.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.#options.maxOutputTokens }
            : {}),
        });

        attempts.push({
          providerId: candidate.provider.id,
          modelId: candidate.model.id,
          failedBecause: null,
        });

        const substituted = candidate.model.id !== first.model.id;

        return {
          ...result,
          requestedModel: first.model.id,
          requestedProvider: first.provider.id,
          substituted,
          capabilityLoss: substituted
            ? this.#capabilityLoss(first.model, candidate.model)
            : null,
          attempts,
        };
      } catch (error) {
        attempts.push({
          providerId: candidate.provider.id,
          modelId: candidate.model.id,
          failedBecause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const summary = attempts
      .map((attempt) => `${attempt.modelId} on ${attempt.providerId}: ${attempt.failedBecause}`)
      .join('; ');

    throw new Error(`No inference provider could answer. ${summary}`);
  }

  /**
   * Why nothing can run, in the user's terms.
   *
   * Names the specific missing thing per provider rather than saying "no
   * provider available", because the fix differs: one needs a key, another
   * needs the desktop shell, a third is not built.
   */
  #nothingAvailableReason(): string {
    const reasons = this.#providers
      .map((provider) => {
        const configuration = provider.isConfigured();
        return configuration.configured ? null : `${provider.name}: ${configuration.reason}`;
      })
      .filter((reason): reason is string => reason !== null);

    if (reasons.length === 0) {
      return 'No model in the registry can do what this request needs.';
    }
    return reasons.join(' ');
  }

  /** What the status panel shows: the model and the provider, separately. */
  describeSelection(requirement?: Requirement): {
    model: ModelInfo | null;
    provider: InferenceProvider | null;
    reason: string;
  } {
    const plan = this.plan(
      requirement ?? { capabilities: ['chat'], reason: 'An ordinary request.' },
    );
    const first = plan[0];

    if (!first) {
      return { model: null, provider: null, reason: this.#nothingAvailableReason() };
    }
    return {
      model: first.model,
      provider: first.provider,
      reason: requirement?.reason ?? 'An ordinary request.',
    };
  }
}
