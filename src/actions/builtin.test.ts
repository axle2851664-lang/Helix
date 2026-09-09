import { describe, expect, it } from 'vitest';
import { Logger } from '../core/Logger.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { PermissionManager, type PermissionPrompter } from '../security/PermissionManager.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ActionRegistry } from './ActionRegistry.js';
import { ActionRunner, type ActionConfirmer } from './ActionRunner.js';
import { builtinActions } from './builtin.js';

/**
 * These run the built-in actions against the real managers rather than mocks.
 * An action that passes against a stub proves the pipeline; only this proves
 * the action actually does what it says.
 */
const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

const allow: PermissionPrompter = async () => 'allow';

async function harness(options: { confirmer?: ActionConfirmer; prompter?: PermissionPrompter } = {}) {
  const store = new MemoryKeyValueStore();
  const logger = silentLogger();
  const settings = new SettingsManager({ store, logger });
  await settings.load();

  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store, logger, paths });
  const knowledge = new KnowledgeIndex({ store, projects, logger });
  const memory = new MemoryManager({ store, settings, logger });

  const permissions = new PermissionManager({
    store,
    logger,
    prompter: options.prompter ?? allow,
  });

  const registry = new ActionRegistry();
  registry.registerAll(builtinActions({ settings, knowledge, memory }));

  const runner = new ActionRunner({
    registry,
    permissions,
    logger,
    quickActions: () => settings.get('quickActions'),
    ...(options.confirmer ? { confirmer: options.confirmer } : {}),
  });

  return { runner, registry, settings, memory, knowledge, projects, permissions };
}

describe('settings.change', () => {
  it('actually changes the setting', async () => {
    const { runner, settings } = await harness();
    const result = await runner.run('settings.change', { key: 'theme', value: 'midnight' });

    expect(result.status).toBe('ok');
    expect(settings.get('theme')).toBe('midnight');
  });

  it('reports the value that was applied, not the one that was asked for', async () => {
    const { runner, settings } = await harness();
    // SettingsManager clamps to the field's range; the message must not claim
    // the requested number was used.
    const result = await runner.run('settings.change', { key: 'storageLimitGb', value: 9000 });

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.message).toContain(String(settings.get('storageLimitGb')));
    expect(settings.get('storageLimitGb')).not.toBe(9000);
  });

  it('refuses to touch a privacy setting', async () => {
    const { runner, settings } = await harness();
    const result = await runner.run('settings.change', {
      key: 'allowComputerControl',
      value: true,
    });

    expect(result.status === 'refused' && result.reason).toBe('bad-parameters');
    expect(settings.get('allowComputerControl')).toBe(false);
  });

  it('cannot turn on quick actions to escape its own confirmations', async () => {
    const { runner, settings } = await harness();
    const result = await runner.run('settings.change', { key: 'quickActions', value: true });

    expect(result.status).toBe('refused');
    expect(settings.get('quickActions')).toBe(false);
  });
});

describe('knowledge.search', () => {
  it('searches the real index once permission is given', async () => {
    const { runner, projects, knowledge } = await harness();
    const project = await projects.createProject('Notes');
    const file = await projects.addFileToProject({
      projectId: project.id,
      file: { name: 'tax.md', size: 40, type: 'text/plain' },
      data: new TextEncoder().encode('The quarterly tax return is due in April.').buffer as ArrayBuffer,
    });
    await knowledge.indexAsset(file.id);

    const result = await runner.run('knowledge.search', { query: 'tax return' });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && Array.isArray(result.data) && result.data.length).toBeGreaterThan(0);
  });

  it('says nothing matched rather than implying there are no files', async () => {
    const { runner } = await harness();
    const result = await runner.run('knowledge.search', { query: 'submarines' });

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.message).toBe(
      'Nothing in your indexed files matches "submarines".',
    );
  });

  it('does not search when the file permission is refused', async () => {
    const { runner } = await harness({ prompter: async () => 'deny' });
    const result = await runner.run('knowledge.search', { query: 'tax' });

    expect(result.status === 'refused' && result.reason).toBe('permission');
  });
});

describe('memory.forget', () => {
  it('shows the memory itself in the confirmation, not its id', async () => {
    let shown = '';
    const { runner, memory } = await harness({
      confirmer: async (request) => {
        shown = request.description;
        return true;
      },
    });
    const saved = await memory.save({ content: 'The dentist is on Thursday.' });

    const result = await runner.run('memory.forget', { id: saved.id });
    expect(shown).toBe('Forget: "The dentist is on Thursday."');
    expect(result.status).toBe('ok');
    expect(await memory.get(saved.id)).toBeUndefined();
  });

  it('keeps the memory when the confirmation is declined', async () => {
    const { runner, memory } = await harness({ confirmer: async () => false });
    const saved = await memory.save({ content: 'The dentist is on Thursday.' });

    const result = await runner.run('memory.forget', { id: saved.id });
    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
    expect(await memory.get(saved.id)).toBeDefined();
  });

  it('will not delete without a confirmer, even though it needs no permission', async () => {
    const { runner, memory } = await harness();
    const saved = await memory.save({ content: 'The dentist is on Thursday.' });

    const result = await runner.run('memory.forget', { id: saved.id });
    expect(result.status === 'refused' && result.reason).toBe('cannot-ask');
    expect(await memory.get(saved.id)).toBeDefined();
  });

  it('says so when there is nothing to forget', async () => {
    const { runner } = await harness({ confirmer: async () => true });
    const result = await runner.run('memory.forget', { id: 'mem_nothing' });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toBe(
      'Helix has no memory like that to forget.',
    );
  });

  it('skips the confirmation only once the user has turned quick actions on', async () => {
    const { runner, settings, memory } = await harness();
    await settings.set('quickActions', true);
    const saved = await memory.save({ content: 'The dentist is on Thursday.' });

    const result = await runner.run('memory.forget', { id: saved.id });
    expect(result.status).toBe('ok');
    expect(await memory.get(saved.id)).toBeUndefined();
  });
});

describe('the registered set', () => {
  it('registers only actions that are wired to something real', async () => {
    const { registry } = await harness();
    expect(registry.ids().sort()).toEqual([
      'knowledge.search',
      'memory.forget',
      'phone.pair',
      'phone.unpair',
      'settings.change',
    ]);
  });
});
