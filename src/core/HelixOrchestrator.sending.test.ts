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
import { OutboundManager } from '../outbound/OutboundManager.js';
import { GmailTransport } from '../outbound/GmailTransport.js';
import { GmailProvider } from '../integrations/google/GmailProvider.js';
import type { InferenceTransport } from '../ai/types.js';
import type { AIRouter } from '../ai/AIRouter.js';

/**
 * Asking Helix to send something, all the way to the wire.
 *
 * The pieces each have their own tests. What this file checks is the join:
 * that asking produces a draft rather than a send, that the draft carries
 * what the user actually asked for, and that nothing reaches Gmail until the
 * message has been confirmed on its own.
 */

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

async function makeContext() {
  const kv = new MemoryKeyValueStore();
  const logger = silentLogger();
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });

  const wire: Array<{ path: string; body: unknown }> = [];
  const transport: InferenceTransport = {
    id: 'google',
    unavailableReason: () => null,
    hasCredential: () => true,
    request: async (request) => {
      wire.push({ path: request.path, body: request.body });
      return { id: 'sent_1' };
    },
  };

  const gmail = new GmailProvider({ transport, account: () => 'me@example.com' });
  const outbound = new OutboundManager({
    store: kv,
    logger,
    transports: [new GmailTransport(gmail)],
  });

  const ai = {
    generate: async () => ({ text: 'Are we still on for Thursday?' }),
  } as unknown as AIRouter;

  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity: new ActivityManager(),
    projects,
    memory,
    knowledge,
    logger,
    outbound,
    ai,
  });
  const conversation = await conversations.create();

  return {
    outbound,
    wire,
    ask: (text: string) => orchestrator.submit({ text, conversationId: conversation.id }),
  };
}

describe('asking Helix to email somebody', () => {
  it('drafts rather than sends, and says where to read it', async () => {
    const { ask, outbound, wire } = await makeContext();

    const response = await ask('email marlow@example.com about the site visit');

    expect(response.handled).toBe(true);
    expect(response.navigateTo).toBe('outbox');

    const pending = await outbound.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.to).toEqual(['marlow@example.com']);

    // The whole point: nothing has left.
    expect(wire).toEqual([]);
  });

  it('keeps dictated wording exactly as it was said', async () => {
    const { ask, outbound } = await makeContext();
    await ask('email marlow@example.com saying I will be twenty minutes late');

    expect((await outbound.pending())[0]?.body).toBe('I will be twenty minutes late');
  });

  it('refuses to guess an address from a name', async () => {
    const { ask, outbound } = await makeContext();
    const response = await ask('email Marlow about the site visit');

    expect(response.handled).toBe(false);
    expect(await outbound.pending()).toEqual([]);
  });

  /** "Never spend" survives the arrival of a working transport. */
  it('refuses to draft a purchase', async () => {
    const { ask, outbound, wire } = await makeContext();
    const response = await ask('email shop@example.com saying please buy me a new laptop');

    expect(response.handled).toBe(false);
    expect(await outbound.pending()).toEqual([]);
    expect(wire).toEqual([]);
  });
});

describe('the gate between a draft and the wire', () => {
  it('refuses to dispatch a draft that was never confirmed', async () => {
    const { ask, outbound, wire } = await makeContext();
    await ask('email marlow@example.com about the site visit');
    const id = (await outbound.pending())[0]?.id ?? '';

    await expect(outbound.dispatch(id)).rejects.toThrow();
    expect(wire).toEqual([]);
  });

  it('sends only after that one message is confirmed', async () => {
    const { ask, outbound, wire } = await makeContext();
    await ask('email marlow@example.com saying we are on for Thursday');
    const id = (await outbound.pending())[0]?.id ?? '';

    await outbound.confirm(id);
    await outbound.dispatch(id);

    expect(wire).toHaveLength(1);
    expect(wire[0]?.path).toBe('/gmail/v1/users/me/messages/send');

    const raw = (wire[0]?.body as { raw: string }).raw.replace(/-/g, '+').replace(/_/g, '/');
    const mime = Buffer.from(raw, 'base64').toString('utf8');
    expect(mime).toContain('To: marlow@example.com');
    expect(mime).toContain('we are on for Thursday');
  });

  /**
   * An approval given and forgotten must not sit waiting to be spent on
   * something the user has stopped thinking about.
   */
  it('refuses a confirmation that has gone stale', async () => {
    const { ask, outbound, wire } = await makeContext();
    await ask('email marlow@example.com about the site visit');
    const id = (await outbound.pending())[0]?.id ?? '';

    await outbound.confirm(id, Date.now() - 60 * 60 * 1000);
    await expect(outbound.dispatch(id)).rejects.toThrow(/stale/);
    expect(wire).toEqual([]);
  });

  it('cannot send the same message twice', async () => {
    const { ask, outbound, wire } = await makeContext();
    await ask('email marlow@example.com about the site visit');
    const id = (await outbound.pending())[0]?.id ?? '';

    await outbound.confirm(id);
    await outbound.dispatch(id);
    await expect(outbound.dispatch(id)).rejects.toThrow();

    expect(wire).toHaveLength(1);
  });
});
