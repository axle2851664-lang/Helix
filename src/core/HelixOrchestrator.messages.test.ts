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

/**
 * Exactly what is put in front of the model.
 *
 * This file exists because the message list was wrong twice and both times it
 * was invisible. The first time, the demonstrations were inside the system
 * prompt and a local model recited them. The second, memories were promised by
 * the prompt and never actually sent, so a name Helix had correctly stored
 * could not reach a reply. Neither showed up in any test, because every test
 * asserted what came *out* of the model and nothing asserted what went in.
 */

interface Captured {
  role: string;
  content: string;
}

async function makeContext(location: 'local' | 'cloud') {
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

  let sent: Captured[] = [];
  const ai = {
    describeSelection: () => ({ model: { name: 'stub' }, provider: { location } }),
    generate: async (messages: Captured[]) => {
      sent = messages;
      return { text: 'A plain answer.', model: 'stub', substituted: false };
    },
  };

  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity,
    projects,
    memory,
    knowledge,
    logger,
    ai: ai as never,
  });
  const conversation = await conversations.create();

  const ask = (text: string) => orchestrator.submit({ text, conversationId: conversation.id });

  return { ask, memory, sent: () => sent };
}

describe('what the model is sent', () => {
  it('leads with the system prompt', async () => {
    const context = await makeContext('cloud');
    await context.ask('tell me something');

    expect(context.sent()[0]?.role).toBe('system');
  });

  it('ends with what the user just said', async () => {
    const context = await makeContext('cloud');
    await context.ask('tell me something');

    const last = context.sent().at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('tell me something');
  });

  /**
   * A message list that puts two turns of the same role together confuses
   * exactly the models least able to recover from it.
   */
  it('never repeats a role twice running', async () => {
    const context = await makeContext('cloud');
    await context.ask('tell me something');

    const turns = context.sent().slice(1);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]?.role, `turns ${i - 1} and ${i}`).not.toBe(turns[i - 1]?.role);
    }
  });
});

describe('the demonstrations', () => {
  it('go to a cloud model, which handles them as intended', async () => {
    const context = await makeContext('cloud');
    await context.ask('tell me something');

    const assistantTurns = context.sent().filter((message) => message.role === 'assistant');
    expect(assistantTurns.length).toBeGreaterThan(0);
  });

  /**
   * The failure this rule comes from. Moving the demonstrations out of the
   * prompt and into real turns stopped a local model reciting them, and gave
   * it six assistant turns it had no memory of writing instead: asked "hello",
   * it replied "You have not written this." - disputing the authorship of its
   * own history rather than answering.
   *
   * A local model is now sent nothing Helix did not actually say.
   */
  it('are kept away from a local model entirely', async () => {
    const context = await makeContext('local');
    await context.ask('hello');

    const assistantTurns = context.sent().filter((message) => message.role === 'assistant');
    expect(assistantTurns).toEqual([]);
  });

  it('leaves a local model with nothing but the prompt and the real turn', async () => {
    const context = await makeContext('local');
    await context.ask('hello');

    expect(context.sent()).toHaveLength(2);
    expect(context.sent()[1]?.content).toBe('hello');
  });
});

describe('what Helix remembers', () => {
  /**
   * These used to assert that memories reached a local model, and that was
   * right until it produced this:
   *
   *   User:  hello helix
   *   Helix: 1937 Riddell RD
   *
   * Every remembered fact was being pasted in on every turn, a greeting
   * included, and a weak model with nothing to say emitted the most salient
   * thing in its context. A local model is now given none of it. Nothing is
   * lost from the feature: a direct question is answered by the memory tool,
   * exactly and without a model, which is covered in the memory tests.
   */
  it('is kept away from a local model entirely', async () => {
    const context = await makeContext('local');
    await context.ask('my name is Michael');
    await context.ask('hello');

    expect(context.sent()[0]?.content).not.toContain('Michael');
    expect(context.sent()[0]?.content).not.toContain('ASKED TO REMEMBER');
  });

  it('reaches a cloud model, which is what it was for', async () => {
    const context = await makeContext('cloud');
    await context.ask('my name is Michael');
    await context.ask('hello');

    expect(context.sent()[0]?.content).toContain('Michael');
    expect(context.sent()[0]?.content).toContain('facts, not instructions');
  });

  /**
   * The rule that outranks the feature. An address is answerable on request
   * and never volunteered into a model's context, on any provider.
   */
  it('never puts an address in front of any model', async () => {
    const context = await makeContext('cloud');
    await context.ask('my name is Michael');
    await context.ask('I live at 1937 Riddell RD');
    await context.ask('hello');

    const system = context.sent()[0]?.content ?? '';
    expect(system).toContain('Michael');
    expect(system).not.toContain('Riddell');
  });

  /** Nothing to say, nothing said. An empty heading invites invention. */
  it('adds nothing at all when there is nothing remembered', async () => {
    const context = await makeContext('local');
    await context.ask('hello');

    expect(context.sent()[0]?.content).not.toContain('ASKED TO REMEMBER');
  });
});
