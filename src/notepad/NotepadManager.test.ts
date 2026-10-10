import { describe, expect, it } from 'vitest';
import { NotepadManager, deriveTitle } from './NotepadManager.js';
import { EventBus } from '../core/EventBus.js';
import { HavocError } from '../core/HavocError.js';
import { Logger } from '../core/Logger.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';

function makeNotepad(options: { bus?: EventBus } = {}) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const notepad = new NotepadManager({
    store,
    logger,
    ...(options.bus ? { bus: options.bus } : {}),
  });
  return { notepad, store };
}

describe('writing a note', () => {
  it('keeps what it was given', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Check the margins before Friday.' });

    expect(note.content).toBe('Check the margins before Friday.');
    expect(note.source).toBe('user-explicit');
    expect(note.category).toBe('note');
    expect(await notepad.count()).toBe(1);
  });

  it('takes a title when one is given', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Ideas go here.', title: 'Reselling' });
    expect(note.title).toBe('Reselling');
  });

  /**
   * Derived, never invented: every character comes from what the user wrote.
   * A title Havoc made up would be Havoc's words in a list of the user's.
   */
  it('derives a title from the first line when none is given', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Supplier list\n\nAcme, Belco, Corvid.' });
    expect(note.title).toBe('Supplier list');
  });

  it('strips markdown list and heading markers from a derived title', async () => {
    const { notepad } = makeNotepad();
    expect((await notepad.save({ content: '# Suppliers\nAcme' })).title).toBe('Suppliers');
    expect((await notepad.save({ content: '- Acme\n- Belco' })).title).toBe('Acme');
  });

  it('cuts a very long first line at a word boundary', () => {
    const long = `${'word '.repeat(60)}end`;
    const title = deriveTitle(long);
    expect(title.length).toBeLessThan(130);
    expect(title.endsWith('...')).toBe(true);
    expect(title).not.toMatch(/wor\.\.\.$/);
  });

  it('refuses an empty note rather than storing a blank one', async () => {
    const { notepad } = makeNotepad();
    await expect(notepad.save({ content: '   ' })).rejects.toBeInstanceOf(HavocError);
    expect(await notepad.count()).toBe(0);
  });

  it('refuses a note too long to store rather than truncating it', async () => {
    const { notepad } = makeNotepad();
    // Silently keeping the first hundred thousand characters would be the
    // worst outcome available: it looks saved and it is not.
    await expect(notepad.save({ content: 'x'.repeat(100_001) })).rejects.toBeInstanceOf(HavocError);
    expect(await notepad.count()).toBe(0);
  });

  it('lowercases and de-duplicates tags', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Anything', tags: ['Work', 'work', ' Money '] });
    expect(note.tags).toEqual(['work', 'money']);
  });

  it('announces the note without announcing its contents', async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('NOTE_SAVED', (event) => seen.push(event));

    const { notepad } = makeNotepad({ bus });
    const note = await notepad.save({ content: 'The bank code is in the drawer.' });

    expect(seen).toEqual([{ noteId: note.id, category: 'note' }]);
  });
});

describe('credentials', () => {
  /**
   * The same rule as long-term memory, and it has to be: a second store of
   * the user's own words with looser rules would be the obvious way round the
   * first one.
   */
  it('refuses content that looks like a key', async () => {
    const { notepad } = makeNotepad();
    await expect(
      notepad.save({ content: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ).rejects.toBeInstanceOf(HavocError);
    expect(await notepad.count()).toBe(0);
  });

  it('refuses a labelled password', async () => {
    const { notepad } = makeNotepad();
    await expect(notepad.save({ content: 'password: hunter2isnotsecure' })).rejects.toBeInstanceOf(
      HavocError,
    );
  });

  it('explains what it refused without repeating it back', async () => {
    const { notepad } = makeNotepad();
    const error = await notepad
      .save({ content: 'password: hunter2isnotsecure' })
      .then(() => null)
      .catch((caught: unknown) => caught as HavocError);

    expect(error).toBeInstanceOf(HavocError);
    expect(error?.message).toMatch(/credential|password|key/i);
    // The rejected content is never repeated back, here or in the log.
    expect(error?.message).not.toContain('hunter2');
  });

  /**
   * An edit is a write. A note that refused a key on creation and accepted
   * one on its second save would have no rule at all.
   */
  it('refuses a credential added by an edit, not only by a create', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Nothing sensitive here.' });

    await expect(
      notepad.update(note.id, { content: 'password: hunter2isnotsecure' }),
    ).rejects.toBeInstanceOf(HavocError);

    expect((await notepad.get(note.id))?.content).toBe('Nothing sensitive here.');
  });

  it('refuses one added by an append too', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Supplier list.' });

    await expect(
      notepad.append(note.id, 'password: hunter2isnotsecure'),
    ).rejects.toBeInstanceOf(HavocError);
  });
});

describe('changing a note', () => {
  it('keeps the creation date and moves the update date', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'First.' });
    const changed = await notepad.update(note.id, { content: 'Second.' });

    expect(changed.createdAt).toBe(note.createdAt);
    expect(changed.updatedAt).toBeGreaterThanOrEqual(note.createdAt);
    expect(changed.content).toBe('Second.');
  });

  /**
   * A title the user chose is theirs. A title Havoc derived should follow the
   * text it was derived from, or a note whose first line has been rewritten
   * keeps a title that no longer appears anywhere in it.
   */
  it('lets a derived title follow the content', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Supplier list\nAcme' });
    const changed = await notepad.update(note.id, { content: 'Customer list\nBelco' });

    expect(changed.title).toBe('Customer list');
  });

  it('leaves a title the user chose alone', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Supplier list\nAcme', title: 'Q3' });
    const changed = await notepad.update(note.id, { content: 'Customer list\nBelco' });

    expect(changed.title).toBe('Q3');
  });

  it('adds to the end rather than replacing', async () => {
    const { notepad } = makeNotepad();
    const note = await notepad.save({ content: 'Acme' });
    const changed = await notepad.append(note.id, 'Belco');

    expect(changed.content).toBe('Acme\n\nBelco');
  });

  it('says so when the note is not there', async () => {
    const { notepad } = makeNotepad();
    await expect(notepad.update('note_nothing', { content: 'x' })).rejects.toBeInstanceOf(HavocError);
    await expect(notepad.append('note_nothing', 'x')).rejects.toBeInstanceOf(HavocError);
  });
});

describe('deleting', () => {
  /** No bin, no archive, no soft flag. A note that looks deleted and is not
   *  is worse than one that was never deleted at all. */
  it('removes the note from storage', async () => {
    const { notepad, store } = makeNotepad();
    const note = await notepad.save({ content: 'Temporary.' });

    expect(await notepad.remove(note.id)).toBe(true);
    expect(await notepad.get(note.id)).toBeUndefined();
    expect(await store.keys('notepad')).toEqual([]);
  });

  it('says plainly when there was nothing to delete', async () => {
    const { notepad } = makeNotepad();
    expect(await notepad.remove('note_nothing')).toBe(false);
  });
});

describe('finding a note again', () => {
  const seed = async (notepad: NotepadManager) => {
    await notepad.save({ content: 'Suppliers\n\nAcme are late again. Belco are fine.' });
    await notepad.save({ content: 'Margins\n\nToo thin on the Acme line.' });
    await notepad.save({ content: 'Holiday\n\nBook the ferry.', tags: ['personal'] });
  };

  it('returns nothing for an empty query rather than everything', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);
    expect(await notepad.search('   ')).toEqual([]);
  });

  /**
   * Someone searching for "suppliers" who has a note called Suppliers means
   * that one. Burying it under three notes that mention the word in passing
   * is the difference between a search that works and one that technically
   * works.
   */
  it('puts a title match first', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);

    const found = await notepad.search('suppliers');
    expect(found[0]?.note.title).toBe('Suppliers');
    expect(found[0]?.reason).toBe('title');
  });

  it('finds a word in the body', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);

    const found = await notepad.search('ferry');
    expect(found).toHaveLength(1);
    expect(found[0]?.note.title).toBe('Holiday');
  });

  it('finds several notes that share a word, best first', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);

    const titles = (await notepad.search('Acme')).map((match) => match.note.title);
    expect(titles).toContain('Suppliers');
    expect(titles).toContain('Margins');
  });

  it('finds by tag', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);

    const found = await notepad.search('personal');
    expect(found[0]?.note.title).toBe('Holiday');
  });

  /**
   * The excerpt exists so the user can see why a note came back. It has to be
   * their words: a summary would be Havoc's words presented as theirs.
   */
  it('quotes the line it matched rather than summarising it', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);

    const found = await notepad.search('ferry');
    const match = found[0];
    expect(match).toBeDefined();
    expect(match?.note.content).toContain(match?.excerpt ?? 'missing');
  });

  it('honours a limit', async () => {
    const { notepad } = makeNotepad();
    await seed(notepad);
    expect(await notepad.search('Acme', { limit: 1 })).toHaveLength(1);
  });
});

describe('listing', () => {
  it('puts the most recently changed first', async () => {
    const { notepad } = makeNotepad();
    const first = await notepad.save({ content: 'First.' });
    await notepad.save({ content: 'Second.' });
    await notepad.update(first.id, { content: 'First, revised.' });

    expect((await notepad.list())[0]?.id).toBe(first.id);
  });

  it('tells its listeners when anything changes', async () => {
    const { notepad } = makeNotepad();
    let calls = 0;
    const stop = notepad.subscribe(() => {
      calls += 1;
    });

    const note = await notepad.save({ content: 'One.' });
    await notepad.update(note.id, { content: 'Two.' });
    await notepad.remove(note.id);
    stop();
    await notepad.save({ content: 'After unsubscribing.' });

    expect(calls).toBe(3);
  });
});
