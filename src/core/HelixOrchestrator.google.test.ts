import { describe, expect, it } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { HelixOrchestrator } from './HelixOrchestrator.js';
import { Logger } from './Logger.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import type { GmailProvider } from '../integrations/google/GmailProvider.js';
import type { CalendarProvider } from '../integrations/google/CalendarProvider.js';

/**
 * The inbox and the calendar, wired.
 *
 * These exist because of a specific fault: both providers were built and
 * handed only to the action registry, so Helix answered "read my inbox" with
 * a card saying no mail provider existed - while one sat a call away. A
 * stale denial is as wrong as an optimistic claim; it just fails in the
 * direction nobody checks. So the assertions here are about wiring, and the
 * fakes are deliberately thin.
 */

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

async function makeContext(
  options: { gmail?: Partial<GmailProvider>; calendar?: Partial<CalendarProvider> } = {},
) {
  const kv = new MemoryKeyValueStore();
  const logger = silentLogger();
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });

  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity: new ActivityManager(),
    projects,
    memory,
    knowledge,
    logger,
    ...(options.gmail ? { gmail: options.gmail as GmailProvider } : {}),
    ...(options.calendar ? { calendar: options.calendar as CalendarProvider } : {}),
  });
  const conversation = await conversations.create();

  return {
    ask: (text: string) => orchestrator.submit({ text, conversationId: conversation.id }),
  };
}

describe('reading the inbox', () => {
  it('reads real mail when Gmail is connected', async () => {
    const { ask } = await makeContext({
      gmail: {
        status: () => ({ connected: true, address: 'a@example.com', message: 'Connected.' }),
        unread: async () => ({
          total: 2,
          messages: [
            { id: '1', from: 'Marlow', subject: 'Thursday', snippet: '', unread: true },
            { id: '2', from: 'Bank', subject: 'Statement', snippet: '', unread: true },
          ],
          topSenders: [],
        }),
      } as Partial<GmailProvider>,
    });

    const response = await ask('read my inbox');

    expect(response.handled).toBe(true);
    expect(response.text).toContain('Marlow');
    expect(response.text).toContain('Thursday');
  });

  it('says so rather than inventing mail when Gmail is not connected', async () => {
    const { ask } = await makeContext({
      gmail: {
        status: () => ({ connected: false, address: null, message: 'Gmail is not connected yet.' }),
      } as Partial<GmailProvider>,
    });

    const response = await ask('read my inbox');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
    // The card must carry the real blocker, not the retired "not written" one.
    const details = (response.card?.sections ?? [])
      .flatMap((section) => section.items)
      .map((item) => item.detail ?? '');
    expect(details.some((detail) => detail.includes('not connected yet'))).toBe(true);
    expect(details.some((detail) => detail.includes('No mail provider exists'))).toBe(false);
  });

  it('reports a failed lookup as a failure, never as an empty inbox', async () => {
    const { ask } = await makeContext({
      gmail: {
        status: () => ({ connected: true, address: 'a@example.com', message: 'Connected.' }),
        unread: async () => {
          throw new Error('the token expired');
        },
      } as Partial<GmailProvider>,
    });

    const response = await ask('read my inbox');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_FAILED');
    expect(response.text).toContain('token expired');
  });
});

describe('reading the calendar', () => {
  it('lists what is coming up', async () => {
    const { ask } = await makeContext({
      calendar: {
        unavailableReason: () => null,
        upcoming: async () => [
          {
            id: '1',
            summary: 'Standup',
            start: '2026-10-02T09:00:00Z',
            end: '2026-10-02T09:15:00Z',
            allDay: false,
          },
        ],
      } as Partial<CalendarProvider>,
    });

    const response = await ask("what's on my calendar this week");

    expect(response.handled).toBe(true);
    expect(response.text).toContain('Standup');
  });

  it('says nothing is on it only when the calendar actually answered', async () => {
    const { ask } = await makeContext({
      calendar: {
        unavailableReason: () => null,
        upcoming: async () => {
          throw new Error('calendar unreachable');
        },
      } as Partial<CalendarProvider>,
    });

    const response = await ask("what's on my calendar");

    expect(response.failure).toBe('PROVIDER_FAILED');
    expect(response.text).not.toContain('Nothing on your calendar');
  });

  it('refuses to guess when no calendar is wired at all', async () => {
    const { ask } = await makeContext();
    const response = await ask("what's on my calendar");

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

/**
 * The invention, and why it cannot happen again.
 *
 * Asked "whats unread on my gmail right mow", Helix answered "I'm checking
 * your Gmail inbox. As of now, you have several unread messages" - having
 * touched nothing. The phrase missed the inbox matcher, fell through to the
 * language model, and the model wrote a plausible sentence about a mailbox it
 * cannot see. Then it refused to read them, which is how the user found out.
 *
 * A fabricated inbox is believed exactly when it matters and cannot be
 * detected by the person reading it.
 */
describe('the phrasings that must reach the mailbox', () => {
  const mailbox = (messages: Array<{ id: string; from: string; subject: string }>) =>
    ({
      status: () => ({ connected: true, address: 'me@example.com', message: 'Connected.' }),
      unread: async () => ({
        total: messages.length,
        messages: messages.map((m) => ({ ...m, snippet: '', unread: true })),
        topSenders: [],
      }),
      body: async (id: string) => ({
        from: messages.find((m) => m.id === id)?.from ?? 'x',
        subject: messages.find((m) => m.id === id)?.subject ?? 'x',
        text: `The full text of ${id}.`,
      }),
    }) as unknown as GmailProvider;

  it('answers the exact question that was answered with an invention', async () => {
    const { ask } = await makeContext({
      gmail: mailbox([{ id: '1', from: 'Marlow', subject: 'Thursday' }]),
    });

    const response = await ask('whats unread on my gmail right mow');

    expect(response.handled).toBe(true);
    // The real subject, from the real mailbox - not a count in prose.
    expect(response.text).toContain('Thursday');
  });

  it('reads the messages when asked to, instead of declining', async () => {
    const { ask } = await makeContext({
      gmail: mailbox([{ id: '1', from: 'Marlow', subject: 'Thursday' }]),
    });

    await ask('whats unread on my gmail');
    const response = await ask('read them for me');

    expect(response.handled).toBe(true);
    expect(response.text).toContain('The full text of 1.');
  });

  it('still refuses to invent when Gmail is not connected', async () => {
    const { ask } = await makeContext({
      gmail: {
        status: () => ({ connected: false, address: null, message: 'Gmail is not connected yet.' }),
      } as unknown as GmailProvider,
    });

    const response = await ask('whats unread on my gmail right now');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.text).not.toMatch(/several|you have \d/i);
  });
});
