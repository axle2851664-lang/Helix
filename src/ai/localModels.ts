import type { HardwareProfile } from '../platform/PlatformAdapter.js';
import { assessFit, footprintFromName } from './resources.js';
import type { ModelInfo } from './types.js';

/**
 * What the local runtime reports, judged against what this machine can run.
 *
 * `OllamaProvider` is the authority on which models are installed, and it is
 * deliberately ignorant of hardware - it has no business knowing how much
 * memory there is. `resources.ts` is the authority on whether a model fits,
 * and it knows nothing about runtimes. This joins them, and it is the only
 * place that does.
 *
 * The judgement matters because being installed is not the same as being
 * usable. Both models on the machine this was written for are installed;
 * measured, the 7B produced 0.2 tokens per second against the 3B's 10.8,
 * because the 7B was swapping. Offering both as equal choices, or letting the
 * router pick the larger one because larger sounds better, hands the user a
 * model that appears to have hung.
 *
 * So a model that will not fit is marked `unavailable` with the fit assessment
 * as its note. The router already skips `unavailable` entries, which means the
 * right model gets chosen on this machine without any model name being written
 * down anywhere - the 3B wins because it fits, not because it is named here.
 */
export function assessInstalledModels(
  installed: readonly ModelInfo[],
  hardware: Pick<
    HardwareProfile,
    'totalMemoryBytes' | 'memoryIsApproximate' | 'availableMemoryBytes'
  >,
): ModelInfo[] {
  return installed.map((model): ModelInfo => {
    const fit = assessFit(footprintFromName(model.id), hardware);

    // Only a permanent refusal takes a model out of service.
    //
    // `not-right-now` deliberately does not: free memory is a reading taken at
    // one instant, and a spike at the wrong second would otherwise leave Helix
    // mute for the whole session with two serviceable models on the disk. The
    // note says the memory is short; the model stays available and the runtime
    // is left to do what it does when memory is tight. Unknown is not a
    // refusal either - blocking a model whose size cannot be read would be a
    // guess dressed as caution.
    if (fit.verdict === 'will-not-fit') {
      return { ...model, status: 'unavailable', note: joinNotes(model.note, fit.message) };
    }

    return { ...model, note: joinNotes(model.note, fit.message) };
  });
}

function joinNotes(existing: string | undefined, added: string): string {
  return existing ? `${existing} ${added}` : added;
}

/**
 * The model that should answer, given what is installed and what fits.
 *
 * The largest of the ones that fit - which is a safe rule only because the
 * ones that do not fit have already been marked unavailable above, against
 * measured free memory rather than the machine's total. Applied to the raw
 * installed list it would pick the 7B that ran at 0.2 tokens per second.
 */
export function preferredLocalModel(assessed: readonly ModelInfo[]): ModelInfo | null {
  const usable = assessed.filter((model) => model.status !== 'unavailable');
  if (usable.length === 0) return null;

  const sized = usable
    .map((model) => ({ model, parameters: footprintFromName(model.id).parameters }))
    .sort((a, b) => {
      // An unreadable size sorts last: a known quantity is a better bet than
      // one that could be anything.
      if (a.parameters === null) return 1;
      if (b.parameters === null) return -1;
      return b.parameters - a.parameters;
    });

  return sized[0]?.model ?? null;
}
