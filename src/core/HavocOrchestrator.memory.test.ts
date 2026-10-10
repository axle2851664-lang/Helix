import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { HavocOrchestrator } from './HavocOrchestrator.js';
import { Logger } from './Logger.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { ActionRegistry } from '../actions/ActionRegistry.js';
import { ActionRunner } from '../actions/ActionRunner.js';
import { builtinActions } from '../actions/builtin.js';
import { PermissionManager } from '../security/PermissionManager.js';

/**
 * `confirms` decides what the user says to the confirmation that forgetting
 * now goes through. `null` builds the orchestrator with no action pipeline at
 * all, which is the case where nothing can ask and deleting must not happen.
 */
async function makeContext(confirms: boolean | null = true) {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const activity = new ActivityManager();
  const paths = new PathManager({ root: 'E:/Havoc' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });
  const registry = new ActionRegistry();
  registry.registerAll(builtinActions({ settings, knowledge, memory }));
  const runner =
    confirms === null
      ? undefined
      : new ActionRunner({
          registry,
          permissions: new PermissionManager({ store: kv, logger }),
          logger,
          confirmer: async () => confirms,
        });

  const orchestrator = new HavocOrchestrator({
    settings,
    conversations,
    activity,
    projects,
    memory,
    knowledge,
    logger,
    ...(runner ? { runner } : {}),
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
      expect(response.text).toContain("made a note");
      // Quoted, not echoed in first person, so it does not read as Havoc's own view.
      expect(response.text).toContain('"I prefer dark interfaces"');

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

    /**
     * The central privacy rule, and where it now sits.
     *
     * Ordinary conversation is still never remembered: there is no path from
     * a question, an answer, or a passing remark to a memory. What changed is
     * narrow and deliberate - telling Havoc a fact about yourself counts as
     * asking it to know that fact, because in ordinary speech it is one. This
     * test used to assert that "my sister is called Mira" was discarded; it
     * now asserts that the things around it still are.
     */
    it('does not store ordinary conversation', async () => {
      await ask('what should I cook tonight?');
      await ask('I prefer dark interfaces');
      await ask('I think that build is broken');
      await ask('hello');

      expect(await context.memory.count()).toBe(0);
    });

    it('does store a fact the user states about themselves', async () => {
      const response = await ask('my sister is called Mira');

      expect(await context.memory.count()).toBe(1);
      expect((await context.memory.list())[0]?.content).toContain('Mira');
      // Always said out loud: a memory the user did not notice being made is
      // one they cannot choose to delete.
      expect(response.text.toLowerCase()).toContain('mira');
    });

    /**
     * The conversation this came from. The user said their name three times
     * and Havoc discarded it three times, then answered "what is my name"
     * with "I am Havoc."
     */
    it('learns a name and gives it back', async () => {
      await ask('Ok my name is Michael');
      expect(await context.memory.count()).toBe(1);

      const response = await ask('So what is my name');
      expect(response.handled).toBe(true);
      expect(response.text).toContain('Michael');
    });

    it('says it has not been told rather than guessing a name', async () => {
      const response = await ask('what is my name');

      expect(response.text.toLowerCase()).toContain("haven't told me");
      expect(await context.memory.count()).toBe(0);
    });

    /** Correcting yourself should not leave Havoc holding both answers. */
    it('replaces a fact rather than accumulating it', async () => {
      await ask('my name is Michael');
      await ask('my name is Mike');

      expect(await context.memory.count()).toBe(1);
      expect((await context.memory.list())[0]?.content).toContain('Mike');
    });

    /** The credential refusal runs on this path exactly as on every other. */
    it('refuses a credential offered as a fact about the user', async () => {
      const response = await ask('my password is hunter2isnotsecure');

      expect(await context.memory.count()).toBe(0);
      expect(response.text.toLowerCase()).toMatch(/credential|password|key/);
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
      expect(response.text).toContain('nothing on record');
    });

    it('says plainly when it has nothing at all', async () => {
      const fresh = await makeContext();
      const response = await fresh.orchestrator.submit({
        text: 'what do you remember?',
        conversationId: fresh.conversation.id,
      });
      expect(response.text).toContain('not asked me to remember anything');
    });

    // Works with no provider and offline: retrieval is literal, not a model.
    it('recalls with no language provider configured', async () => {
      // Set, not assumed. This used to read the default, which is now 'cloud'
    // - and the subject of the test is the no-provider case, so it says so.
    await context.settings.set('languageProvider', 'none');
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
      expect(response.text).toContain('out of mind');
      expect(await context.memory.count()).toBe(0);
    });

    it('leaves it alone when the confirmation is declined', async () => {
      const declining = await makeContext(false);
      await declining.orchestrator.submit({
        text: 'remember that my sister is called Mira',
        conversationId: declining.conversation.id,
      });

      const response = await declining.orchestrator.submit({
        text: 'forget about my sister',
        conversationId: declining.conversation.id,
      });

      // Cancelling is an answer, not a failure: the tool asked and obeyed.
      expect(response.handled).toBe(true);
      expect(response.failure).toBeUndefined();
      expect(await declining.memory.count()).toBe(1);
    });

    it('refuses to delete when there is no way to confirm', async () => {
      const unasked = await makeContext(null);
      await unasked.orchestrator.submit({
        text: 'remember that my sister is called Mira',
        conversationId: unasked.conversation.id,
      });

      const response = await unasked.orchestrator.submit({
        text: 'forget about my sister',
        conversationId: unasked.conversation.id,
      });

      expect(response.handled).toBe(false);
      expect(await unasked.memory.count()).toBe(1);
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
