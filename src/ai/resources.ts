import type { HardwareProfile } from '../platform/PlatformAdapter.js';

/**
 * Whether a model will actually run on this machine.
 *
 * The question worth answering is not "how much RAM is there" but "what
 * happens if this is loaded". On a machine with 8 GB the difference between a
 * 7B at 4-bit and a 13B is the difference between a working assistant and one
 * that swaps to disk and appears to have hung. Saying so before the download
 * costs nothing; saying so after costs several gigabytes and half an hour.
 *
 * Every figure here is derived from measured values or reported as unknown.
 * There is no default "probably fine": a guess that a model fits is exactly
 * the guess that wastes the download.
 */

/** How a model's weights are stored, which dominates what it costs to load. */
export type Quantisation = 'q4' | 'q5' | 'q8' | 'f16' | 'unknown';

export interface ModelFootprint {
  /** Billions of parameters. Null when it cannot be read from the name. */
  parameters: number | null;
  quantisation: Quantisation;
  /** Bytes on disk, when the runtime reports it. */
  diskBytes: number | null;
}

export type FitVerdict = 'comfortable' | 'tight' | 'will-not-fit' | 'unknown';

export interface FitAssessment {
  verdict: FitVerdict;
  /** Estimated bytes needed resident to run it. Null when unknown. */
  estimatedBytes: number | null;
  /** What the user should know, in one sentence. Always present. */
  message: string;
}

/**
 * Bytes per parameter, by quantisation.
 *
 * These are the storage costs of the weights themselves. Real usage is higher
 * - context, activations and the runtime all take more - which is what the
 * overhead below accounts for.
 */
const BYTES_PER_PARAMETER: Record<Exclude<Quantisation, 'unknown'>, number> = {
  q4: 0.55,
  q5: 0.7,
  q8: 1.1,
  f16: 2.0,
};

/**
 * Headroom assumed when free memory cannot be measured.
 *
 * A fallback, and a poor one - it was set to 3 GB and proved far too
 * optimistic in practice. On a 7.8 GB machine it implied 4.8 GB usable while
 * 2.3 GB was actually free, and a 7B model assessed as "tight" on that basis
 * ran at 0.2 tokens per second because it was swapping. Measured free memory
 * is used wherever the host can report it, and this only applies when it
 * cannot.
 */
const ASSUMED_RESERVE_BYTES = 4.5 * 1024 ** 3;

/**
 * Fraction of free memory a model may occupy before it is called tight.
 *
 * Deliberately well under one: the model is not the only thing that will want
 * memory while it runs, and the failure mode is not a clean refusal but a
 * machine that slows to a crawl.
 */
const COMFORTABLE_SHARE = 0.7;

/** Runtime overhead beyond the weights: context, activations, the server. */
const RUNTIME_OVERHEAD = 1.25;

/**
 * Read a model's shape from its name.
 *
 * Ollama names carry this by convention - `qwen2.5:7b`, `llama3.1:8b-q4_K_M`
 * - and it is the only description available before downloading. Returns
 * nulls rather than guesses when the name does not say.
 */
export function footprintFromName(name: string, diskBytes: number | null = null): ModelFootprint {
  const lower = name.toLowerCase();

  // Parameter count: "7b", "13b", "3.8b".
  const parameterMatch = /(\d+(?:\.\d+)?)\s*b\b/.exec(lower);
  const parameters = parameterMatch?.[1] ? Number.parseFloat(parameterMatch[1]) : null;

  const quantisation: Quantisation = /q4|int4|4bit|4-bit/.test(lower)
    ? 'q4'
    : /q5/.test(lower)
      ? 'q5'
      : /q8|int8|8bit/.test(lower)
        ? 'q8'
        : /f16|fp16/.test(lower)
          ? 'f16'
          : // Ollama's default tags are 4-bit, but the name does not say so
            // and assuming it would understate every model that is not.
            'unknown';

  return { parameters, quantisation, diskBytes };
}

/**
 * What this model needs resident, in bytes.
 *
 * Prefers the real file size when the runtime reports one, because a measured
 * number beats an estimate from a name every time.
 */
export function estimateResidentBytes(footprint: ModelFootprint): number | null {
  if (footprint.diskBytes !== null && footprint.diskBytes > 0) {
    return Math.round(footprint.diskBytes * RUNTIME_OVERHEAD);
  }

  if (footprint.parameters === null) return null;

  // An unknown quantisation is assumed to be the common 4-bit case, which is
  // what Ollama ships by default. Flagged in the message rather than hidden.
  const perParameter =
    footprint.quantisation === 'unknown'
      ? BYTES_PER_PARAMETER.q4
      : BYTES_PER_PARAMETER[footprint.quantisation];

  return Math.round(footprint.parameters * 1e9 * perParameter * RUNTIME_OVERHEAD);
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Will it run here?
 *
 * Three honest outcomes and one admission. `unknown` is a real answer and is
 * returned whenever the machine cannot be measured or the model cannot be
 * read - claiming a model fits on the strength of a guess is the failure this
 * function exists to prevent.
 */
export function assessFit(
  footprint: ModelFootprint,
  hardware: Pick<
    HardwareProfile,
    'totalMemoryBytes' | 'memoryIsApproximate' | 'availableMemoryBytes'
  >,
): FitAssessment {
  const needed = estimateResidentBytes(footprint);
  const total = hardware.totalMemoryBytes;

  if (needed === null) {
    return {
      verdict: 'unknown',
      estimatedBytes: null,
      message:
        'I cannot tell how large this model is from its name, so I cannot say whether it will fit.',
    };
  }

  if (total === null) {
    return {
      verdict: 'unknown',
      estimatedBytes: needed,
      message: `This needs roughly ${gigabytes(needed)}. I cannot measure this machine's memory, so I cannot say whether that is available.`,
    };
  }

  // Measured free memory wherever the host can report it. This is the figure
  // that actually decides whether a model runs or swaps, and assuming it from
  // the total is what produced a wrong answer here once already.
  const measured = hardware.availableMemoryBytes;
  const usable = measured !== null ? measured : total - ASSUMED_RESERVE_BYTES;

  const basis = measured !== null ? 'free now' : 'estimated free';
  const approximate = hardware.memoryIsApproximate ? ' The memory figure is approximate.' : '';

  if (needed > usable) {
    return {
      verdict: 'will-not-fit',
      estimatedBytes: needed,
      message: `This needs roughly ${gigabytes(needed)}, and about ${gigabytes(Math.max(0, usable))} is ${basis} on a ${gigabytes(total)} machine. It would swap to disk and crawl rather than fail outright.${approximate}`,
    };
  }

  if (needed > usable * COMFORTABLE_SHARE) {
    return {
      verdict: 'tight',
      estimatedBytes: needed,
      message: `This needs roughly ${gigabytes(needed)} of about ${gigabytes(usable)} ${basis}. It will run, slowly, and little else will run comfortably beside it.${approximate}`,
    };
  }

  return {
    verdict: 'comfortable',
    estimatedBytes: needed,
    message: `This needs roughly ${gigabytes(needed)}, which this machine has room for.${approximate}`,
  };
}

/** The largest parameter count that fits comfortably, for a recommendation. */
export function largestComfortableModel(
  hardware: Pick<
    HardwareProfile,
    'totalMemoryBytes' | 'memoryIsApproximate' | 'availableMemoryBytes'
  >,
): number | null {
  if (hardware.totalMemoryBytes === null) return null;

  const free =
    hardware.availableMemoryBytes !== null
      ? hardware.availableMemoryBytes
      : hardware.totalMemoryBytes - ASSUMED_RESERVE_BYTES;
  const usable = free * COMFORTABLE_SHARE;
  if (usable <= 0) return null;

  const billions = usable / (1e9 * BYTES_PER_PARAMETER.q4 * RUNTIME_OVERHEAD);
  // Reported in the sizes models actually come in, rounded down: suggesting
  // "9.4B" would be useless, and rounding up would recommend one that does
  // not fit.
  const sizes = [1, 2, 3, 4, 7, 8, 13, 14, 20, 30, 32, 70];
  const fits = sizes.filter((size) => size <= billions);

  return fits.length > 0 ? (fits.at(-1) as number) : null;
}
