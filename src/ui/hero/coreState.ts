import type { ActivityKind } from '../../core/ActivityManager.js';
import type { VoiceState } from '../../voice/types.js';
import type { CoreState } from './Core.js';

/**
 * What the core on screen is showing, derived from what Havoc is actually
 * doing.
 *
 * Six states, and the brief is explicit that they must never be blurred:
 * answering, thinking, planning, executing, awaiting confirmation, failed. The
 * one that matters most is the line between thinking and executing, because
 * one of them has already started changing things, and a screen that shows the
 * same glow for both is telling the user they are the same.
 *
 * Every input here is something the rest of the program already knows and
 * cannot fake. `ActivityManager` hands out its kinds against a token owned by
 * the code doing the work, so "searching" is on screen only while something is
 * genuinely searching. `VoiceState` comes from the audio path. The consent
 * flag comes from the gate that is holding the question open. Nothing in this
 * file invents a state, and there is no branch that produces motion for its
 * own sake.
 *
 * Pure, and separate from the canvas, so the mapping can be tested without a
 * renderer - the thing worth testing here is the decision, not the drawing.
 */

export interface CoreInputs {
  /** What the activity manager says is running. */
  activity: ActivityKind;
  /** What the voice pipeline says. */
  voice: VoiceState;
  /** True while a consent question is on screen and unanswered. */
  awaitingConsent: boolean;
}

/**
 * Activity kinds that mean Havoc has started doing something.
 *
 * Deliberately a list rather than "anything that is not thinking": a kind
 * added later should have to be classified on purpose. Getting a new one
 * wrong in the safe direction shows deliberation where there is action, and
 * that is the wrong way round.
 */
const EXECUTING: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'searching',
  'opening-project',
  'loading-model',
  'analyzing-image',
  'generating',
]);

export function coreStateFor({ activity, voice, awaitingConsent }: CoreInputs): CoreState {
  // A question on screen outranks everything. Havoc has stopped, and whatever
  // it was doing a moment ago is not what the user needs to see.
  if (awaitingConsent) return 'awaiting';

  // A failure outranks the rest, from either side. It is the one state that
  // must not be overwritten by whatever happened to be running.
  if (voice === 'error' || activity === 'failed') return 'error';

  // The audio path wins over the activity kind while it is live, because it is
  // the more specific fact: "speaking" and "listening" are both also
  // activities, and the voice manager is the thing that knows when they end.
  if (voice === 'listening') return 'listening';
  if (voice === 'speaking') return 'speaking';

  if (EXECUTING.has(activity)) return 'executing';
  if (activity === 'thinking' || voice === 'processing') return 'thinking';

  // 'standing-by' and 'completed'. Completed is a finished thing, and a core
  // still lit for a finished thing reads as one still running.
  return 'idle';
}

/**
 * The state in words, shown briefly under the core and then gone.
 *
 * Not a permanent label: the brief asks for no permanent dashboards, and a
 * word that is always on screen is one nobody reads. It is here at all because
 * brightness and rhythm must never be the only signal - the same rule the
 * capability ring followed when it carried its reasons in text.
 *
 * Idle has no word. There is nothing to say, and saying "Idle" is the kind of
 * readout that makes a screen look busy while reporting nothing.
 */
export function coreStateLabel(state: CoreState): string | null {
  switch (state) {
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Working it out';
    case 'executing':
      return 'Running';
    case 'speaking':
      return 'Speaking';
    case 'awaiting':
      return 'Waiting on you';
    case 'error':
      return 'Stopped';
    case 'idle':
      return null;
  }
}
