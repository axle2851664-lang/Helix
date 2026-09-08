import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../core/Logger.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { SpatialScene } from '../spatial/SpatialScene.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { ActionRegistry } from './ActionRegistry.js';
import { ActionRunner, type ActionConfirmer } from './ActionRunner.js';
import { SPATIAL_ACTION_IDS, spatialActions } from './spatial.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

function stage(options: { confirmer?: ActionConfirmer; quickActions?: boolean } = {}) {
  const scene = new SpatialScene();
  const registry = new ActionRegistry();
  registry.registerAll(spatialActions(scene));
  const runner = new ActionRunner({
    registry,
    permissions: new PermissionManager({ store: new MemoryKeyValueStore(), logger: silentLogger() }),
    logger: silentLogger(),
    quickActions: () => options.quickActions ?? false,
    ...(options.confirmer ? { confirmer: options.confirmer } : {}),
  });
  const object = scene.add({ label: 'Hat.png', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
  return { scene, registry, runner, object };
}

describe('what the palm-out menu offers', () => {
  it('offers exactly the actions that apply to a stage object', () => {
    const { registry } = stage();
    expect(registry.forTarget('spatial-object').map((action) => action.id).sort()).toEqual(
      [...SPATIAL_ACTION_IDS].sort(),
    );
  });

  it('does not offer actions belonging to something else', () => {
    const { registry } = stage();
    const ids = registry.forTarget('spatial-object').map((action) => action.id);
    expect(ids).not.toContain('memory.forget');
    expect(registry.forTarget('memory')).toEqual([]);
  });

  it('marks only the destructive one as destructive', () => {
    const { registry } = stage();
    const irreversible = registry
      .forTarget('spatial-object')
      .filter((action) => !action.reversible)
      .map((action) => action.id);
    expect(irreversible).toEqual(['spatial.delete']);
  });
});

describe('deleting from the menu', () => {
  it('asks first, naming the object and the limit of what is deleted', async () => {
    let description = '';
    const { runner, object, scene } = stage({
      confirmer: async (request) => {
        description = request.description;
        return true;
      },
    });

    const result = await runner.run('spatial.delete', { objectId: object.id });

    expect(description).toBe('Take "Hat.png" off the stage. The file itself is not deleted.');
    expect(result.status).toBe('ok');
    expect(scene.objects).toHaveLength(0);
  });

  it('leaves the object alone when the confirmation is declined', async () => {
    const { runner, object, scene } = stage({ confirmer: async () => false });

    const result = await runner.run('spatial.delete', { objectId: object.id });

    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
    expect(scene.objects).toHaveLength(1);
  });

  it('will not delete when there is nothing to ask with', async () => {
    const { runner, object, scene } = stage();

    const result = await runner.run('spatial.delete', { objectId: object.id });

    expect(result.status === 'refused' && result.reason).toBe('cannot-ask');
    expect(scene.objects).toHaveLength(1);
  });

  it('skips the confirmation only once quick actions are on', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner, object, scene } = stage({ confirmer, quickActions: true });

    await runner.run('spatial.delete', { objectId: object.id });

    expect(confirmer).not.toHaveBeenCalled();
    expect(scene.objects).toHaveLength(0);
  });
});

describe('the reversible actions', () => {
  it('duplicates without asking', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner, object, scene } = stage({ confirmer });

    const result = await runner.run('spatial.duplicate', { objectId: object.id });

    expect(result.status).toBe('ok');
    expect(confirmer).not.toHaveBeenCalled();
    expect(scene.objects).toHaveLength(2);
    // Offset, so the copy is visibly distinct from the original.
    expect(scene.objects[1]?.x).not.toBe(scene.objects[0]?.x);
  });

  it('brings an object to the front', async () => {
    const { runner, scene, object } = stage();
    const second = scene.add({ label: 'B.png', x: 0.2, y: 0.2, scale: 1, rotation: 0 });
    expect(scene.objects[1]?.id).toBe(second.id);

    await runner.run('spatial.bringToFront', { objectId: object.id });
    expect(scene.objects[1]?.id).toBe(object.id);
  });

  it('returns an object to its natural size and rotation', async () => {
    const { runner, scene, object } = stage();
    scene.setScale(object.id, 3);
    scene.setRotation(object.id, 1.2);

    await runner.run('spatial.resetSize', { objectId: object.id });

    expect(scene.get(object.id)?.scale).toBe(1);
    expect(scene.get(object.id)?.rotation).toBe(0);
  });
});

describe('an object that has gone', () => {
  it('says so rather than failing silently', async () => {
    const { runner } = stage({ confirmer: async () => true });
    const result = await runner.run('spatial.duplicate', { objectId: 'obj_gone' });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toBe(
      'That object is no longer on the stage.',
    );
  });

  it('refuses an object id that is not a string', async () => {
    const { runner } = stage();
    const result = await runner.run('spatial.delete', { objectId: 42 });
    expect(result.status === 'refused' && result.reason).toBe('bad-parameters');
  });
});

describe('the registry lets go of a closed stage', () => {
  it('removes the actions, so nothing can act on a scene nobody can see', () => {
    const { registry } = stage();
    registry.unregisterAll(SPATIAL_ACTION_IDS);

    expect(registry.forTarget('spatial-object')).toEqual([]);
    expect(registry.has('spatial.delete')).toBe(false);
  });
});
