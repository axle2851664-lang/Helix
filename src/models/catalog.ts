/**
 * The Claude model catalogue.
 *
 * Model ids here are the exact strings the Anthropic API accepts. They are
 * complete as written - never append a date suffix, and never construct an id
 * by pattern (there is, for example, no `claude-haiku-5`; the current Haiku is
 * 4.5). A wrong id fails at request time with a 404, so this file is the single
 * place ids are allowed to live.
 *
 * Pricing and context windows are recorded for display and cost estimation.
 * They are a cached snapshot, not a live feed, and are labelled as such in the
 * UI rather than presented as authoritative billing figures.
 */

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface ModelSpec {
  /** Exact API model id. */
  id: string;
  /** Short name used in the UI and recognised in switch commands. */
  name: string;
  tier: ModelTier;
  /** One line on when to reach for this model. */
  summary: string;
  /** Maximum input context, in tokens. */
  contextTokens: number;
  /** Maximum output tokens the model can produce in one response. */
  maxOutputTokens: number;
  /** USD per million input tokens. */
  inputPricePerMTok: number;
  /** USD per million output tokens. */
  outputPricePerMTok: number;
  /** Spoken or typed aliases that should select this model. */
  aliases: readonly string[];
}

/**
 * Ordered most to least capable. Opus 5 is the default: the specification's
 * instruction is never to downgrade for cost on the user's behalf.
 */
export const MODELS = [
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    tier: 'opus',
    summary: 'Most capable. Best for hard reasoning and long agentic work.',
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPricePerMTok: 5,
    outputPricePerMTok: 25,
    aliases: ['opus', 'opus 5', 'opus5', 'claude opus', 'claude opus 5'],
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    tier: 'sonnet',
    summary: 'Balanced capability and cost for everyday work.',
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    aliases: ['sonnet', 'sonnet 5', 'sonnet5', 'claude sonnet', 'claude sonnet 5'],
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    tier: 'haiku',
    // Worth stating plainly in the UI: there is no Haiku 5 to select.
    summary: 'Fastest and cheapest. The current Haiku is 4.5; there is no Haiku 5.',
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
    aliases: ['haiku', 'haiku 4.5', 'haiku 45', 'haiku4.5', 'claude haiku', 'haiku 5'],
  },
] as const satisfies readonly ModelSpec[];

/** One catalogue entry, with its id narrowed to a literal. */
export type Model = (typeof MODELS)[number];

/** The exact set of ids Helix can select. Keep settings/schema.ts in step. */
export type ModelId = Model['id'];

export const DEFAULT_MODEL_ID: ModelId = 'claude-opus-5';

export const MODEL_IDS: readonly ModelId[] = MODELS.map((model) => model.id);

export function getModel(id: string): Model | undefined {
  return MODELS.find((model) => model.id === id);
}

/** The model to use when a stored id is unrecognised. */
export function getModelOrDefault(id: string): Model {
  return getModel(id) ?? MODELS[0];
}

/**
 * Resolve free text to a model.
 *
 * Longest alias first, so "opus 5" is not shadowed by "opus". Returns null when
 * nothing matches rather than guessing - switching to the wrong model silently
 * would be worse than declining.
 */
export function resolveModel(input: string): Model | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === '') return null;

  const exact = MODELS.find((model) => model.id === normalized);
  if (exact) return exact;

  const candidates: Array<{ model: Model; text: string }> = [];
  for (const model of MODELS) {
    candidates.push({ model, text: model.name.toLowerCase() });
    for (const alias of model.aliases) candidates.push({ model, text: alias });
  }
  candidates.sort((a, b) => b.text.length - a.text.length);

  for (const candidate of candidates) {
    // Word-boundary match so "haiku" inside an unrelated word does not count.
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(candidate.text)}([^a-z0-9]|$)`);
    if (pattern.test(normalized)) return candidate.model;
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

/** Human-readable context size, e.g. "1M" or "200K". */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${Math.round(tokens / 1000)}K`;
}
