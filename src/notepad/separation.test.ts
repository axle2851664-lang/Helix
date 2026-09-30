import { describe, expect, it } from 'vitest';
import { NotepadManager } from './NotepadManager.js';
import { understand } from '../understanding/understand.js';
import { ConversationState } from '../understanding/state.js';
import { inferType, type VaultDocumentType } from '../vault/VaultGraph.js';
import { ARCHIVABLE } from '../backup/archive.js';
import { WORKSPACES } from '../ui/workspaces/registry.js';
import { Logger } from '../core/Logger.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { PathManager } from '../storage/PathManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';

/**
 * The Notepad and the user's files are different things, and this file exists
 * to keep them that way.
 *
 * They blurred once, in three places at once, and every one of them reached a
 * user:
 *
 *   - "search my notes" was a phrase in the file-search tool, so someone who
 *     had just written three notes and searched for them was told that no
 *     files were indexed.
 *   - The vault graph called every markdown file on disk a "note", so Helix
 *     used one word for a file it had only read and for something it had been
 *     asked to write. A user cannot see which one they have got.
 *   - The Graph's subtitle read "Your notes and the links between them",
 *     about files Helix never wrote.
 *
 * The distinction, stated once: a NOTE is Helix's own, in Helix's own
 * storage, written only when asked. A FILE is the user's, made somewhere
 * else, which Helix reads and indexes and never authored. They have different
 * rules about writing, deleting and export, so they get different words,
 * different screens and different storage.
 */

function makeNotepad() {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  return { store, logger, notepad: new NotepadManager({ store, logger }) };
}

describe('separate storage', () => {
  /**
   * The strongest form of the separation: a note is not reachable from the
   * thing that reads files, whatever either of them is asked.
   */
  it('keeps notes out of the file index entirely', async () => {
    const { store, logger, notepad } = makeNotepad();
    const paths = new PathManager({ root: 'E:/Helix' });
    const projects = new ProjectManager({ store, logger, paths });
    const knowledge = new KnowledgeIndex({ store, projects, logger });

    await notepad.save({ content: 'Suppliers\n\nAcme are late again.' });

    expect(await knowledge.search('Acme')).toEqual([]);
    expect((await knowledge.stats()).searchable).toBe(0);
    expect(await notepad.count()).toBe(1);
  });

  it('gives the Notepad a namespace of its own', async () => {
    const { store, notepad } = makeNotepad();
    await notepad.save({ content: 'Anything.' });

    expect(await store.keys('notepad')).toHaveLength(1);
    // Not in with the files, the projects or the memories.
    for (const other of ['project-assets', 'asset-blobs', 'knowledge', 'memory']) {
      expect(await store.keys(other), other).toEqual([]);
    }
  });

  /** Both are archivable, and archivable separately - that is the point. */
  it('lets a copy carry one without the other', () => {
    expect(Object.keys(ARCHIVABLE)).toContain('notepad');
    expect(Object.keys(ARCHIVABLE)).toContain('knowledge');
    expect(ARCHIVABLE.notepad).not.toBe(ARCHIVABLE.knowledge);
  });
});

describe('separate words', () => {
  /**
   * The vault graph shows markdown files on the user's disk. It used to call
   * them notes. Nothing in Helix may call a file a note.
   */
  it('does not call a file in a vault a note', () => {
    const types: VaultDocumentType[] = [
      'document',
      'client',
      'project',
      'meeting',
      'invoice',
      'missing',
    ];
    expect(types).not.toContain('note' as VaultDocumentType);
    expect(inferType('Notes/Idea.md')).toBe('document');
  });

  /**
   * A file in a folder called "Notes" is still a file. The folder name is the
   * user's, and it must not change what Helix calls the thing.
   */
  it('is not fooled by a folder called Notes', () => {
    expect(inferType('Notes/anything.md')).not.toBe('note');
  });

  it('points the plain word "notes" at the Notepad and nowhere else', () => {
    const owners = Object.values(WORKSPACES).filter((workspace) =>
      workspace.aliases.some((alias) => alias === 'notes' || alias === 'note'),
    );
    expect(owners.map((workspace) => workspace.id)).toEqual(['notepad']);
  });

  /**
   * The Graph's subtitle read "Your notes and the links between them", about
   * files Helix never wrote.
   */
  it('keeps the word out of the file-facing screens', () => {
    for (const id of ['files', 'graph', 'upload-project'] as const) {
      expect(WORKSPACES[id].subtitle.toLowerCase(), id).not.toContain('note');
    }
  });

  it('keeps the Notepad describing itself in its own terms', () => {
    expect(WORKSPACES.notepad.subtitle.toLowerCase()).toContain('note');
  });
});

describe('separate instructions', () => {
  /**
   * The regression that reached a user. "search my notes" was answered out of
   * the file index; the fix was to take the phrase off the file-search tool
   * and give the Notepad the higher priority. This asserts the half that
   * lives here: the Notepad claims it.
   */
  it('claims every phrasing that names notes', () => {
    for (const said of [
      'search my notes for Acme',
      'find my note about suppliers',
      'what did I write about margins',
      'open my notes',
      // Phrasings nobody wrote down, understood by decomposition.
      'pull up my notebook',
      'can you jot this down',
    ]) {
      const state = new ConversationState();
      state.advance();
      const step = understand(said, state).steps[0];
      expect(step?.match?.capability.id, said).toBe('notepad');
    }
  });

  /** And declines every phrasing that names files. */
  it('declines every phrasing that names files', () => {
    for (const said of [
      'search my files for Acme',
      'what do my files say about deadline',
      'find in my files invoices',
      'look in my files for the contract',
      'open my project',
      'index my files',
      'show me the graph',
    ]) {
      const state = new ConversationState();
      state.advance();
      const step = understand(said, state).steps[0];
      expect(step?.match?.capability.id, said).not.toBe('notepad');
    }
  });
});
