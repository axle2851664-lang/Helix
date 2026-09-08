import type { ActionDefinition, ActionGroup, ActionTarget } from './action.js';

/**
 * Every action Helix can perform, in one place (spec 5).
 *
 * The registry exists so that "what can Helix do?" has an answer that is
 * computed rather than remembered. The palm-out context menu asks it what
 * applies to the selected object; the planner asks it what exists at all; the
 * Settings screen can list it. None of those needs its own list, and none of
 * them can drift from the others.
 *
 * Registration is strict about duplicate ids. Two actions answering to the
 * same name is not a merge conflict that resolves itself sensibly - it is a
 * planner asking for `files.delete` and getting whichever one loaded last.
 */
export class ActionRegistry {
  readonly #actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    if (this.#actions.has(action.id)) {
      throw new Error(`An action called "${action.id}" is already registered.`);
    }
    this.#actions.set(action.id, action);
  }

  registerAll(actions: readonly ActionDefinition[]): void {
    for (const action of actions) this.register(action);
  }

  /**
   * Remove an action.
   *
   * Needed because some actions are bound to something with a shorter life
   * than the registry: the spatial ones hold a scene that exists only while
   * that workspace is open. Leaving them registered would mean a menu, or a
   * planner, offering an action against a scene nobody can see.
   */
  unregister(id: string): boolean {
    return this.#actions.delete(id);
  }

  unregisterAll(ids: readonly string[]): void {
    for (const id of ids) this.#actions.delete(id);
  }

  get(id: string): ActionDefinition | undefined {
    return this.#actions.get(id);
  }

  has(id: string): boolean {
    return this.#actions.has(id);
  }

  get size(): number {
    return this.#actions.size;
  }

  /** Every action, in registration order. */
  list(): ActionDefinition[] {
    return [...this.#actions.values()];
  }

  ids(): string[] {
    return [...this.#actions.keys()];
  }

  byGroup(group: ActionGroup): ActionDefinition[] {
    return this.list().filter((action) => action.group === group);
  }

  /**
   * The actions that make sense for a selected object.
   *
   * This is the whole of the context menu's filtering rule from the
   * specification: an action that cannot apply is not shown greyed out, it is
   * not shown. A menu offering Duplicate on something that cannot be
   * duplicated teaches the user that the menu is decorative.
   */
  forTarget(target: ActionTarget): ActionDefinition[] {
    return this.list().filter((action) => action.appliesTo.includes(target));
  }
}
