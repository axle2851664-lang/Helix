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
 * `confirms` is what the user says to the confirmation that deleting a note
 * goes through. `null` builds the orchestrator with no action pipeline at all,
 * which is the case where nothing can ask - and a delete that cannot ask must
 * not happen.
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

  const ask = (text: string) =>
    orchestrator.submit({ text, conversationId: conversation.id });

  return { orchestrator, notepad, memory, ask };
}

describe('orchestrator: the notepad', () => {
  describe('writing', () => {
    it('writes down what was said and nothing else', async () => {
      const { ask, notepad } = await makeContext();
      const response = await ask('write down the margins are too thin');

      expect(response.handled).toBe(true);
      const notes = await notepad.list();
      expect(notes).toHaveLength(1);
      // "the" is kept. The old matcher stripped a leading article, which is
      // fine for "the margins" and wrong for "the Acme contract" - the words
      // after the instruction are the note, exactly as dictated.
      expect(notes[0]?.content).toBe('the margins are too thin');
    });

    /**
     * Writing a note no longer throws the Notepad on screen. The composer
     * lives on the home screen, so navigating away ended the conversation -
     * and the note is named back in the reply, which is what the user needs.
     */
    it('stays in the conversation after writing a note', async () => {
      const { ask, notepad } = await makeContext();
      const response = await ask('make a note called Suppliers');

      expect(response.handled).toBe(true);
      expect(response.navigateTo).toBeUndefined();
      expect(await notepad.count()).toBe(1);
      expect(response.text).toContain('Suppliers');
    });

    /**
     * "Write this down" with nothing after it. There is no honest way to know
     * what "this" was, and reaching into the transcript for the last plausible
     * sentence would be Havoc deciding what to keep - which is precisely what
     * the Notepad promises not to do.
     */
    it('asks what to write rather than guessing from the conversation', async () => {
      const { ask, notepad } = await makeContext();
      await ask('the supplier is late again');
      const response = await ask('write this down');

      expect(response.handled).toBe(false);
      expect(response.text.toLowerCase()).toContain('what should i write');
      expect(await notepad.count()).toBe(0);
    });

    /** The manager's refusal is the answer, in its own words. */
    it('passes a credential refusal through rather than softening it', async () => {
      const { ask, notepad } = await makeContext();
      const response = await ask('write down the password: hunter2isnotsecure');

      expect(response.handled).toBe(false);
      expect(response.text.toLowerCase()).toMatch(/credential|password|key/);
      expect(await notepad.count()).toBe(0);
    });
  });

  describe('finding', () => {
    const seed = async (notepad: NotepadManager) => {
      await notepad.save({ content: 'Suppliers\n\nAcme are late again.' });
      await notepad.save({ content: 'Margins\n\nToo thin on the Acme line.' });
    };

    it('names the note when there is only one, without leaving the conversation', async () => {
      const { ask, notepad } = await makeContext();
      await seed(notepad);

      const response = await ask('find my note about suppliers');
      expect(response.handled).toBe(true);
      expect(response.text).toContain('Suppliers');
      expect(response.navigateTo).toBeUndefined();
    });

    /**
     * The spoken line and the card are never the same content. Reading six
     * rows aloud is not conversation.
     */
    it('names one note out loud and puts the rest on a card', async () => {
      const { ask, notepad } = await makeContext();
      await seed(notepad);

      const response = await ask('search my notes for Acme');
      expect(response.card?.sections[0]?.items.length).toBeGreaterThan(1);
      expect(response.text).not.toBe(response.card?.title);
      // A card that hides its limits is worse than no card.
      expect(response.card?.caveat.length).toBeGreaterThan(40);
    });

    /** Every row quotes the note. A summary would be Havoc's words as theirs. */
    it('quotes the note on every row', async () => {
      const { ask, notepad } = await makeContext();
      await seed(notepad);

      const response = await ask('search my notes for Acme');
      const notes = await notepad.list();
      for (const item of response.card?.sections[0]?.items ?? []) {
        const source = notes.find((note) => note.title === item.label);
        expect(source?.content, item.label).toContain(item.detail);
      }
    });

    /**
     * The regression this ordering exists for. "search my notes" was a phrase
     * in the file-search tool, written when the only notes Havoc had were
     * markdown files in a vault. Someone who had just written three notes and
     * searched for them was told no files were indexed.
     */
    it('is answered from the Notepad, not from the file index', async () => {
      const { ask, notepad } = await makeContext();
      await seed(notepad);

      const response = await ask('search my notes for Acme');
      expect(response.text.toLowerCase()).not.toContain('indexed');
      expect(response.card?.sections[0]?.items.length).toBeGreaterThan(1);
    });

    it('says plainly when there is nothing', async () => {
      const { ask } = await makeContext();
      const response = await ask('find my note about tungsten');

      expect(response.handled).toBe(true);
      expect(response.text.toLowerCase()).toContain('nothing in the notepad');
    });
  });

  describe('deleting', () => {
    it('deletes once the user has confirmed', async () => {
      const { ask, notepad } = await makeContext(true);
      await notepad.save({ content: 'Suppliers\n\nAcme are late.' });

      const response = await ask('delete my note about suppliers');
      expect(response.handled).toBe(true);
      expect(await notepad.count()).toBe(0);
    });

    /** A cancellation is an answer. The tool ran, asked, and obeyed. */
    it('keeps the note when the user says no, and does not call it a failure', async () => {
      const { ask, notepad } = await makeContext(false);
      await notepad.save({ content: 'Suppliers\n\nAcme are late.' });

      const response = await ask('delete my note about suppliers');
      expect(response.handled).toBe(true);
      expect(response.failure).toBeUndefined();
      expect(await notepad.count()).toBe(1);
    });

    /** A delete that cannot ask is a delete that must not happen. */
    it('refuses to delete when there is no way to ask', async () => {
      const { ask, notepad } = await makeContext(null);
      await notepad.save({ content: 'Suppliers\n\nAcme are late.' });

      const response = await ask('delete my note about suppliers');
      expect(response.handled).toBe(false);
      expect(await notepad.count()).toBe(1);
    });

    it('says so when nothing matches rather than deleting the nearest thing', async () => {
      const { ask, notepad } = await makeContext(true);
      await notepad.save({ content: 'Suppliers\n\nAcme are late.' });

      const response = await ask('delete my note about tungsten');
      expect(response.handled).toBe(false);
      expect(await notepad.count()).toBe(1);
    });
  });

  describe('opening and exporting', () => {
    it('opens the Notepad', async () => {
      const { ask } = await makeContext();
      expect((await ask('open my notes')).navigateTo).toBe('notepad');
    });

    /**
     * Nothing is exported here. The Flash Drive screen is where a copy is
     * made and where the choice of what goes in it lives, so the honest
     * outcome is to take the user there - not to report a copy that does not
     * exist.
     */
    it('sends an export request to the screen that makes one', async () => {
      const { ask } = await makeContext();
      const response = await ask('export my notes');

      expect(response.navigateTo).toBe('portable');
      expect(response.text.toLowerCase()).not.toMatch(/exported|copied|saved to/);
    });
  });

  describe('not the notepad', () => {
    /**
     * "remember that ..." belongs to memory, which has its own rules, its own
     * refusals and its own screen. Routing it to both would store it twice.
     */
    it('leaves a memory instruction to memory', async () => {
      const { ask, notepad, memory } = await makeContext();
      await ask('remember that I prefer terse answers');

      expect(await notepad.count()).toBe(0);
      expect(await memory.count()).toBe(1);
    });

    it('does not hijack an ordinary question', async () => {
      const { ask, notepad } = await makeContext();
      await ask('what is the capital of Australia');
      expect(await notepad.count()).toBe(0);
    });
  });
});
