import type { ConfirmationRequest } from '../../actions/ActionRunner.js';
import type { PermissionPrompt } from '../../security/PermissionManager.js';

/**
 * The questions Helix has to ask before it may act, held in one queue.
 *
 * Both gates - "may I use your microphone" and "shall I delete this" - end up
 * here, because from the user's side they are the same interruption and two
 * competing dialog systems would eventually both be on screen at once.
 *
 * The rules are all about what happens when things go wrong:
 *
 * - **One at a time.** A second question waits rather than replacing the first.
 *   A dialog that is swapped out from under someone gets the answer they meant
 *   for the previous question.
 *
 * - **Answers are matched to the question by id.** A click that lands after the
 *   queue has moved on is discarded, not applied to whatever is now in front.
 *
 * - **Closing refuses.** When the gate goes away - the window is closing, the
 *   component unmounts - every outstanding question resolves as "no". An
 *   unanswered question is not consent, and the caller is still waiting on a
 *   promise that has to settle.
 */

export type ConsentKind = 'permission' | 'action';

export interface ConsentRequest {
  id: number;
  kind: ConsentKind;
  /** The capability or the action, named as the user would name it. */
  title: string;
  /** What will happen, or what is being asked for. */
  detail: string;
  /** Why Helix is asking, right now. Null when the detail says it already. */
  reason: string | null;
  /** The thing the user most needs to know before answering. */
  note: string | null;
  allowLabel: string;
  denyLabel: string;
  /** Irreversible, or reaching outside Helix. Styles the button accordingly. */
  danger: boolean;
}

type PendingEntry = { request: ConsentRequest; settle: (allowed: boolean) => void };

export class ConsentQueue {
  #queue: PendingEntry[] = [];
  #nextId = 1;
  readonly #listeners = new Set<() => void>();
  #closed = false;

  /** The question on screen, or null when there is nothing to ask. */
  get current(): ConsentRequest | null {
    return this.#queue[0]?.request ?? null;
  }

  /** How many are waiting behind it. */
  get waiting(): number {
    return Math.max(0, this.#queue.length - 1);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  ask(request: Omit<ConsentRequest, 'id'>): Promise<boolean> {
    if (this.#closed) {
      // Nothing can be shown, so nothing can be agreed to.
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      this.#queue.push({
        request: { ...request, id: this.#nextId++ },
        settle: (allowed) => {
          // A question is answered once. Belt and braces against a double
          // click racing the queue advance.
          if (settled) return;
          settled = true;
          resolve(allowed);
        },
      });
      this.#notify();
    });
  }

  /**
   * Answer the question with this id.
   *
   * Ignores an id that is not currently being asked, which is what makes a
   * late click harmless rather than an answer to the wrong question.
   */
  answer(id: number, allowed: boolean): void {
    const head = this.#queue[0];
    if (!head || head.request.id !== id) return;
    this.#queue.shift();
    head.settle(allowed);
    this.#notify();
  }

  /** Refuse everything outstanding. Used when nothing can ask any more. */
  close(): void {
    this.#closed = true;
    const outstanding = this.#queue;
    this.#queue = [];
    for (const entry of outstanding) entry.settle(false);
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * A permission prompt, in the user's terms.
 *
 * `secondGate` is carried through deliberately. Telling someone their answer
 * here is the whole decision, when the operating system is about to ask them
 * again, is how "I already allowed that" turns into a bug report.
 */
export function permissionConsent(prompt: PermissionPrompt): Omit<ConsentRequest, 'id'> {
  const { permission, reason } = prompt;
  return {
    kind: 'permission',
    title: permission.label,
    detail: permission.description,
    reason,
    note:
      permission.secondGate === null
        ? null
        : `Allowing this is not the whole decision: ${permission.secondGate} will ask you separately.`,
    allowLabel: 'Allow',
    denyLabel: 'Not now',
    danger: permission.risk === 'high',
  };
}

/**
 * An action confirmation.
 *
 * The detail is the action's own description, built from its real parameters,
 * so what is confirmed is the specific thing rather than its category.
 */
export function actionConsent(request: ConfirmationRequest): Omit<ConsentRequest, 'id'> {
  return {
    kind: 'action',
    title: request.action.label,
    detail: request.description,
    reason: null,
    note: request.reversible ? null : 'This cannot be undone.',
    allowLabel: request.reversible ? 'Yes, do it' : request.action.label,
    denyLabel: 'Cancel',
    danger: !request.reversible,
  };
}
