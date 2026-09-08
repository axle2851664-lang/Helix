import type { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { HelixError } from '../core/HelixError.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import {
  SETTINGS_KEYS,
  SETTINGS_SCHEMA,
  type HelixSettings,
  type SettingsKey,
} from '../settings/schema.js';
import type { ActionDefinition } from './action.js';
import { optionalNumber, readString, readValue } from './action.js';

/**
 * The actions that exist today.
 *
 * The specification lists twenty things Helix should eventually be able to do
 * to its own application. This file holds the ones that are genuinely wired to
 * a working service, and nothing else. An action that returns a plausible
 * result without doing anything is worse than a missing action: the planner
 * will use it, report success, and the user will believe it.
 *
 * So the list is short on purpose, and grows as each capability is actually
 * built rather than in anticipation of it.
 */

/**
 * Settings Helix will not change on its own.
 *
 * Derived rather than listed, so a new privacy or relay setting is protected
 * the moment it is added and not the moment someone remembers to add it here.
 *
 * The important one is `quickActions`: without this rule, "skip confirmation
 * on destructive actions" would itself be a setting an action could turn on,
 * and every confirmation in Helix would be one action call away from being
 * switched off. A permission that can grant itself is not a permission.
 */
export function isProtectedSetting(key: SettingsKey): boolean {
  const field = SETTINGS_SCHEMA[key];
  if (field.section === 'privacy' || field.section === 'relay') return true;
  // Secrets are not settings, but a field that names one must not be writable
  // by a planner even so.
  return /secret|token|password|credential/i.test(key);
}

export const CHANGEABLE_SETTING_KEYS: readonly string[] = SETTINGS_KEYS.filter(
  (key) => !isProtectedSetting(key),
);

export interface BuiltinActionServices {
  settings: SettingsManager;
  knowledge: KnowledgeIndex;
  memory: MemoryManager;
}

function changeSetting(settings: SettingsManager): ActionDefinition {
  return {
    id: 'settings.change',
    label: 'Change a setting',
    group: 'settings',
    summary: 'Change one Helix setting. Privacy, permission and relay settings are not included.',
    parameters: {
      key: {
        type: 'string',
        description: 'Which setting to change.',
        required: true,
        options: CHANGEABLE_SETTING_KEYS,
      },
      value: {
        type: 'value',
        description: 'The new value. Out-of-range numbers are clamped to the allowed range.',
        required: true,
      },
    },
    permission: null,
    // Reversible, visible, and confined to settings that cannot weaken a
    // safeguard. Confirming each one would train the user to click through.
    confirmation: 'none',
    reversible: true,
    appliesTo: ['setting'],
    describe: (params) => {
      const key = readString(params, 'key') as SettingsKey;
      return `Set "${SETTINGS_SCHEMA[key].label}" to ${String(readValue(params, 'value'))}.`;
    },
    run: async (params) => {
      const key = readString(params, 'key') as SettingsKey;
      if (isProtectedSetting(key)) {
        // Unreachable through `run`, because the parameter options exclude
        // these. Kept so the rule survives someone widening the options.
        throw new HelixError('PERMISSION_DENIED', 'That setting can only be changed by you.', {
          remedy: 'settings:privacy',
          technical: `Refused a protected setting: ${key}`,
        });
      }

      // SettingsManager validates and coerces; the cast is the boundary
      // between a runtime key and the compile-time settings type.
      const applied = await settings.set(key, readValue(params, 'value') as HelixSettings[typeof key]);
      return {
        message: `"${SETTINGS_SCHEMA[key].label}" is now ${String(applied)}.`,
        data: { key, value: applied },
      };
    },
  };
}

function searchFiles(knowledge: KnowledgeIndex): ActionDefinition {
  return {
    id: 'knowledge.search',
    label: 'Search files',
    group: 'knowledge',
    summary: 'Keyword search across the documents Helix has indexed.',
    parameters: {
      query: {
        type: 'string',
        description: 'What to look for.',
        required: true,
        maxLength: 200,
      },
      limit: {
        type: 'number',
        description: 'How many passages to return.',
        required: false,
        min: 1,
        max: 50,
      },
      projectId: {
        type: 'string',
        description: 'Restrict the search to one project.',
        required: false,
        maxLength: 100,
      },
    },
    permission: 'FILES_READ',
    confirmation: 'none',
    reversible: true,
    appliesTo: ['file', 'project'],
    describe: (params) => `Search your indexed files for "${readString(params, 'query')}".`,
    run: async (params) => {
      const query = readString(params, 'query');
      const limit = optionalNumber(params, 'limit');
      const projectId = params['projectId'];

      const hits = await knowledge.search(query, {
        ...(limit !== undefined ? { limit } : {}),
        ...(typeof projectId === 'string' ? { projectId } : {}),
      });

      return {
        // Says what was searched, so an empty result is not read as "you have
        // no files" when it means "nothing indexed matched".
        message:
          hits.length === 0
            ? `Nothing in your indexed files matches "${query}".`
            : `${hits.length} passage${hits.length === 1 ? '' : 's'} in your indexed files match "${query}".`,
        data: hits,
      };
    },
  };
}

function forgetMemory(memory: MemoryManager): ActionDefinition {
  const preview = (content: string): string =>
    content.length <= 80 ? content : `${content.slice(0, 77)}...`;

  return {
    id: 'memory.forget',
    label: 'Forget',
    group: 'memory',
    summary: 'Delete one thing Helix remembers about you.',
    parameters: {
      id: {
        type: 'string',
        description: 'Which memory to delete.',
        required: true,
        maxLength: 100,
      },
    },
    permission: null,
    confirmation: 'destructive',
    // Nothing restores it. The confirmation says so.
    reversible: false,
    appliesTo: ['memory'],
    describe: async (params) => {
      const id = readString(params, 'id');
      const record = await memory.get(id);
      // The confirmation shows the memory itself. An id is not something a
      // person can judge, and a confirmation nobody can judge is a formality.
      return record ? `Forget: "${preview(record.content)}"` : 'Forget a memory that no longer exists.';
    },
    run: async (params) => {
      const id = readString(params, 'id');
      const record = await memory.get(id);
      if (!record) {
        throw new HelixError('NOT_FOUND', 'Helix has no memory like that to forget.', {
          technical: `No memory record with id ${id}`,
        });
      }

      await memory.delete(id);
      return { message: `Forgotten: "${preview(record.content)}"` };
    },
  };
}

export function builtinActions(services: BuiltinActionServices): ActionDefinition[] {
  return [
    changeSetting(services.settings),
    searchFiles(services.knowledge),
    forgetMemory(services.memory),
  ];
}
