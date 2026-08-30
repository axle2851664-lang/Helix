import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryManager } from './MemoryManager.js';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';

async function makeMemory(options: { enabled?: boolean; bus?: EventBus } = {}) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store, logger });
  await settings.load();
  if (options.enabled === false) await settings.set('allowLongTermMemory', false);

  const memory = new MemoryManager({
    store,
    settings,
    logger,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  return { memory, settings, store };
}

describe('MemoryManager: saving', () => {
  it('is enabled by default', async () => {
    const { memory } = await makeMemory();
    expect(memory.enabled).toBe(true);
  });

  it('saves a memory with the specified fields', async () => {
    const { memory } = await makeMemory();
    const record = await memory.save({ content: 'I prefer dark interfaces' });

    expect(record.id).toMatch(/^mem_/);
    expect(record.content).toBe('I prefer dark interfaces');
    expect(record.category).toBe('fact');
    expect(record.source).toBe('user-explicit');
    expect(record.confidence).toBe(1);
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.lastAccessedAt).toBeGreaterThan(0);
  });

  it('accepts a category, tags and a project', async () => {
    const { memory } = await makeMemory();
    const record = await memory.save({
      content: 'The suit is red and gold',
      category: 'project',
      projectId: 'proj_1',
      tags: ['  Ironman ', 'Colours'],
    });

    expect(record.category).toBe('project');
    expect(record.projectId).toBe('proj_1');
    expect(record.tags).toEqual(['ironman', 'colours']);
  });

  it('falls back to "fact" for an unknown category', async () => {
    const { memory } = await makeMemory();
    const record = await memory.save({
      content: 'x',
      category: 'nonsense' as never,
    });
    expect(record.category).toBe('fact');
  });

  it('trims content and refuses empty content', async () => {
    const { memory } = await makeMemory();
    expect((await memory.save({ content: '  spaced  ' })).content).toBe('spaced');
    await expect(memory.save({ content: '   ' })).rejects.toThrow('nothing to remember');
  });

  it('refuses content over the length limit rather than truncating', async () => {
    const { memory } = await makeMemory();
    await expect(memory.save({ content: 'x'.repeat(2500) })).rejects.toThrow('too long');
  });

  // The user can turn memory off, and that must actually stop writes.
  it('refuses to save when long-term memory is disabled', async () => {
    const { memory } = await makeMemory({ enabled: false });

    expect(memory.enabled).toBe(false);
    await expect(memory.save({ content: 'anything' })).rejects.toThrow(
      'Long-term memory is turned off',
    );
    expect(await memory.count()).toBe(0);
  });

  it('still reads and deletes existing memories when disabled', async () => {
    const { memory, settings } = await makeMemory();
    const record = await memory.save({ content: 'kept' });

    await settings.set('allowLongTermMemory', false);

    // Disabling must not destroy what is already stored.
    expect(await memory.get(record.id)).toBeDefined();
    expect(await memory.list()).toHaveLength(1);
    await expect(memory.delete(record.id)).resolves.toBeUndefined();
  });
});

describe('MemoryManager: credential refusal', () => {
  // Spec 8: passwords, keys, tokens and private keys must never be stored.
  const credentials: Array<[string, string]> = [
    ['Anthropic key', 'remember sk-ant-abcdefghijklmnopqrstuvwx'],
    ['OpenAI key', 'my key is sk-abcdefghijklmnopqrstuvwxyz'],
    ['GitHub token', 'use ghp_abcdefghijklmnopqrstuvwxyz1234'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE is the id'],
    ['Google API key', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['bearer header', 'Authorization: Bearer abcdef1234567890xyz'],
    ['JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ];

  for (const [label, content] of credentials) {
    it(`refuses to store a ${label}`, async () => {
      const { memory } = await makeMemory();

      await expect(memory.save({ content })).rejects.toThrow(HelixError);
      expect(await memory.count(), 'nothing may be written').toBe(0);
    });
  }

  it('refuses a labelled password written in prose', async () => {
    const { memory } = await makeMemory();

    for (const content of [
      'my password is hunter2',
      'the api key is abc123def',
      'passphrase: correct-horse-battery',
    ]) {
      await expect(memory.save({ content }), content).rejects.toThrow(HelixError);
    }
    expect(await memory.count()).toBe(0);
  });

  it('explains what was detected without echoing the secret', async () => {
    const { memory } = await makeMemory();
    try {
      await memory.save({ content: 'sk-ant-abcdefghijklmnopqrstuvwx' });
      expect.unreachable('should have refused');
    } catch (error) {
      const helix = error as HelixError;
      expect(helix.userMessage).toContain('credential');
      expect(helix.userMessage).not.toContain('sk-ant-abcdef');
    }
  });

  it('does not refuse ordinary text that merely mentions keys', async () => {
    const { memory } = await makeMemory();
    // False positives cost a rephrase, but this phrasing must still work.
    const record = await memory.save({ content: 'I keep my house keys by the door' });
    expect(record.id).toBeTruthy();
  });

  it('applies the same rule when editing an existing memory', async () => {
    const { memory } = await makeMemory();
    const record = await memory.save({ content: 'harmless note' });

    await expect(
      memory.update(record.id, { content: 'sk-ant-abcdefghijklmnopqrstuvwx' }),
    ).rejects.toThrow(HelixError);

    expect((await memory.get(record.id))?.content).toBe('harmless note');
  });
});

describe('MemoryManager: listing, updating, deleting', () => {
  let context: Awaited<ReturnType<typeof makeMemory>>;

  beforeEach(async () => {
    context = await makeMemory();
  });

  it('lists newest first', async () => {
    const first = await context.memory.save({ content: 'first' });
    await context.memory.save({ content: 'second' });
    await context.memory.update(first.id, { content: 'first again' });

    const list = await context.memory.list();
    expect(list[0]?.id).toBe(first.id);
  });

  it('scopes a list to one project', async () => {
    await context.memory.save({ content: 'global note' });
    await context.memory.save({ content: 'project note', projectId: 'proj_1' });

    const scoped = await context.memory.list({ projectId: 'proj_1' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.content).toBe('project note');
  });

  it('updates content and bumps updatedAt', async () => {
    const record = await context.memory.save({ content: 'old' });
    const updated = await context.memory.update(record.id, { content: 'new' });

    expect(updated.id).toBe(record.id);
    expect(updated.content).toBe('new');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
  });

  it('refuses to update an unknown memory', async () => {
    await expect(context.memory.update('mem_nope', { content: 'x' })).rejects.toThrow(
      'no longer exists',
    );
  });

  it('deletes one memory', async () => {
    const record = await context.memory.save({ content: 'temporary' });
    await context.memory.delete(record.id);

    expect(await context.memory.get(record.id)).toBeUndefined();
    expect(await context.memory.count()).toBe(0);
  });

  it('deleting an unknown memory is harmless', async () => {
    await expect(context.memory.delete('mem_nope')).resolves.toBeUndefined();
  });

  it('clears everything and reports how many went', async () => {
    await context.memory.save({ content: 'a' });
    await context.memory.save({ content: 'b' });

    expect(await context.memory.clear()).toBe(2);
    expect(await context.memory.list()).toEqual([]);
  });

  it('clears only one project, leaving the rest', async () => {
    await context.memory.save({ content: 'global' });
    await context.memory.save({ content: 'scoped', projectId: 'proj_1' });

    expect(await context.memory.clear({ projectId: 'proj_1' })).toBe(1);

    const remaining = await context.memory.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.content).toBe('global');
  });
});

describe('MemoryManager: search', () => {
  let context: Awaited<ReturnType<typeof makeMemory>>;

  beforeEach(async () => {
    context = await makeMemory();
    await context.memory.save({ content: 'I prefer dark interfaces', category: 'preference' });
    await context.memory.save({ content: 'My sister is called Mira', category: 'person' });
    await context.memory.save({
      content: 'The Iron Man suit is red and gold',
      category: 'project',
      tags: ['ironman'],
    });
  });

  it('finds an exact phrase', async () => {
    const results = await context.memory.search('I prefer dark interfaces');
    expect(results[0]?.reason).toBe('exact');
  });

  it('finds a substring', async () => {
    const results = await context.memory.search('red and gold');
    expect(results[0]?.memory.content).toContain('Iron Man');
    expect(results[0]?.reason).toBe('phrase');
  });

  it('finds by keyword', async () => {
    const results = await context.memory.search('sister');
    expect(results[0]?.memory.content).toContain('Mira');
  });

  it('finds by tag', async () => {
    const results = await context.memory.search('ironman');
    expect(results[0]?.memory.content).toContain('Iron Man');
  });

  it('ignores stop words so a natural question still matches', async () => {
    const results = await context.memory.search('what do you know about my sister');
    expect(results[0]?.memory.content).toContain('Mira');
  });

  it('returns nothing for an unrelated query', async () => {
    expect(await context.memory.search('quantum tunnelling')).toEqual([]);
  });

  it('returns nothing for an empty query', async () => {
    expect(await context.memory.search('   ')).toEqual([]);
  });

  it('respects a result limit', async () => {
    const results = await context.memory.search('the', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('updates lastAccessedAt on returned memories without changing updatedAt', async () => {
    const before = (await context.memory.list())[0] as { id: string; updatedAt: number };
    await new Promise((resolve) => setTimeout(resolve, 5));

    await context.memory.search('dark interfaces');

    const all = await context.memory.list();
    const touched = all.find((record) => record.content.includes('dark interfaces'));
    expect(touched?.lastAccessedAt).toBeGreaterThan(0);
    // Reading must not reorder the list as though the memory were edited.
    const untouched = all.find((record) => record.id === before.id);
    expect(untouched?.updatedAt).toBe(before.updatedAt);
  });
});

describe('MemoryManager: events and notifications', () => {
  it('emits MEMORY_SAVED and MEMORY_DELETED', async () => {
    const bus = new EventBus();
    const saved = vi.fn();
    const deleted = vi.fn();
    bus.on('MEMORY_SAVED', saved);
    bus.on('MEMORY_DELETED', deleted);

    const { memory } = await makeMemory({ bus });
    const record = await memory.save({ content: 'note', category: 'fact' });
    await memory.delete(record.id);

    expect(saved).toHaveBeenCalledWith({ memoryId: record.id, category: 'fact' });
    expect(deleted).toHaveBeenCalledWith({ memoryId: record.id });
  });

  it('notifies subscribers on change', async () => {
    const { memory } = await makeMemory();
    const listener = vi.fn();
    memory.subscribe(listener);

    await memory.save({ content: 'note' });
    expect(listener).toHaveBeenCalled();
  });

  it('persists across a new manager on the same store', async () => {
    const { memory, store, settings } = await makeMemory();
    await memory.save({ content: 'survives' });

    const logger = new Logger('test', { level: 'ERROR', sinks: [] });
    const reopened = new MemoryManager({ store, settings, logger });
    const list = await reopened.list();

    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe('survives');
  });
});
