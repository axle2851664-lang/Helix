/**
 * What the conversation is currently about.
 *
 * WHY THIS IS NEEDED. Every matcher in Helix read one sentence in isolation,
 * so "open it" was meaningless and "the second one" was meaningless, and the
 * user had to repeat the full name of a thing every time they wanted to touch
 * it again. That is not how anyone talks:
 *
 *   User:  Create a note called Project Ideas.
 *   Helix: Created.
 *   User:  Put the supplier idea in it.
 *
 * "It" is doing the work of a proper noun, and without somewhere to hold what
 * "it" refers to there is nothing that can resolve it.
 *
 * WHAT IS HELD, AND WHAT IS NOT. This is short-term working state: the thing
 * currently in focus, the list the user is choosing from, the last action and
 * whether it worked, and any question Helix is waiting on an answer to. It is
 * per-conversation and it is not persisted - it is the equivalent of what a
 * person holds in their head during a conversation, not what they write down.
 * Anything worth keeping goes to MemoryManager or the Notepad, which have
 * their own rules about consent and deletion. Nothing here is ever written to
 * disk, which is also why holding a note's id costs nothing in privacy terms.
 *
 * ON STALENESS. Focus decays. A note opened twenty turns and three subjects
 * ago is not what "it" means any more, and resolving to it confidently would
 * be worse than admitting the reference is unclear. Every focused object
 * records the turn it was set on, and `referent` refuses anything too old.
 */

/** A thing the conversation is about, that a later turn can refer back to. */
export interface FocusedObject {
  /** Which capability owns it - 'notepad', 'memory', 'projects'. */
  kind: string;
  /** The identifier the owning system uses. */
  id: string;
  /** What to call it when asking about it. */
  label: string;
  /** The turn it came into focus, for staleness. */
  turn: number;
}

export interface LastAction {
  capability: string;
  verb: string;
  /** True only when the underlying operation genuinely succeeded. */
  succeeded: boolean;
  /** What was acted on, when there was something. */
  object?: FocusedObject;
  /** The sentence that caused it, so "do that again" can repeat it. */
  utterance: string;
}

/** A question Helix asked and is waiting on an answer to. */
export interface PendingQuestion {
  /** What was being attempted when the question became necessary. */
  capability: string;
  verb: string;
  /** The question as it was put to the user. */
  asked: string;
  /** The options offered, when it was a choice. */
  options: readonly FocusedObject[];
  turn: number;
}

/**
 * How many turns a focused object stays referable.
 *
 * Six is about the span of a short exchange about one thing. Beyond it, "it"
 * is more likely to mean whatever has been discussed since, and Helix asking
 * is better than Helix guessing.
 */
export const FOCUS_LIFETIME = 6;

export class ConversationState {
  #turn = 0;
  #focus: FocusedObject | null = null;
  /** The list the user is currently choosing from, for "the second one". */
  #candidates: readonly FocusedObject[] = [];
  #candidatesTurn = 0;
  #lastAction: LastAction | null = null;
  #pending: PendingQuestion | null = null;
  #topic: string | null = null;

  get turn(): number {
    return this.#turn;
  }

  /** Called once per user message, before anything is resolved. */
  advance(): void {
    this.#turn += 1;
  }

  get focus(): FocusedObject | null {
    return this.#focus;
  }

  /** The focused object, or null when it is too old to be what "it" means. */
  referent(): FocusedObject | null {
    if (this.#focus === null) return null;
    return this.#turn - this.#focus.turn <= FOCUS_LIFETIME ? this.#focus : null;
  }

  focusOn(object: Omit<FocusedObject, 'turn'>): void {
    this.#focus = { ...object, turn: this.#turn };
  }

  clearFocus(): void {
    this.#focus = null;
  }

  /**
   * Offer a list to choose from.
   *
   * Also sets focus to the first, because "find my notes about X" followed by
   * "open it" sensibly means the best match - while "the second one" still
   * works because the whole list is kept.
   */
  offer(candidates: readonly FocusedObject[]): void {
    this.#candidates = candidates.map((entry) => ({ ...entry, turn: this.#turn }));
    this.#candidatesTurn = this.#turn;
    const first = this.#candidates[0];
    if (first) this.#focus = first;
  }

  get candidates(): readonly FocusedObject[] {
    return this.#turn - this.#candidatesTurn <= FOCUS_LIFETIME ? this.#candidates : [];
  }

  get lastAction(): LastAction | null {
    return this.#lastAction;
  }

  record(action: LastAction): void {
    this.#lastAction = action;
    if (action.object) this.focusOn(action.object);
  }

  get pending(): PendingQuestion | null {
    if (this.#pending === null) return null;
    // A question two turns old has been ignored, and treating the next thing
    // said as its answer would be worse than dropping it.
    return this.#turn - this.#pending.turn <= 2 ? this.#pending : null;
  }

  ask(question: Omit<PendingQuestion, 'turn'>): void {
    this.#pending = { ...question, turn: this.#turn };
  }

  answered(): void {
    this.#pending = null;
  }

  get topic(): string | null {
    return this.#topic;
  }

  setTopic(topic: string | null): void {
    this.#topic = topic;
  }

  /** Everything, for diagnostics. Never shown to the user unaltered. */
  describe(): Record<string, unknown> {
    return {
      turn: this.#turn,
      focus: this.#focus,
      candidates: this.#candidates.length,
      lastAction: this.#lastAction,
      pending: this.#pending?.asked ?? null,
      topic: this.#topic,
    };
  }
}

/**
 * One state per conversation.
 *
 * Held in a map rather than on the conversation record because it is working
 * state and must not be persisted: the store writes conversations to disk, and
 * this is the part that is deliberately forgotten when Helix closes.
 */
export class ConversationStates {
  readonly #states = new Map<string, ConversationState>();

  for(conversationId: string): ConversationState {
    let state = this.#states.get(conversationId);
    if (!state) {
      state = new ConversationState();
      this.#states.set(conversationId, state);
    }
    return state;
  }

  forget(conversationId: string): void {
    this.#states.delete(conversationId);
  }
}
