import { beforeEach, describe, expect, it } from 'vitest';
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

/**
 * A router that reports exactly what it is told to, so "what is answering"
 * can be asserted rather than inferred.
 */
function routerReporting(model: { id: string; name: string } | null, location = 'local') {
  return {
    describeSelection: () => ({
      model,
      provider:
        model === null ? null : { name: location === 'local' ? 'Ollama' : 'Gemini', location },
      reason: model === null ? 'No local model is running.' : 'An ordinary request.',
    }),
  };
}

async function makeContext(ai?: unknown) {
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
    ...(ai !== undefined ? { ai: ai as never } : {}),
  });
  const conversation = await conversations.create();

  return { orchestrator, settings, projects, conversation, kv, logger };
}

describe('orchestrator: model switching', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  it('defaults to Opus 5', () => {
    expect(context.settings.get('languageModel')).toBe('claude-opus-5');
  });

  it('switches to Sonnet on command', async () => {
    const response = await ask('switch to Sonnet');

    expect(response.handled).toBe(true);
    expect(response.text).toContain('Sonnet 5');
    expect(context.settings.get('languageModel')).toBe('claude-sonnet-5');
  });

  it('switches to Haiku on command', async () => {
    await ask('use Haiku');
    expect(context.settings.get('languageModel')).toBe('claude-haiku-4-5');
  });

  it('switches back to Opus', async () => {
    await ask('switch to Sonnet');
    await ask('switch to Opus 5');
    expect(context.settings.get('languageModel')).toBe('claude-opus-5');
  });

  it('accepts several phrasings', async () => {
    for (const [phrase, expected] of [
      ['switch to sonnet', 'claude-sonnet-5'],
      ['use opus', 'claude-opus-5'],
      ['change to haiku', 'claude-haiku-4-5'],
      ['switch to claude sonnet 5', 'claude-sonnet-5'],
    ] as const) {
      await ask(phrase);
      expect(context.settings.get('languageModel'), phrase).toBe(expected);
    }
  });

  // A request for "Haiku 5" gets the real Haiku, and the reply names it, so the
  // user is not left believing a Haiku 5 exists.
  it('answers a request for "Haiku 5" with Haiku 4.5 by name', async () => {
    const response = await ask('switch to Haiku 5');

    expect(context.settings.get('languageModel')).toBe('claude-haiku-4-5');
    expect(response.text).toContain('Haiku 4.5');
  });

  /**
   * The bug this replaced: "which model are you" answered from
   * settings.languageModel, whose default is claude-opus-5, while a local
   * model wrote every other sentence. Someone running local-only asks this
   * exact question to check that nothing is leaving the machine, so a
   * confident wrong answer here is the most damaging one Helix can give.
   */
  it('names what is actually answering, not the stored preference', async () => {
    const local = await makeContext(routerReporting({ id: 'qwen2.5:7b', name: 'Qwen2.5 7B' }));
    const response = await local.orchestrator.submit({
      text: 'which model are you using?',
      conversationId: local.conversation.id,
    });

    expect(response.handled).toBe(true);
    expect(response.text).toContain('qwen2.5:7b');
    expect(response.text).not.toContain('Opus');
    expect(response.text).not.toContain('claude');
  });

  it('says plainly that a local model keeps the conversation on the machine', async () => {
    const local = await makeContext(routerReporting({ id: 'qwen2.5:7b', name: 'Qwen2.5 7B' }));
    const response = await local.orchestrator.submit({
      text: 'what are you running on?',
      conversationId: local.conversation.id,
    });

    expect(response.text).toContain('this machine');
    expect(response.text).toMatch(/not sent anywhere|Nothing you say/i);
  });

  it('does not claim to be local when a cloud provider is answering', async () => {
    const cloud = await makeContext(
      routerReporting({ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, 'cloud'),
    );
    const response = await cloud.orchestrator.submit({
      text: 'are you local?',
      conversationId: cloud.conversation.id,
    });

    expect(response.text).toContain('off this machine');
    expect(response.text).not.toMatch(/Nothing you say/i);
  });

  it('says nothing is answering rather than naming a model, when none is', async () => {
    const response = await ask('which model are you using?');

    expect(response.text).not.toContain('Opus 5');
    expect(response.text).toMatch(/nothing is answering/i);
  });

  it('says when the model is already selected', async () => {
    const response = await ask('switch to Opus');
    expect(response.text).toContain('already set to Opus 5');
  });

  // The switch is real; the connection is not. Every reply must say so, or a
  // user will reasonably assume the next question gets answered.
  it('always states that no API key is connected when switching', async () => {
    for (const phrase of ['switch to sonnet', 'switch to haiku']) {
      const response = await ask(phrase);
      expect(response.text, phrase).toContain('no API key is connected');
    }
  });

  it('persists the choice across a restart', async () => {
    await ask('switch to Sonnet');

    const reloaded = new SettingsManager({ store: context.kv, logger: context.logger });
    await reloaded.load();
    expect(reloaded.get('languageModel')).toBe('claude-sonnet-5');
  });

  it('names the selected model when it cannot answer a question', async () => {
    await context.settings.set('languageProvider', 'cloud');
    await ask('switch to Sonnet');

    const response = await ask('write a poem about the ocean');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_IMPLEMENTED');
    expect(response.text).toContain('Sonnet 5');
  });

  describe('routing precedence', () => {
    it('does not treat an ordinary question as a model switch', async () => {
      const response = await ask('what should I cook tonight?');
      expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
      expect(context.settings.get('languageModel')).toBe('claude-opus-5');
    });

    it('does not hijack a project request', async () => {
      const project = await context.projects.createProject('Iron Man');
      const response = await ask('open my Iron Man project');

      expect(response.openProjectId).toBe(project.id);
      expect(context.settings.get('languageModel')).toBe('claude-opus-5');
    });

    it('does not hijack navigation', async () => {
      const response = await ask('open settings');
      expect(response.navigateTo).toBe('settings');
    });

    // "use" is a switching verb, but without a model name it is not a switch.
    it('ignores a switching verb with no model named', async () => {
      const response = await ask('switch to something else');
      expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
      expect(context.settings.get('languageModel')).toBe('claude-opus-5');
    });
  });
});
