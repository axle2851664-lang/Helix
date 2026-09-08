import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { PermissionManager, type PermissionPrompter } from '../security/PermissionManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { validateParams, type ActionDefinition } from './action.js';
import { ActionRegistry } from './ActionRegistry.js';
import { ActionRunner, type ActionConfirmer } from './ActionRunner.js';
import { CHANGEABLE_SETTING_KEYS, isProtectedSetting } from './builtin.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

const allow: PermissionPrompter = async () => 'allow';
const deny: PermissionPrompter = async () => 'deny';

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: 'test.act',
    label: 'Do the thing',
    group: 'system',
    summary: 'Does the thing.',
    parameters: {},
    permission: null,
    confirmation: 'none',
    reversible: true,
    appliesTo: ['none'],
    describe: () => 'Do the thing.',
    run: async () => ({ message: 'Did the thing.' }),
    ...overrides,
  };
}

function makeRunner(
  action: ActionDefinition,
  options: {
    prompter?: PermissionPrompter;
    confirmer?: ActionConfirmer;
    quickActions?: boolean;
    bus?: EventBus;
  } = {},
) {
  const registry = new ActionRegistry();
  registry.register(action);
  const permissions = new PermissionManager({
    store: new MemoryKeyValueStore(),
    logger: silentLogger(),
    ...(options.prompter ? { prompter: options.prompter } : {}),
  });
  const runner = new ActionRunner({
    registry,
    permissions,
    logger: silentLogger(),
    quickActions: () => options.quickActions ?? false,
    ...(options.confirmer ? { confirmer: options.confirmer } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
  });
  return { registry, permissions, runner };
}

describe('parameter validation', () => {
  const action = makeAction({
    parameters: {
      query: { type: 'string', description: 'What to find.', required: true, maxLength: 10 },
      limit: { type: 'number', description: 'How many.', required: false, min: 1, max: 5 },
      mode: { type: 'string', description: 'Which mode.', required: false, options: ['fast', 'thorough'] },
    },
  });

  it('accepts what it declares', () => {
    const result = validateParams(action, { query: 'notes', limit: 3, mode: 'fast' });
    expect(result.ok).toBe(true);
  });

  it('refuses a parameter the action does not have', () => {
    const result = validateParams(action, { query: 'notes', recursive: true });
    expect(result).toEqual({ ok: false, problem: '"test.act" has no parameter called "recursive".' });
  });

  it('refuses a missing required parameter', () => {
    expect(validateParams(action, { limit: 2 })).toEqual({ ok: false, problem: '"query" is required.' });
  });

  it('refuses a parameter of the wrong type', () => {
    const result = validateParams(action, { query: 12 });
    expect(result).toEqual({ ok: false, problem: '"query" must be a string.' });
  });

  it('refuses an out-of-range number rather than clamping it', () => {
    const result = validateParams(action, { query: 'notes', limit: 900 });
    expect(result).toEqual({ ok: false, problem: '"limit" must be at most 5.' });
  });

  it('refuses NaN and Infinity', () => {
    expect(validateParams(action, { query: 'a', limit: Number.NaN }).ok).toBe(false);
    expect(validateParams(action, { query: 'a', limit: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it('refuses a value outside an enumerated set', () => {
    const result = validateParams(action, { query: 'notes', mode: 'instant' });
    expect(result).toEqual({ ok: false, problem: '"mode" must be one of: fast, thorough.' });
  });

  it('refuses an over-long string', () => {
    expect(validateParams(action, { query: 'x'.repeat(40) }).ok).toBe(false);
  });

  it('refuses parameters that are not an object', () => {
    expect(validateParams(action, 'notes').ok).toBe(false);
    expect(validateParams(action, ['notes']).ok).toBe(false);
    expect(validateParams(action, null).ok).toBe(false);
  });

  it('leaves an omitted optional parameter out rather than setting it undefined', () => {
    const result = validateParams(action, { query: 'notes' });
    expect(result.ok && Object.keys(result.params)).toEqual(['query']);
  });
});

describe('the registry', () => {
  it('refuses two actions with the same name', () => {
    const registry = new ActionRegistry();
    registry.register(makeAction());
    expect(() => registry.register(makeAction())).toThrow(/already registered/);
  });

  it('offers only the actions compatible with the selected object', () => {
    const registry = new ActionRegistry();
    registry.register(makeAction({ id: 'a.one', appliesTo: ['file'] }));
    registry.register(makeAction({ id: 'a.two', appliesTo: ['memory'] }));
    registry.register(makeAction({ id: 'a.three', appliesTo: ['file', 'memory'] }));

    expect(registry.forTarget('file').map((action) => action.id)).toEqual(['a.one', 'a.three']);
    expect(registry.forTarget('project')).toEqual([]);
  });
});

describe('running an action', () => {
  it('performs it and reports what happened', async () => {
    const { runner } = makeRunner(makeAction());
    await expect(runner.run('test.act')).resolves.toEqual({
      status: 'ok',
      action: 'test.act',
      message: 'Did the thing.',
    });
  });

  it('refuses an action that does not exist, rather than throwing', async () => {
    const { runner } = makeRunner(makeAction());
    const result = await runner.run('files.deleteEverything');
    expect(result).toEqual({
      status: 'refused',
      action: 'files.deleteEverything',
      reason: 'unknown-action',
      message: 'Helix has no action called "files.deleteEverything".',
    });
  });

  it('separates an action that would not run from one that ran and broke', async () => {
    const { runner } = makeRunner(
      makeAction({
        run: async () => {
          throw new HelixError('PROVIDER_UNREACHABLE', 'Helix could not reach the thing.');
        },
      }),
    );
    const result = await runner.run('test.act');
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toBe('Helix could not reach the thing.');
  });

  it('does not put an unexpected error in front of the user', async () => {
    const { runner } = makeRunner(
      makeAction({
        run: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:11434');
        },
      }),
    );
    const result = await runner.run('test.act');
    expect(result.status === 'failed' && result.message).toBe(
      'That did not work. The details are in the log.',
    );
  });

  it('refuses rather than running when a parameter is wrong', async () => {
    const run = vi.fn(async () => ({ message: 'ran' }));
    const { runner } = makeRunner(
      makeAction({
        parameters: { path: { type: 'string', description: 'Which file.', required: true } },
        run,
      }),
    );
    const result = await runner.run('test.act', { path: 'a.md', recursive: true });
    expect(result.status === 'refused' && result.reason).toBe('bad-parameters');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('permission', () => {
  it('asks for the permission the action declares, saying what it is for', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => 'allow');
    const { runner } = makeRunner(
      makeAction({ permission: 'FILES_READ', describe: () => 'Search your files for "tax".' }),
      { prompter },
    );

    await expect(runner.run('test.act')).resolves.toMatchObject({ status: 'ok' });
    expect(prompter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Search your files for "tax".' }),
    );
  });

  it('refuses without running when permission is not given', async () => {
    const run = vi.fn(async () => ({ message: 'ran' }));
    const { runner } = makeRunner(makeAction({ permission: 'FILES_READ', run }), { prompter: deny });

    const result = await runner.run('test.act');
    expect(result.status === 'refused' && result.reason).toBe('permission');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not spend the user\'s attention confirming something it may not do', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(
      makeAction({ permission: 'FILES_DELETE', confirmation: 'destructive' }),
      { prompter: deny, confirmer },
    );

    await runner.run('test.act');
    expect(confirmer).not.toHaveBeenCalled();
  });
});

describe('confirmation', () => {
  it('confirms a destructive action, and says it cannot be undone', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(
      makeAction({ confirmation: 'destructive', reversible: false, describe: () => 'Delete notes/tax.md.' }),
      { confirmer },
    );

    await expect(runner.run('test.act')).resolves.toMatchObject({ status: 'ok' });
    expect(confirmer).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Delete notes/tax.md.', reversible: false }),
    );
  });

  it('does not run when the confirmation is declined', async () => {
    const run = vi.fn(async () => ({ message: 'ran' }));
    const { runner } = makeRunner(makeAction({ confirmation: 'destructive', run }), {
      confirmer: async () => false,
    });

    const result = await runner.run('test.act');
    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses when it needs confirming and there is nothing to ask with', async () => {
    const run = vi.fn(async () => ({ message: 'ran' }));
    const { runner } = makeRunner(makeAction({ confirmation: 'destructive', run }));

    const result = await runner.run('test.act');
    expect(result.status === 'refused' && result.reason).toBe('cannot-ask');
    expect(run).not.toHaveBeenCalled();
  });

  it('treats a confirmation prompt that failed as unanswered', async () => {
    const { runner } = makeRunner(makeAction({ confirmation: 'destructive' }), {
      confirmer: async () => {
        throw new Error('the window closed');
      },
    });
    const result = await runner.run('test.act');
    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
  });

  it('lets quick actions skip a destructive confirmation, as the spec allows', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(makeAction({ confirmation: 'destructive' }), {
      confirmer,
      quickActions: true,
    });

    await expect(runner.run('test.act')).resolves.toMatchObject({ status: 'ok' });
    expect(confirmer).not.toHaveBeenCalled();
  });

  it('never lets quick actions skip an always-confirm action', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(makeAction({ confirmation: 'always' }), {
      confirmer,
      quickActions: true,
    });

    await runner.run('test.act');
    expect(confirmer).toHaveBeenCalledTimes(1);
  });

  it('takes a confirmation floor from the permission, so a delete cannot declare it needs none', async () => {
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(
      // The action claims no confirmation; FILES_DELETE says otherwise.
      makeAction({ permission: 'FILES_DELETE', confirmation: 'none' }),
      { prompter: allow, confirmer },
    );

    await runner.run('test.act');
    expect(confirmer).toHaveBeenCalledTimes(1);
  });

  it('lets an action raise the floor above what the permission asks for', async () => {
    const { registry, runner } = makeRunner(
      makeAction({ permission: 'GOOGLE_GMAIL_SEND', confirmation: 'always' }),
      { prompter: allow, confirmer: async () => true, quickActions: true },
    );
    const action = registry.get('test.act');
    expect(action && runner.confirmationFor(action)).toBe('always');
    expect(action && runner.requiresConfirmation(action)).toBe(true);
  });

  it('describes what will happen before asking, and does not ask if it cannot', async () => {
    const run = vi.fn(async () => ({ message: 'ran' }));
    const confirmer = vi.fn<ActionConfirmer>(async () => true);
    const { runner } = makeRunner(
      makeAction({
        confirmation: 'destructive',
        describe: () => {
          throw new Error('no such file');
        },
        run,
      }),
      { confirmer },
    );

    const result = await runner.run('test.act');
    expect(result.status === 'refused' && result.reason).toBe('bad-parameters');
    expect(confirmer).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('what the rest of Helix is told', () => {
  it('announces every run, refusals included', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('ACTION_PERFORMED', (payload) => seen.push(`${payload.action}:${payload.status}`));

    const { runner } = makeRunner(makeAction(), { bus });
    await runner.run('test.act');
    await runner.run('nope');

    expect(seen).toEqual(['test.act:ok', 'nope:refused']);
  });
});

describe('the built-in actions', () => {
  it('will not let an action change a privacy or relay setting', () => {
    expect(isProtectedSetting('quickActions')).toBe(true);
    expect(isProtectedSetting('allowComputerControl')).toBe(true);
    expect(isProtectedSetting('saveConversationHistory')).toBe(true);
    expect(isProtectedSetting('relaySecret')).toBe(true);
    expect(isProtectedSetting('theme')).toBe(false);
  });

  it('keeps quick actions itself out of reach, so confirmations cannot be switched off', () => {
    expect(CHANGEABLE_SETTING_KEYS).not.toContain('quickActions');
    expect(CHANGEABLE_SETTING_KEYS).toContain('theme');
  });
});
