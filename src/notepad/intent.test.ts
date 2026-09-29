import { describe, expect, it } from 'vitest';
import { notepadIntent } from './intent.js';

const act = (said: string) => notepadIntent(said)?.action ?? null;
const subject = (said: string) => notepadIntent(said)?.subject ?? null;

describe('opening the notepad', () => {
  it('recognises the ways people ask for it', () => {
    for (const said of [
      'open notepad',
      'Helix, open my notepad',
      'open my notes',
      'show my notes',
      'show me my notes',
      'list notes',
      'read my notes',
      'bring up my notebook',
      'go to notes',
      'notepad',
      'my notes',
      'Helix, notebook',
    ]) {
      expect(act(said), said).toBe('open');
    }
  });

  it('asks for the screen rather than for a note', () => {
    expect(subject('open my notes')).toBe('');
  });
});

describe('writing a note', () => {
  it('recognises the ways people ask for one', () => {
    for (const said of [
      'create a note',
      'make a new note',
      'start a note',
      'write this down',
      'note this down',
      'write down the supplier is late',
      'make a note of the supplier being late',
      'add this to my notes',
      'put this in my notepad',
      'save that in my notes',
      'jot this down',
    ]) {
      expect(act(said), said).toBe('create');
    }
  });

  it('takes the title or the text with it', () => {
    expect(subject('create a note called Reselling Ideas')).toBe('Reselling Ideas');
    expect(subject('make a note titled Blender')).toBe('Blender');
    expect(subject('add a note saying find better suppliers')).toBe('find better suppliers');
    expect(subject('write down the margins are too thin')).toBe('margins are too thin');
  });

  it('strips the quotes people put around a title', () => {
    expect(subject('create a note called "Reselling Ideas"')).toBe('Reselling Ideas');
  });
});

describe('adding to a note that exists', () => {
  /**
   * Distinct from creating, and it has to be, because "add this to my notes
   * about suppliers" names a note that is already there. Read as a create it
   * makes a second note with the same subject, which is how a notepad stops
   * being worth opening.
   */
  it('recognises an addition to a named note', () => {
    expect(act('add this to my note about suppliers')).toBe('append');
    expect(subject('add this to my note about suppliers')).toBe('suppliers');
    expect(act('append this to my notes called Blender')).toBe('append');
  });

  it('is still a create when no note is named', () => {
    expect(act('add this to my notes')).toBe('create');
  });
});

describe('searching', () => {
  it('recognises the ways people go looking', () => {
    for (const said of [
      'find my note about the reselling business',
      'search my notes for Blender',
      'search notes about suppliers',
      'look for a note about margins',
      'what did I write about my reselling project',
      'what did I note about the vault',
      'do I have a note about margins',
      'pull up my notes on suppliers',
    ]) {
      expect(act(said), said).toBe('search');
    }
  });

  it('carries what to look for', () => {
    expect(subject('find my note about the reselling business')).toBe('reselling business');
    expect(subject('search my notes for Blender')).toBe('Blender');
    expect(subject('what did I write about my reselling project')).toBe('reselling project');
  });
});

describe('deleting', () => {
  /**
   * Order matters, and this is the case it matters for. "delete my note about
   * Blender" contains "note about", which the search rule also matches. Read
   * as a search it shows you the note; read as a delete it destroys it. The
   * destructive rules are tested first so the ambiguity resolves towards the
   * reading that will ask before acting.
   */
  it('reads as a delete even though it mentions a note about something', () => {
    expect(act('delete my note about Blender')).toBe('delete');
    expect(subject('delete my note about Blender')).toBe('Blender');
    expect(act('delete that note')).toBe('delete');
    expect(act('remove the note called Blender')).toBe('delete');
    expect(subject('remove the note called Blender')).toBe('Blender');
    expect(act('get rid of my note on margins')).toBe('delete');
  });
});

describe('exporting', () => {
  it('recognises the ways people ask for a copy', () => {
    for (const said of ['export my notes', 'back up my notes', 'backup my notepad', 'export notes']) {
      expect(act(said), said).toBe('export');
    }
  });

  /** Before the search rules, or "back up my notes" is a hunt for "up". */
  it('is not mistaken for a search', () => {
    expect(act('back up my notes')).not.toBe('search');
  });
});

describe('everything else', () => {
  it('stays out of the way of ordinary talk', () => {
    // Nearly everything anyone says is not about the notepad. A false
    // positive here hijacks a question Helix should simply have answered.
    for (const said of [
      'what is my storage ceiling',
      'what is the weather',
      'hello',
      'what can you do',
      'tell me a joke',
      'open my project',
      'search my files for invoices',
      'show me the graph',
      '',
      '   ',
    ]) {
      expect(notepadIntent(said), said).toBeNull();
    }
  });

  /**
   * Memory is a different system with different rules, different refusals and
   * its own screen. Routing this to both would store it twice, in two places.
   */
  it('does not treat a memory instruction as a notepad one', () => {
    expect(notepadIntent('remember that I prefer terse answers')).toBeNull();
    expect(notepadIntent('remember this: I take my coffee black')).toBeNull();
    expect(notepadIntent('what do you remember about me')).toBeNull();
    expect(notepadIntent('forget what I said about margins')).toBeNull();
  });

  /** A question about the notepad, answered from a count, not by opening it. */
  it('does not open the screen for a question about it', () => {
    expect(notepadIntent('how many notes do I have')).toBeNull();
  });
});

describe('the wake word and the politeness', () => {
  it('is stripped before anything is matched', () => {
    for (const said of [
      'Helix open my notes',
      'Hey Helix, open my notes',
      'Helix, please open my notes',
      'could you open my notes',
      'OK Helix open my notes',
    ]) {
      expect(act(said), said).toBe('open');
    }
  });
});
