import { describe, expect, it } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { HavocOrchestrator } from './HavocOrchestrator.js';
import { Logger } from './Logger.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { NotepadManager } from '../notepad/NotepadManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { ActionRegistry } from '../actions/ActionRegistry.js';
import { ActionRunner } from '../actions/ActionRunner.js';
import { builtinActions } from '../actions/builtin.js';
import { PermissionManager } from '../security/PermissionManager.js';

/**
 * Whole conversations, through the real orchestrator.
 *
 * The understanding layer's own tests check a sentence at a time. These check
 * the thing that actually matters: that several turns in a row work, that "it"
 * still means the right note three turns later, and that a correction changes
 * a target instead of starting again.
 */
async function talk(confirms: boolean | null = true) {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const activity = new ActivityManager();
  const paths = new PathManager({ root: 'E:/Havoc' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const notepad = new NotepadManager({ store: kv, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });

  const registry = new ActionRegistry();
  registry.registerAll(builtinActions({ settings, knowledge, memory, notepad }));
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
    notepad,
    knowledge,
    logger,
    ...(runner ? { runner } : {}),
  });
  const conversation = await conversations.create();

  const say = (text: string) => orchestrator.submit({ text, conversationId: conversation.id });
  return { say, notepad, memory };
}

describe('the first conversation in the brief', () => {
  it('knows what "it" means three turns later', async () => {
    const { say, notepad } = await talk();

    expect((await say('Open Notepad.')).navigateTo).toBe('notepad');

    const created = await say('Create a note called Havoc Ideas.');
    expect(created.handled).toBe(true);

    const added = await say('Add the new aura design to it.');
    expect(added.handled).toBe(true);

    const notes = await notepad.list();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain('aura design');
  });
});

describe('the second conversation in the brief', () => {
  it('picks the second of two without the name being repeated', async () => {
    const { say, notepad } = await talk();
    await notepad.save({ content: 'Website\n\nThe marketing site.' });
    await notepad.save({ content: 'Website redesign\n\nThe rebuild.' });

    const found = await say('Find my notes about the website.');
    expect(found.handled).toBe(true);
    expect(found.card?.sections[0]?.items.length).toBe(2);

    const second = await say('The second one.');
    expect(second.handled).toBe(true);

    const added = await say('Add the login issue.');
    expect(added.handled).toBe(true);

    const titles = (await notepad.list()).filter((note) => note.content.includes('login issue'));
    expect(titles).toHaveLength(1);
  });
});

describe('natural phrasings, end to end', () => {
  it('opens the Notepad however it is asked for', async () => {
    for (const said of [
      'Can you open my notes?',
      'Pull up my notebook.',
      'show my notes',
      'open not pad',
    ]) {
      const { say } = await talk();
      const response = await say(said);
      expect(response.navigateTo, said).toBe('notepad');
    }
  });

  it('writes a note from a sentence that never says "note"', async () => {
    const { say, notepad } = await talk();
    await say('I need to write something down: the supplier is late.');

    expect(await notepad.count()).toBe(1);
  });

  it('keeps a list as one note rather than three', async () => {
    const { say, notepad } = await talk();
    await say('write down eggs, milk and bread');

    expect(await notepad.count()).toBe(1);
    expect((await notepad.list())[0]?.content).toContain('milk');
  });
});

describe('corrections', () => {
  it('redirects to the other note instead of starting again', async () => {
    const { say, notepad } = await talk();
    await notepad.save({ content: 'Blender\n\nModelling notes.' });
    await notepad.save({ content: 'Havoc\n\nAssistant notes.' });

    await say('Open my Blender notes.');
    const redirected = await say('No, I meant the Havoc notes.');

    expect(redirected.handled).toBe(true);
    expect(redirected.navigateTo).toBe('notepad');
  });

  it('stops on a cancellation rather than acting', async () => {
    const { say, notepad } = await talk();
    await notepad.save({ content: 'Website\n\nNotes.' });

    await say('find my note about the website');
    const cancelled = await say('Actually, forget that.');

    // Declined, so it falls through rather than being acted on.
    expect(cancelled.handled).toBe(false);
    expect(await notepad.count()).toBe(1);
  });
});

describe('asking rather than guessing', () => {
  it('asks which note when a deletion names none', async () => {
    const { say, notepad } = await talk();
    await notepad.save({ content: 'One\n\nFirst.' });
    await notepad.save({ content: 'Two\n\nSecond.' });

    const response = await say('delete that');
    expect(response.text.toLowerCase()).toContain('which');
    // Nothing was deleted while it asked.
    expect(await notepad.count()).toBe(2);
  });

  /** Irreversible, so it still goes through the confirmation pipeline. */
  it('confirms before deleting, and obeys a no', async () => {
    const { say, notepad } = await talk(false);
    await notepad.save({ content: 'Website\n\nNotes.' });

    const response = await say('delete my note about the website');
    expect(response.handled).toBe(true);
    expect(await notepad.count()).toBe(1);
  });

  it('deletes once confirmed', async () => {
    const { say, notepad } = await talk(true);
    await notepad.save({ content: 'Website\n\nNotes.' });

    await say('delete my note about the website');
    expect(await notepad.count()).toBe(0);
  });
});

describe('several instructions in one message', () => {
  it('runs them in order, each one feeding the next', async () => {
    const { say, notepad } = await talk();
    await notepad.save({ content: 'Website\n\nThe marketing site.' });

    const response = await say(
      'Open my notes, find the one about the website, and add that I need to fix the login page',
    );

    expect(response.handled).toBe(true);
    const website = (await notepad.list()).find((note) => note.title === 'Website');
    expect(website?.content).toContain('login page');
  });
});

describe('what it must not take over', () => {
  /**
   * Sixteen keyword tools sit below this layer and every one of them has to
   * keep working. The layer declines whatever it is unsure of, and these are
   * the requests that must reach the tools underneath.
   */
  it('leaves memory, files and ordinary questions alone', async () => {
    const { say, memory, notepad } = await talk();

    await say('remember that I take my answers short');
    expect(await memory.count()).toBe(1);
    expect(await notepad.count()).toBe(0);

    const asked = await say('what is the capital of Australia');
    expect(asked.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

describe('questions about Havoc itself', () => {
  /**
   * A 1B model told the user they could grant file access by typing a magic
   * phrase. They typed it, and the understanding layer opened the Files
   * screen - which looked like proof the invented mechanism worked. Both
   * halves of that are fixed: the question is answered from the real
   * permission record, and the phrase is no longer read as a command.
   */
  it('answers a permission question itself, rather than letting a model invent one', async () => {
    const { say } = await talk();

    const asked = await say('How do i give you permission');
    expect(asked.handled).toBe(true);
    expect(asked.text.toLowerCase()).toContain('nothing to type');

    const typed = await say('i want to give you permission to access my files');
    expect(typed.navigateTo).toBeUndefined();
  });

  it('does not invent a menu or a service', async () => {
    const { say } = await talk();

    const response = await say('where is the menu');
    expect(response.handled).toBe(true);
    expect(response.text).toContain('Settings');
  });

  it('answers what it can do from the registry', async () => {
    const { say } = await talk();

    const response = await say('what can you do');
    expect(response.handled).toBe(true);
    expect(response.text.toLowerCase()).toContain('notepad');
  });
});

describe('chat that is not an instruction', () => {
  /**
   * Every one of these was acted on. The user was correcting Havoc's English,
   * thanking it, or asking it to explain itself, and Havoc went looking
   * through their files.
   */
  it('falls through to conversation instead of acting', async () => {
    for (const said of ['Which file', 'ok thx', 'nothing', 'no its "yes"', 'Why is it open']) {
      const { say } = await talk();
      const response = await say(said);
      expect(response.navigateTo, said).toBeUndefined();
      expect(response.failure, said).toBe('PROVIDER_NOT_CONFIGURED');
    }
  });
});

describe('the interface, by voice', () => {
  it('shows the sidebar however it is asked for', async () => {
    for (const said of [
      'Show the sidebar.',
      'Open the sidebar.',
      'Bring up the sidebar.',
      'I want the sidebar.',
      'Show me my controls.',
      'Open the panel.',
      'Bring the panel back.',
    ]) {
      const { say } = await talk();
      const response = await say(said);
      expect(response.ui?.sidebar, said).toBe('show');
    }
  });

  it('hides it however it is asked for', async () => {
    for (const said of [
      'Hide the sidebar.',
      'Close the sidebar.',
      'Get rid of the sidebar.',
      'Hide the panel.',
    ]) {
      const { say } = await talk();
      const response = await say(said);
      expect(response.ui?.sidebar, said).toBe('hide');
    }
  });

  /** Local, every time. Showing a panel is not something to ask a model. */
  it('never needs a model to move a panel', async () => {
    const { say } = await talk();
    const response = await say('show the sidebar');

    expect(response.handled).toBe(true);
    expect(response.failure).toBeUndefined();
  });
});

describe('the clock', () => {
  it('opens however the time is asked for', async () => {
    for (const said of [
      'Show me the time.',
      'What time is it?',
      'Display the time.',
      'Tell me the time.',
      'Give me the current time.',
      "What's the exact time?",
      'Show the clock.',
    ]) {
      const { say } = await talk();
      const response = await say(said);
      expect(response.ui?.overlay, said).toBe('time');
    }
  });

  it('closes however that is asked for', async () => {
    for (const said of ['Close the clock.', 'Hide the time.']) {
      const { say } = await talk();
      await say('show me the time');
      const response = await say(said);
      expect(response.ui?.overlay, said).toBeNull();
    }
  });

  /**
   * The contextual case from the brief. "That" has to resolve to the thing
   * Havoc just put on screen, not to whichever note was last touched.
   */
  it('understands "close that" as the clock it just opened', async () => {
    for (const said of ['Close that.', 'Go back.', "That's enough."]) {
      const { say } = await talk();
      await say('show me the time');
      const response = await say(said);
      expect(response.ui?.overlay, said).toBeNull();
    }
  });

  /** The time itself never comes from a model - it is read in the browser. */
  it('never answers with a time of its own', async () => {
    const { say } = await talk();
    const response = await say('what time is it');

    expect(response.ui?.overlay).toBe('time');
    expect(response.text).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('facts the user marks as true', () => {
  it('stores a marked fact in long-term memory', async () => {
    const { say, memory } = await talk();
    const response = await say('The truth is that my project is called Havoc.');

    expect(await memory.count()).toBe(1);
    const stored = (await memory.list())[0];
    expect(stored?.content).toContain('my project is called Havoc');
    expect(stored?.tags).toContain('truth');
    expect(stored?.tags).toContain('user-stated');
    expect(response.text).toContain('You told me');
  });

  /**
   * The rule the whole feature turns on: a question is answered, never
   * stored, and an unmarked opinion is not stored either.
   */
  it('never stores a question or a bare opinion', async () => {
    const { say, memory } = await talk();

    await say('Is the Earth flat?');
    await say('I think the Earth is flat.');
    await say('the moon is made of cheese');

    expect(await memory.count()).toBe(0);
  });

  it('stores a marked belief as a belief about the user', async () => {
    const { say, memory } = await talk();
    const response = await say('The truth is that I believe the Earth is flat.');

    expect((await memory.list())[0]?.tags).toContain('user-belief');
    expect(response.text).toContain('you believe');
  });

  /**
   * Being told something does not make it so. A stored claim is read back as
   * something the user said, never as something Havoc knows.
   */
  it('never reads a stored claim back as verified fact', async () => {
    const { say } = await talk();
    await say('The truth is that the moon is made of cheese.');

    const recalled = await say('what do you remember');
    expect(recalled.text).toContain('You told me');
    expect(recalled.text).not.toMatch(/^The moon is made of cheese/m);
  });

  it('replaces a fact rather than keeping both when corrected', async () => {
    const { say, memory } = await talk();
    await say('The truth is that the rent is due on the 3rd.');
    const updated = await say('The new truth is that the rent is due on the 5th.');

    expect(await memory.count()).toBe(1);
    expect((await memory.list())[0]?.content).toContain('5th');
    expect(updated.text).toContain('Updated');
  });

  it('drops a fact the user retracts', async () => {
    const { say, memory } = await talk();
    await say('The truth is that the office closes at six.');
    await say("That's no longer true.");

    expect(await memory.count()).toBe(0);
  });

  it('asks rather than guessing when an update names no replacement', async () => {
    const { say, memory } = await talk();
    await say('The truth is that the office closes at six.');
    const response = await say('Change that fact');

    expect(response.text.toLowerCase()).toContain('what should it say');
    expect(await memory.count()).toBe(1);
  });
});
