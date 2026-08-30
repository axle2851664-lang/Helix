import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from './ConversationStore.js';
import { EventBus } from '../core/EventBus.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';

async function makeStore(options: { persist?: boolean; bus?: EventBus } = {}) {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();
  if (options.persist) await settings.set('saveConversationHistory', true);

  const conversations = new ConversationStore({
    store: kv,
    settings,
    logger,
    ...(options.bus ? { bus: options.bus } : {}),
  });

  return { conversations, kv, settings, logger };
}

describe('ConversationStore', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('creates a conversation with an id and timestamps', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();

    expect(conversation.id).toMatch(/^conv_/);
    expect(conversation.messages).toEqual([]);
    expect(conversation.createdAt).toBeGreaterThan(0);
  });

  it('gives each conversation a distinct id', async () => {
    const { conversations } = await makeStore();
    const a = await conversations.create();
    const b = await conversations.create();
    expect(a.id).not.toBe(b.id);
  });

  it('appends messages and returns them', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();

    await conversations.appendMessage(conversation.id, { role: 'user', text: 'hello' });
    await conversations.appendMessage(conversation.id, { role: 'helix', text: 'hi' });

    const loaded = await conversations.get(conversation.id);
    expect(loaded?.messages.map((m) => m.role)).toEqual(['user', 'helix']);
    expect(loaded?.messages[0]?.text).toBe('hello');
  });

  it('records a failure on a message rather than dropping it', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();

    await conversations.appendMessage(conversation.id, {
      role: 'helix',
      text: 'No language provider is configured.',
      failure: 'PROVIDER_NOT_CONFIGURED',
    });

    const loaded = await conversations.get(conversation.id);
    expect(loaded?.messages[0]?.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('titles a conversation from its first user message', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();

    await conversations.appendMessage(conversation.id, {
      role: 'user',
      text: 'What should I cook tonight?',
    });

    const loaded = await conversations.get(conversation.id);
    expect(loaded?.title).toBe('What should I cook tonight?');
  });

  it('does not retitle after the first user message', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();

    await conversations.appendMessage(conversation.id, { role: 'user', text: 'first' });
    await conversations.appendMessage(conversation.id, { role: 'user', text: 'second' });

    expect((await conversations.get(conversation.id))?.title).toBe('first');
  });

  it('throws a readable error for an unknown conversation', async () => {
    const { conversations } = await makeStore();
    await expect(
      conversations.appendMessage('conv_missing', { role: 'user', text: 'x' }),
    ).rejects.toThrow('That conversation no longer exists.');
  });

  it('lists conversations newest-updated first', async () => {
    const { conversations } = await makeStore();
    const first = await conversations.create('First');
    const second = await conversations.create('Second');
    await conversations.appendMessage(first.id, { role: 'user', text: 'bump' });

    const list = await conversations.list();
    expect(list[0]?.id).toBe(first.id);
    expect(list[1]?.id).toBe(second.id);
  });

  it('deletes a conversation', async () => {
    const { conversations } = await makeStore();
    const conversation = await conversations.create();
    await conversations.delete(conversation.id);

    expect(await conversations.get(conversation.id)).toBeUndefined();
    expect(await conversations.list()).toEqual([]);
  });

  describe('privacy', () => {
    // Off by default: nothing reaches disk unless the user allowed it.
    it('does not write to storage when history saving is off', async () => {
      const { conversations, kv } = await makeStore({ persist: false });
      const conversation = await conversations.create();
      await conversations.appendMessage(conversation.id, { role: 'user', text: 'private' });

      expect(conversations.persisting).toBe(false);
      expect(await kv.keys('conversations')).toEqual([]);
    });

    it('still serves conversations from the session when not persisting', async () => {
      const { conversations } = await makeStore({ persist: false });
      const conversation = await conversations.create();
      await conversations.appendMessage(conversation.id, { role: 'user', text: 'in session' });

      const loaded = await conversations.get(conversation.id);
      expect(loaded?.messages).toHaveLength(1);
      expect(await conversations.list()).toHaveLength(1);
    });

    it('writes to storage once history saving is on', async () => {
      const { conversations, kv } = await makeStore({ persist: true });
      const conversation = await conversations.create();
      await conversations.appendMessage(conversation.id, { role: 'user', text: 'kept' });

      expect(conversations.persisting).toBe(true);
      expect(await kv.keys('conversations')).toEqual([conversation.id]);
    });

    it('reloads persisted conversations in a new store instance', async () => {
      const kv = new MemoryKeyValueStore();
      const logger = new Logger('test', { level: 'ERROR', sinks: [] });
      const settings = new SettingsManager({ store: kv, logger });
      await settings.load();
      await settings.set('saveConversationHistory', true);

      const first = new ConversationStore({ store: kv, settings, logger });
      const conversation = await first.create();
      await first.appendMessage(conversation.id, { role: 'user', text: 'persisted' });

      const second = new ConversationStore({ store: kv, settings, logger });
      const list = await second.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe('persisted');
    });

    it('clearAll removes session and stored conversations', async () => {
      const { conversations, kv } = await makeStore({ persist: true });
      await conversations.create();
      await conversations.clearAll();

      expect(await conversations.list()).toEqual([]);
      expect(await kv.keys('conversations')).toEqual([]);
    });
  });

  describe('events and failures', () => {
    it('emits CONVERSATION_CREATED and MESSAGE_APPENDED', async () => {
      const created = vi.fn();
      const appended = vi.fn();
      bus.on('CONVERSATION_CREATED', created);
      bus.on('MESSAGE_APPENDED', appended);

      const { conversations } = await makeStore({ bus });
      const conversation = await conversations.create();
      await conversations.appendMessage(conversation.id, { role: 'user', text: 'x' });

      expect(created).toHaveBeenCalledWith({ conversationId: conversation.id });
      expect(appended).toHaveBeenCalledWith({ conversationId: conversation.id, role: 'user' });
    });

    it('notifies subscribers of changes', async () => {
      const { conversations } = await makeStore();
      const listener = vi.fn();
      conversations.subscribe(listener);

      await conversations.create();
      expect(listener).toHaveBeenCalled();
    });

    // A storage failure must not lose the conversation the user is having.
    it('keeps the session copy when a write fails', async () => {
      const { conversations, kv } = await makeStore({ persist: true });
      vi.spyOn(kv, 'set').mockRejectedValue(new Error('quota exceeded'));

      const conversation = await conversations.create();
      await conversations.appendMessage(conversation.id, { role: 'user', text: 'survives' });

      const loaded = await conversations.get(conversation.id);
      expect(loaded?.messages).toHaveLength(1);
    });
  });
});
