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

async function makeContext() {
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

  return { orchestrator, memory, projects, settings, conversation };
}

describe('orchestrator: memory tool', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  describe('remembering', () => {
    it('stores what it is asked to remember', async () => {
      const response = await ask('remember that I prefer dark interfaces');

      expect(response.handled).toBe(true);
      expect(response.text).toContain('Remembered');

      const stored = await context.memory.list();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.content).toBe('I prefer dark interfaces');
    });

    it('accepts several phrasings', async () => {
      for (const phrase of [
        'remember that my sister is called Mira',
        'remember: the suit is red and gold',
        'note that the deadline is Friday',
        'keep in mind that I work best in the morning',
      ]) {
        const response = await ask(phrase);
        expect(response.handled, phrase).toBe(true);
      }
      expect(await context.memory.count()).toBe(4);
    });

    it('asks what to remember when nothing follows', async () => {
      const response = await ask('remember');
      expect(response.handled).toBe(false);
      expect(await context.memory.count()).toBe(0);
    });

    // The central privacy rule: ordinary conversation is never remembered.
    it('does not store an ordinary statement', async () => {
      await ask('my sister is called Mira');
      await ask('what should I cook tonight?');
      await ask('I prefer dark interfaces');

      expect(await context.memory.count()).toBe(0);
    });

    it('refuses a credential and says why', async () => {
      const response = await ask('remember that my key is sk-ant-abcdefghijklmnopqrstuvwx');

      expect(response.handled).toBe(false);
      expect(response.text).toContain('credential');
      expect(await context.memory.count()).toBe(0);
    });

    it('reports that memory is off rather than failing obscurely', async () => {
      await context.settings.set('allowLongTermMemory', false);

      const response = await ask('remember that I prefer dark interfaces');

      expect(response.handled).toBe(false);
      expect(response.text).toContain('Long-term memory is turned off');
      expect(await context.memory.count()).toBe(0);
    });
  });

  describe('recalling', () => {
    beforeEach(async () => {
      await ask('remember that my sister is called Mira');
      await ask('remember that I prefer dark interfaces');
    });

    it('recalls by subject', async () => {
      const response = await ask('what do you remember about my sister?');

      expect(response.handled).toBe(true);
      expect(response.text).toContain('Mira');
    });

    it('handles "what do you know about"', async () => {
      const response = await ask('what do you know about my sister');
      expect(response.text).toContain('Mira');
    });

    it('lists everything when no subject is given', async () => {
      const response = await ask('what do you remember?');

      expect(response.handled).toBe(true);
      expect(response.text).toContain('Mira');
      expect(response.text).toContain('dark interfaces');
    });

    it('says plainly when it has nothing on a subject', async () => {
      const response = await ask('what do you remember about my car?');
      expect(response.text).toContain('nothing remembered');
    });

    it('says plainly when it has nothing at all', async () => {
      const fresh = await makeContext();
      const response = await fresh.orchestrator.submit({
        text: 'what do you remember?',
        conversationId: fresh.conversation.id,
      });
      expect(response.text).toContain('not been asked to remember anything');
    });

    // Works with no provider and offline: retrieval is literal, not a model.
    it('recalls with no language provider configured', async () => {
      expect(context.settings.get('languageProvider')).toBe('none');
      const response = await ask('what do you remember about my sister');
      expect(response.handled).toBe(true);
    });
  });

  describe('forgetting', () => {
    beforeEach(async () => {
      await ask('remember that my sister is called Mira');
    });

    it('forgets a matching memory', async () => {
      const response = await ask('forget about my sister');

      expect(response.handled).toBe(true);
      expect(response.text).toContain('Forgotten');
      expect(await context.memory.count()).toBe(0);
    });

    it('says so when nothing matches', async () => {
      const response = await ask('forget about my car');

      expect(response.handled).toBe(false);
      expect(response.failure).toBe('NOT_FOUND');
      expect(await context.memory.count()).toBe(1);
    });

    it('asks what to forget when nothing follows', async () => {
      const response = await ask('forget');
      expect(response.handled).toBe(false);
      expect(await context.memory.count()).toBe(1);
    });
  });

  describe('routing precedence', () => {
    it('does not hijack a project request', async () => {
      const project = await context.projects.createProject('Iron Man');
      const response = await ask('open my Iron Man project');

      expect(response.openProjectId).toBe(project.id);
      expect(await context.memory.count()).toBe(0);
    });

    it('does not hijack navigation', async () => {
      const response = await ask('open settings');
      expect(response.navigateTo).toBe('settings');
    });

    it('does not hijack a model switch', async () => {
      await ask('switch to Sonnet');
      expect(context.settings.get('languageModel')).toBe('claude-sonnet-5');
      expect(await context.memory.count()).toBe(0);
    });

    // "open memory" is navigation to the workspace, not a recall request.
    it('treats "open memory" as navigation', async () => {
      const response = await ask('open memory');
      expect(response.navigateTo).toBe('memory');
    });
  });
});
