import { beforeEach, describe, expect, it } from 'vitest';
import { understand, understandClause, FLOOR } from './understand.js';
import { ConversationState } from './state.js';
import { normalise } from './normalise.js';
import { vocabulary } from './registry.js';
import { matchCapabilities } from './match.js';

let state: ConversationState;
beforeEach(() => {
  state = new ConversationState();
  state.advance();
});

const read = (said: string) => understandClause(said, state);
const capabilityOf = (said: string) => read(said).match?.capability.id ?? null;
const verbOf = (said: string) => read(said).match?.verb ?? null;

describe('the phrasings the brief asks for', () => {
  /**
   * The whole point. None of these were written down anywhere as a phrase;
   * they are recognised by decomposing the sentence into a verb and a
   * subject and scoring both against the registry.
   */
  it('understands every way of asking for the Notepad', () => {
    for (const said of [
      'Open my notes.',
      'Can you open my notes?',
      'Can you pull up my notebook?',
      'Pull up my notebook.',
      'Let me see what I saved earlier.',
      'show my notes',
      'bring up my notebook',
      'I need to write something down.',
      'Can you jot this down?',
      'Save this for later.',
      'Keep this somewhere so I don\'t forget.',
    ]) {
      expect(capabilityOf(said), said).toBe('notepad');
    }
  });

  it('tells apart opening, writing, searching and deleting', () => {
    expect(verbOf('open my notes')).toBe('open');
    expect(verbOf('pull up my notebook')).toBe('open');
    expect(verbOf('write this down')).toBe('create');
    expect(verbOf('jot this down')).toBe('create');
    expect(verbOf('find my note about Blender')).toBe('search');
    expect(verbOf('delete my note about Blender')).toBe('delete');
  });

  it('carries what the verb should act on', () => {
    expect(read('find my note about Blender').match?.target).toBe('blender');
    expect(read('bring up what I wrote about Blender').match?.target).toBe('blender');
    expect(read('create a note called Project Ideas').match?.target).toBe('project ideas');
  });
});

describe('imperfect speech', () => {
  /**
   * Dictation splits compounds and near-misses uncommon words. Neither is the
   * user making a mistake, so failing on them is Helix's fault.
   */
  it('understands what a speech recogniser did to the word', () => {
    for (const said of ['open not pad', 'open my note pad', 'show me my noats', 'open notebok']) {
      expect(capabilityOf(said), said).toBe('notepad');
    }
  });

  it('says what it repaired, rather than silently rewriting', () => {
    const repairs = normalise('show me my noats', vocabulary()).repairs;
    expect(repairs).toContainEqual(['noats', 'notes']);
  });

  /**
   * The line a repairer must not cross. These are ordinary English words that
   * happen to be one edit from a capability word, and correcting them would
   * change what the sentence means.
   */
  it('never corrects an ordinary word into a capability word', () => {
    for (const word of ['not', 'now', 'one', 'node', 'nope', 'no']) {
      const repaired = normalise(word, vocabulary()).text;
      expect(repaired, word).not.toBe('note');
    }
  });
});

describe('confidence', () => {
  it('acts on a clear, safe request', () => {
    expect(read('open my notes').outcome).toBe('act');
  });

  /** Irreversible, so it goes to the existing confirmation pipeline. */
  it('sends a deletion to confirmation rather than doing it', () => {
    expect(read('delete my note about Blender').outcome).toBe('confirm');
  });

  /**
   * "Delete my note about X" contains "about", which is a search word. Read
   * as a search it shows the note; read as a delete it destroys it. The
   * stronger reading has to win, and confirmation then makes it safe.
   */
  it('reads a destructive verb as destructive even when a safe one also matches', () => {
    expect(verbOf('delete my note about Blender')).toBe('delete');
  });

  it('asks when the verb needs a target and none was given', () => {
    const understanding = read('delete a note');
    expect(understanding.outcome).toBe('clarify');
    expect(understanding.question).toBeTruthy();
  });

  it('declines rather than guessing when nothing names a capability', () => {
    for (const said of ['open the thing', 'what is the capital of Australia', 'hello']) {
      expect(read(said).outcome, said).toBe('decline');
    }
  });

  it('keeps a floor below which it claims nothing', () => {
    expect(FLOOR).toBeGreaterThan(0.3);
  });
});

describe('references', () => {
  it('resolves "it" to whatever is in focus', () => {
    state.focusOn({ kind: 'notepad', id: 'note_1', label: 'Project Ideas' });
    state.advance();

    const understanding = read('add the supplier idea to it');
    expect(understanding.object?.id).toBe('note_1');
    expect(understanding.match?.capability.id).toBe('notepad');
  });

  it('resolves an ordinal against the list it offered', () => {
    state.offer([
      { kind: 'notepad', id: 'a', label: 'Website', turn: 1 },
      { kind: 'notepad', id: 'b', label: 'Website redesign', turn: 1 },
    ]);
    state.advance();

    expect(read('the second one').object?.id).toBe('b');
    expect(read('open the first one').object?.id).toBe('a');
  });

  it('resolves "the other one" only when there are exactly two', () => {
    state.offer([
      { kind: 'notepad', id: 'a', label: 'Website', turn: 1 },
      { kind: 'notepad', id: 'b', label: 'Website redesign', turn: 1 },
    ]);
    state.advance();
    expect(read('no, the other one').object?.id).toBe('b');
  });

  /**
   * A guess here is unrecoverable on a delete, so an unresolvable reference
   * has to become a question.
   */
  it('asks rather than guessing when a reference resolves to nothing', () => {
    const understanding = read('delete that');
    expect(understanding.outcome).toBe('clarify');
  });

  it('lets focus go stale rather than resolving to something long past', () => {
    state.focusOn({ kind: 'notepad', id: 'note_1', label: 'Old' });
    for (let i = 0; i < 10; i += 1) state.advance();

    expect(state.referent()).toBeNull();
  });
});

describe('corrections', () => {
  it('treats a redirection as a change of target, not a new request', () => {
    state.record({
      capability: 'notepad',
      verb: 'open',
      succeeded: true,
      utterance: 'open my Blender notes',
    });
    state.advance();

    const understanding = read('No, I meant the Helix notes.');
    expect(understanding.correction?.kind).toBe('replace');
    expect(understanding.match?.capability.id).toBe('notepad');
  });

  it('understands a cancellation as stopping, not as a new request', () => {
    const understanding = read('Actually, forget that.');
    expect(understanding.correction?.kind).toBe('cancel');
    expect(understanding.outcome).toBe('decline');
  });

  it('recognises a request to do the same thing again', () => {
    expect(read('do it again').correction?.kind).toBe('repeat');
  });

  it('recognises a revision of the thing in hand', () => {
    expect(read('wait, make it simpler').correction?.kind).toBe('revise');
  });
});

describe('several requests in one message', () => {
  it('splits the example from the brief into its parts', () => {
    const understood = understand(
      'Open my notes, find the one about the website, and add that I need to fix the login page',
      state,
    );

    expect(understood.multiple).toBe(true);
    expect(understood.steps.length).toBeGreaterThanOrEqual(2);
    expect(understood.steps[0]?.match?.verb).toBe('open');
  });

  it('splits finding from exporting', () => {
    const understood = understand('Find my Helix notes and export them to the flash drive', state);
    expect(understood.steps.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The line the splitter must not cross. A shopping list is one note, and
   * cutting it into three would be worse than never splitting anything.
   */
  it('never cuts the contents of a note into separate requests', () => {
    const understood = understand('write down eggs, milk and bread', state);
    expect(understood.steps).toHaveLength(1);
    expect(understood.steps[0]?.match?.verb).toBe('create');
  });
});

describe('what it leaves alone', () => {
  /**
   * The layer sits above the existing tools and only claims what it is sure
   * of. Everything else has to fall through untouched, or it breaks the
   * sixteen tools that already work.
   */
  it('declines ordinary conversation so it falls through', () => {
    for (const said of [
      'hello',
      'what is the capital of Australia',
      'how are you',
      'what can you do',
      'my name is Michael',
      'thanks',
    ]) {
      expect(read(said).outcome, said).toBe('decline');
    }
  });

  it('scores nothing for a sentence that names no capability', () => {
    expect(matchCapabilities('tell me a joke')).toEqual([]);
  });
});
