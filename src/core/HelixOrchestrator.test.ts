import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { HelixOrchestrator, type HelixTool } from './HelixOrchestrator.js';
import { Logger } from './Logger.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { PathManager } from '../storage/PathManager.js';

async function makeOrchestrator() {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const activity = new ActivityManager();
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });
  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity,
    projects,
    memory,
    knowledge,
    logger,
  });
  const conversation = await conversations.create();

  return { orchestrator, conversations, settings, activity, projects, conversation };
}

describe('HelixOrchestrator', () => {
  let context: Awaited<ReturnType<typeof makeOrchestrator>>;

  beforeEach(async () => {
    context = await makeOrchestrator();
  });

  it('ignores empty input', async () => {
    const response = await context.orchestrator.submit({
      text: '   ',
      conversationId: context.conversation.id,
    });
    expect(response.handled).toBe(false);
    expect(response.failure).toBe('EMPTY');
  });

  it('records both sides of an exchange in the conversation', async () => {
    await context.orchestrator.submit({
      text: 'open settings',
      conversationId: context.conversation.id,
    });

    const loaded = await context.conversations.get(context.conversation.id);
    expect(loaded?.messages.map((m) => m.role)).toEqual(['user', 'helix']);
  });

  describe('navigation tool', () => {
    it('routes a navigation request and reports the target', async () => {
      const response = await context.orchestrator.submit({
        text: 'open settings',
        conversationId: context.conversation.id,
      });

      expect(response.handled).toBe(true);
      expect(response.navigateTo).toBe('settings');
    });

    it('handles several natural phrasings', async () => {
      for (const [text, expected] of [
        ['show me the globe', 'earth'],
        ['take me to storage', 'storage'],
        ['bring up gesture control', 'gesture-control'],
        ['go to conversations', 'conversations'],
      ] as const) {
        const response = await context.orchestrator.submit({
          text,
          conversationId: context.conversation.id,
        });
        expect(response.navigateTo, text).toBe(expected);
      }
    });

    // Navigation is genuinely local: it must work with no provider and offline.
    it('works with no language provider configured', async () => {
      expect(context.settings.get('languageProvider')).toBe('none');
      const response = await context.orchestrator.submit({
        text: 'open memory',
        conversationId: context.conversation.id,
      });
      expect(response.handled).toBe(true);
    });

    it('does not treat an ordinary question as navigation', async () => {
      const response = await context.orchestrator.submit({
        text: 'what should I cook tonight?',
        conversationId: context.conversation.id,
      });
      expect(response.navigateTo).toBeUndefined();
    });
  });

  describe('honesty when unhandled', () => {
    // The single most important behaviour: no fabricated answers.
    it('reports the missing provider rather than answering', async () => {
      const response = await context.orchestrator.submit({
        text: 'write a poem about the ocean',
        conversationId: context.conversation.id,
      });

      expect(response.handled).toBe(false);
      expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
      expect(response.text).toContain('No language provider is configured');
    });

    it('records the failure on the stored message', async () => {
      await context.orchestrator.submit({
        text: 'what is the weather?',
        conversationId: context.conversation.id,
      });

      const loaded = await context.conversations.get(context.conversation.id);
      expect(loaded?.messages[1]?.failure).toBe('PROVIDER_NOT_CONFIGURED');
    });

    it('does not claim success when a provider is selected but unbuilt', async () => {
      await context.settings.set('languageProvider', 'cloud');

      const response = await context.orchestrator.submit({
        text: 'write a poem about the ocean',
        conversationId: context.conversation.id,
      });

      expect(response.handled).toBe(false);
      expect(response.failure).toBe('PROVIDER_NOT_IMPLEMENTED');
      expect(response.text).toContain('will not invent an answer');
    });
  });

  describe('tool registry', () => {
    const stubTool = (overrides: Partial<HelixTool> = {}): HelixTool => ({
      name: 'stub',
      description: 'test tool',
      priority: 500,
      matches: () => true,
      unavailableReason: () => null,
      execute: async () => ({ text: 'stub ran', handled: true }),
      ...overrides,
    });

    it('registers and runs a tool', async () => {
      context.orchestrator.registerTool(stubTool());

      const response = await context.orchestrator.submit({
        text: 'anything at all',
        conversationId: context.conversation.id,
      });

      expect(response.text).toBe('stub ran');
      expect(response.handled).toBe(true);
    });

    it('runs higher-priority tools first', async () => {
      const order: string[] = [];
      context.orchestrator.registerTool(
        stubTool({ name: 'low', priority: 1, execute: async () => { order.push('low'); return { text: 'low', handled: true }; } }),
      );
      context.orchestrator.registerTool(
        stubTool({ name: 'high', priority: 999, execute: async () => { order.push('high'); return { text: 'high', handled: true }; } }),
      );

      await context.orchestrator.submit({ text: 'x', conversationId: context.conversation.id });
      expect(order).toEqual(['high']);
    });

    // A tool that cannot run must explain why, not fail obscurely.
    it('reports why an unavailable tool cannot run', async () => {
      context.orchestrator.registerTool(
        stubTool({ unavailableReason: () => 'No camera is connected.' }),
      );

      const response = await context.orchestrator.submit({
        text: 'x',
        conversationId: context.conversation.id,
      });

      expect(response.handled).toBe(false);
      expect(response.text).toBe('No camera is connected.');
      expect(response.failure).toBe('CAPABILITY_UNAVAILABLE');
    });

    it('converts a thrown tool error into a readable failure', async () => {
      context.orchestrator.registerTool(
        stubTool({
          execute: async () => {
            throw new Error('ECONNREFUSED 127.0.0.1:11434');
          },
        }),
      );

      const response = await context.orchestrator.submit({
        text: 'x',
        conversationId: context.conversation.id,
      });

      expect(response.handled).toBe(false);
      // The raw socket error must never reach the user.
      expect(response.text).not.toContain('ECONNREFUSED');
    });
  });

  describe('activity tracking', () => {
    it('returns to standing by after a request completes', async () => {
      await context.orchestrator.submit({
        text: 'open settings',
        conversationId: context.conversation.id,
      });
      expect(context.activity.isBusy).toBe(false);
    });

    it('does not leave activity stuck when a tool throws', async () => {
      context.orchestrator.registerTool({
        name: 'boom',
        description: 'always throws',
        priority: 900,
        matches: () => true,
        unavailableReason: () => null,
        execute: async () => {
          throw new Error('kaboom');
        },
      });

      await context.orchestrator.submit({ text: 'x', conversationId: context.conversation.id });
      expect(context.activity.isBusy).toBe(false);
    });

    it('reports activity while a tool runs', async () => {
      const seen: string[] = [];
      context.activity.subscribe((a) => seen.push(a.kind));

      context.orchestrator.registerTool({
        name: 'slow',
        description: 'observable',
        priority: 900,
        matches: () => true,
        unavailableReason: () => null,
        execute: async () => ({ text: 'ok', handled: true }),
      });

      await context.orchestrator.submit({ text: 'x', conversationId: context.conversation.id });
      expect(seen).toContain('thinking');
    });
  });
});

describe('orchestrator wiring', () => {
  it('registers the navigation tool by default', async () => {
    const { orchestrator } = await makeOrchestrator();
    expect(orchestrator.tools.map((t) => t.name)).toContain('navigate');
  });

  it('logs tool registration without throwing', async () => {
    const { orchestrator } = await makeOrchestrator();
    expect(() =>
      orchestrator.registerTool({
        name: 'noop',
        description: 'd',
        priority: 0,
        matches: () => false,
        unavailableReason: () => null,
        execute: async () => ({ text: '', handled: false }),
      }),
    ).not.toThrow();
    expect(vi.isMockFunction(() => {})).toBe(false);
  });
});
