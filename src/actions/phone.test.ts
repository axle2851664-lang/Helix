import { describe, expect, it } from 'vitest';
import { Logger } from '../core/Logger.js';
import { PermissionManager, type PermissionPrompter } from '../security/PermissionManager.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { keyProblem } from '../relay/pairing.js';
import { ActionRegistry } from './ActionRegistry.js';
import { ActionRunner, type ActionConfirmer } from './ActionRunner.js';
import { phoneActions } from './phone.js';
import { CHANGEABLE_SETTING_KEYS } from './builtin.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

async function harness(
  options: { allow?: boolean; confirmer?: ActionConfirmer; sink?: string[] } = {},
) {
  const store = new MemoryKeyValueStore();
  const records: string[] = options.sink ?? [];
  const logger = new Logger('test', {
    level: 'DEBUG',
    sinks: [{ write: (record) => records.push(JSON.stringify(record)) }],
  });

  const settings = new SettingsManager({ store, logger: silentLogger() });
  await settings.load();

  const prompter: PermissionPrompter = async () => (options.allow === false ? 'deny' : 'allow');
  const permissions = new PermissionManager({ store, logger: silentLogger(), prompter });

  const registry = new ActionRegistry();
  registry.registerAll(phoneActions({ settings }));
  const runner = new ActionRunner({
    registry,
    permissions,
    logger,
    ...(options.confirmer ? { confirmer: options.confirmer } : {}),
  });

  return { runner, settings, permissions, records };
}

describe('pairing a phone', () => {
  it('generates a key strong enough for the listener and switches it on', async () => {
    const { runner, settings } = await harness();

    const result = await runner.run('phone.pair', { host: 'helix-desktop.tail1234.ts.net' });

    expect(result.status).toBe('ok');
    expect(keyProblem(settings.get('relaySecret'))).toBeNull();
    expect(settings.get('relaySecret')).toMatch(/^[0-9a-f]{32}$/);
    // The key and the switch are set together: a stored key with the listener
    // off is a setup that looks finished and answers nothing.
    expect(settings.get('phoneListenerEnabled')).toBe(true);
  });

  it('needs permission to open a listener, and changes nothing without it', async () => {
    const { runner, settings } = await harness({ allow: false });

    const result = await runner.run('phone.pair', { host: 'helix-desktop' });

    expect(result.status === 'refused' && result.reason).toBe('permission');
    expect(settings.get('relaySecret')).toBe('');
    expect(settings.get('phoneListenerEnabled')).toBe(false);
  });

  it('gives a different key every time it is paired', async () => {
    const { runner, settings } = await harness();

    await runner.run('phone.pair', { host: 'helix-desktop' });
    const first = settings.get('relaySecret');
    await runner.run('phone.pair', { host: 'helix-desktop' });

    expect(settings.get('relaySecret')).not.toBe(first);
  });

  it('never puts the key in the message, which is what gets shown and repeated', async () => {
    const { runner, settings } = await harness();

    const result = await runner.run('phone.pair', { host: 'helix-desktop' });
    const key = settings.get('relaySecret');

    expect(result.status === 'ok' && result.message).not.toContain(key);
    expect(result.status === 'ok' && (result.data as { key: string }).key).toBe(key);
  });

  it('keeps the key out of the log entirely', async () => {
    const { runner, settings, records } = await harness();

    await runner.run('phone.pair', { host: 'helix-desktop' });
    const key = settings.get('relaySecret');

    expect(records.length).toBeGreaterThan(0);
    expect(records.join('\n')).not.toContain(key);
  });

  it('refuses an address it cannot use, rather than pairing to nothing', async () => {
    const { runner, settings } = await harness();

    const result = await runner.run('phone.pair', { host: '   ' });

    expect(result.status).toBe('failed');
    expect(settings.get('relaySecret')).toBe('');
  });

  it('refuses a port that needs privileges Helix does not ask for', async () => {
    const { runner, settings } = await harness();

    const result = await runner.run('phone.pair', { host: 'helix-desktop', port: 80 });

    expect(result.status === 'refused' && result.reason).toBe('bad-parameters');
    expect(settings.get('phoneListenerEnabled')).toBe(false);
  });
});

describe('unpairing', () => {
  it('asks first, saying that every paired phone stops working', async () => {
    let description = '';
    const { runner, settings } = await harness({
      confirmer: async (request) => {
        description = request.description;
        return true;
      },
    });
    await runner.run('phone.pair', { host: 'helix-desktop' });

    const result = await runner.run('phone.unpair');

    expect(description).toContain('Every phone paired with this machine will stop working');
    expect(result.status).toBe('ok');
    expect(settings.get('relaySecret')).toBe('');
    expect(settings.get('phoneListenerEnabled')).toBe(false);
  });

  it('keeps the key when the confirmation is declined', async () => {
    const { runner, settings } = await harness({ confirmer: async () => false });
    await runner.run('phone.pair', { host: 'helix-desktop' });
    const key = settings.get('relaySecret');

    const result = await runner.run('phone.unpair');

    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
    expect(settings.get('relaySecret')).toBe(key);
    expect(settings.get('phoneListenerEnabled')).toBe(true);
  });

  it('will not unpair when there is no way to ask', async () => {
    const { runner, settings } = await harness();
    await runner.run('phone.pair', { host: 'helix-desktop' });

    const result = await runner.run('phone.unpair');

    expect(result.status === 'refused' && result.reason).toBe('cannot-ask');
    expect(settings.get('relaySecret')).not.toBe('');
  });
});

describe('the boundary with the general settings action', () => {
  it('leaves the key and the listener out of what a planner may change', () => {
    // These actions write them deliberately and under permission. The blunt
    // "change a setting" action must not reach them at all.
    for (const key of ['relaySecret', 'phoneListenerEnabled', 'phoneListenerPort']) {
      expect(CHANGEABLE_SETTING_KEYS).not.toContain(key);
    }
  });
});
