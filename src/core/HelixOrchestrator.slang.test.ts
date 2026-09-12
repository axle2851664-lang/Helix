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
import type { AIRouter } from '../ai/AIRouter.js';

/** A stand-in router that records what it was asked and answers fixed text. */
function fakeAi(reply = 'yo the meetin got moved fr') {
  const calls: Array<{ system: string; user: string }> = [];
  const router = {
    generate: async (messages: Array<{ role: string; content: string }>) => {
      calls.push({
        system: messages.find((m) => m.role === 'system')?.content ?? '',
        user: messages.find((m) => m.role === 'user')?.content ?? '',
      });
      return { text: reply, model: 'test', requestedModel: 'test', substituted: false };
    },
  } as unknown as AIRouter;
  return { router, calls };
}

async function makeContext(ai?: AIRouter) {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
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
    ...(ai ? { ai } : {}),
  });
  const conversation = await conversations.create();
  return { orchestrator, conversations, conversation };
}

describe('slang, when asked', () => {
  it('rewrites the text it was given', async () => {
    const ai = fakeAi();
    const context = await makeContext(ai.router);

    const response = await context.orchestrator.submit({
      text: 'translate "the meeting has been moved" into slang',
      conversationId: context.conversation.id,
    });

    expect(response.handled).toBe(true);
    expect(response.text).toBe('yo the meetin got moved fr');
    expect(ai.calls[0]?.user).toBe('the meeting has been moved');
    // Told to rewrite, not to reply: a slang answer is not a slang translation.
    expect(ai.calls[0]?.system).toContain('Do not answer it');
  });

  it('rewrites what Helix last said when the request points back', async () => {
    const ai = fakeAi();
    const context = await makeContext(ai.router);
    await context.conversations.appendMessage(context.conversation.id, {
      role: 'helix',
      text: 'The meeting has been moved to Tuesday.',
    });

    const response = await context.orchestrator.submit({
      text: 'say that in slang',
      conversationId: context.conversation.id,
    });

    expect(response.handled).toBe(true);
    expect(ai.calls[0]?.user).toBe('The meeting has been moved to Tuesday.');
  });

  it('asks what to translate rather than translating the request itself', async () => {
    const ai = fakeAi();
    const context = await makeContext(ai.router);

    const response = await context.orchestrator.submit({
      text: 'say that in slang',
      conversationId: context.conversation.id,
    });

    expect(response.handled).toBe(false);
    expect(ai.calls).toHaveLength(0);
  });

  it('says a rewrite needs a model rather than faking one', async () => {
    const context = await makeContext();

    const response = await context.orchestrator.submit({
      text: 'translate "good morning" into slang',
      conversationId: context.conversation.id,
    });

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('does not put the slang back into Helix\u2019s own register', async () => {
    // `repair` enforces Helix's voice, which would undo the whole request.
    const ai = fakeAi('nah fam that ain\u2019t it');
    const context = await makeContext(ai.router);

    const response = await context.orchestrator.submit({
      text: 'translate "that is incorrect" into slang',
      conversationId: context.conversation.id,
    });

    expect(response.text).toBe('nah fam that ain\u2019t it');
  });
});

describe('slang, when not asked', () => {
  it('never fires on an ordinary question', async () => {
    const ai = fakeAi();
    const context = await makeContext(ai.router);

    for (const text of [
      'what is on my calendar',
      'what does that slang mean',
      'remember that my sister is called Mira',
      'is that slang or a typo',
    ]) {
      await context.orchestrator.submit({ text, conversationId: context.conversation.id });
    }

    // The slang tool builds its own prompt; the conversation path builds the
    // persona one. None of these may have reached the former.
    expect(ai.calls.every((call) => !call.system.startsWith('Rewrite the text'))).toBe(true);
  });
});
