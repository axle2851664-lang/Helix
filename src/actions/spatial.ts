import { HelixError } from '../core/HelixError.js';
import type { SpatialObject, SpatialScene } from '../spatial/SpatialScene.js';
import type { ActionDefinition } from './action.js';
import { readString } from './action.js';

/**
 * What can be done to an object on the spatial stage (spec 4, 5, 12).
 *
 * These are bound to one scene, so they are registered when the spatial
 * workspace opens and removed when it closes. That is what lets the palm-out
 * menu ask the registry "what applies to this?" rather than carrying its own
 * hardcoded list - which is the specification's rule that only compatible
 * actions are shown, made true rather than asserted.
 *
 * The specification's menu also names Open, Close, Minimize, Pin, Share, Save,
 * Rename, Send to Helix and Export. None of those is here, because none of
 * them does anything to a stage object today. An action registered here would
 * appear in the menu and be clickable, and a menu item that does nothing is
 * worse than a missing one.
 */

function objectOr404(scene: SpatialScene, id: string): SpatialObject {
  const object = scene.get(id);
  if (!object) {
    throw new HelixError('NOT_FOUND', 'That object is no longer on the stage.', {
      technical: `No spatial object with id ${id}`,
    });
  }
  return object;
}

const objectIdParam = {
  objectId: {
    type: 'string' as const,
    description: 'Which object on the stage.',
    required: true,
    maxLength: 100,
  },
};

export function spatialActions(scene: SpatialScene): ActionDefinition[] {
  const nameOf = (id: string): string => scene.get(id)?.label ?? 'that object';

  return [
    {
      id: 'spatial.duplicate',
      label: 'Duplicate',
      group: 'workspace',
      summary: 'Make a copy of an object on the stage.',
      parameters: objectIdParam,
      permission: null,
      confirmation: 'none',
      reversible: true,
      appliesTo: ['spatial-object'],
      describe: (params) => `Duplicate "${nameOf(readString(params, 'objectId'))}".`,
      run: async (params) => {
        const id = readString(params, 'objectId');
        objectOr404(scene, id);
        const copy = scene.duplicate(id);
        if (!copy) throw new HelixError('INTERNAL', 'That could not be duplicated.');
        return { message: `Duplicated "${copy.label}".`, data: { objectId: copy.id } };
      },
    },

    {
      id: 'spatial.delete',
      label: 'Delete',
      group: 'workspace',
      summary: 'Take an object off the stage.',
      parameters: objectIdParam,
      permission: null,
      // The specification's own example of an action that must be confirmed,
      // and the reason the dwell exists: a gesture must not be one slip away
      // from destroying an arrangement.
      confirmation: 'destructive',
      // Nothing puts it back where it was. The file is untouched, but the
      // position, size and rotation are gone.
      reversible: false,
      appliesTo: ['spatial-object'],
      describe: (params) =>
        // Says exactly how far the deletion reaches. Someone who reads this as
        // "my photo is being deleted" would answer a different question from
        // the one being asked.
        `Take "${nameOf(readString(params, 'objectId'))}" off the stage. The file itself is not deleted.`,
      run: async (params) => {
        const id = readString(params, 'objectId');
        const object = objectOr404(scene, id);
        scene.remove(id);
        return { message: `"${object.label}" is off the stage.` };
      },
    },

    {
      id: 'spatial.bringToFront',
      label: 'Bring to front',
      group: 'workspace',
      summary: 'Put an object in front of the others.',
      parameters: objectIdParam,
      permission: null,
      confirmation: 'none',
      reversible: true,
      appliesTo: ['spatial-object'],
      describe: (params) => `Bring "${nameOf(readString(params, 'objectId'))}" to the front.`,
      run: async (params) => {
        const id = readString(params, 'objectId');
        const object = objectOr404(scene, id);
        scene.bringToFront(id);
        return { message: `"${object.label}" is at the front.` };
      },
    },

    {
      id: 'spatial.resetSize',
      label: 'Reset size',
      group: 'workspace',
      summary: 'Return an object to its natural size and rotation.',
      parameters: objectIdParam,
      permission: null,
      confirmation: 'none',
      reversible: true,
      appliesTo: ['spatial-object'],
      describe: (params) =>
        `Return "${nameOf(readString(params, 'objectId'))}" to its natural size and rotation.`,
      run: async (params) => {
        const id = readString(params, 'objectId');
        const object = objectOr404(scene, id);
        scene.setScale(id, 1);
        scene.setRotation(id, 0);
        return { message: `"${object.label}" is back to its natural size.` };
      },
    },
  ];
}

/** The ids above, for unregistering when the spatial workspace closes. */
export const SPATIAL_ACTION_IDS: readonly string[] = [
  'spatial.duplicate',
  'spatial.delete',
  'spatial.bringToFront',
  'spatial.resetSize',
];
