import type { PermissionId } from '../security/permissions.js';

/**
 * What an action is, declared as data (spec 5).
 *
 * The specification's rule is that Helix "must use a centralized ACTION / TOOL
 * system rather than directly modifying arbitrary UI state", and that every
 * action carries a name, parameters, a permission requirement, a confirmation
 * requirement, a result and error handling. All six live on this type, which is
 * the point: they cannot be remembered at one call site and forgotten at
 * another.
 *
 * Two decisions here are worth arguing for, because the loose version of each
 * is what usually ships:
 *
 * - **Parameters are declared and validated, and unknown ones are rejected.**
 *   An action's parameters do not arrive from a form. They arrive from a
 *   language model that has been asked to plan, which means they are untrusted
 *   input that happens to look structured. Ignoring a parameter the action does
 *   not understand is how `{ path, recursive: true }` gets handed to a delete
 *   that quietly drops `recursive` and reports success.
 *
 * - **`describe()` is required, and is built from the parameters.** A
 *   confirmation that says "Delete this file?" is a confirmation people learn
 *   to click through. The description states what will actually happen, in
 *   full - the same rule the outbound drafts already follow, where recipients
 *   are listed rather than counted.
 */

export type ActionParamValue = string | number | boolean | readonly string[];
export type ActionParams = Readonly<Record<string, ActionParamValue>>;

/**
 * `value` accepts any single scalar. It exists for the one honest case -
 * changing a setting, where the type depends on which setting - and not as a
 * general escape hatch from declaring what a parameter is.
 */
export type ParameterType = 'string' | 'number' | 'boolean' | 'string[]' | 'value';

export interface ParameterSpec {
  type: ParameterType;
  /** What it means, for the planner and for the Settings list of actions. */
  description: string;
  required: boolean;
  /** The only accepted values, when the parameter is a choice. */
  options?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

/**
 * When the user must confirm.
 *
 * The three are not a severity scale, they are three different promises:
 *
 * - `none` - reversible, and cheap to undo if it was not what was meant.
 * - `destructive` - confirmed by default, and skippable *only* when the user
 *   has explicitly turned on quick actions. This is the case the specification
 *   names: "Destructive actions such as Delete must require confirmation unless
 *   the user has explicitly enabled a trusted/quick-action mode."
 * - `always` - confirmed however Helix is configured. Anything that leaves the
 *   machine or reaches another person lives here, because the standing rule for
 *   outbound is that there is no bulk approval and no remembered permission,
 *   and a settings toggle must not be able to weaken it.
 */
export type ConfirmationRule = 'none' | 'destructive' | 'always';

/**
 * What kind of thing an action applies to.
 *
 * The palm-out context menu (spec 4) shows only the actions compatible with
 * the selected object, so compatibility has to be a property of the action
 * rather than a switch statement in the menu.
 */
export type ActionTarget =
  | 'none'
  | 'file'
  | 'note'
  | 'panel'
  | 'project'
  | 'conversation'
  | 'memory'
  | 'spatial-object'
  | 'setting';

export type ActionGroup =
  | 'files'
  | 'knowledge'
  | 'memory'
  | 'workspace'
  | 'settings'
  | 'media'
  | 'system';

/** What a successful run reports back. */
export interface ActionOutcome {
  /** One line for the user. Plain, and true of what actually happened. */
  message: string;
  /** Anything the caller needs, e.g. search hits. Never required. */
  data?: unknown;
}

export interface ActionDefinition {
  /** Stable, namespaced: `group.verb`. Referred to by the planner. */
  id: string;
  label: string;
  group: ActionGroup;
  /** One sentence for the planner and the action list. */
  summary: string;
  parameters: Readonly<Record<string, ParameterSpec>>;
  /** The permission this needs, or null when it needs none. */
  permission: PermissionId | null;
  confirmation: ConfirmationRule;
  /** False when there is no way back. Shown in the confirmation. */
  reversible: boolean;
  /** Targets this can be offered for. Empty means it is never in a menu. */
  appliesTo: readonly ActionTarget[];
  /**
   * Exactly what is about to happen, built from the parameters.
   *
   * May be async, because a useful description often needs a lookup: "Forget:
   * the dentist is on Thursday" is a confirmation someone can actually judge,
   * and "Forget memory mem_8f3c" is not.
   */
  describe(params: ActionParams): string | Promise<string>;
  run(params: ActionParams): Promise<ActionOutcome>;
}

export type ValidationResult =
  | { ok: true; params: ActionParams }
  | { ok: false; problem: string };

function typeOfValue(value: unknown): ParameterType | 'unsupported' {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return 'string[]';
  return 'unsupported';
}

/**
 * Check arguments against an action's declared parameters.
 *
 * Reports the first problem rather than collecting all of them: the caller is
 * usually a planner that will retry, and one precise correction is more use
 * than a list.
 */
export function validateParams(
  action: ActionDefinition,
  raw: unknown,
): ValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: 'Parameters must be given as an object.' };
  }

  const source = raw as Record<string, unknown>;
  const declared = action.parameters;

  for (const name of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(declared, name)) {
      // Never ignored. An unrecognised parameter means the caller believes the
      // action does something it does not do.
      return { ok: false, problem: `"${action.id}" has no parameter called "${name}".` };
    }
  }

  const params: Record<string, ActionParamValue> = {};

  for (const [name, spec] of Object.entries(declared)) {
    const value = source[name];

    if (value === undefined || value === null) {
      if (spec.required) return { ok: false, problem: `"${name}" is required.` };
      continue;
    }

    const actual = typeOfValue(value);
    if (spec.type === 'value') {
      if (actual === 'unsupported' || actual === 'string[]') {
        return { ok: false, problem: `"${name}" must be a single text, number or true/false value.` };
      }
      params[name] = value as ActionParamValue;
      continue;
    }
    if (actual !== spec.type) {
      return {
        ok: false,
        problem: `"${name}" must be ${spec.type === 'string[]' ? 'a list of text values' : `a ${spec.type}`}.`,
      };
    }

    if (spec.type === 'number') {
      const numeric = value as number;
      if (!Number.isFinite(numeric)) {
        return { ok: false, problem: `"${name}" must be a real number.` };
      }
      // Out of range is refused, not clamped. A parameter is not a preference:
      // quietly changing it would run an action nobody asked for.
      if (spec.min !== undefined && numeric < spec.min) {
        return { ok: false, problem: `"${name}" must be at least ${spec.min}.` };
      }
      if (spec.max !== undefined && numeric > spec.max) {
        return { ok: false, problem: `"${name}" must be at most ${spec.max}.` };
      }
    }

    if (spec.type === 'string') {
      const text = value as string;
      if (spec.maxLength !== undefined && text.length > spec.maxLength) {
        return { ok: false, problem: `"${name}" is longer than ${spec.maxLength} characters.` };
      }
      if (spec.options && !spec.options.includes(text)) {
        // A long list of options is not a useful error message, so past a
        // handful it says how many rather than reciting them.
        return {
          ok: false,
          problem:
            spec.options.length > 8
              ? `"${text}" is not one of the ${spec.options.length} values "${name}" accepts.`
              : `"${name}" must be one of: ${spec.options.join(', ')}.`,
        };
      }
    }

    params[name] = value as ActionParamValue;
  }

  return { ok: true, params };
}

/**
 * Typed readers for validated parameters.
 *
 * Validation has already proved the types, so these exist to express that
 * without a cast at every use. They throw rather than return a default: a
 * missing required parameter here means validation was skipped, which is a
 * programming error and not something to paper over at runtime.
 */
export function readString(params: ActionParams, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw new Error(`Parameter "${name}" is not a string.`);
  return value;
}

export function optionalString(params: ActionParams, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' ? value : undefined;
}

export function optionalNumber(params: ActionParams, name: string): number | undefined {
  const value = params[name];
  return typeof value === 'number' ? value : undefined;
}

export function readValue(params: ActionParams, name: string): ActionParamValue {
  const value = params[name];
  if (value === undefined) throw new Error(`Parameter "${name}" is missing.`);
  return value;
}
