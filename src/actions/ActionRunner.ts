import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { PermissionManager } from '../security/PermissionManager.js';
import { describePermission } from '../security/permissions.js';
import type { ActionDefinition, ConfirmationRule } from './action.js';
import { validateParams } from './action.js';
import type { ActionRegistry } from './ActionRegistry.js';

/** Why an action did not run. Each maps to a different thing to do about it. */
export type RefusalReason =
  | 'unknown-action'
  | 'bad-parameters'
  | 'permission'
  | 'not-confirmed'
  | 'cannot-ask';

export type ActionResult =
  | { status: 'ok'; action: string; message: string; data?: unknown }
  | { status: 'refused'; action: string; reason: RefusalReason; message: string }
  | { status: 'failed'; action: string; message: string };

/** What the user is being asked to approve. */
export interface ConfirmationRequest {
  action: ActionDefinition;
  /** Exactly what will happen, in full. Never a count, never a summary. */
  description: string;
  /** False when there is no way back, so the prompt can say so. */
  reversible: boolean;
}

export type ActionConfirmer = (request: ConfirmationRequest) => Promise<boolean>;

export interface ActionRunnerOptions {
  registry: ActionRegistry;
  permissions: PermissionManager;
  logger: Logger;
  bus?: EventBus;
  confirmer?: ActionConfirmer;
  /**
   * Whether the user has explicitly turned on quick actions. Read fresh on
   * every run, so turning it off takes effect immediately rather than at the
   * next restart.
   */
  quickActions?: () => boolean;
}

const RULE_RANK: Record<ConfirmationRule, number> = { none: 0, destructive: 1, always: 2 };

function stricter(a: ConfirmationRule, b: ConfirmationRule): ConfirmationRule {
  return RULE_RANK[a] >= RULE_RANK[b] ? a : b;
}

/**
 * The pipeline every action goes through (spec 5).
 *
 *     request -> parameters -> permission -> confirmation -> execute -> result
 *
 * Four things this class refuses to do, each because the alternative is a
 * failure that looks like success:
 *
 * - **It never throws at the caller.** Every path returns an `ActionResult`
 *   with a status the caller has to look at. A planner that ignores a thrown
 *   error and reports "done" is the exact outcome this shape prevents.
 *
 * - **It checks permission before asking for confirmation.** Making someone
 *   read and approve a deletion Helix is not allowed to perform spends their
 *   attention on a question that could not matter.
 *
 * - **It fails closed when it cannot ask.** No confirmer registered means the
 *   action is refused, not performed. A confirmation nobody was shown is not a
 *   confirmation.
 *
 * - **It does not log parameters.** Every run is logged, because an assistant
 *   that acts on your behalf needs a record of what it did. Parameters carry
 *   note text, file paths and recipients, so the record names the action and
 *   its outcome and stops there.
 */
export class ActionRunner {
  readonly #registry: ActionRegistry;
  readonly #permissions: PermissionManager;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #quickActions: () => boolean;
  #confirmer: ActionConfirmer | undefined;

  constructor(options: ActionRunnerOptions) {
    this.#registry = options.registry;
    this.#permissions = options.permissions;
    this.#logger = options.logger.child('actions');
    this.#bus = options.bus;
    this.#confirmer = options.confirmer;
    this.#quickActions = options.quickActions ?? (() => false);
  }

  /** Register the thing that asks. The UI mounts after the kernel starts. */
  setConfirmer(confirmer: ActionConfirmer | undefined): void {
    this.#confirmer = confirmer;
  }

  get canConfirm(): boolean {
    return this.#confirmer !== undefined;
  }

  /**
   * How this action would be confirmed right now.
   *
   * The permission catalogue sets a floor: a permission marked as needing
   * confirmation for each use cannot be attached to an action that confirms
   * nothing. The action may raise that floor but never lower it - which is how
   * `files.delete` inherits confirmation from `FILES_DELETE` without every
   * future file action having to remember to ask.
   */
  confirmationFor(action: ActionDefinition): ConfirmationRule {
    const floor: ConfirmationRule =
      action.permission !== null && describePermission(action.permission).alwaysConfirm
        ? 'destructive'
        : 'none';
    return stricter(action.confirmation, floor);
  }

  /** True when this particular run must be confirmed by the user. */
  requiresConfirmation(action: ActionDefinition): boolean {
    const rule = this.confirmationFor(action);
    if (rule === 'none') return false;
    if (rule === 'always') return true;
    // `destructive` is the one the specification lets quick actions skip.
    return !this.#quickActions();
  }

  async run(id: string, rawParams: unknown = {}): Promise<ActionResult> {
    const action = this.#registry.get(id);
    if (!action) {
      return this.#refuse(id, 'unknown-action', `Helix has no action called "${id}".`);
    }

    const validation = validateParams(action, rawParams);
    if (!validation.ok) {
      return this.#refuse(id, 'bad-parameters', validation.problem);
    }
    const params = validation.params;

    let description: string;
    try {
      description = await action.describe(params);
    } catch (error) {
      this.#logger.error('An action could not describe itself; refusing to run it.', error);
      return this.#refuse(
        id,
        'bad-parameters',
        'Helix could not work out what that would do, so it did not do it.',
      );
    }

    if (action.permission !== null) {
      try {
        // The reason is the description, so the prompt says what it is for at
        // the moment of need rather than naming a capability in the abstract.
        await this.#permissions.require(action.permission, description);
      } catch (error) {
        const message =
          error instanceof HelixError
            ? error.userMessage
            : 'Helix does not have permission to do that.';
        return this.#refuse(id, 'permission', message);
      }
    }

    if (this.requiresConfirmation(action)) {
      const confirmer = this.#confirmer;
      if (!confirmer) {
        this.#logger.error('An action needed confirming but nothing can ask for it.', {
          action: id,
        });
        return this.#refuse(
          id,
          'cannot-ask',
          'That needs confirming, and Helix has no way to ask you right now.',
        );
      }

      let approved: boolean;
      try {
        approved = await confirmer({ action, description, reversible: action.reversible });
      } catch (error) {
        // A prompt that failed is a question that was not answered.
        this.#logger.error('The confirmation prompt failed; treating it as unanswered.', error);
        return this.#refuse(id, 'not-confirmed', 'That was not confirmed, so nothing happened.');
      }

      if (!approved) {
        return this.#refuse(id, 'not-confirmed', 'Cancelled. Nothing was changed.');
      }
    }

    try {
      const outcome = await action.run(params);
      this.#settled(id, 'ok');
      return {
        status: 'ok',
        action: id,
        message: outcome.message,
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    } catch (error) {
      // The action ran and something went wrong inside it. That is a different
      // answer from "refused", and the caller is told which.
      this.#logger.error(`Action "${id}" failed.`, error);
      this.#settled(id, 'failed');
      return {
        status: 'failed',
        action: id,
        message:
          error instanceof HelixError
            ? error.userMessage
            : 'That did not work. The details are in the log.',
      };
    }
  }

  #refuse(id: string, reason: RefusalReason, message: string): ActionResult {
    this.#settled(id, 'refused', reason);
    return { status: 'refused', action: id, reason, message };
  }

  #settled(id: string, status: 'ok' | 'refused' | 'failed', reason?: RefusalReason): void {
    this.#logger.info('Action ' + status + '.', {
      action: id,
      ...(reason !== undefined ? { reason } : {}),
    });
    this.#bus?.emit('ACTION_PERFORMED', {
      action: id,
      status,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}
