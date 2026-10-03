import { findCorrection, isNoise, type Correction } from './corrections.js';
import { matchCapabilities, type Match } from './match.js';
import { normalise, type Normalised } from './normalise.js';
import { findReference, resolveReference, type Reference } from './references.js';
import { vocabulary } from './registry.js';
import { segment } from './segment.js';
import type { ConversationState, FocusedObject } from './state.js';

/**
 * The pipeline: a sentence in, a decision out.
 *
 *   MESSAGE
 *     -> normalise        wake word, filler, dictation damage
 *     -> segment          one message may be several instructions
 *     -> correction?      is this changing the last one rather than a new one
 *     -> match            score every capability the registry knows
 *     -> reference?       does "it" or "the second one" name the target
 *     -> decide           act, ask, or say what is unclear
 *
 * THE DECISION IS THE POINT. Every earlier matcher in Helix answered a
 * boolean, so there were only ever two outcomes: run the tool, or fall through
 * to a model that had no idea a tool existed. There was no way to express "I
 * am fairly sure you mean the Notepad but not sure enough to delete
 * something", which is the single most common state an assistant is actually
 * in.
 *
 * So the outcome is one of four, and which one depends on confidence measured
 * against what the verb would do:
 *
 *   ACT       confident enough for this verb. Run it.
 *   CONFIRM   confident about the intent, and the verb is destructive.
 *             The existing permission pipeline asks; this layer does not
 *             invent its own confirmation.
 *   CLARIFY   the intent is clear and the target is not. One short question,
 *             naming the options where there are options.
 *   DECLINE   not confident enough to claim understanding. Say what is
 *             unclear rather than guessing, and let the request fall through
 *             to conversation.
 *
 * The thresholds differ by risk on purpose. Opening the wrong screen costs a
 * click; deleting the wrong note costs the note.
 */

/** How sure the layer must be before each kind of verb runs unasked. */
export const THRESHOLD = {
  /** Reversible: open a screen, run a search. */
  safe: 0.55,
  /** Writes something the user can then see and undo. */
  notable: 0.62,
  /** Irreversible. High, and it still goes through confirmation after. */
  destructive: 0.72,
} as const;

/** Below this, the layer does not claim to have understood at all. */
export const FLOOR = 0.4;

export type Outcome = 'act' | 'confirm' | 'clarify' | 'decline';

export interface Understanding {
  outcome: Outcome;
  /** Present for act, confirm and clarify. */
  match?: Match;
  /** The object the verb should act on, when a reference resolved to one. */
  object?: FocusedObject;
  /** For clarify: the question to put, already phrased. */
  question?: string;
  /** For clarify: what the user is choosing between. */
  options?: readonly FocusedObject[];
  /** A correction, when this message was one. */
  correction?: Correction;
  /** The reference found, whether or not it resolved. */
  reference?: Reference;
  /** Why, in words. Shown only in diagnostics. */
  because: string[];
  normalised: Normalised;
}

function thresholdFor(match: Match): number {
  return THRESHOLD[match.risk];
}

/**
 * Verbs that cannot be anything but an instruction.
 *
 * Deliberately narrower than the registry's verb words, which include things
 * like "what" and "about" that appear in every other sentence. This list is
 * only used to tell "delete that" - clearly an instruction with an unclear
 * object - from "what is that", which is a question for a model to answer.
 */
/** Words that mean adding to something that already exists. */
const APPEND_WORDS = ['add', 'append', 'put', 'include', 'stick'] as const;

/** Phrases that unambiguously ask for a new thing rather than an addition. */
const NEW_THING = [
  'new note', 'create a note', 'make a note', 'start a note', 'another note',
  'called', 'titled', 'named',
] as const;

const UNMISTAKABLE = new Set([
  'delete', 'remove', 'erase', 'open', 'save', 'export', 'add', 'append',
  'create', 'rename', 'close', 'send', 'find', 'search', 'show', 'list',
  'pull', 'back', 'enough', 'dismiss', 'hide',
]);

/**
 * Words that make a sentence a question rather than an instruction.
 *
 * "Find out what the capital of Australia is" begins with an instruction word
 * and is not one. Only the opening matters: an instruction leads with its
 * verb, and a question leads with its question word.
 */
const QUESTION_OPENERS = new Set([
  'what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose', 'is', 'are',
  'was', 'were', 'can', 'could', 'do', 'does', 'did', 'should', 'would',
  'will', 'am', 'have', 'has', 'had',
]);

function opensWithAQuestion(normalised: Normalised): boolean {
  const first = normalised.tokens[0];
  return first !== undefined && QUESTION_OPENERS.has(first);
}

/**
 * Is this a question rather than an instruction?
 *
 * Exported because the older keyword matchers need the same distinction and
 * should not each invent their own. "Why is it open" contains "open", which
 * was enough for the project tool to go looking for a project called "why" and
 * answer "You have no projects as yet" - to a user who was asking why Helix
 * had just opened something.
 *
 * Polite requests are not questions by the time this sees them: `normalise`
 * strips "can you", "could you" and the rest, so "can you open my notes?"
 * arrives as "open my notes".
 */
export function isQuestion(text: string): boolean {
  return opensWithAQuestion(normalise(text, vocabulary()));
}

function namesAnAction(normalised: Normalised): boolean {
  const first = normalised.tokens[0];
  if (first !== undefined && QUESTION_OPENERS.has(first)) return false;
  return normalised.tokens.some((token) => UNMISTAKABLE.has(token));
}

/**
 * Understand one clause, against the conversation so far.
 *
 * `state` is read, never written: applying the outcome is the caller's job,
 * because only the caller knows whether the action actually succeeded, and
 * recording a focus for something that failed is how "it" comes to mean a
 * thing that does not exist.
 */
export function understandClause(text: string, state: ConversationState): Understanding {
  const correction = findCorrection(text);

  /**
   * A correction is about the last action, so the sentence to understand is
   * what is left after the marker - "no, I meant the Helix notes" is
   * understood as "the Helix notes", carrying the verb forward from before.
   */
  const effective = correction?.kind === 'replace' ? correction.remainder : text;
  const normalised = normalise(effective, vocabulary());
  const because: string[] = [];

  if (correction) because.push(`"${correction.marker}" corrects the last request`);
  for (const [wrong, right] of normalised.repairs) {
    because.push(`read "${wrong}" as "${right}"`);
  }

  if (correction?.kind === 'cancel') {
    /**
     * "Stop it" means stop the thing, when there is a thing.
     *
     * A bare abort normally cancels the request Helix is working on, which is
     * right for "never mind" and for "stop" said over an answer. But with a
     * timer or a stopwatch in focus, "stop it" and "cancel that" are plainly
     * about that - and it is the most natural thing anyone says to a timer
     * that is going off. Declining it left the one phrase a person reaches
     * for first doing nothing at all.
     *
     * Narrow on purpose: only these three, and only because each is a thing
     * that is actively running and can be stopped. A note in focus does not
     * make "never mind" mean "delete the note".
     *
     * Falling through is the whole of the change. What happens next is the
     * focus carry further down, which prepends the focused thing's kind to
     * the sentence - so "stop it" becomes "timer stop it" and resolves the
     * ordinary way. Nothing here decides what to do about it.
     */
    const focus = state.focus;
    const running = focus !== null
      && (focus.kind === 'timer' || focus.kind === 'stopwatch' || focus.kind === 'alarm');
    /**
     * And only for the markers that name stopping something.
     *
     * "Stop it" and "cancel that" say what to do to the thing. "Never mind",
     * "forget it", "leave it" and "don't bother" say the user has changed
     * their mind, which is an abort whatever happens to be in focus - and
     * gating on focus alone turned "forget it" into "cancel the timer",
     * because "forget" is one of the words that cancels a timer when it is
     * named outright.
     */
    const namesStopping = /^(?:stop|cancel)\b/i.test(correction.marker.trim());
    if (!running || !namesStopping) {
      return { outcome: 'decline', correction, because, normalised };
    }
    because.push(`"${correction.marker}" is about ${focus?.label}`);
  }

  const reference = findReference(effective) ?? undefined;
  const resolved = reference ? resolveReference(reference, state) : null;
  if (resolved) because.push(`${resolved.how} is ${resolved.object.label}`);

  /**
   * A question about what Helix just did is not an instruction to do it again.
   *
   * "Which file", "why did you open the files", "why is it open" were all
   * being claimed - "which" and "what" are search words, "file" is a subject,
   * and the score came out at 0.9. The user was asking Helix to explain
   * itself and Helix went looking through their files.
   *
   * A clause that opens with a question word is therefore only an instruction
   * when a phrase in the registry says so - "what did I write about X" is a
   * real search and is listed as one. Everything else falls through to
   * conversation, which is where a question belongs.
   *
   * Note that genuine polite requests never reach here as questions:
   * `normalise` strips "can you", "could you" and the rest before this runs,
   * so "can you open my notes?" arrives as "open my notes".
   */
  const matches = matchCapabilities(effective, { normalised }).filter(
    (candidate) =>
      !opensWithAQuestion(normalised) ||
      candidate.capability.implied.some((entry) => normalised.text.includes(entry.phrase)),
  );
  let best = matches[0];

  /**
   * A reference with no capability named inherits the one in focus.
   *
   * "Add the login issue" after opening a note names no capability at all,
   * and without this it falls through to conversation - which is where every
   * follow-up used to go.
   */
  if (!best && resolved) {
    const carried = matchCapabilities(`${resolved.object.kind} ${effective}`);
    best = carried[0];
    if (best) because.push(`carried on from ${resolved.object.label}`);
  }

  /**
   * An instruction with no subject, while something is open.
   *
   *   Helix: "Website redesign" open.
   *   User:  Add the login issue.
   *
   * Names no capability and contains no pronoun either - there is nothing to
   * resolve, only something already in hand. This is the brief's "current
   * object", and without it every follow-up fell through to a model that had
   * no idea a note was open, which is how "add the login issue" quietly
   * became a second note.
   *
   * Gated on an unmistakable action verb so that ordinary conversation, which
   * is most of what anyone says, still falls through untouched.
   */
  const open = state.referent();
  if (!best && open && namesAnAction(normalised)) {
    const carried = matchCapabilities(`${open.kind} ${effective}`);
    best = carried[0];
    if (best) because.push(`${open.label} is open, so this applies to it`);
  }

  /**
   * An instruction with no subject and nothing open, but a subject already
   * established in this conversation.
   *
   *   User:  Open my notes.
   *   User:  Find the one about the website.
   *
   * The second clause names no capability and refers to no object - the
   * Notepad is simply what this conversation is about. Topic is the weakest
   * of the three carries and is tried last, after a reference and after
   * whatever is open.
   */
  const topic = state.topic;
  if (!best && topic !== null && namesAnAction(normalised)) {
    const carried = matchCapabilities(`${topic} ${effective}`);
    best = carried[0];
    if (best) because.push(`this conversation is about the ${topic}`);
  }

  // A correction that only names a target keeps the verb it is correcting.
  if (!best && correction?.kind === 'replace' && !isNoise(effective) && state.lastAction) {
    const carried = matchCapabilities(
      `${state.lastAction.verb} ${state.lastAction.capability} ${effective}`,
    );
    best = carried[0];
    if (best) because.push(`kept "${state.lastAction.verb}" from the last request`);
  }

  /**
   * A reference that resolved to nothing, next to a verb that plainly wants
   * an object.
   *
   * "Delete that" names no capability, so nothing above matched - but the
   * user unmistakably meant something, and declining drops them into
   * conversation with a model that has no idea a note exists. One short
   * question is the right answer, and on a destructive verb it is the only
   * safe one.
   */
  if (!best && reference && !resolved && namesAnAction(normalised)) {
    return {
      outcome: 'clarify',
      question: `I'm not sure what "${reference.phrase}" refers to. Which one?`,
      because: [...because, `"${reference.phrase}" refers to nothing in this conversation`],
      ...(correction ? { correction } : {}),
      reference,
      normalised,
    };
  }

  if (!best) {
    return {
      outcome: 'decline',
      because: [...because, 'nothing named a capability'],
      ...(correction ? { correction } : {}),
      ...(reference ? { reference } : {}),
      normalised,
    };
  }

  because.push(...best.because);

  /**
   * "Add" means two different things, and only context tells them apart.
   *
   * It is a create word ("add a note about suppliers") and an append word
   * ("add the login issue"), and the registry cannot choose between them
   * because the difference is not in the sentence - it is in whether there is
   * already a note in hand. With something in focus and no sign that a new
   * one was asked for, the second reading is right, and taking the first
   * silently produced a duplicate note instead of adding to the open one.
   */
  const inHand = resolved?.object ?? state.referent();
  if (
    best.verb === 'create' &&
    inHand !== null &&
    inHand !== undefined &&
    inHand.kind === best.capability.id &&
    APPEND_WORDS.some((word) => normalised.tokens.includes(word)) &&
    !NEW_THING.some((phrase) => normalised.text.includes(phrase))
  ) {
    const append = best.capability.verbs.find((entry) => entry.verb === 'append');
    if (append) {
      best = { ...best, verb: 'append', risk: append.risk, needsTarget: append.needsTarget };
      because.push(`something is already open, so "add" means add to it`);
    }
  }

  const object = resolved?.object ?? (best.verb === 'append' ? (inHand ?? undefined) : undefined);
  const common = {
    match: best,
    because,
    normalised,
    ...(object ? { object } : {}),
    ...(correction ? { correction } : {}),
    ...(reference ? { reference } : {}),
  };

  if (best.confidence < FLOOR) {
    return { outcome: 'decline', ...common };
  }

  /**
   * The verb needs something to act on and nothing named one.
   *
   * This is where "delete that" with three candidates becomes a question
   * rather than a deletion. An unresolved reference lands here too: the user
   * clearly meant something, and Helix clearly does not know what.
   */
  const hasTarget = best.target !== '' || object !== undefined;
  if (best.needsTarget && !hasTarget) {
    const options = state.candidates;
    return {
      outcome: 'clarify',
      ...common,
      question:
        options.length > 1
          ? `Which one - ${options.map((entry) => entry.label).join(', or ')}?`
          : `What should I ${best.verb}?`,
      ...(options.length > 1 ? { options } : {}),
    };
  }

  if (reference && !resolved && best.needsTarget) {
    return {
      outcome: 'clarify',
      ...common,
      question: `I'm not sure what "${reference.phrase}" means here. Which one?`,
    };
  }

  if (best.confidence < thresholdFor(best)) {
    return {
      outcome: 'clarify',
      ...common,
      question: `Do you want me to ${best.capability.verbs.find((entry) => entry.verb === best.verb)?.summary ?? best.verb}?`,
    };
  }

  return { outcome: best.risk === 'destructive' ? 'confirm' : 'act', ...common };
}

export interface Understood {
  /** One per clause, in the order they should run. */
  steps: Understanding[];
  /** True when the message held more than one instruction. */
  multiple: boolean;
}

/** Understand a whole message, which may be several instructions. */
export function understand(text: string, state: ConversationState): Understood {
  const clauses = segment(text);
  const steps = clauses.map((clause) => understandClause(clause, state));

  /**
   * A split that produced nothing useful was not a real split.
   *
   * "Write down eggs, milk and bread" should never be three requests, and if
   * the segmenter gets it wrong the clauses each score badly. Falling back to
   * the whole message is cheaper and safer than acting on the fragments.
   */
  if (steps.length > 1 && steps.every((step) => step.outcome === 'decline')) {
    return { steps: [understandClause(text, state)], multiple: false };
  }

  return { steps, multiple: steps.length > 1 };
}
