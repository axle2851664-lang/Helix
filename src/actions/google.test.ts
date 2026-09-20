import { describe, expect, it } from 'vitest';
import { Logger } from '../core/Logger.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { ActionRegistry } from './ActionRegistry.js';
import { ActionRunner, type ActionConfirmer } from './ActionRunner.js';
import { googleActions } from './google.js';
import { GmailProvider } from '../integrations/google/GmailProvider.js';
import { CalendarProvider } from '../integrations/google/CalendarProvider.js';
import type { InferenceTransport } from '../ai/types.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });
const NOW = new Date(2026, 8, 16, 10, 0, 0);

function harness(options: { confirmer?: ActionConfirmer; answer?: unknown } = {}) {
  const sent: Array<{ path: string; body: unknown }> = [];
  const transport: InferenceTransport = {
    id: 'test',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async (request) => {
      sent.push({ path: request.path, body: request.body });
      return options.answer ?? { id: 'evt_1', summary: 'Dentist', htmlLink: 'https://cal/evt_1' };
    },
  };

  const account = () => 'me@example.com';
  const registry = new ActionRegistry();
  registry.registerAll(
    googleActions({
      gmail: new GmailProvider({ transport, account }),
      calendar: new CalendarProvider({ transport, account, timeZone: () => 'Europe/London' }),
      now: () => NOW,
    }),
  );

  const runner = new ActionRunner({
    registry,
    permissions: new PermissionManager({
      store: new MemoryKeyValueStore(),
      logger: silentLogger(),
      prompter: async () => 'allow',
    }),
    logger: silentLogger(),
    ...(options.confirmer ? { confirmer: options.confirmer } : {}),
  });

  return { runner, sent, registry };
}

describe('mail housekeeping', () => {
  it('archives by removing the inbox label, which is all archiving is', async () => {
    const { runner, sent } = harness();
    const result = await runner.run('mail.archive', { ids: 'a,b' });

    expect(result.status).toBe('ok');
    expect(sent[0]?.path).toBe('/gmail/v1/users/me/messages/batchModify');
    expect(sent[0]?.body).toEqual({ ids: ['a', 'b'], removeLabelIds: ['INBOX'] });
  });

  it('stars and unstars', async () => {
    const starred = harness();
    await starred.runner.run('mail.star', { ids: 'a' });
    expect(starred.sent[0]?.body).toEqual({ ids: ['a'], addLabelIds: ['STARRED'] });

    const plain = harness();
    await plain.runner.run('mail.unstar', { ids: 'a' });
    expect(plain.sent[0]?.body).toEqual({ ids: ['a'], removeLabelIds: ['STARRED'] });
  });

  it('offers an undo for everything it does', () => {
    // Which is why none of them needs a confirmation of its own.
    const { registry } = harness();
    for (const id of ['mail.archive', 'mail.star', 'mail.markRead']) {
      expect(registry.has(id)).toBe(true);
    }
    for (const id of ['mail.unarchive', 'mail.unstar', 'mail.markUnread']) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it('sends no label that would make a message disappear', async () => {
    // The scope permits deleting and batchModify can do it by adding TRASH.
    // No public method does, and a guard refuses it if one ever tries.
    const { runner, sent } = harness();
    for (const id of ['mail.archive', 'mail.unarchive', 'mail.star', 'mail.unstar', 'mail.markRead', 'mail.markUnread']) {
      await runner.run(id, { ids: 'a' });
    }

    const everything = JSON.stringify(sent);
    expect(everything).not.toContain('TRASH');
    expect(everything).not.toContain('SPAM');
    expect(sent).toHaveLength(6);
  });

  it('refuses when no messages were named', async () => {
    const { runner, sent } = harness();
    const result = await runner.run('mail.archive', { ids: '  ,  ' });
    expect(result.status).toBe('failed');
    expect(sent).toHaveLength(0);
  });
});

describe('putting something on the calendar', () => {
  it('shows the resolved time in the confirmation, not the words', async () => {
    // A misread "Tuesday" has to be caught here rather than by missing it.
    let description = '';
    const { runner, sent } = harness({
      confirmer: async (request) => {
        description = request.description;
        return true;
      },
    });

    const result = await runner.run('calendar.create', {
      summary: 'Dentist',
      when: 'tomorrow at 3pm for 30 minutes',
    });

    expect(description).toContain('2026-09-17 15:00:00');
    expect(result.status).toBe('ok');
    expect(sent[0]?.path).toBe('/calendar/v3/calendars/primary/events');
    expect(sent[0]?.body).toEqual({
      summary: 'Dentist',
      start: { dateTime: '2026-09-17T15:00:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-09-17T15:30:00', timeZone: 'Europe/London' },
    });
  });

  it('invites nobody, by construction', async () => {
    const { runner, sent } = harness({ confirmer: async () => true });
    await runner.run('calendar.create', { summary: 'Dentist', when: 'tomorrow at 3pm' });

    expect(JSON.stringify(sent[0]?.body)).not.toContain('attendee');
  });

  it('creates nothing when the confirmation is declined', async () => {
    const { runner, sent } = harness({ confirmer: async () => false });
    const result = await runner.run('calendar.create', {
      summary: 'Dentist',
      when: 'tomorrow at 3pm',
    });

    expect(result.status === 'refused' && result.reason).toBe('not-confirmed');
    expect(sent).toHaveLength(0);
  });

  it('refuses a time it cannot be certain of rather than guessing', async () => {
    const { runner, sent } = harness({ confirmer: async () => true });
    const result = await runner.run('calendar.create', {
      summary: 'Dentist',
      when: 'next friday',
    });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toContain('will not guess');
    expect(sent).toHaveLength(0);
  });

  it('books a whole day when no time was given', async () => {
    const { runner, sent } = harness({ confirmer: async () => true });
    await runner.run('calendar.create', { summary: 'Leave', when: 'tomorrow' });

    expect(sent[0]?.body).toEqual({
      summary: 'Leave',
      start: { date: '2026-09-17' },
      end: { date: '2026-09-18' },
    });
  });
});
